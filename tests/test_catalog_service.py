from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.contracts import PrincipalRef, ExecutionContext
from openagent_core.engine import MemoryDB
from openagent_core.runtime import execution_scope
from openagent_server.catalog_service import NativeCatalogService


class OwnerPolicy:
    async def authorize(self, context, action, resource, *, audience=()):
        return context.initiator.subject_id == 'alice'


class CatalogServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = MemoryDB(db_path=str(Path(self.directory.name) / 'state.sqlite3'))
        await self.db.connect()
        await self.db.upsert_mcp('vault',kind='builtin',builtin_name='vault',source='builtin')
        await self.db.upsert_mcp('existing-user',kind='custom',command=['echo'],source='api')
        self.agent = SimpleNamespace(memory_db=self.db,config={},capability_pool=None)
        self.service = NativeCatalogService(self.agent, OwnerPolicy())
        await self.service.start()
        p = PrincipalRef('openagent','network','alice')
        self.context = ExecutionContext(p,p,p,'session','agent',(p,))

    async def asyncTearDown(self):
        await self.db.close()
        self.directory.cleanup()

    async def test_managed_ownership_survives_mutable_row_rewrite_and_restart(self):
        await self.db.upsert_mcp('vault',kind='custom',command=['untrusted'],source='api')
        restored = NativeCatalogService(self.agent, OwnerPolicy())
        await restored.start()
        self.assertTrue((await restored.get(self.context,'vault'))['managed'])
        with self.assertRaises(PermissionError):
            await restored.update(self.context,'vault',command=['echo'])
        with self.assertRaises(PermissionError):
            await restored.delete(self.context,'vault')
        with self.assertRaises(ValueError):
            await restored.create(self.context,'vault',command=['echo'])

    async def test_user_configuration_and_mutability_cannot_be_promoted_by_import_fields(self):
        row = await self.service.create(self.context,'new-user',command=['echo'],args=['hello'])
        self.assertFalse(row['managed'])
        self.assertIn('new-user',self.service.user_sources)
        with self.assertRaises(ValueError):
            await self.service.update(self.context,'new-user',kind='builtin',source='product')
        await self.service.set_enabled(self.context,'new-user',False)
        self.assertFalse((await self.service.get(self.context,'new-user'))['enabled'])
        await self.service.delete(self.context,'new-user')
        with self.assertRaises(LookupError):
            await self.service.get(self.context,'new-user')

    async def test_non_owner_cannot_read_credentials_or_mutate_catalog(self):
        p = PrincipalRef('openagent','network','bob')
        context = ExecutionContext(p,p,p,'session','agent',(p,))
        for operation in (self.service.list(context),self.service.get(context,'existing-user'),
                          self.service.create(context,'other',command=['echo'])):
            with self.assertRaises(PermissionError):
                await operation

    async def test_mcp_manager_delegates_to_the_same_host_service(self):
        from openagent_core.mcp.servers.mcp_manager.server import add_custom_mcp, update_mcp
        runtime = SimpleNamespace(
            service=lambda key, default=None: self.service if key == "catalog_management" else default,
            settings=SimpleNamespace(environment=()),
        )
        with execution_scope(runtime,self.context,'run'):
            row = await add_custom_mcp('from-tool',command=['echo'])
            self.assertEqual(row,await self.service.get(self.context,'from-tool'))
            with self.assertRaises(PermissionError):
                await update_mcp('vault',command=['other-program'])
        with self.assertRaises(PermissionError):
            await add_custom_mcp('without-run',command=['echo'])
