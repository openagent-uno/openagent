from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from openagent_core.contracts import PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.coordinator.service import CoordinatorService
from openagent_server.runtime_directory import NativeRuntimeDirectory


class DirectoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.db=MemoryDB(str(Path(self.temp.name)/'state.sqlite3'))
        await self.db.connect()
        self.store=CoordinatorStore(self.db)
        await self.store.set_network_role(role='coordinator',network_id='network',name='test')
        for user in ('alice','bob'):
            await self.store.create_user(handle=user,pake_record=b'never-published',pake_algo='fixture')
        await self.store.add_device(device_pubkey=b'a'*32,user_handle='alice')
        await self.store.add_device(device_pubkey=b'b'*32,user_handle='bob')
        await self.store.register_agent(handle='worker',node_id='f'*64,owner_handle='alice')
        self.coordinator=CoordinatorService(store=self.store,coordinator_key=Ed25519PrivateKey.generate(),network_id='network',network_name='test')
        self.directory=NativeRuntimeDirectory(SimpleNamespace(),SimpleNamespace(memory_db=self.db))

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def test_enrolled_agent_gets_only_current_public_identity_fields(self):
        with self.assertRaises(Exception) as caught:
            await self.coordinator._m_runtime_directory({},peer_node_id='unknown')
        self.assertEqual(caught.exception.code,'unauthorized')
        reply=await self.coordinator._m_runtime_directory({},peer_node_id='f'*64)
        self.assertEqual(set(reply),{'users','agents','devices'})
        self.assertEqual(set(reply['users']),{'alice','bob'})
        self.assertEqual(reply['devices'][0],{'device_id':(b'a'*32).hex(),'handle':'alice'})
        await self.store.set_user_status('bob','suspended')
        reply=await self.coordinator._m_runtime_directory({},peer_node_id='f'*64)
        self.assertEqual(reply['users'],['alice'])
        self.assertFalse(any(row['handle']=='bob' for row in reply['devices']))
        self.assertFalse(await self.directory.principal_active(PrincipalRef('openagent','network','bob')))

    async def test_shared_audience_expands_from_live_directory_and_revocation_changes_it(self):
        await self.db._conn.execute("INSERT INTO sessions_v2 (id,tenant_id,owner_principal_id,visibility,session_type,kind,status,acl_version,created_at_ms,updated_at_ms,last_activity_at_ms,metadata_json) VALUES ('shared','network','user:alice','installation_shared','chat','chat','idle',1,1,1,1,'{}')")
        await self.db._conn.commit()
        audience=await self.directory.audience('shared','network')
        self.assertEqual({p.subject_id for p in audience},{'alice','bob','worker'})
        await self.store.set_user_status('bob','suspended')
        self.assertEqual({p.subject_id for p in await self.directory.audience('shared','network')},{'alice','worker'})
