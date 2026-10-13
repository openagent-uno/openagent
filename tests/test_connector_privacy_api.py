"""Real product routes and canonical storage on two isolated owned servers."""
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import aiosqlite
import pytest

from openagent_core import Runtime, RuntimeServices, RuntimeSettings, PrincipalRef, ExecutionContext, RunRequest
from openagent_core.content_privacy import ContentOrigin, ContentFragment, ToolResultProvenance
from openagent_core.engine import MemoryDB, NativeProvider
from openagent_core.memory.store.sqlite.sqlite import SqliteDb
from openagent_core.memory.sessions.agent import AgentSession
from openagent_core.core._run_state.agent import RunOutput
from openagent_core.models.providers.message import Message
from openagent_core.models.providers.response import ToolExecution
from openagent_core.runtime import execution_scope
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.official_connectors import OfficialConnectors
from openagent_server.connector_privacy import install_local_privacy, grant_generation
from openagent_server.gateway.api import official_connectors as api


class Allow:
    async def authorize(self, *args, **kwargs): return True


async def owned_server(root, label):
    root.mkdir()
    memory = MemoryDB(str(root / 'state.sqlite'))
    await memory.connect()
    canonical = SqliteRuntimeStore(memory.db_path)
    runtime = Runtime(RuntimeSettings('agent', root), RuntimeServices(canonical, None, Allow()))
    await runtime.start()
    principal = PrincipalRef('host', label, 'owner')
    context = ExecutionContext(principal, principal, principal, 'session', 'agent', (principal,))
    agent = SimpleNamespace(name='QA', config={}, memory_db=memory,
                            model=NativeProvider('openai:fixture', api_key='fixture'))
    host = SimpleNamespace(agent=agent, authorizer=Allow(), runtime=runtime)
    service = OfficialConnectors(host)
    await service.start()
    # Only this fixture's managed canonical surfaces are enabled. This is not
    # an attestation for arbitrary product extensions or historical user data.
    publisher = install_local_privacy(service, runtime)
    service.privacy_processor.covered_surfaces = service.privacy_processor.store.required_surfaces
    generation = grant_generation('2026-10-13T10:00:00Z')
    async with aiosqlite.connect(memory.db_path) as db:
        await db.execute('''INSERT INTO official_connector_connections
            (id,tenant_id,owner_key,catalog_id,provider,capability,display_name,status,app_id,group_id,created_at)
            VALUES('connection',?,?,'shopify','shopify','commerce','Shop','disconnected','app','group','2026-10-13T10:00:00Z')''',
            (label, principal.key))
        await db.commit()
    await canonical.accept(RunRequest('run', 'session', 'key', 'HUMAN QUESTION'), context)
    await canonical.transition('run', 'running')
    await canonical.begin_tool('run', 'call', {'source_id':'shopify', 'name':'customers.list', 'provider_call_id':'model-call'}, {})
    first = ContentOrigin(label, 'shopify/app', 'group', generation, ('customer:23',))
    other = ContentOrigin(label, 'shopify/app', 'group', generation, ('customer:24',))
    result = {'customers':[{'id':23,'name':'PRIVATE CUSTOMER A'},{'id':24,'name':'RETAIN CUSTOMER B'}]}
    plan = ToolResultProvenance((ContentFragment(('customers',0),(first,)),ContentFragment(('customers',1),(other,))))
    await publisher.publish_tool_result(context, 'run', 'call', result, plan)
    encoded = json.dumps(result)
    legacy = SqliteDb(db_file=memory.db_path)
    session = AgentSession(session_id='session', agent_id='agent', user_id=principal.key, created_at=1, updated_at=1,
        runs=[RunOutput(run_id='run',agent_id='agent',session_id='session',content='DERIVED CUSTOMER A AND B',
            messages=[Message(role='user',content='HUMAN QUESTION'),Message(role='tool',tool_call_id='model-call',content=encoded)],
            tools=[ToolExecution(tool_call_id='model-call',tool_name='customers.list',tool_args={},result=encoded)])])
    with execution_scope(runtime, context, 'run'):
        legacy.upsert_session(session)
        await memory.append_session_event('session','assistant/message',{'text':'DERIVED CUSTOMER A AND B'})
    await canonical.transition('run','success',output='DERIVED CUSTOMER A AND B')
    active = {'allowed':True}
    async def request_context(request, _session):
        if not active['allowed'] or request.headers.get('Authorization') != 'Fixture owner':
            raise web.HTTPForbidden()
        return context
    app = web.Application()
    app['gateway'] = SimpleNamespace(runtime_service=SimpleNamespace(context=request_context,official_connectors=service))
    app.router.add_post('/api/connectors/privacy/{request_id}/export',api.privacy_export)
    app.router.add_post('/api/connectors/privacy/{request_id}/ack',api.privacy_export_ack)
    client = TestClient(TestServer(app));await client.start_server()
    async def close():
        await client.close();legacy.close();await service.close();await runtime.close();await memory.close()
    return SimpleNamespace(service=service, publisher=publisher, context=context, legacy=legacy,
                           client=client, active=active, close=close, runtime=runtime, canonical=canonical)


@pytest.mark.asyncio
async def test_two_product_servers_selective_export_ack_redaction_and_acl(tmp_path):
    servers = [await owned_server(tmp_path/'one','one'), await owned_server(tmp_path/'two','two')]
    try:
        receipt = {'id':'provider-export','group':'group','topic':'customers/data_request',
            'created_at':'2026-10-13T12:00:00Z','occurred_at':'2026-10-13T11:00:00Z',
            'payload':{'customer':{'id':23},'orders_requested':[]}}
        request_ids = []
        for server in servers:
            await server.service.receive_event(receipt)
            await server.service.process_privacy_events()
            ledger = server.service.privacy_processor.store
            request_id = hashlib.sha256(('provider-export\0'+server.context.tenant_id+'\0app').encode()).hexdigest()
            request_ids.append(request_id)
            assert (await ledger.progress(request_id)).status == 'complete'
            async with aiosqlite.connect(server.service.db_path) as db:
                assert (await (await db.execute('SELECT status FROM official_connector_events')).fetchone())[0] == 'blocked'
            path = f'/api/connectors/privacy/{request_id}'
            denied = await server.client.post(path+'/export');assert denied.status == 403
            response = await server.client.post(path+'/export',headers={'Authorization':'Fixture owner'})
            assert response.status == 200
            assert response.headers['Cache-Control'] == 'no-store'
            packet = await response.json()
            contents = b' '.join(base64.b64decode(part['content_base64']) for part in packet['bundle']['parts'])
            assert b'PRIVATE CUSTOMER A' in contents
            assert b'RETAIN CUSTOMER B' not in contents
            assert b'HUMAN QUESTION' not in contents
            spool = server.service.privacy_processor.exports
            assert b'PRIVATE CUSTOMER A' not in spool.path.read_bytes()
            server.active['allowed'] = False
            denied = await server.client.post(path+'/ack',json={'delivery_token':packet['delivery_token']},headers={'Authorization':'Fixture owner'})
            assert denied.status == 403 and not await spool.delivered(request_id)
            server.active['allowed'] = True
            acknowledged = await server.client.post(path+'/ack',json={'delivery_token':packet['delivery_token']},headers={'Authorization':'Fixture owner'})
            assert acknowledged.status == 200 and await spool.delivered(request_id)
            async with aiosqlite.connect(server.service.db_path) as db:
                assert (await (await db.execute('SELECT status FROM official_connector_events')).fetchone())[0] == 'complete'
        assert request_ids[0] != request_ids[1]
        # Same provider receipt addresses both owned hosts. One duplicate
        # delivery does not repeat actions or erase customer B/human content.
        redact = {**receipt,'id':'provider-erase','topic':'customers/redact',
                  'payload':{'customer':{'id':23},'orders_to_redact':[]}}
        for server in servers:
            await server.service.receive_event(redact);await server.service.process_privacy_events()
            await server.service.receive_event(redact);await server.service.process_privacy_events()
            stored = str(server.legacy.get_session('session',deserialize=False))
            assert 'PRIVATE CUSTOMER A' not in stored
            assert 'DERIVED CUSTOMER A AND B' not in stored
            assert 'RETAIN CUSTOMER B' in stored and 'HUMAN QUESTION' in stored
            async with aiosqlite.connect(server.service.db_path) as db:
                assert (await (await db.execute("SELECT status FROM official_connector_events WHERE id='provider-erase'")).fetchone())[0] == 'complete'
    finally:
        for server in servers: await server.close()


@pytest.mark.asyncio
async def test_shared_store_export_checks_each_session_owner_and_ack_current_acl(tmp_path):
    server = await owned_server(tmp_path/'owned', 'tenant')
    try:
        bob = PrincipalRef('host', 'tenant', 'bob')
        context = ExecutionContext(bob, bob, bob, 'bob-session', 'agent', (bob,))
        await server.canonical.accept(RunRequest('bob-run', 'bob-session', 'bob-key', 'BOB HUMAN'), context)
        await server.canonical.transition('bob-run', 'running')
        await server.canonical.begin_tool('bob-run', 'bob-call', {'source_id':'shopify','name':'customers.get'}, {})
        origin = ContentOrigin('tenant', 'shopify/app', 'group', grant_generation('2026-10-13T10:00:00Z'), ('customer:23',))
        await server.publisher.publish_tool_result(context, 'bob-run', 'bob-call', {'private':'BOB PRIVATE SESSION'}, (origin,))
        await server.canonical.transition('bob-run', 'success', output='BOB DERIVED CONTENT')
        policy = SimpleNamespace(shared=False)
        class CurrentSessionPolicy:
            async def authorize(self, actor, action, resource, **kwargs):
                return action != 'run.read' or resource.resource_id == 'session' or policy.shared
        server.runtime.services.authorizer = CurrentSessionPolicy()
        receipt = {'id':'shared-export','group':'group','topic':'customers/data_request',
                   'created_at':'2026-10-13T12:00:00Z','occurred_at':'2026-10-13T11:00:00Z',
                   'payload':{'customer':{'id':23},'orders_requested':[]}}
        await server.service.receive_event(receipt)
        await server.service.process_privacy_events()
        request_id = hashlib.sha256(b'shared-export\0tenant\0app').hexdigest()
        headers = {'Authorization':'Fixture owner'}
        response = await server.client.post(f'/api/connectors/privacy/{request_id}/export', headers=headers)
        assert response.status == 403
        assert 'BOB PRIVATE' not in await response.text()
        policy.shared = True
        response = await server.client.post(f'/api/connectors/privacy/{request_id}/export', headers=headers)
        assert response.status == 200
        delivered = await response.json()
        policy.shared = False
        response = await server.client.post(f'/api/connectors/privacy/{request_id}/ack', headers=headers,
                                           json={'delivery_token':delivered['delivery_token']})
        assert response.status == 403
        assert not await server.service.privacy_processor.exports.delivered(request_id)
    finally:
        await server.close()
