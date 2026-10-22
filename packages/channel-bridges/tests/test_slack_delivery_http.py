"""Complete SDK delivery over real loopback HTTP, without provider traffic."""
import asyncio
import base64
import hashlib
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from openagent_channel_bridges.slack import SlackBridge
from openagent_channel_bridges.stdio import StdioBridgeTransport
from openagent_channel_bridges.wire import PROTOCOL, decode_line


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["complete", "empty", "multi-chunk", "early-response", "http-error", "revoke-after-body", "mutate-after-body"])
async def test_full_slack_ipc_delivery_waits_for_bytes_not_generator_eof(mode, monkeypatch):
    from openagent_channel_bridges.media import MEDIA_CHUNK_BYTES
    data = b"" if mode == "empty" else b"x" * (MEDIA_CHUNK_BYTES * 3 + 7) if mode in {"multi-chunk", "early-response"} else b"diagnostic 57"
    state = {"allowed": True, "received": [], "slots": [], "completed": []}

    async def receiver(request):
        state["received"].append(await request.content.read(1) if mode == "early-response" else await request.read())
        if mode == "mutate-after-body":
            Path(state["output_path"]).write_bytes(b"changed after upload")
        if mode == "revoke-after-body":
            state["allowed"] = False
        return web.Response(text="OK", status=500 if mode == "http-error" else 200)

    app = web.Application()
    app.router.add_post("/upload", receiver)
    server = TestServer(app)
    await server.start_server()
    http = ClientSession()

    class ProviderClient:
        async def auth_test(self):
            # Normal fresh provider/host authorization yields to the event
            # loop after the final request bytes, before generator exhaustion.
            await asyncio.sleep(.01)
            return {"ok": True, "user_id": "BOT", "team_id": "T1"}

        async def conversations_members(self, **kwargs):
            await asyncio.sleep(.01)
            return {"ok": True, "members": ["BOT", "U1"]}

        async def chat_postMessage(self, **kwargs):
            return {"ok": True, "ts": "10.2"}

        async def files_getUploadURLExternal(self, **kwargs):
            state["slots"].append(kwargs)
            return {"ok": True, "file_id": "F1", "upload_url": "https://files.slack.com/upload/test"}

        async def files_completeUploadExternal(self, **kwargs):
            state["completed"].append(kwargs)
            return {"ok": True}

    class LocalUploadSession:
        def post(self, url, **kwargs):
            assert url == "https://files.slack.com/upload/test"
            assert "Authorization" not in kwargs["headers"]
            assert not kwargs["allow_redirects"]
            # Only the test HTTP transport changes destination. The published
            # Slack client, orchestration, wire DTO and artifact store are real.
            return http.post(server.make_url("/upload"), **kwargs)

    queue = asyncio.Queue()

    async def write(line):
        await queue.put(decode_line(line))

    transport = StdioBridgeTransport(write, binding_id="binding", provider="slack")

    def frame(kind, request_id, **values):
        return {"protocol": PROTOCOL, "type": kind, "request_id": request_id, **values}

    async def artifact_rpc(parent, method, params):
        await transport.receive(frame("request", method, parent_request_id=parent, method=method, params=params))
        reply = await queue.get()
        assert reply["type"] == "result"
        return reply["result"]

    async def host():
        while True:
            request = await queue.get()
            request_id, method = request["request_id"], request["method"]
            if method == "start":
                result = {"api_version": 1, "commands": [], "input_media": [], "output_media": ["file"], "progress_kinds": []}
            elif method in {"authorize_context", "authorize_delivery"}:
                result = state["allowed"]
            elif method == "send":
                ref = (await artifact_rpc(request_id, "upload_begin", {
                    "kind": "file", "filename": "report.txt", "mime_type": "text/plain",
                    "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                }))["reader_ref"]
                for offset in range(0, len(data), 65536):
                    await artifact_rpc(request_id, "upload_chunk", {"reader_ref": ref, "offset": offset,
                        "data_base64": base64.b64encode(data[offset:offset+65536]).decode()})
                await artifact_rpc(request_id, "upload_finish", {"reader_ref": ref})
                result = {"api_version": 1, "status": "completed", "parts": [
                    {"text": "Report ready"}, {"attachment": {"reader_ref": ref}},
                ]}
            elif method == "stop":
                result = None
            else:
                raise AssertionError(method)
            await transport.receive(frame("result", request_id, result=result))
            if method == "stop":
                return

    bridge = SlackBridge(bot_token="fixture-not-a-credential", transport=transport,
        binding_id="binding", allowed_users=["U1"], listen_channels=["C1"], context_messages=0, live=False)
    bridge._audio_session = AsyncMock(return_value=LocalUploadSession())
    original_send = bridge.send_attachment
    async def observe_file(target, attachment):
        state["output_path"] = attachment.path
        return await original_send(target, attachment)
    bridge.send_attachment = observe_file
    descriptors = []
    original_open = os.open
    def observe_open(path, *args, **kwargs):
        fd = original_open(path, *args, **kwargs)
        if str(path) == state.get("output_path"):
            info = os.fstat(fd)
            descriptors.append((fd, info.st_dev, info.st_ino))
        return fd
    monkeypatch.setattr(os, "open", observe_open)
    worker = asyncio.create_task(host())
    try:
        await asyncio.wait_for(bridge.handle_event({"type": "app_mention", "user": "U1",
            "channel": "C1", "text": "<@BOT> report", "ts": "10.1"}, ProviderClient(),
            account_id="T1", event_id="E1"), 5)
        assert state["received"] == [data[:1] if mode == "early-response" else data]
        assert state["slots"] == [{"filename": "report.txt", "length": len(data)}]
        if mode in {"complete", "empty", "multi-chunk"}:
            assert state["completed"] == [{"files": [{"id": "F1", "title": "report.txt"}],
                "channel_id": "C1"}]
        else:
            assert state["completed"] == []
        assert all(not Path(path).exists() for path in transport.artifacts._retained)
        assert descriptors
        for fd, device, inode in descriptors:
            try:
                current = os.fstat(fd)
            except OSError:
                continue
            # A zero-byte source closes before connecting; the socket may
            # reuse its descriptor number without retaining the file itself.
            assert (current.st_dev, current.st_ino) != (device, inode)
    finally:
        try:
            await asyncio.wait_for(bridge.stop(), 2)
            await asyncio.wait_for(worker, 2)
        finally:
            transport.close()
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
            await http.close()
            await server.close()
