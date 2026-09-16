from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.contracts import ExecutionContext,PrincipalRef,ResourceRef
from openagent_core.engine import MemoryDB
from openagent_server.memory_access import NativeMemoryAccess
from openagent_server.runtime_access import NativeRuntimeAuthorizer


class NativeMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.db=MemoryDB(str(Path(self.temp.name)/'state.sqlite3'));await self.db.connect()
        self.alice=PrincipalRef('openagent','network','alice');self.bob=PrincipalRef('openagent','network','bob')
        self.context=ExecutionContext(self.alice,self.alice,self.alice,'shared','worker',(self.alice,self.bob))
        self.members=['alice','bob']
        async def snapshot(tenant):
            if tenant!='network':raise PermissionError()
            return {'users':self.members,'agents':['worker'],'devices':[{'handle':'alice','device_id':'a'*64}]}
        async def owner():return 'alice'
        self.agent=SimpleNamespace(memory_db=self.db,config={})
        self.service=NativeMemoryAccess(SimpleNamespace(agent=self.agent,
            authorizer=NativeRuntimeAuthorizer(SimpleNamespace(),self.db.db_path),
            directory=SimpleNamespace(snapshot=snapshot,owner_handle=owner)))
        await self.db._conn.execute("INSERT INTO sessions_v2 (id,tenant_id,owner_principal_id,visibility,session_type,kind,status,acl_version,created_at_ms,updated_at_ms,last_activity_at_ms,metadata_json) VALUES ('private','network','user:alice','private','chat','chat','idle',1,1,1,1,'{}')")
        await self.db._conn.commit()
    async def asyncTearDown(self):
        await self.db.close();self.temp.cleanup()
    async def test_read_permission_does_not_publish_private_history_to_shared_session(self):
        resource=ResourceRef('session','network','private')
        self.assertTrue(await self.service.authorize(self.context,'memory.read',resource))
        self.assertFalse(await self.service.authorize(self.context,'memory.publish',resource,audience=self.context.audience))
        await self.db._conn.execute("INSERT INTO resource_acl (tenant_id,resource_type,resource_id,principal_type,principal_id,permission,acl_version,granted_at_ms) VALUES ('network','session','private','user','bob','view',1,1)")
        await self.db._conn.commit()
        self.assertTrue(await self.service.authorize(self.context,'memory.publish',resource,audience=self.context.audience))
        self.members.remove('bob')
        self.assertFalse(await self.service.authorize(self.context,'memory.publish',resource,audience=self.context.audience))
    async def test_private_vault_requires_explicit_shared_store_policy(self):
        note=ResourceRef('vault-note','network','notes/learning.md')
        self.assertTrue(await self.service.authorize(self.context,'memory.read',note))
        self.assertFalse(await self.service.authorize(self.context,'memory.publish',note,audience=self.context.audience))
        self.agent.config['runtime_tool_audiences']={'vault':'installation'}
        self.assertTrue(await self.service.authorize(self.context,'memory.publish',note,audience=self.context.audience))
        self.assertFalse(await self.service.authorize(self.context,'memory.publish',note,audience=(self.alice,)))
        self.assertFalse(await self.service.authorize(self.context,'memory.write',note))
    async def test_identity_aliases_are_typed_and_unknown_history_is_not_reassigned(self):
        access=await self.service.access(self.alice)
        self.assertIn(self.alice.key,access.principal_ids)
        self.assertIn('device:'+'a'*64,access.principal_ids)
        self.assertNotIn('alice',access.principal_ids)
        await self.db._conn.execute("UPDATE sessions_v2 SET owner_principal_id='unresolved-old-author' WHERE id='private'")
        await self.db._conn.commit()
        self.assertFalse(await self.service.authorize(self.context,'memory.read',ResourceRef('session','network','private')))
        with self.assertRaises(PermissionError):await self.service.access(PrincipalRef('external','network','alice'))
