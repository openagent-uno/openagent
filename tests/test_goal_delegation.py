"""The owner's goal carries a durable delegation; nobody else's goal, and no changed or stopped goal, does."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.capabilities import CapabilityCatalog, ToolDefinition
from openagent_core.contracts import CapabilityLease, ExecutionContext, PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_core.session_goal import GoalStore
from openagent_server import goal_delegation
from openagent_server.automation_authority import NativeAutomationAuthority


class Policy:
    async def authorize(self,context,action,resource,*,audience=()):
        return context.initiator.subject_id == 'alice'


class Source:
    async def discover(self,context):
        return (ToolDefinition('read','read a record',{'type':'object'}),)
    async def call_tool(self,name,arguments,context):
        return {}


class GoalDelegationTests(unittest.IsolatedAsyncioTestCase):
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
        self.service.automations=self.authority
        self.goals=GoalStore(self.db)
        await self.authority.start()
        p=PrincipalRef('openagent','network','alice')
        self.context=ExecutionContext(p,p,p,'original','agent',(p,),capabilities=(lease,),ingress_id='verified')
        self.task_id=await self.db.add_task('Daily','0 9 * * *','Remember',timezone='Europe/Rome')
        self.task=await self.db.get_task(self.task_id)

    async def asyncTearDown(self):
        await self.db.close()
        self.directory.cleanup()

    def _member(self):
        p=PrincipalRef('openagent','network','bob')
        return ExecutionContext(p,p,p,'original','agent',(p,),ingress_id='verified-bob')

    async def test_the_owners_active_goal_resolves_to_a_deferred_delegation(self):
        await self.goals.set('s','triage every report')
        grant=await goal_delegation.sync(self.service,'s',self.context)
        self.assertTrue(grant)
        context=await goal_delegation.context_for(self.service,'s')
        self.assertEqual((self.context.initiator,'s',grant),(context.initiator,context.session_id,context.delegation_id))
        self.assertTrue(context.deferred)
        self.assertEqual((),context.capabilities)
        self.assertTrue(await self.authority.validate(context))

    async def test_a_goal_set_by_someone_who_cannot_delegate_has_none(self):
        await self.goals.set('s','triage every report')
        self.assertIsNone(await goal_delegation.sync(self.service,'s',self._member()))
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))

    async def test_a_paused_changed_or_removed_goal_loses_its_delegation(self):
        await self.goals.set('s','triage every report')
        await goal_delegation.sync(self.service,'s',self.context)
        context=await goal_delegation.context_for(self.service,'s')
        await self.goals.pause('s','Paused by the user.')
        self.assertFalse(await self.authority.validate(context))
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))
        await self.goals.resume('s')
        self.assertTrue(await self.authority.validate(context))
        await self.goals.update('s',objective='something else entirely')
        self.assertFalse(await self.authority.validate(context))
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))
        await self.goals.clear('s')
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))
        self.assertIsNone(await goal_delegation.sync(self.service,'s',self.context))

    async def test_pausing_through_the_owner_withdraws_the_grant_for_good(self):
        await self.goals.set('s','triage every report')
        await goal_delegation.sync(self.service,'s',self.context)
        context=await goal_delegation.context_for(self.service,'s')
        await self.goals.pause('s','Paused by the user.')
        self.assertIsNone(await goal_delegation.sync(self.service,'s',self.context))
        await self.goals.resume('s')
        # Resumed by someone who cannot delegate: the withdrawn grant stays withdrawn.
        await goal_delegation.sync(self.service,'s',self._member())
        self.assertFalse(await self.authority.validate(context))
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))

    async def test_an_inactive_owner_or_an_unknown_goal_has_no_delegation(self):
        await self.goals.set('s','triage every report')
        await goal_delegation.sync(self.service,'s',self.context)
        self.active=False
        self.assertIsNone(await goal_delegation.context_for(self.service,'s'))
        self.assertIsNone(await goal_delegation.context_for(self.service,'no-such-session'))


    def _interrupt(self, session_id, run_id='run-1'):
        import json, sqlite3
        conn=sqlite3.connect(self.db.db_path); conn.execute('PRAGMA foreign_keys=OFF')
        values={'id':run_id,'session_id':session_id,'ordinal':0,'status':'interrupted','status_raw':'interrupted',
                'completeness':'complete','idempotency_key':run_id,'runner_kind':'agent',
                'output_json':json.dumps({'reason':'runtime_restarted'})}
        for _cid,name,kind,notnull,default,_pk in conn.execute('PRAGMA table_info(session_runs)'):
            if name not in values and notnull and default is None:
                values[name]=1 if 'INT' in kind.upper() else '{}' if name.endswith('_json') else 'x'
        conn.execute('INSERT INTO session_runs (%s) VALUES (%s)' % (', '.join(values), ', '.join('?' for _ in values)),
                     tuple(values.values()))
        conn.commit(); conn.close()

    async def test_after_a_restart_the_owners_goal_runs_again_and_others_pause(self):
        import asyncio
        submitted=[]
        class Runtime:
            capabilities=self.service.runtime.capabilities
            async def submit(inner, request, context): submitted.append((request, context))
            async def wait(inner, run_id, context): return SimpleNamespace(status='success')
        self.service.runtime=Runtime()
        updates=[]
        async def broadcast(kind, action, identifier): updates.append((kind, action, identifier))
        self.service.gateway.broadcast_resource=broadcast
        await self.goals.set('mine','triage every report')
        await goal_delegation.sync(self.service,'mine',self.context)
        self._interrupt('mine','run-mine')
        await self.goals.set('theirs','something a member asked for')
        await goal_delegation.sync(self.service,'theirs',self._member())
        self._interrupt('theirs','run-theirs')
        results={r['session_id']:r['action'] for r in await goal_delegation.resume_interrupted(self.service)}
        await asyncio.sleep(0)
        self.assertEqual({'mine':'resumed','theirs':'paused'},results)
        request,context=submitted[0]
        self.assertEqual(('mine','goal-restart:run-mine'),(request.session_id,request.idempotency_key))
        self.assertTrue(context.deferred and context.delegation_id)
        self.assertEqual(self.context.initiator,context.initiator)
        self.assertIn('runtime restarted',(await self.goals.get('theirs')).paused_reason)
        self.assertEqual([('session','updated','theirs')],updates)

if __name__ == '__main__':
    unittest.main()
