"""Read-only observer health, resnapshot and authorization over real WebSockets."""

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest
from aiohttp import ClientSession, WSMsgType, web
from aiohttp.test_utils import TestServer

from openagent_server.gateway.collaboration_hub import SharedAgentHub


@asynccontextmanager
async def observer():
    hub = SharedAgentHub()
    allowed = {"chat", "child"}

    async def authorize(_actor, targets):
        if "device" in allowed:
            raise PermissionError("revoked")
        return {"userId": "user:viewer", "name": "Viewer",
                "allowed": [target for target in targets if target["id"] in allowed]}

    @web.middleware
    async def identity(request, handler):
        request["device_cert"] = object()
        return await handler(request)

    app = web.Application(middlewares=[identity])
    app.router.add_get("/ws/collaboration", hub.handle)
    with patch("openagent_server.gateway.collaboration_hub.authorize", authorize):
        async with TestServer(app) as server, ClientSession() as http:
            async with http.ws_connect(server.make_url("/ws/collaboration")) as ws:
                greeting = await ws.receive_json()
                assert greeting["shared"] and greeting["heartbeat"]
                await ws.send_json({"type": "observe", "sessions": ["chat"]})
                try:
                    yield hub, ws, allowed
                finally:
                    await hub.close()


async def until(ws, kind):
    async with asyncio.timeout(3):
        while True:
            frame = await ws.receive_json()
            if frame["type"] == kind:
                return frame


@pytest.mark.asyncio
async def test_heartbeat_rebuilds_unchanged_snapshot_without_finishing_long_tool():
    async with observer() as (hub, ws, _allowed):
        hub.begin("chat", "Save notes", run_id="request")
        hub.publish({"type": "status", "session_id": "chat", "text":
                     '{"tool_name":"vault_write_note","tool_call_id":"save"}'})
        original = await until(ws, "shared_state")
        await ws.send_json({"type": "ping", "id": 1})
        refreshed = await until(ws, "shared_state")
        assert refreshed == original
        assert refreshed["turns"][0]["active"] is True
        assert "result" not in refreshed["turns"][0]["tools"][0]["toolInfo"]
        assert (await until(ws, "pong"))["id"] == 1
        assert len(hub.sessions["chat"]["turns"]) == 1


@pytest.mark.asyncio
async def test_refresh_rechecks_child_and_parent_authorization_before_pong():
    async with observer() as (hub, ws, allowed):
        hub.begin("chat", "Investigate", run_id="request")
        hub.publish({"type": "status", "session_id": "chat", "text":
                     '{"tool_name":"delegate_task","tool_call_id":"delegate","child_session_id":"child"}'})
        original = await until(ws, "shared_state")
        assert original["turns"][0]["tools"][0]["toolInfo"]["child_session_id"] == "child"
        allowed.remove("child")
        await ws.send_json({"type": "ping", "id": 2})
        refreshed = await until(ws, "shared_state")
        assert "child_session_id" not in refreshed["turns"][0]["tools"][0]["toolInfo"]
        assert refreshed["revision"] > original["revision"]
        await until(ws, "pong")
        await ws.send_json({"type": "ping", "id": 20})
        replay = await until(ws, "shared_state")
        assert replay == refreshed  # preserve observer-local ACL revision offsets
        await until(ws, "pong")
        allowed.add("child")
        await ws.send_json({"type": "ping", "id": 21})
        regrant = await until(ws, "shared_state")
        assert regrant["revision"] > replay["revision"]
        assert regrant["turns"][0]["tools"][0]["toolInfo"]["child_session_id"] == "child"
        await until(ws, "pong")
        allowed.remove("chat")
        await ws.send_json({"type": "ping", "id": 3})
        assert (await until(ws, "shared_revoked"))["session_id"] == "chat"
        assert (await until(ws, "pong"))["id"] == 3


@pytest.mark.asyncio
async def test_revoked_device_cannot_receive_health_ack_or_cached_snapshot():
    async with observer() as (hub, ws, allowed):
        hub.begin("chat", "Private", run_id="request")
        await until(ws, "shared_state")
        allowed.add("device")
        await ws.send_json({"type": "ping", "id": 4})
        assert (await until(ws, "auth_error"))["text"]
        assert (await ws.receive()).type in {WSMsgType.CLOSE, WSMsgType.CLOSED}


@pytest.mark.asyncio
@pytest.mark.parametrize("nonce", [True, "1", -1, 2**53])
async def test_invalid_heartbeat_closes_only_the_reader(nonce):
    async with observer() as (hub, ws, _allowed):
        hub.begin("chat", "Work", run_id="request")
        await until(ws, "shared_state")
        await ws.send_json({"type": "ping", "id": nonce})
        assert (await ws.receive()).type == WSMsgType.CLOSE
        assert ws.close_code == 1008
        assert hub.sessions["chat"]["turns"][0]["active"] is True
