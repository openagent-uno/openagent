"""Power observation is authorized, stateless and follows actual Runtime runs."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from openagent_core import Runtime, RuntimeSettings, RuntimeServices, PrincipalRef, ExecutionContext, RunRequest
from openagent_core.memory.db import MemoryDB
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.gateway.api import operational


@pytest.mark.asyncio
async def test_active_probe_tracks_runtime_and_acl_without_evicting_history_cursors(tmp_path):
    db = MemoryDB(str(tmp_path / 'state.db'))
    await db.connect()
    conn = await db._ensure_connected()
    tenant = 'tenant-a'
    started, release = asyncio.Event(), asyncio.Event()

    class Policy:
        async def authorize(self, *args, **kwargs): return True

    class Executor:
        async def execute(self, request, context, runtime):
            started.set(); await release.wait(); return 'Completed'

    runtime = Runtime(RuntimeSettings('agent', tmp_path), RuntimeServices(SqliteRuntimeStore(tmp_path / 'state.db'), Executor(), Policy()))
    await runtime.start()
    actor = PrincipalRef('openagent', tenant, 'alice', 'user')
    context = ExecutionContext(actor, actor, actor, 'live-session', 'agent', (actor,))
    gateway = SimpleNamespace(agent=SimpleNamespace(memory_db=db), _operational_history_ready=True)

    class Request(dict):
        app = {'gateway': gateway}
        query = {}

    def request(handle='alice', network=tenant):
        return Request(auth_kind='device_cert', user_handle=handle, client_id='device', network_id=network,
            device_cert=SimpleNamespace(handle=handle, network_id=network, device_pubkey_hex='device', capabilities=[]))

    async def active(req):
        response = await operational.handle_active_history(req)
        assert response.status == 200, response.text
        return json.loads(response.text)['active']

    try:
        await runtime.submit(RunRequest('running', 'live-session', 'key', 'Work'), context)
        await asyncio.wait_for(started.wait(), 2)
        alice, bob = request(), request('bob')
        state = operational._state(alice)
        for _ in range(6): assert await active(alice) is True
        assert len(state.history) == 0
        assert await active(bob) is False
        assert await active(request(network='another-tenant')) is False
        version = (await (await conn.execute("SELECT acl_version FROM sessions_v2 WHERE id='live-session'")).fetchone())[0]
        await conn.execute("INSERT INTO resource_acl (tenant_id,resource_type,resource_id,principal_type,principal_id,permission,acl_version,granted_by_principal_id,granted_at_ms) VALUES(?,'session','live-session','user','bob','view',?,'user:alice',1)", (tenant, version))
        await conn.commit()
        assert await active(bob) is True
        await conn.execute("DELETE FROM resource_acl WHERE resource_id='live-session' AND principal_id='bob'")
        await conn.commit()
        assert await active(bob) is False
        release.set()
        await runtime.wait('running', context)
        assert await active(alice) is False
        assert len(state.history) == 0
    finally:
        release.set()
        await runtime.close()
        await db.close()
