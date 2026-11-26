"""The standalone daemon rechecks inherited document history on its certified bridge socket."""
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace

from aiohttp import web
import pytest

from openagent_core.contracts import PrincipalRef, ResourceRef, RunRequest
from openagent_core.memory.db import MemoryDB
from openagent_core.workspace_administration import SessionInspection
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_identity.auth.device_cert import verify_cert
from openagent_identity.auth.middleware import make_auth_middleware
from openagent_identity.bridge_session import BridgeSession
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.state import NetworkState
from openagent_identity.transport.aiohttp_iroh_site import IrohSite
from openagent_server.bridges.telegram import TelegramBridge
from openagent_server.gateway.server import Gateway
from openagent_server.runtime_service import NativeRuntimeService, bind_runtime_identity


@asynccontextmanager
async def certified_bridge(tmp_path, monkeypatch, build_agent=None):
    monkeypatch.setenv('OPENAGENT_AGENT_DIR', str(tmp_path))
    db = MemoryDB(str(tmp_path / 'state.sqlite'))
    actor = '100'
    legacy = {'version': 1, 'binding_id': 'telegram', 'account_id': '900', 'actor_ids': [actor]}
    channel = {'token': '900:fixture', 'allowed_users': [actor], 'legacy_private_sessions': legacy}
    config = {'memory': {'vault': {'backend': 'documents'}}, 'channels': {'telegram': channel},
              'runtime_tool_audiences': {'vault_owner_channels': {'telegram': [actor]}}}
    class FixtureAgent(SimpleNamespace):
        def set_capability_pool(self, pool):
            self.capability_pool = pool

        async def initialize(self):
            pass

    async with AsyncExitStack() as stack:
        await db.connect()
        stack.push_async_callback(db.close)
        if build_agent is None:
            agent = FixtureAgent(name='agent', memory_db=db, config=config, capability_pool=None, product_environment={}, model=None)
        else:
            agent = await build_agent(db, config)
            stack.push_async_callback(agent.shutdown)
        conn = await db._ensure_connected()
        await ensure_custom_views_storage(conn, app_version='test')
        coordinator = CoordinatorStore(db)
        await coordinator.set_network_role(role='coordinator', network_id='fixture', name='Fixture')
        state = await NetworkState.from_db(db=db, identity_path=tmp_path / 'identity.key')
        await coordinator.create_user(handle='owner', pake_record=b'fixture', pake_algo='fixture')
        await coordinator.register_agent(handle='agent', node_id=state.identity.public_hex, owner_handle='owner')

        gateway = Gateway(agent, state)
        service = gateway.runtime_service = NativeRuntimeService(gateway, agent)
        await service.start()
        stack.push_async_callback(service.close)
        gateway.agent = service.facade
        authenticated = asyncio.get_running_loop().create_future()

        @web.middleware
        async def record_socket(request, handler):
            if request.path == '/ws' and not authenticated.done():
                authenticated.set_result(request)
            return await handler(request)

        app = web.Application(middlewares=[make_auth_middleware(state.auth_state), bind_runtime_identity, record_socket])
        app['gateway'] = gateway
        app.router.add_get('/ws', gateway._handle_ws)
        runner = web.AppRunner(app)
        await runner.setup()
        stack.push_async_callback(runner.cleanup)
        site = IrohSite(runner, SimpleNamespace(identity=state.identity))
        await site.start()
        bridge_session = BridgeSession(bridge_name='telegram')
        await bridge_session.start(network_state=state, gateway_site=site, agent_dir=tmp_path)
        stack.push_async_callback(bridge_session.stop)
        certificate = verify_cert(bridge_session.cert_wire, coordinator_pubkey=state.coordinator_key.public_key(),
                                  expected_network_id=state.network_id)
        assert certificate.handle == '__bridge_telegram' and 'bridge' in certificate.capabilities
        bridge = TelegramBridge(channel['token'], allowed_users=[actor], gateway_url=bridge_session.ws_url,
                                legacy_private_sessions=legacy)
        observed = asyncio.Queue()
        receive_frame = bridge.transport._handle_gateway_frame

        async def record_frame(frame):
            await receive_frame(frame)
            await observed.put(frame)

        monkeypatch.setattr(bridge.transport, '_handle_gateway_frame', record_frame)
        await bridge._ensure_transport_started()
        stack.push_async_callback(bridge.transport.stop)
        request = await asyncio.wait_for(authenticated, 3)
        assert request['device_cert'].device_pubkey == certificate.device_pubkey
        guard = request['openagent_session_projection']
        socket = next(ws for ws, bound in gateway._ws_history_guards.items() if bound is guard)

        async def delivered(session_id):
            # The pong is queued after the protected frame on the same socket.
            await gateway._safe_ws_send_json(socket, {'type': 'status', 'session_id': session_id, 'text': 'Neutral progress'})
            await gateway._safe_ws_send_json(socket, {'type': 'pong', 'id': 'flush'})
            frames = []
            async with asyncio.timeout(3):
                while True:
                    frame = await observed.get()
                    if frame.get('type') == 'pong' and frame.get('id') == 'flush':
                        return session_id in frames
                    if frame.get('type') == 'status':
                        frames.append(frame.get('session_id'))

        yield SimpleNamespace(db=db, service=service, request=request, delivered=delivered,
                              config=config, bridge=bridge, auth_state=state.auth_state)


@pytest.mark.asyncio
async def test_certified_bridge_publishes_only_existing_revisions_of_its_private_root(tmp_path, monkeypatch):
    async with certified_bridge(tmp_path, monkeypatch) as fixture:
        service, request, delivered, config = fixture.service, fixture.request, fixture.delivered, fixture.config
        root = await service.context(request, 'tg:100')
        store, vault = service.runtime.services.store, service.document_vault
        scope = {'tenant': root.tenant_id, 'agent': root.agent_id, 'space': await vault.resolve_space(root)}
        for path in ['original.md', 'independent.md']:
            await vault.write(root, path, 'Neutral fixture.', expected_revision=0)
        original, = await vault.note_receipts(scope, {('original.md', 1)})
        independent, = await vault.note_receipts(scope, {('independent.md', 1)})

        async def admit(run_id, context, sources=()):
            await store.accept(RunRequest(run_id, context.session_id, run_id, 'Neutral task'), context)
            await store.transition(run_id, 'running')
            if sources:
                await store.bind_document_sources(context, run_id, sources)

        await admit('root-run', root, (original,))
        agent_principal = PrincipalRef('openagent', root.tenant_id, 'agent', 'agent')
        child = root.child(session_id='worker', run_id='root-run', agent=agent_principal)
        await admit('worker-run', child)
        assert await store.document_sources(root, session_id=child.session_id) == (original,)
        child_reader = await service.context(request, child.session_id)
        assert await service.authorizer.authorize(child_reader, 'session.read',
            ResourceRef('session', root.tenant_id, child.session_id), audience=child_reader.audience)
        assert not await service.authorizer.authorize(child_reader, 'memory.read',
            ResourceRef('vault-space', root.tenant_id, scope['space']), audience=child_reader.audience)
        assert await delivered(root.session_id)
        assert await delivered(child.session_id)

        # An independent private route with the same bot certificate does not acquire owner-vault access.
        other = await service.context(request, 'tg:101')
        await admit('other-run', other, (original,))
        other_child = other.child(session_id='other-worker', run_id='other-run', agent=agent_principal)
        await admit('other-worker-run', other_child)
        assert not await delivered(other_child.session_id)

        peer = PrincipalRef('openagent', root.tenant_id, 'peer', 'user')
        widened = replace(child, session_id='wider-worker', audience=(root.authority, peer))
        await admit('wider-worker-run', widened)
        assert not await delivered(widened.session_id)
        different_ingress = replace(child, session_id='other-binding-worker', ingress_id='different-binding')
        await admit('different-binding-run', different_ingress)
        assert not await delivered(different_ingress.session_id)

        extra = replace(child, session_id='additional-note-worker')
        await admit('additional-note-run', extra, (independent,))
        assert not await delivered(extra.session_id)

        # A newly inherited receipt needs its own Core verification before a frame leaves the socket.
        raced = replace(child, session_id='growing-worker')
        await admit('growing-run', raced)
        inspect = SessionInspection.authorize

        async def inherit_after_inspection(inspector, viewer, sid, **options):
            await inspect(inspector, viewer, sid, **options)
            if sid == raced.session_id:
                await store.bind_document_sources(root, 'root-run', (independent,))
                await store.bind_document_sources(raced, 'growing-run', (independent,))

        with monkeypatch.context() as inflight:
            inflight.setattr(SessionInspection, 'authorize', inherit_after_inspection)
            assert not await delivered(raced.session_id)
        assert await delivered(raced.session_id)
        with monkeypatch.context() as revoked:
            revoked.setitem(config['runtime_tool_audiences']['vault_owner_channels'], 'telegram', [])
            assert not await delivered(child.session_id)
        assert await delivered(child.session_id)
        await vault.forget(root, 'original.md', expected_revision=1)
        assert not await delivered(root.session_id)
        assert not await delivered(child.session_id)


@pytest.mark.asyncio
async def test_certified_bridge_runs_two_models_with_only_the_parent_note_receipts(tmp_path, monkeypatch):
    import json
    from unittest.mock import AsyncMock

    from openagent_channel_bridges.contracts import BridgeContext, BridgeMessage, BridgePart
    from openagent_core.engine import Agent
    from openagent_core.mcp.pool import MCPPool
    from openagent_core.models import discovery
    from openagent_core.models.dispatcher import ModelDispatcher
    from openagent_core.models.native_provider import NativeProvider
    from openagent_core.models.providers.base import Model
    from openagent_core.models.providers.response import ModelResponse
    from openagent_core.runtime import current_execution_context, current_run_id

    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    monkeypatch.setenv("LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS", "True")
    parents, calls, returned, held = [], {}, {}, set()
    waiting, resume = asyncio.Event(), asyncio.Event()
    hold_children = False
    note = "Amber fixture revision."

    class ModelFixture(Model):
        def invoke(self, *args, **kwargs):
            raise AssertionError("Unexpected synchronous inference")

        invoke_stream = invoke

        async def ainvoke(self, *, messages, **kwargs):
            ctx, rid = current_execution_context(), current_run_id()
            if ctx.parent_run_id:
                calls[rid] = f"{self.provider}:{self.id}"
                receipts = await store.document_sources(ctx, run_id=rid)
                assert receipts == (original,)
                with pytest.raises(PermissionError):
                    await vault.read(ctx, "unrelated.md")
                if hold_children:
                    held.add(rid)
                    if len(held) == 2:
                        waiting.set()
                    await resume.wait()
                return ModelResponse(role="assistant", content=f"Verified by {self.id}")
            if rid in parents:
                results = returned.setdefault(rid, set())
                for member in ("reader", "writer"):
                    value = f"Verified by {member}"
                    if any(value in str(m.content) for m in messages):
                        results.add(value)
                return ModelResponse(role="assistant", content=". ".join(sorted(results)) or "Child results unavailable.")
            parents.append(rid)
            assert (await vault.read(ctx, "included.md"))["content"] == note
            assert await store.document_sources(ctx, run_id=rid) == (original,)
            members = ("primary-reader", "secondary-writer")
            return ModelResponse(role="assistant", tool_calls=[{
                "id": "call-" + member, "type": "function", "function": {
                    "name": "delegate_task_to_member",
                    "arguments": json.dumps({"member_id": member, "task": "Verify the fixture."})},
            } for member in members])

        async def ainvoke_stream(self, **kwargs):
            yield await self.ainvoke(**kwargs)

        def _parse_provider_response(self, response, **kwargs):
            return response

        _parse_provider_response_delta = _parse_provider_response

    def build_model(provider):
        name, model = provider.model.split(":", 1)
        return ModelFixture(id=model, provider=name)

    monkeypatch.setattr(NativeProvider, "build_runtime_model", build_model)
    monkeypatch.setattr(NativeProvider, "_build_runtime_model", build_model)
    monkeypatch.setattr(discovery, "_fetch_openrouter_catalog", AsyncMock(return_value=[]))

    async def build_agent(db, config):
        for name, models in (("primary", ("coordinator", "reader")), ("secondary", ("writer",))):
            provider = await db.upsert_provider(name=name, framework="api-based", enabled=True)
            for model in models:
                await db.upsert_model(provider_id=provider, model=model, enabled=True, is_classifier=model == "coordinator")
        agent = Agent(name="agent", memory=db, model=ModelDispatcher(await db.materialise_providers_config(enabled_only=True)),
                      mcp_pool=MCPPool.from_config([], include_defaults=False), config=config)
        agent.product_environment = {}
        return agent

    async with certified_bridge(tmp_path, monkeypatch, build_agent) as fixture:
        service, request = fixture.service, fixture.request
        root = await service.context(request, "tg:100")
        store, vault = service.runtime.services.store, service.document_vault
        await vault.write(root, "included.md", note, expected_revision=0)
        await vault.write(root, "unrelated.md", "Independent fixture.", expected_revision=0)
        space = {"tenant": root.tenant_id, "agent": root.agent_id, "space": await vault.resolve_space(root)}
        original, = await vault.note_receipts(space, {("included.md", 1)})
        await fixture.db.pin_session_model(root.session_id, "primary:coordinator")

        async def send(event):
            route = BridgeContext("telegram", "telegram", "900", "100", "100", event, conversation_kind="direct")
            return await fixture.bridge.transport.send(BridgeMessage(route, (BridgePart(text="Delegate the fixture checks " + event),)))

        async with asyncio.timeout(20):
            first = await send("first")
        assert first.session_ref == root.session_id
        assert len(parents) == 1
        children = await service.runtime.children(parents[0], root)
        assert [run.status for run in children] == ["success", "success"], returned.get(parents[0])
        assert {calls[run.run_id] for run in children} == {"primary:reader", "secondary:writer"}
        assert len({run.session_id for run in children}) == 2
        for run in children:
            accepted = await service.runtime.accepted_request(run.run_id, root)
            assert accepted.request.model_ref == calls[run.run_id]
            assert run.output == "Verified by " + calls[run.run_id].split(":", 1)[1]
            assert run.output in returned[parents[0]]
            assert any(part.text and run.output in part.text for part in first.parts)
            assert await fixture.delivered(run.session_id)

        other = await service.context(request, "tg:101")
        with pytest.raises((PermissionError, LookupError)):
            await vault.read(other, "included.md")
        for run in children:
            with pytest.raises((PermissionError, LookupError)):
                await service.runtime.get_run(run.run_id, other)

        hold_children = True
        async with asyncio.timeout(20):
            pending = asyncio.create_task(send("revoked"))
            try:
                await waiting.wait()
                with monkeypatch.context() as revoked:
                    revoked.setitem(service.agent.config["runtime_tool_audiences"]["vault_owner_channels"], "telegram", [])
                    resume.set()
                    for rid in held:
                        while not (record := await store.get(rid)).terminal:
                            await asyncio.sleep(.01)
                        assert record.status == "failed"
                        assert "Verified by" not in str(record.output)
                        assert not any(e.kind == "run.stream" and e.payload.get("kind") == "done"
                                       for e in await store.events(rid, 0))
            finally:
                resume.set()
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
        fixture.auth_state.revoke(request["device_cert"].device_pubkey)
        with pytest.raises(PermissionError):
            await service.runtime.get_run(children[0].run_id, root)
