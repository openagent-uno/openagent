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

    async def test_document_dream_source_selection_is_stable_and_revocable(self):
        from dataclasses import replace
        from uuid import uuid4
        from sqlalchemy.ext.asyncio import create_async_engine
        from openagent_core.contracts import SessionRef
        from openagent_core.core.builtin_tasks import DREAM_MODE_TASK_NAME
        from openagent_core.memory.vault.document_dream import DreamClaim
        from openagent_server.document_vault import SPACE, create_dream_evidence
        from unittest.mock import AsyncMock
        agent = self.service.agent.name
        for name in ("vault", "sessions"):
            source = Source()
            self.service.runtime.capabilities.register(name, source, source, target_label=name)
        self.service.automations = self.authority
        self.service.runtime.authorize = AsyncMock()
        owner = self.context.initiator
        ref = SessionRef(owner.authority,owner.tenant_id,agent,"first-chat")
        store = self.service.store = SimpleNamespace(personal_session_page=AsyncMock(return_value={
            "sessions":[{"session_ref":ref.token}]}))
        ident = await self.db.add_task(DREAM_MODE_TASK_NAME,'0 4 * * *','Maintain vault')
        task = await self.db.get_task(ident)
        await self.authority.capture("task",task,self.context)
        parent = await self.authority.resolve("task",task,"occurrence","scheduled")
        claim = DreamClaim(parent.tenant_id,agent,SPACE,1,uuid4().hex,"local")
        child = replace(parent,session_id=claim.session_id,scopes=("capability:vault",claim.context_scope))
        engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(self.directory.name)/"sources.db"))
        self.addAsyncCleanup(engine.dispose)
        evidence = await create_dream_evidence(self.service, SimpleNamespace(engine=engine))
        self.assertEqual(await evidence.resolve_sessions(child, claim.scope), (ref,))
        store.personal_session_page.return_value = {"sessions":[]}
        second = await create_dream_evidence(self.service,SimpleNamespace(engine=engine))
        self.assertEqual(await second.resolve_sessions(child, claim.scope), (ref,))
        await self.authority.revoke("task", ident, self.context)
        self.assertIsNone(await second.resolve_sessions(child, claim.scope))
        store.personal_session_page.assert_awaited_once()

    async def test_document_dream_only_attenuates_the_existing_builtin_grant(self):
        from dataclasses import replace
        from openagent_core.core.builtin_tasks import DREAM_MODE_TASK_NAME
        from openagent_core.memory.vault.document_dream import DreamClaim
        from openagent_server.document_vault import SPACE
        source = Source()
        self.service.runtime.capabilities.register('vault',source,source,target_label='Vault')
        ident = await self.db.add_task(DREAM_MODE_TASK_NAME,'0 4 * * *','Maintain vault')
        task = await self.db.get_task(ident)
        await self.authority.capture('task',task,self.context)
        parent = await self.authority.resolve('task',task,'occurrence','scheduled')
        claim = DreamClaim(parent.tenant_id,parent.agent_id,SPACE,1,'a'*32,'local')
        child = replace(parent, session_id=claim.session_id, scopes=('capability:vault',claim.context_scope))
        self.assertTrue(await self.authority.validate(child))
        self.assertFalse(await self.authority.validate(replace(child,scopes=(*child.scopes,'capability:device'))))
        await self.authority.capture('task',self.task,self.context)
        other = await self.authority.resolve('task',self.task,'occurrence','scheduled')
        self.assertFalse(await self.authority.validate(replace(child,delegation_id=other.delegation_id)))
        await self.authority.revoke('task',ident,self.context)
        self.assertFalse(await self.authority.validate(child))

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

    async def test_explicit_selection_replaces_inherited_capability_scopes_and_rejects_leases(self):
        from dataclasses import replace

        owner = replace(self.context, scopes=("audit:fixture", "capability:unselected"))
        with self.assertRaises(PermissionError):
            await self.authority.capture("task", self.task, owner, sources=["fixed", "device"])
        self.assertIsNone(await self.authority.granted_sources("task", self.task))
        await self.authority.capture("task", self.task, owner, sources=["fixed"])
        delegated = await self.authority.resolve("task", self.task, "occurrence", "child")
        self.assertEqual(delegated.scopes, ("audit:fixture", "capability:fixed"))
        self.assertFalse(await self.authority.validate(replace(delegated, scopes=owner.scopes)))

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
