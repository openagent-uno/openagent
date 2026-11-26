"""The standalone daemon rechecks inherited document history on its certified bridge socket."""
import asyncio
from contextlib import AsyncExitStack
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


@pytest.mark.asyncio
async def test_certified_bridge_publishes_only_existing_revisions_of_its_private_root(tmp_path, monkeypatch):
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

    agent = FixtureAgent(name='agent', memory_db=db, config=config, capability_pool=None, product_environment={}, model=None)
    async with AsyncExitStack() as stack:
        await db.connect()
        stack.push_async_callback(db.close)
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
