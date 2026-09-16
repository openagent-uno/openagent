from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.capabilities import CapabilityCatalog, ToolDefinition
from openagent_core.contracts import CapabilityLease, ExecutionContext, PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_server.automation_authority import NativeAutomationAuthority


class Policy:
    async def authorize(self,context,action,resource,*,audience=()):
        return context.initiator.subject_id == 'alice'


class Source:
    async def discover(self,context):
        return (ToolDefinition('read','read a record',{'type':'object'}),)
    async def call_tool(self,name,arguments,context):
        return {}


class AutomationAuthorityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = MemoryDB(db_path=str(Path(self.directory.name)/'state.sqlite3'))
        await self.db.connect()
        self.active = True
        async def principal_active(principal):
            return self.active
        source=Source()
        catalog=CapabilityCatalog(Policy())
        catalog.register('fixed',source,source,target_label='Agent')
        lease=CapabilityLease('device','instance',1)
        catalog.register('device',source,source,target_label='Laptop',lease=lease)
        self.service=SimpleNamespace(agent=SimpleNamespace(name='agent',memory_db=self.db),
            authorizer=Policy(),gateway=SimpleNamespace(runtime_principal_active=principal_active),
            runtime=SimpleNamespace(capabilities=catalog))
        self.authority=NativeAutomationAuthority(self.service)
        await self.authority.start()
        p=PrincipalRef('openagent','network','alice')
        self.context=ExecutionContext(p,p,p,'original','agent',(p,),capabilities=(lease,),ingress_id='verified')
        self.task_id=await self.db.add_task('Daily','0 9 * * *','Remember',timezone='Europe/Rome')
        self.task=await self.db.get_task(self.task_id)

    async def asyncTearDown(self):
        await self.db.close()
        self.directory.cleanup()

    async def test_unknown_definition_is_not_assigned_an_owner(self):
        with self.assertRaises(PermissionError):
            await self.authority.resolve('task',self.task,'occurrence','child')

    async def test_grant_preserves_identity_and_drops_device_capabilities(self):
        await self.authority.capture('task',self.task,self.context)
        context=await self.authority.resolve('task',self.task,'occurrence','child')
        self.assertEqual(context.initiator,self.context.initiator)
        self.assertEqual(context.author.kind,'agent')
        self.assertTrue(context.deferred)
        self.assertEqual(context.capabilities,())
        self.assertIsNone(context.ingress_id)
        self.assertEqual(context.scopes,('capability:fixed',))
        self.active=False
        self.assertFalse(await self.authority.validate(context))

    async def test_changed_definition_revokes_but_schedule_cursor_does_not(self):
        await self.authority.capture('task',self.task,self.context)
        context=await self.authority.resolve('task',self.task,'occurrence','child')
        await self.db.update_task(self.task_id,next_run=123456789,last_run=123456700)
        self.assertTrue(await self.authority.validate(context))
        await self.db.update_task(self.task_id,prompt='Changed behavior')
        self.assertFalse(await self.authority.validate(context))

    async def test_reapproval_never_revives_context_of_a_revoked_grant(self):
        first=await self.authority.capture('task',self.task,self.context)
        old=await self.authority.resolve('task',self.task,'occurrence','child')
        await self.authority.revoke('task',self.task_id,self.context)
        second=await self.authority.capture('task',self.task,self.context)
        self.assertNotEqual(first,second)
        self.assertFalse(await self.authority.validate(old))
        self.assertTrue(await self.authority.validate(await self.authority.resolve('task',self.task,'new','child2')))
