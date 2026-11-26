"""A signed standalone client can recover its own original after a document read."""

import ast
import asyncio
from contextlib import AsyncExitStack
from hashlib import sha256
import json
from unittest.mock import AsyncMock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
import pytest

from openagent_core.engine import Agent, MemoryDB
from openagent_core.mcp.pool import MCPPool
from openagent_core.models import discovery
from openagent_core.models.dispatcher import ModelDispatcher
from openagent_core.models.native_provider import NativeProvider
from openagent_core.models.providers.base import Model
from openagent_core.models.providers.response import ModelResponse
from openagent_core.runtime import current_run_id
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_identity.auth import middleware
from openagent_identity.auth.device_cert import issue_cert
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.identity import Identity
from openagent_identity.state import NetworkState
from openagent_server.bootstrap import discovery_presentation
from openagent_server.gateway.api import operational
from openagent_server.gateway.server import Gateway
from openagent_server.runtime_service import NativeRuntimeService, bind_runtime_identity


async def _send_turn(client, ingress, run, session, attachments=()):
    body = {"request_id": run, "session_id": session, "delivery": "queue",
            "message": "Check " + run, "attachments": list(attachments)}
    async with asyncio.timeout(15):
        if ingress == "app":
            async with client.post("/api/collaboration/turns", json=body) as response:
                assert response.status == 200, await response.text()
                reply = await response.json()
                assert not reply["errored"], reply
            return
        request = {"run_id": run, "session_id": session, "idempotency_key": run,
                   "input": body["message"], "attachments": list(attachments), "model_ref": "fixture:fixture"}
        async with client.post("/api/runtime/runs", json=request) as response:
            assert response.status == 202, await response.text()
        while True:
            async with client.get("/api/runtime/runs/" + run) as response:
                assert response.status == 200, await response.text()
                record = await response.json()
            if record["status"] not in {"queued", "running", "accepted", "pending"}:
                assert record["status"] == "success", record
                return
            await asyncio.sleep(.01)


async def _reopen_outputs(client, ingress, history):
    if ingress == "app":
        async with client.get(history) as response:
            assert response.status == 200, await response.text()
            messages = (await response.json())["messages"]
        replies = [m for m in messages if m["role"] == "assistant" and m["attachments"]]
        assert [reply["run_id"] for reply in replies] == ["original", "again"]
        return [reply["attachments"] for reply in replies]
    outputs = []
    for run in ("original", "again"):
        async with client.get(f"/api/runtime/runs/{run}/events") as response:
            assert response.status == 200, await response.text()
            events = (await response.json())["events"]
        terminal, = [e["payload"] for e in events if e["kind"] == "run.stream"
                     and e["payload"].get("kind") == "done"]
        outputs.append(terminal["final_answer"]["attachments"])
    return outputs


@pytest.mark.asyncio
@pytest.mark.parametrize("ingress", ["app", "runtime"])
async def test_certified_owner_resends_original_attachment_after_reading_a_note(tmp_path, monkeypatch, ingress):
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    monkeypatch.setenv("LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS", "True")
    content = b"item,count\nblue,7\n"
    filename = "fixture-stock.csv"
    note = "Synthetic filing guidance."
    derivative = tmp_path / "derived.txt"
    derivative.write_text(note)
    receipts = {}
    entered = asyncio.Event()
    resume = asyncio.Event()
    original_id = None

    def call(source, name, args):
        return ModelResponse(role="assistant", tool_calls=[{
            "id": "call-" + name, "type": "function", "function": {
                "name": "tool_search_call_named_tool",
                "arguments": json.dumps({"source_ref": source, "tool_name": name, "args": args}),
            },
        }])

    class FixtureModel(Model):
        def invoke(self, *args, **kwargs):
            raise AssertionError("Unexpected synchronous model call")

        invoke_stream = invoke

        async def ainvoke(self, *, messages, **kwargs):
            run = current_run_id()
            if run not in {"original", "again", "other"}:
                return ModelResponse(role="assistant", content="Ready")
            seen = receipts.setdefault(run, [])
            if messages[-1].role == "tool":
                seen.append(str(messages[-1].content))
            if not seen:
                # A real provider wait exposes the interval between admission
                # and the durable projection of the first human message.
                if run == "original":
                    entered.set()
                    await resume.wait()
                return call("vault", "vault_read_note", {"path": "filing.md"})
            if run == "other":
                if len(seen) == 1:
                    return call("attachments", "find_session_attachments", {"query": filename})
                if len(seen) == 2:
                    return call("attachments", "resend_session_attachment", {"artifact_id": original_id})
                return ModelResponse(role="assistant", content="Checked")
            if len(seen) == 1:
                return call("attachments", "send_file_to_user", {"path": str(derivative)})
            if len(seen) == 2:
                return call("attachments", "find_session_attachments", {"query": filename})
            if seen[-1].startswith("{"):
                result = ast.literal_eval(seen[-1])
                if len(seen) == 3 and result.get("attachments"):
                    ref, = result["attachments"]
                    return call("attachments", "resend_session_attachment", {"artifact_id": ref["artifact_id"]})
                if len(seen) == 4 and result.get("ok"):
                    return ModelResponse(role="assistant", content="Here is the original. " + result["marker"])
            return ModelResponse(role="assistant", content="No file returned")

        async def ainvoke_stream(self, **kwargs):
            yield await self.ainvoke(**kwargs)

        def _parse_provider_response(self, response, **kwargs):
            return response

        _parse_provider_response_delta = _parse_provider_response

    def build_model(provider):
        return FixtureModel(id="fixture", provider="fixture")

    monkeypatch.setattr(NativeProvider, "build_runtime_model", build_model)
    monkeypatch.setattr(NativeProvider, "_build_runtime_model", build_model)
    monkeypatch.setattr(discovery, "_fetch_openrouter_catalog", AsyncMock(return_value=[]))
    async with AsyncExitStack() as stack:
        db = MemoryDB(str(tmp_path / "state.sqlite"))
        await db.connect()
        stack.push_async_callback(db.close)
        conn = await db._ensure_connected()
        await ensure_custom_views_storage(conn, app_version="test")
        store = CoordinatorStore(db)
        await store.set_network_role(role="coordinator", network_id="network", name="Fixture")
        state = await NetworkState.from_db(db=db, identity_path=tmp_path / "identity.key")
        peers = {}
        for handle in ("owner", "peer"):
            device = Identity.generate()
            await store.create_user(handle=handle, pake_record=b"fixture", pake_algo="fixture")
            await store.add_device(device_pubkey=device.public_bytes, user_handle=handle)
            wire = issue_cert(coordinator_key=state.identity._private_key, handle=handle,
                              device_pubkey=device.public_bytes, network_id="network")
            peers[handle] = (device, wire)
        await store.register_agent(handle="agent", node_id=state.identity.public_hex, owner_handle="owner")
        identity = "owner"
        # Loopback supplies the two transport-owned Iroh facts. The real
        # middleware verifies the certificate, roster and device pairing.
        monkeypatch.setattr(middleware, "current_device_cert_wire", lambda: peers[identity][1])
        monkeypatch.setattr(middleware, "current_peer_node_id", lambda: peers[identity][0].public_hex)
        provider = await db.upsert_provider(name="fixture", framework="api-based", enabled=True)
        await db.upsert_model(provider_id=provider, model="fixture", enabled=True, is_classifier=True)
        config = {"memory": {"vault": {"backend": "documents"}}, "server_host_tools": {"tools": ["filesystem"]}}
        pool = MCPPool.from_config([{"builtin": "tool-search"}], include_defaults=False)
        pool.configure_discovery(discovery_presentation(config))
        agent = Agent(name="agent", config=config, memory=db, mcp_pool=pool,
                      model=ModelDispatcher(await db.materialise_providers_config(enabled_only=True)))
        agent.product_environment = {}
        stack.push_async_callback(agent.shutdown)
        gateway = Gateway(agent, state)
        service = gateway.runtime_service = NativeRuntimeService(gateway, agent)
        await service.start()
        stack.push_async_callback(service.close)
        gateway.agent = service.facade
        app = web.Application(middlewares=[middleware.make_auth_middleware(state.auth_state), bind_runtime_identity])
        app["gateway"] = gateway
        gateway._register_routes(app)
        stack.push_async_callback(gateway._collaboration.close)
        operational.start_background_maintenance(gateway)
        stack.push_async_callback(operational.stop_background_maintenance, gateway)
        await asyncio.wait_for(gateway._operational_ready_event.wait(), 10)
        server = await stack.enter_async_context(TestServer(app))

        history = "/api/sessions/chat/messages"
        async with aiohttp.ClientSession(base_url=server.make_url("/")) as client:
            async with client.patch("/api/sessions/chat", json={"title": "Stock report"}) as response:
                assert response.status == 200, await response.text()
            async with client.put("/api/vault/notes/filing.md", json={"content": note}) as response:
                assert response.status == 200, await response.text()
            form = aiohttp.FormData()
            form.add_field("file", content, filename=filename, content_type="text/csv")
            async with client.post("/api/upload", params={"session_id": "chat"}, data=form) as response:
                assert response.status == 200, await response.text()
                original = await response.json()
            original_id = original["artifact_id"]
            uploaded = {key: original[key] for key in ("artifact_id", "artifact_link_id", "filename", "mime_type")}
            pending = asyncio.create_task(_send_turn(client, ingress, "original", "chat", [uploaded]))
            try:
                await asyncio.wait_for(entered.wait(), 8)
                admission = await (await conn.execute(
                    "SELECT json_extract(metadata_json, '$.attachments[0].artifact_id') FROM session_runs WHERE id='original'"
                )).fetchone()
                assert admission[0] == original_id
                links = await (await conn.execute(
                    "SELECT resource_type FROM artifact_links WHERE artifact_id=? AND relation='input_attachment'",
                    (original_id,))).fetchall()
                assert {row[0] for row in links} == {"session"}
            finally:
                resume.set()
                await pending
            await _send_turn(client, ingress, "again", "chat")
            for run in ("original", "again"):
                read, denied, found, *sent = receipts[run]
                assert note in read
                assert "cannot retain document-derived content" in denied
                assert original_id in found, found
                assert len(sent) == 1 and original_id in sent[0]

        # Reopen the corresponding public history in a fresh client. The App
        # reads chat messages; direct runtime clients replay the run journal.
        async with aiohttp.ClientSession(base_url=server.make_url("/")) as client:
            outputs = await _reopen_outputs(client, ingress, history)
            for attachments in outputs:
                ref, = attachments
                assert ref["artifact_id"] == original_id and ref["filename"] == filename
                async with client.get(ref["url"]) as response:
                    assert response.status == 200
                    assert await response.read() == content
                    assert ref["sha256"] == sha256(content).hexdigest()
                    assert response.headers["ETag"] == '"sha256-' + ref["sha256"] + '"'
            async with client.patch("/api/sessions/private-chat", json={"title": "Private chat"}) as response:
                assert response.status == 200, await response.text()
            await _send_turn(client, ingress, "other", "private-chat")
            read, listed, denied = receipts["other"]
            assert note in read
            assert original_id not in listed and filename not in listed
            assert "not available in this session" in denied
            identity = "peer"
            for url in (history, ref["url"]):
                async with client.get(url) as response:
                    assert response.status == 404
                    message = await response.text()
                    assert original_id not in message and filename not in message
            identity = "owner"
            device = peers[identity][0].public_bytes
            assert await store.revoke_device(device)
            state.auth_state.revoke(device)
            async with client.get(ref["url"]) as response:
                assert response.status == 401
