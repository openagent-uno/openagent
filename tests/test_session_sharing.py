"""Authenticated sharing HTTP API with real SQLite and native user directory."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import tempfile
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from openagent_core.memory.db import MemoryDB
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_server.runtime_directory import NativeRuntimeDirectory
from openagent_server.gateway.collaboration_members import handle_members


class SessionSharingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / 'state.sqlite3'))
        await self.db.connect()
        await self.db.upsert_session('chat', client_id='alice')
        self.connection = await self.db._ensure_connected()
        self.tenant = (await (await self.connection.execute("SELECT tenant_id FROM sessions_v2 WHERE id='chat'")).fetchone())[0]
        users = CoordinatorStore(self.db)
        await users.set_network_role(role='coordinator', network_id=self.tenant, name='fixture')
        for handle in ('alice', 'bob', 'carol', 'suspended'):
            await users.create_user(handle=handle, pake_record=b'fixture', pake_algo='fixture')
        await users.set_user_status('suspended', 'suspended')
        self.authenticated = True
        async def authorized(request, cert): return self.authenticated
        self.gateway = SimpleNamespace(agent=SimpleNamespace(memory_db=self.db),
            _request_device_still_authorized=authorized, broadcast_resource=AsyncMock(),
            _collaboration=SimpleNamespace(hub=SimpleNamespace(wake=lambda: None), runtimes={}))
        self.gateway.runtime_principal_active = NativeRuntimeDirectory(self.gateway, self.gateway.agent).principal_active
        @web.middleware
        async def identity(request, handler):
            user = request.headers.get('Test-User', 'alice')
            tenant = request.headers.get('Test-Tenant', self.tenant)
            request.update(auth_kind='device_cert', user_handle=user, network_id=tenant, client_id='device-'+user,
                device_cert=SimpleNamespace(handle=user,network_id=tenant,device_pubkey_hex='device-'+user,capabilities=[]))
            return await handler(request)
        app = web.Application(middlewares=[identity]); app['gateway'] = self.gateway
        app.router.add_get('/members/{session_id}', handle_members)
        app.router.add_put('/members/{session_id}', handle_members)
        self.client = TestClient(TestServer(app)); await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close(); await self.db.close(); self.temp.cleanup()

    async def state(self):
        version = (await (await self.connection.execute("SELECT acl_version FROM sessions_v2 WHERE id='chat'")).fetchone())[0]
        acl = [tuple(row) for row in await (await self.connection.execute("SELECT principal_id,permission,acl_version FROM resource_acl WHERE resource_id='chat' ORDER BY principal_id,acl_version")).fetchall()]
        return version, acl

    async def put(self, handle, permission='admin', **headers):
        return await self.client.put('/members/chat', json={'handle':handle,'permission':permission}, headers=headers)

    async def test_active_native_user_can_receive_access_and_collaborator_cannot_reshare(self):
        response = await self.put('bob'); self.assertEqual(200,response.status)
        self.assertIn({'handle':'bob','permission':'admin'},(await response.json())['members'])
        response = await self.client.get('/members/chat',headers={'Test-User':'bob'})
        self.assertEqual(200,response.status); self.assertFalse((await response.json())['can_manage'])
        response = await self.put('carol',**{'Test-User':'bob'}); self.assertEqual(403,response.status)

    async def test_unknown_and_suspended_users_cannot_change_grants_or_acl_generation(self):
        before = await self.state()
        for handle in ('unregistered','suspended'):
            for permission in ('admin','view'):
                with self.subTest(handle=handle,permission=permission):
                    response = await self.put(handle,permission)
                    self.assertEqual(404,response.status); self.assertEqual('User unavailable',(await response.json())['error'])
                    self.assertEqual(before,await self.state())

    async def test_directory_outage_denies_new_grants_but_preserves_removal(self):
        self.assertEqual(200,(await self.put('bob')).status)
        self.gateway.runtime_principal_active = None
        before = await self.state()
        self.assertEqual(503,(await self.put('carol')).status)
        self.assertEqual(before,await self.state())
        response = await self.put('bob',None); self.assertEqual(200,response.status)
        self.assertNotIn('bob',[row['handle'] for row in (await response.json())['members']])

    async def test_certificate_revocation_during_directory_lookup_prevents_mutation(self):
        before = await self.state()
        async def revoke(principal): self.authenticated=False; return True
        self.gateway.runtime_principal_active = revoke
        self.assertEqual(401,(await self.put('bob')).status)
        self.assertEqual(before,await self.state())

    async def test_other_grants_advance_without_reviving_historical_grants(self):
        await self.connection.execute("UPDATE sessions_v2 SET acl_version=2 WHERE id='chat'")
        for handle,version in (('bob',2),('carol',1)):
            await self.connection.execute("INSERT INTO resource_acl(tenant_id,resource_type,resource_id,principal_type,principal_id,permission,acl_version,granted_at_ms) VALUES(?,'session','chat','user',?,'admin',?,1)",(self.tenant,handle,version))
        await self.connection.commit()
        response = await self.put('bob','view'); self.assertEqual(200,response.status)
        members = {row['handle']:row['permission'] for row in (await response.json())['members']}
        self.assertEqual('view',members.get('bob')); self.assertNotIn('carol',members)
        self.assertEqual(3,(await self.state())[0])

    async def test_other_tenant_or_unrelated_actor_cannot_enumerate_or_mutate_access(self):
        before = await self.state()
        for headers in ({'Test-Tenant':'other-network'},{'Test-User':'carol'}):
            self.assertEqual(404,(await self.client.get('/members/chat',headers=headers)).status)
            self.assertEqual(404,(await self.put('bob',**headers)).status)
        self.assertEqual(before,await self.state())
