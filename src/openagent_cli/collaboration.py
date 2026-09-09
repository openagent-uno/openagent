"""Account-bound shared-session client; no server package dependency.

The caller owns the request id and may retry that exact id after a lost HTTP
response. Observing/reconnecting never sends a message or stops a generation.
"""

from __future__ import annotations

import asyncio
import json
import re

import aiohttp

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
_KINDS = {"session", "workflow", "scheduled_task", "event"}


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid collaboration identifier")
    return value


class CollaborationClient:
    def __init__(self, session: aiohttp.ClientSession, base_url: str):
        self.session = session
        self.base_url = base_url.rstrip("/")

    async def supported(self):
        async with self.session.get(
            self.base_url + "/api/collaboration",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status in {404, 405}:
                return False
            response.raise_for_status()
            return (await response.json()).get("version") == 1

    async def ensure_session(self, session_id, title="Chat"):
        from urllib.parse import quote

        path = (
            self.base_url + "/api/sessions/" + quote(_identifier(session_id), safe="")
        )
        async with self.session.get(path) as response:
            if response.status != 404:
                response.raise_for_status()
                return
        async with self.session.patch(
            path, json={"title": title[:70] or "Chat"}
        ) as response:
            response.raise_for_status()

    async def _post(self, path, body):
        async with self.session.post(
            self.base_url + path,
            json=body,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10),
        ) as response:
            response.raise_for_status()
            result = await response.json()
            if not isinstance(result, dict):
                raise ValueError("Invalid collaboration response")
            return result

    async def send_turn(
        self,
        session_id: str,
        request_id: str,
        message: str,
        *,
        delivery="queue",
        client_instance_id=None,
        attachments=None,
    ):
        if (
            delivery not in {"queue", "steer"}
            or not isinstance(message, str)
            or not message.strip()
            or len(message) > 131072
        ):
            raise ValueError("Expected a message and queue/steer delivery")
        return await self._post(
            "/api/collaboration/turns",
            {
                "session_id": _identifier(session_id),
                "request_id": _identifier(request_id),
                "message": message,
                "delivery": delivery,
                **(
                    {"client_instance_id": _identifier(client_instance_id)}
                    if client_instance_id
                    else {}
                ),
                **({"attachments": attachments} if attachments else {}),
            },
        )

    async def stop_turn(self, session_id: str, request_id: str):
        return await self._post(
            "/api/collaboration/stop",
            {
                "session_id": _identifier(session_id),
                "request_id": _identifier(request_id),
            },
        )

    async def observe(self, sessions, *, focus=None):
        """Yield replacement snapshots/presence; ``shared_reset`` clears caches.

        Create a new iterator to change views. Closing it detaches only this
        observer. Authentication and unsupported-server errors are propagated;
        transient disconnects reconnect from a fresh, authorized snapshot.
        """
        if not isinstance(sessions, (list, tuple)) or len(sessions) > 16:
            raise ValueError("Too many sessions")
        sessions = list(dict.fromkeys(_identifier(sid) for sid in sessions))
        if focus is not None:
            if (
                not isinstance(focus, dict)
                or set(focus) != {"kind", "id"}
                or not isinstance(focus["kind"], str)
                or focus["kind"] not in _KINDS
            ):
                raise ValueError("Invalid observation focus")
            _identifier(focus["id"])
        retry = 0
        while not self.session.closed:
            yield {"type": "shared_reset"}
            try:
                async with self.session.ws_connect(
                    self.base_url + "/ws/collaboration",
                    heartbeat=10,
                    max_msg_size=4 * 1024 * 1024,
                ) as ws:
                    greeting = await ws.receive_json(timeout=10)
                    if (
                        not isinstance(greeting, dict)
                        or greeting.get("type") != "auth_ok"
                        or greeting.get("shared") is not True
                    ):
                        raise PermissionError("Collaboration authentication failed")
                    retry = 0
                    await ws.send_json(
                        {"type": "observe", "sessions": sessions, "focus": focus}
                    )
                    async for message in ws:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            break
                        frame = json.loads(message.data)
                        if not isinstance(frame, dict):
                            raise ValueError("Invalid collaboration frame")
                        if frame.get("type") == "auth_error":
                            yield {"type": "shared_reset"}
                            raise PermissionError("Collaboration authorization changed")
                        if frame.get("type") in {"shared_state", "shared_revoked"}:
                            if frame.get("session_id") not in sessions:
                                continue
                        if frame.get("type") in {
                            "shared_state",
                            "shared_revoked",
                            "shared_presence",
                            "resource_event",
                        }:
                            yield frame
            except aiohttp.WSServerHandshakeError as exc:
                if exc.status < 500:
                    raise
            except (aiohttp.ClientConnectionError, asyncio.TimeoutError):
                pass
            if not self.session.closed:
                # Notify before the backoff, so stale text is never displayed
                # as authorized while disconnected.
                yield {"type": "shared_reset"}
                await asyncio.sleep(min(8, 0.25 * 2 ** min(retry, 5)))
                retry += 1
