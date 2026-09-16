from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.automation_authority import NativeAutomationAuthority
from openagent_server.automation_management import NativeAutomationManagement
from openagent_server.automation_execution import NativeAutomationExecution


class Policy:
    deny_capture=False
    async def authorize(self,context,action,resource,*,audience=()):
        return not (self.deny_capture and action=='automation.manage' and '/' in resource.resource_id)


class Executor:
    async def execute(self,request,context,runtime):
        return 'agent response'


class AutomationManagementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory()
        path=Path(self.directory.name)/'state.sqlite3'
        self.db=MemoryDB(db_path=str(path))
        await self.db.connect()
        self.policy=Policy()
        async def active(principal): return True
        self.service=SimpleNamespace(agent=SimpleNamespace(memory_db=self.db,name='agent',config={}),
            authorizer=self.policy,gateway=SimpleNamespace(runtime_principal_active=active))
        self.authority=NativeAutomationAuthority(self.service)
        self.service.automations=self.authority
        await self.authority.start()
        self.runtime=Runtime(RuntimeSettings('agent',path.parent),RuntimeServices(
            SqliteRuntimeStore(path),Executor(),self.policy,delegations=self.authority))
        self.service.runtime=self.runtime
        self.management=NativeAutomationManagement(self.service)
        self.execution=NativeAutomationExecution(self.service)
        await self.runtime.start()
        p=PrincipalRef('openagent','network','alice')
        self.context=ExecutionContext(p,p,p,'session','agent',(p,),ingress_id='trusted')

    async def asyncTearDown(self):
        await self.runtime.close()
        await self.db.close()
        self.directory.cleanup()

    async def test_tool_definition_and_grant_commit_together(self):
        row=await self.management.call('scheduled_task','create_scheduled_task',
            {'name':'Morning','cron_expression':'0 9 * * *','prompt':'Remember','timezone':'Europe/Rome'},self.context)
        definition=await self.authority.definition('task',row['id'])
        context=await self.authority.resolve('task',definition,'occurrence','child')
        self.assertTrue(await self.authority.validate(context))
        self.policy.deny_capture=True
        with self.assertRaises(PermissionError):
            await self.management.call('scheduled_task','update_scheduled_task',
                {'task_id':row['id'],'prompt':'Unauthorized edit'},self.context)
        self.assertEqual((await self.db.get_task(row['id']))['prompt'],'Remember')
        self.assertTrue(await self.authority.validate(context))

    async def test_rest_fields_and_disable_are_captured_in_same_transaction(self):
        async def create(store):
            return await store.add_event(name='Webhook',slug='hook',action_kind='prompt',
                prompt_template='hello',secret_enc='encrypted-placeholder',rate_limit_per_min=17,max_payload_bytes=54321)
        identifier=await self.management.mutate('event',create,self.context)
        definition=await self.authority.definition('event',identifier)
        self.assertEqual(definition['rate_limit_per_min'],17)
        self.assertEqual(definition['max_payload_bytes'],54321)
        context=await self.authority.resolve('event',definition,'delivery','child')
        await self.management.mutate('event',lambda store:store.update_event(identifier,enabled=False),self.context)
        self.assertFalse(await self.authority.validate(context))

    async def test_same_delivery_runs_deterministic_operation_once(self):
        row=await self.management.call('scheduled_task','create_scheduled_task',
            {'name':'Run','cron_expression':'0 9 * * *','prompt':'Remember'},self.context)
        calls=[]
        scheduler=SimpleNamespace(db=self.db)
        async def perform(task,**kwargs):
            calls.append(task['_runtime_run_id'])
            await self.db.add_task_run(task_id=task['id'],trigger=kwargs['trigger'],run_id=task['_runtime_run_id'])
            await self.db.update_task_run(task['_runtime_run_id'],status='success')
        for _ in range(2):
            await self.execution.run_task(scheduler,row,trigger='manual',request_id='same-request',payload=None,execute=perform)
        self.assertEqual(len(calls),1)

    async def test_unapproved_manual_request_fails_before_enqueue(self):
        identifier=await self.db.add_task('Pending','* * * * *','hello',next_run=1)
        with self.assertRaisesRegex(PermissionError,'no active durable authorization'):
            await self.management.call('scheduled_task','run_scheduled_task_now',
                {'task_id':identifier,'wait':False},self.context)
        count=await (await self.db._conn.execute('SELECT COUNT(*) FROM task_run_requests')).fetchone()
        self.assertEqual(count[0],0)

    async def test_unknown_definition_remains_due_and_unexecuted(self):
        from openagent_core.core.scheduler import Scheduler
        identifier=await self.db.add_task('Pending','* * * * *','hello',next_run=1)
        task=await self.db.get_task(identifier)
        self.assertFalse(await self.execution.definition_authorized('task',task))
        scheduler=Scheduler(self.db,self.service.agent,execution_service=self.execution)
        await scheduler._recalculate_next_runs()
        await scheduler._check_and_run()
        self.assertEqual((await self.db.get_task(identifier))['next_run'],1)
        self.assertEqual(await self.db.list_task_runs(identifier),[])
