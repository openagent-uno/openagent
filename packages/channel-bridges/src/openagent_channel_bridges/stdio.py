"""Credential-local channel SDK runner for a non-Python host.

All frames carry protocol=channel-bridge-ipc/v1. The first host frame is
configure(request_id, provider, binding_id, config). The runner emits request
frames (request_id, method, params); the host answers result/error with that ID.
Host progress uses event(request_id, event). The host cannot inject a channel
event, actor or conversation: those contexts originate in the provider SDK.

While a child request is pending, host request frames may use read_artifact or
upload_begin/chunk/finish with parent_request_id equal to that child request ID.
Read offsets/lengths and sequential upload chunks are bounded. Reply attachment
objects are only {reader_ref: <finished upload>}; no host path is accepted.
The host ingests input media before answering send/transcribe. References expire
on completion, even if another request with the same actor remains active.
"""
from __future__ import annotations

import asyncio
import contextlib
from importlib import import_module
import logging
import sys
import threading
from dataclasses import dataclass, field

from . import __version__
from .contracts import BridgeContext
from .wire import (ArtifactStore, MAX_CHUNK, MAX_LINE, MAX_ARTIFACT, PROTOCOL,
    WireError, decode_line, encode_line, identifier, object_fields,
    progress, result_dto, to_wire)

MAX_PENDING = 64
PROVIDERS = ("slack", "discord", "telegram", "whatsapp")
_CONFIG = {
    "slack": ({"bot_token"}, {"bot_token", "app_token", "allowed_users", "listen_channels", "context_messages", "personality", "live"}),
    "discord": ({"token"}, {"token", "allowed_users", "allowed_guilds", "listen_channels", "dm_only", "members_intent", "context_messages", "personality", "live"}),
    "telegram": ({"token"}, {"token", "allowed_users", "allowed_chats", "streaming", "personality", "live"}),
    "whatsapp": ({"instance_id", "api_token"}, {"instance_id", "api_token", "allowed_users", "personality", "live"}),
}


class HostClosed(ConnectionError):
    def __init__(self):
        super().__init__("channel_host_closed")


class HostRejected(PermissionError):
    def __init__(self):
        super().__init__("channel_host_rejected")


@dataclass
class _Pending:
    method: str
    future: asyncio.Future
    on_event: object = None
    events: set = field(default_factory=set)
    event_tail: object = None
    event_failure: object = None


class StdioBridgeTransport:
    """An explicit host transport, with no runtime/database/connector fallback."""
    def __init__(self, write_line, *, binding_id: str, provider: str):
        self.binding_id = identifier(binding_id)
        if provider not in PROVIDERS:
            raise WireError("unsupported_provider")
        self.provider = provider
        self._write_line = write_line
        self._write_lock = asyncio.Lock()
        self._pending = {}
        self._serial = 0
        self._closed = False
        self._event_count = 0
        self.artifacts = ArtifactStore()

    async def emit(self, value):
        line = encode_line({"protocol": PROTOCOL, **value})
        async with self._write_lock:
            await self._write_line(line)

    def _context(self, context):
        if (not isinstance(context, BridgeContext) or context.binding_id != self.binding_id
                or context.provider != self.provider):
            raise PermissionError("channel_context_binding_mismatch")

    async def _request(self, method, value=None, *, on_event=None):
        if self._closed:
            raise HostClosed()
        if len(self._pending) >= MAX_PENDING:
            raise WireError("pending_limit")
        self._serial += 1
        request_id = f"child-{self._serial}"
        pending = _Pending(method, asyncio.get_running_loop().create_future(), on_event)
        self._pending[request_id] = pending
        self.artifacts.begin(request_id)
        try:
            params = to_wire(value, self.artifacts, request_id) if value is not None else None
            await self.emit({"type": "request", "request_id": request_id, "method": method, "params": params})
            result = await pending.future
            # Ordered callbacks may themselves issue nested authorization RPCs;
            # the ingress reader must remain free to accept those answers.
            if pending.event_tail is not None:
                await pending.event_tail
            if pending.event_failure is not None:
                raise pending.event_failure
            return result_dto(method, result, self.artifacts, request_id)
        finally:
            self._pending.pop(request_id, None)
            active_events = tuple(pending.events)
            for task in active_events:
                if not task.done():
                    task.cancel()
            if active_events:
                await asyncio.gather(*active_events, return_exceptions=True)
            if not pending.future.done():
                pending.future.cancel()
            elif not pending.future.cancelled():
                pending.future.exception()  # consume EOF racing request emission
            self.artifacts.end(request_id)

    async def start(self):
        return await self._request("start")

    async def stop(self):
        return await self._request("stop")

    async def authorize_context(self, context):
        self._context(context)
        return await self._request("authorize_context", context)

    async def authorize_delivery(self, context):
        self._context(context)
        return await self._request("authorize_delivery", context)

    async def send(self, request, *, on_event=None):
        self._context(request.context)
        return await self._request("send", request, on_event=on_event)

    async def command(self, request):
        self._context(request.context)
        return await self._request("command", request)

    async def transcribe(self, context, attachment):
        self._context(context)
        # A tiny wrapper dataclass keeps serialization restricted to DTO values.
        @dataclass
        class Input:
            context: BridgeContext
            attachment: object
        return await self._request("transcribe", Input(context, attachment))

    async def synthesize(self, context, text):
        self._context(context)
        @dataclass
        class Input:
            context: BridgeContext
            text: str
        return await self._request("synthesize", Input(context, text))

    async def receive(self, frame):
        kind = frame.get("type")
        if kind in ("result", "error", "event"):
            allowed = {"protocol", "type", "request_id", kind if kind != "event" else "event"}
            object_fields(frame, allowed, {"protocol", "type", "request_id", kind if kind != "event" else "event"})
            request_id = identifier(frame["request_id"])
            pending = self._pending.get(request_id)
            if pending is None or pending.future.done():
                raise WireError("unknown_request")
            if kind == "error":
                # Never relay host error messages into provider replies/logs.
                object_fields(frame["error"], {"code"}, {"code"})
                identifier(frame["error"]["code"])
                pending.future.set_exception(HostRejected())
            elif kind == "result":
                pending.future.set_result(frame["result"])
            else:
                if pending.on_event is None or self._event_count >= MAX_PENDING:
                    raise WireError("invalid_progress")
                event = progress(frame["event"])
                previous = pending.event_tail
                self._event_count += 1
                async def deliver():
                    if previous is not None:
                        await previous
                    await pending.on_event(event)
                def delivered(task):
                    self._event_count -= 1
                    pending.events.discard(task)
                    if not task.cancelled():
                        failure = task.exception()
                        if failure is not None and pending.event_failure is None:
                            pending.event_failure = failure
                task = asyncio.create_task(deliver())
                pending.events.add(task)
                pending.event_tail = task
                task.add_done_callback(delivered)
            return
        object_fields(frame, {"protocol", "type", "request_id", "method", "parent_request_id", "params"},
                      {"protocol", "type", "request_id", "method", "parent_request_id", "params"})
        if kind != "request":
            raise WireError("invalid_frame")
        host_id = identifier(frame["request_id"])
        parent_id = identifier(frame["parent_request_id"])
        pending = self._pending.get(parent_id)
        try:
            if pending is None or pending.future.done():
                raise WireError("inactive_request")
            method = frame["method"]
            if method == "read_artifact" and pending.method in ("send", "transcribe", "command"):
                result = self.artifacts.read(parent_id, frame["params"])
            elif method in ("upload_begin", "upload_chunk", "upload_finish") and pending.method in ("send", "command", "synthesize"):
                result = getattr(self.artifacts, method)(parent_id, frame["params"])
            else:
                raise WireError("unsupported_method")
            await self.emit({"type": "result", "request_id": host_id, "result": result})
        except (WireError, ValueError, TypeError, OSError):
            await self.emit({"type": "error", "request_id": host_id, "error": {"code": "artifact_rejected"}})

    def eof(self):
        self._closed = True
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(HostClosed())

    def close(self):
        self.eof()
        self.artifacts.close()


def configure(frame, transport):
    object_fields(frame, {"protocol", "type", "request_id", "provider", "binding_id", "config"},
                  {"protocol", "type", "request_id", "provider", "binding_id", "config"})
    identifier(frame["request_id"]); identifier(frame["binding_id"])
    provider = frame["provider"]
    if frame["type"] != "configure" or not isinstance(provider, str) or provider not in _CONFIG:
        raise WireError("invalid_configuration")
    required, allowed = _CONFIG[provider]
    config = object_fields(frame["config"], allowed, required)
    for name, value in config.items():
        if name in ("live", "streaming", "dm_only", "members_intent"):
            if type(value) is not bool:
                raise WireError("invalid_configuration")
        elif name == "context_messages":
            if type(value) is not int or not 0 <= value <= 100:
                raise WireError("invalid_configuration")
        elif name.startswith("allowed_") or name == "listen_channels":
            if not isinstance(value, list) or len(value) > 1000 or any(type(v) not in (str, int) for v in value):
                raise WireError("invalid_configuration")
        elif value is not None and (not isinstance(value, str) or len(value.encode()) > 16384):
            raise WireError("invalid_configuration")
    if any(not isinstance(config[name], str) or not config[name] for name in required):
        raise WireError("invalid_configuration")
    cls = getattr(import_module(f".{provider}", __package__), provider.capitalize() + "Bridge" if provider != "whatsapp" else "WhatsAppBridge")
    return cls(transport=transport, binding_id=frame["binding_id"], **config)


def describe():
    return {"protocol": PROTOCOL, "type": "description", "package_version": __version__, "providers": list(PROVIDERS),
            "max_line_bytes": MAX_LINE, "max_pending": MAX_PENDING,
            "max_chunk_bytes": MAX_CHUNK, "max_artifact_bytes": MAX_ARTIFACT,
            "methods": ["start", "authorize_context", "authorize_delivery", "send", "command", "transcribe", "synthesize", "stop"],
            "artifact_methods": ["read_artifact", "upload_begin", "upload_chunk", "upload_finish"]}


async def serve(read_line, write_line, *, factory=configure):
    """Run a single binding. Injectable byte IO is useful for host integration.

    EOF shuts down only this bridge and its pending requests. It never owns or
    closes the host runtime. Invalid frames fail closed; no automatic replay.
    """
    transport = bridge = task = None
    try:
        first = decode_line(await read_line())
        transport = StdioBridgeTransport(write_line, binding_id=first.get("binding_id"), provider=first.get("provider"))
        bridge = factory(first, transport)
        await transport.emit({"type": "configured", "request_id": identifier(first["request_id"]),
                              "provider": transport.provider, "binding_id": transport.binding_id,
                              "providers": list(PROVIDERS)})
        task = asyncio.create_task(bridge.start())
        while True:
            line = await read_line()
            if line == b"":
                break
            await transport.receive(decode_line(line))
        return 0
    except (Exception, asyncio.CancelledError) as error:
        # Deliberately omit exception text, payloads, argv and credentials.
        logging.getLogger(__name__).warning("channel IPC stopped (%s)", type(error).__name__)
        return 1
    finally:
        if transport is not None:
            transport.eof()
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if bridge is not None:
            with contextlib.suppress(Exception):
                await bridge.stop()
        if transport is not None:
            transport.close()


async def _stdio(input_stream, output_stream):
    # A daemon reader avoids platform-specific pipe event loops. At most two
    # bounded lines are queued; EOF/cancellation never joins a blocked stdin.
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue(maxsize=2)
    def reader():
        try:
            while True:
                line = input_stream.readline(MAX_LINE + 1)
                future = asyncio.run_coroutine_threadsafe(queue.put(line), loop)
                future.result()
                if not line or len(line) > MAX_LINE:
                    return
        except Exception:
            with contextlib.suppress(Exception):
                asyncio.run_coroutine_threadsafe(queue.put(b""), loop)
    threading.Thread(target=reader, name="channel-ipc-input", daemon=True).start()
    async def write(line):
        output_stream.write(line); output_stream.flush()
    return await serve(queue.get, write)


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args == ["--describe"]:
        sys.stdout.buffer.write(encode_line(describe())); sys.stdout.buffer.flush()
        return 0
    if args:
        sys.stderr.write("unsupported channel runner arguments\n")
        return 2
    output = sys.stdout.buffer
    # SDKs or third-party imports must never print arbitrary text on the wire.
    sys.stdout = sys.stderr
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    try:
        return asyncio.run(_stdio(sys.stdin.buffer, output))
    except (Exception, KeyboardInterrupt):
        sys.stderr.write("channel runner stopped\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
