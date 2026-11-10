"""Standalone host adapter for the native desktop protocol.

The caller authenticates viewers. These requests go to a verified local
binary, outside the agent's tool catalog and the connected-client registry.
"""
from __future__ import annotations

import asyncio
import json
import platform
from time import monotonic

from openagent_device_tools.media import NativeDesktopMedia, native_desktop_command


HOST_SCOPE = "__agent_computer__"
_POINTER_ACTIONS = {
    "mouse_move": {"action": "move"},
    "left_click": {"action": "click", "button": "left"},
    "middle_click": {"action": "click", "button": "middle"},
    "right_click": {"action": "click", "button": "right"},
    "double_click": {"action": "double_click"},
    "left_click_drag": {"action": "drag"},
    "scroll": {"action": "scroll"},
}


class AgentDesktop:
    def __init__(self, *, environment=None):
        self.environment = environment
        self._loaded = False
        self._control = self._view = None
        self._media = None
        self._monitors = {}
        self._inventory_until = 0.0
        self._geometry = {}
        self._refresh = asyncio.Lock()
        self._inputs = asyncio.Semaphore(4)
        self._streams = asyncio.Semaphore(4)

    async def _request(self, command, action, **params):
        if not command:
            raise LookupError("The native desktop helper is unavailable")
        async with self._inputs:
            process = await asyncio.create_subprocess_exec(
                *command, "--desktop-stdio",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env=self.environment,
                limit=16 * 1024 * 1024,
            )
            try:
                async with asyncio.timeout(8):
                    process.stdin.write((json.dumps({"id": 1, "action": action, **params}) + "\n").encode())
                    await process.stdin.drain()
                    process.stdin.close()
                    try:
                        line = await process.stdout.readline()
                        result = json.loads(line)
                    except ValueError as exc:
                        raise RuntimeError("Invalid native desktop response") from exc
                    if (not isinstance(result, dict) or result.get("id") != 1
                            or result.get("ok") is not True or not isinstance(result.get("result"), dict)):
                        raise RuntimeError("The local desktop could not perform the action")
                    return result["result"]
            finally:
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                await process.wait()

    async def monitors(self):
        async with self._refresh:
            if monotonic() < self._inventory_until:
                return self._monitors
            if not self._loaded:
                self._control, self._view = await asyncio.to_thread(self._commands)
                if self._view:
                    self._media = await asyncio.to_thread(NativeDesktopMedia, self._view, environment=self.environment)
                self._loaded = True
            found = {}
            try:
                reply = await self._request(self._view or self._control, "monitors")
                for display in reply.get("monitors", [])[:16]:
                    if not isinstance(display, dict):
                        continue
                    identifier = display.get("id")
                    if not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdecimal():
                        continue
                    if len(identifier) > 10 or int(identifier) > 2**32 - 1:
                        continue
                    found["agent-desktop:" + identifier] = display
            except (LookupError, OSError, ValueError, TypeError, RuntimeError, TimeoutError):
                pass
            self._monitors = found
            self._geometry = {ref: value for ref, value in self._geometry.items() if ref in found}
            self._inventory_until = monotonic() + 5
            return found

    @staticmethod
    def _commands():
        try:
            return native_desktop_command("control"), native_desktop_command("view")
        except (OSError, ValueError):
            return None, None

    async def inventory(self, access):
        monitors = await self.monitors() if access != "none" else {}
        if access == "control" and self._control is None:
            access = "view"
        return {
            "host": {
                "label": "Agent computer",
                "platform": platform.system(),
                "desktop": "restricted" if access == "none" else "available" if monitors else "unavailable",
            },
            "targets": [
                {
                    "tool_ref": reference,
                    "label": "Agent desktop" if len(monitors) == 1 else f"Agent desktop · Display {index}",
                    "agent_host": True,
                    "can_control": access == "control",
                    "live_media": "openagent-video/1" if self._media else None,
                }
                for index, reference in enumerate(monitors, 1)
            ],
        }

    async def _monitor(self, reference):
        display = (await self.monitors()).get(reference)
        if display is None:
            raise LookupError("The requested agent display is unavailable")
        return display

    async def interact(self, reference, arguments, screen_size=None):
        display = await self._monitor(reference)
        action = arguments["action"]
        monitor_id = display["id"]
        if action == "get_screenshot":
            result = await self._request(self._view or self._control, "screenshot", monitorId=monitor_id)
            width, height = result["width"], result["height"]
            self._geometry[reference] = width, height
            return {"content": [
                {"type": "text", "text": json.dumps({"image_width": width, "image_height": height})},
                {"type": "image", "mimeType": result["mimeType"], "data": result["data"]},
            ]}

        if action == "key":
            request = {"action": "key", "key": arguments["text"]}
        elif action == "type":
            request = {"action": "type", "text": arguments["text"]}
        else:
            width, height = screen_size or self._geometry.get(reference) or (display["width"], display["height"])
            x, y = arguments["coordinate"]
            if x >= width or y >= height:
                raise ValueError("Coordinates outside the display")
            request = {**_POINTER_ACTIONS[action], "x": x / max(1, width - 1), "y": y / max(1, height - 1)}
            if action == "scroll":
                direction, _, amount = arguments["text"].partition(":")
                request.update(direction=direction, amount=min(100, int(amount or 3)))
        await self._request(self._control, monitorId=monitor_id, **request)
        return {"content": []}

    async def stream(self, reference, options):
        display = await self._monitor(reference)
        if self._media is None:
            raise LookupError("Live agent display is unavailable")
        display_id = int(display["id"])
        if options.get("display_id", display_id) != display_id:
            raise ValueError("Display does not match the selected target")
        if self._streams.locked():
            raise RuntimeError("The agent desktop has reached its viewer limit")
        async with self._streams:
            iterator = self._media.stream_tool("computer", {**options, "display_id": display_id}, None)
            try:
                async for packet in iterator:
                    if packet.get("type") == "config":
                        self._geometry[reference] = packet["input_width"], packet["input_height"]
                    yield packet
            finally:
                await iterator.aclose()


def agent_desktop_for(gateway):
    if getattr(gateway, "agent_desktop", None) is None:
        gateway.agent_desktop = AgentDesktop(environment=getattr(gateway.agent, "product_environment", None))
    return gateway.agent_desktop
