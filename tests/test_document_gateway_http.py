"""Standalone document retention over signed HTTP and live WebSocket connections."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from openagent_core.memory.db import MemoryDB
from openagent_core.runtime import current_execution_context
from openagent_identity.auth.device_cert import issue_cert
from openagent_identity.auth.middleware import make_auth_middleware
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.identity import Identity
from openagent_identity.state import NetworkState
from openagent_server.gateway.server import Gateway
from openagent_server.runtime_service import NativeRuntimeService, bind_runtime_identity


class DocumentGatewayHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        db = MemoryDB(str(root / "state.sqlite"))
        await db.connect()
        self.addAsyncCleanup(db.close)
        from openagent_dashboards.migration import ensure_custom_views_storage
        await ensure_custom_views_storage(await db._ensure_connected(), app_version="test")
        store = CoordinatorStore(db)
        await store.set_network_role(role="coordinator", network_id="network", name="Fixture")
        state = await NetworkState.from_db(db=db, identity_path=root / "identity.key")
        await store.create_user(handle="alice", pake_record=b"fixture", pake_algo="fixture")
        await store.register_agent(handle="agent", node_id=state.identity.public_hex, owner_handle="alice")
        device = Identity.generate()
        await store.add_device(device_pubkey=device.public_bytes, user_handle="alice")
        wire = issue_cert(coordinator_key=state.identity._private_key, handle="alice",
                          device_pubkey=device.public_bytes, network_id="network")
        # TestServer uses a loopback TCP socket. Supply the same two
        # transport-owned values as IrohSite, never an HTTP identity header.
        for name, value in (("current_device_cert_wire", wire), ("current_peer_node_id", device.public_hex)):
            self.enterContext(patch("openagent_identity.auth.middleware." + name, return_value=value))

        from openagent_core.capabilities import ToolDefinition

        class NoteApp:
            uri = "ui://fixture/note"

            async def discover(self, context):
                return [ToolDefinition("show", "Read the fixture", {}, metadata={"ui": {"resourceUri": self.uri}})]

            async def call_tool(self, name, arguments, context):
                note = await service.document_vault.read(context, "fixture.md")
                return {"content": [{"type": "text", "text": note["content"]}]}

            async def read_resource(self, uri, context):
                return {"contents": [{"uri": uri, "mimeType": "text/html;profile=mcp-app", "text": "<p>Note viewer</p>"}]}

        test = self
        self.held = asyncio.Event()
        self.release = asyncio.Event()

        class Agent:
            name = "agent"
            config = {"memory": {"vault": {"backend": "documents"}}}
            capability_pool = None
            memory_db = db
            product_environment = {}

            async def initialize(self):
                pass

            def set_capability_pool(self, pool):
                self.capability_pool = pool

            async def run_stream(self, message, **kwargs):
                context = current_execution_context()
                if message == "read the note":
                    catalog = service.runtime.capabilities
                    test.tool_ref = await catalog.resolve_tool_ref("fixture-app", "show", context)
                    value = await catalog.call_tool(test.tool_ref, {}, context, call_id="show-note")
                    text = value["content"][0]["text"]
                    await db.append_session_event(context.session_id, "run.completed", {"text": text})
                elif message == "forget the note":
                    await service.document_vault.forget(context, "fixture.md", expected_revision=1)
                    text = "forget complete"
                else:
                    if message == "hold":
                        test.held.set()
                        await test.release.wait()
                    text = "independent reply"
                yield {"kind": "done", "text": text, "final_answer": {"text": text}}

        agent = Agent()
        gateway = self.gateway = Gateway(agent, state)
        gateway.runtime_service = service = NativeRuntimeService(gateway, agent)
        self.service = service
        await service.start()
        self.addAsyncCleanup(service.close)
        app_source = NoteApp()
        service.runtime.capabilities.register("fixture-app", app_source, app_source, target_label="Fixture")
        gateway.agent = service.facade
        app = web.Application(middlewares=[make_auth_middleware(state.auth_state), bind_runtime_identity])
        app["gateway"] = gateway
        gateway._register_routes(app)
        from openagent_server.gateway.api import operational
        operational.start_background_maintenance(gateway)
        self.addAsyncCleanup(operational.stop_background_maintenance, gateway)
        await asyncio.wait_for(gateway._operational_ready_event.wait(), 10)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def request(self, method, path, status=200, **kwargs):
        async with asyncio.timeout(8):
            while True:
                async with self.client.request(method, path, **kwargs) as res:
                    body = await res.text()
                    if res.status == 503 and status == 200 and '"warming"' in body:
                        await asyncio.sleep(.05)
                        continue
                    self.assertEqual(res.status, status, (path, body))
                    return body

    async def turn(self, run, session, message):
        await self.request("POST", "/api/runtime/runs", 202, json={
            "run_id": run, "idempotency_key": run, "input": message, "session_id": session})
        for _ in range(150):
            result = json.loads(await self.request("GET", "/api/runtime/runs/" + run))
            if result["status"] in {"success", "failed", "cancelled", "interrupted"}:
                self.assertEqual(result["status"], "success", result)
                return result
            await asyncio.sleep(.02)
        self.fail("Run did not complete")

    async def frame(self, socket, kind, *, marker="", absent=None):
        async with asyncio.timeout(5):
            while True:
                frame = await socket.receive_json()
                if absent is not None:
                    self.assertNotIn(absent, str(frame))
                if frame.get("type") == kind and marker in str(frame):
                    return frame

    async def test_note_retention(self):
        marker = "synthetic cobalt orchid"
        session = "saved-session"
        await self.request("PUT", "/api/vault/notes/fixture.md", json={"content": marker})
        await self.gateway.agent.memory_db.upsert_session(session, client_id="alice", title="Fixture conversation", origin="chat")
        await self.turn("derived", session, "read the note")
        run_paths = ["/api/runtime/runs/derived", "/api/runtime/runs/derived/events"]
        history_paths = [f"/api/sessions/{session}/{key}" for key in ("runs", "events", "messages", "turns")]
        for path in run_paths + history_paths:
            body = await self.request("GET", path)
            self.assertIn("read the note" if path.endswith("/turns") else marker, body, path)
        await self.request("POST", "/api/runtime/runs", 202, json={
            "run_id": "held", "session_id": session, "idempotency_key": "held", "input": "hold"})
        await asyncio.wait_for(self.held.wait(), 5)
        self.addCleanup(self.release.set)
        self.assertTrue(json.loads(await self.request("GET", "/api/history/active"))["active"])
        async with asyncio.timeout(5):
            while session not in await self.request("GET", "/api/history"):
                await asyncio.sleep(.1)
        control = "control-session"
        await self.gateway.agent.memory_db.upsert_session(control, client_id="alice",
            title="cobalt independent conversation", origin="chat")
        await self.turn("plain", control, "continue")
        search_query = {"query": "cobalt", "scopes": ["chats", "tools"]}
        async with asyncio.timeout(8):
            while True:
                search = await self.request("POST", "/api/search", json=search_query)
                if control in search:
                    break
                await asyncio.sleep(.1)
        self.assertNotIn(session, search)
        self.assertNotIn(marker, search)
        apps = f"/api/sessions/{session}/mcp-apps"
        saved = {"tool_ref": self.tool_ref, "tool_call_id": "show-note"}
        opened = json.loads(await self.request("POST", apps + "/open", json=saved))
        self.assertIn(marker, str(opened["toolResult"]))
        handle = f"{apps}/{opened['handle']}/request"
        authorize = {"method": "authorize", "params": {}}
        self.assertIn(marker, await self.request("POST", handle, json=authorize))
        chat = await self.client.ws_connect("/ws")
        self.addAsyncCleanup(chat.close)
        await self.frame(chat, "auth_ok")
        collaboration = await self.client.ws_connect("/ws/collaboration")
        self.addAsyncCleanup(collaboration.close)
        await self.frame(collaboration, "auth_ok")
        observe = {"type": "observe", "sessions": [session]}
        await collaboration.send_json(observe)
        delta = {"type": "delta", "session_id": session, "text": marker}
        self.gateway._record_live_output(session, delta, owner="alice")
        await self.gateway.broadcast(delta)
        self.assertIn(marker, str(await self.frame(chat, "delta")))
        self.assertIn(marker, str(await self.frame(collaboration, "shared_state", marker=marker)))
        await self.turn("forget", "management", "forget the note")
        for path in run_paths:
            self.assertNotIn(marker, await self.request("GET", path, 403))
        for path in history_paths:
            self.assertNotIn(marker, await self.request("GET", path, 404))
        self.assertNotIn(marker, await self.request("POST", apps + "/open", 403, json=saved))
        self.assertNotIn(marker, await self.request("POST", handle, 403, json=authorize))
        heartbeat = {"method": "authorize", "params": {"display_received": True}}
        self.assertNotIn(marker, await self.request("POST", handle, 403, json=heartbeat))
        self.assertFalse(json.loads(await self.request("GET", "/api/history/active"))["active"])
        self.release.set()
        self.assertNotIn(session, await self.request("GET", "/api/history"))
        results = await self.request("POST", "/api/search", json=search_query)
        self.assertNotIn(session, results)
        self.assertNotIn(marker, results)
        self.assertIn(control, results)
        await self.gateway.broadcast(delta)
        await self.gateway.broadcast({"type": "ping", "id": "flush"})
        await self.frame(chat, "ping", absent=marker)
        await collaboration.send_json(observe)
        await self.frame(collaboration, "shared_revoked", absent=marker)

        async def domain_policy(request, targets, permission):
            return {"userId": "alice", "name": "alice", "allowed": targets}

        self.gateway.collaboration_authorizer = domain_policy
        await collaboration.send_json(observe)
        await self.frame(collaboration, "shared_revoked", absent=marker)
        await self.turn("next", session, "continue")
        self.assertIn("independent reply", await self.request("GET", "/api/runtime/runs/next/events"))
