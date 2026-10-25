"""Compose real admission, engine, durable observation, stream and gateway wire."""
import asyncio
from types import SimpleNamespace

import pytest

from openagent_core.artifacts import ArtifactRepository
from openagent_core.contracts import ExecutionContext, PrincipalRef, RunRequest
from openagent_core.memory.db import MemoryDB
from openagent_core.runtime import current_execution_context, current_run_id
from openagent_core.stream.collector import StreamCollector, fold_outbound_event
from openagent_core.stream.events import TextFinal
from openagent_core.stream.session import StreamSession
from openagent_client_transport.stream.wire import event_to_wire, wire_to_event
from openagent_server.runtime_service import NativeRuntimeService


@pytest.mark.asyncio
@pytest.mark.parametrize('selected', [False, True])
async def test_runtime_facade_gateway_keeps_canonical_media_and_final_selection(tmp_path, selected):
    db = MemoryDB(str(tmp_path / 'state.sqlite'))
    await db.connect()
    refs = []
    calls = []

    class Agent:
        name = 'test-agent'
        config = {'_local_e2e': True}
        capability_pool = None
        memory_db = db
        async def initialize(self): pass
        def set_capability_pool(self, pool): self.capability_pool = pool
        async def run_stream(self, message, **kwargs):
            calls.append(message)
            context = current_execution_context()
            final = f"Result [FILE:{refs[1]['path']}]" if selected else 'All done.'
            text = f"Preview [IMAGE:{refs[0]['path']}]\n" + final
            conn = await db._ensure_connected()
            for sequence, role in enumerate(('user', 'assistant'), 10):
                await conn.execute("INSERT INTO session_messages "
                    "(id,tenant_id,session_id,run_id,sequence,ordinal,role,status,author_kind,author_principal_id,text,visibility,source_version,completeness,raw_envelope_json,raw_envelope_schema,legacy_inferred,created_at_ms,updated_at_ms) "
                    "VALUES (?,?,?,?,?,?,?,'complete',?,'user:alice',?,'user_visible',1,'complete','{}',1,0,1,1)",
                    (role, context.tenant_id, context.session_id, current_run_id(), sequence, sequence,
                     role, 'user' if role == 'user' else 'agent', message if role == 'user' else text))
            await conn.commit()
            yield {'kind': 'done', 'text': text, 'final_answer': {'text': final}}

    async def authorized(request, certificate): return True
    agent = Agent()
    gateway = SimpleNamespace(agent=agent, _request_device_still_authorized=authorized)
    service = NativeRuntimeService(gateway, agent)
    session = None
    try:
        await service.start()
        user = PrincipalRef('openagent', 'network', 'alice')
        context = ExecutionContext(user, user, user, 'session', agent.name, (user,))
        await service.store.accept(RunRequest('seed', 'session', 'seed', 'seed'), context)
        async def fixture_upload(*args, **kwargs): return True
        repository = ArtifactRepository(db, SimpleNamespace(authorize=fixture_upload))
        # Publish fixtures with a host-authorized context before binding the
        # transport identity; the actual turn uses ordinary verified admission.
        class Request(dict):
            app = {'gateway': gateway}
        request = Request(device_cert=SimpleNamespace(network_id='network', handle='alice',
            device_pubkey_hex='device-alice', capabilities=()), network_id='network',
            user_handle='alice', client_id='device-alice', auth_kind='device_cert', device_auth_epoch=1)
        identity = await service.authorizer.bind_request(request)
        context = await service.authorizer.context_for_identity(identity, 'session')
        refs.extend([await repository.upload(context, body, filename=name, session_id='session')
                     for body, name in ((b'preview', 'preview.png'), (b'answer', 'answer.csv'))])
        session = StreamSession(service.facade, client_id='device-alice', session_id='session',
            on_behalf_identity=identity, coalesce_window_ms=0)
        async def no_provider(_db): return None
        await session.start(stt_factory=no_provider, tts_factory=no_provider)
        await session.push_in(TextFinal(session_id='session', text='send assets'))
        reply = StreamCollector()
        while True:
            event = await asyncio.wait_for(session.outbound.get(), 10)
            if fold_outbound_event(reply, wire_to_event(event_to_wire(event))): break
        assert not reply.errored
        assert calls == ['send assets']
        assert len(reply.attachments) == (2 if selected else 1)
        assert [r['artifact_id'] for r in reply.final_answer['attachments']] == ([refs[1]['artifact_id']] if selected else [])
        assert str(tmp_path) not in str(reply.to_legacy_reply())
        if session._current_turn is not None:
            await asyncio.wait_for(asyncio.shield(session._current_turn), 5)
    finally:
        if session is not None: await session.close()
        await service.close()
        await db.close()
