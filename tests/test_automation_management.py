import asyncio
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from openagent_core import Runtime, RuntimeServices, RuntimeSettings
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.automation_authority import NativeAutomationAuthority
from openagent_server.automation_management import (
    AutomationRevisionChanged,
    NativeAutomationManagement,
)
from openagent_server.automation_execution import NativeAutomationExecution
from openagent_server.automation_execution import _runtime_deadline_seconds


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
        self.service.automation_management=self.management
        self.service.automation_execution=self.execution
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

    async def test_task_policy_timeout_outlives_inner_execution_budget(self):
        self.service.agent.config={'automation': {'deadline_seconds': 960}}
        row=await self.management.call('scheduled_task','create_scheduled_task',
            {'name':'Long pipeline','cron_expression':'0 9 * * *','prompt':'Publish',
             'execution_policy': {'timeout_seconds': 3600}},self.context)
        requests=[]
        execute_operation=self.runtime.execute_operation

        async def capture(request,context,operation):
            requests.append(request)
            return await execute_operation(request,context,operation)

        self.runtime.execute_operation=capture
        scheduler=SimpleNamespace(db=self.db)

        async def perform(task,**kwargs):
            await self.db.add_task_run(task_id=task['id'],trigger=kwargs['trigger'],run_id=task['_runtime_run_id'])
            await self.db.update_task_run(task['_runtime_run_id'],status='success')

        await self.execution.run_task(
            scheduler,row,trigger='manual',request_id='long-request',payload=None,
            execute=perform,
        )

        self.assertEqual(len(requests),1)
        self.assertEqual(requests[0].deadline_seconds,3630)

    def test_event_policy_timeout_uses_the_same_outer_deadline_rule(self):
        self.assertEqual(
            _runtime_deadline_seconds(
                {},'event',{'execution_policy': {'timeout_seconds': 1800}},
            ),
            1830,
        )
        self.assertEqual(_runtime_deadline_seconds({},'workflow',{}),960)

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

    async def test_historical_task_requires_exact_review_and_resumes_in_future(self):
        identifier=await self.db.add_task('Pending','* * * * *','hello',next_run=1)

        review=await self.management.review_authorization(
            'scheduled_task',identifier,self.context,
        )
        self.assertFalse(review['authorized'])
        self.assertEqual(review['definition']['id'],identifier)
        with self.assertRaises(AutomationRevisionChanged):
            await self.management.approve_authorization(
                'scheduled_task',identifier,'0'*64,self.context,
            )

        before=time.time()
        result=await self.management.approve_authorization(
            'scheduled_task',identifier,review['digest'],self.context,
        )
        self.assertTrue(result['authorized'])
        self.assertEqual(result['schedules_reconciled'],1)
        self.assertGreater((await self.db.get_task(identifier))['next_run'],before)
        approved=await self.management.review_authorization(
            'scheduled_task',identifier,self.context,
        )
        self.assertTrue(approved['authorized'])

    async def test_historical_workflow_and_event_can_be_reviewed_and_approved(self):
        workflow_id=await self.db.add_workflow(name='Historical workflow')
        event_id=await self.db.add_event(
            name='Historical event',slug='historical-event',action_kind='prompt',
            prompt_template='hello',secret_enc='encrypted-placeholder',
        )

        for kind,identifier in (
            ('workflow',workflow_id),
            ('event',event_id),
        ):
            review=await self.management.review_authorization(
                kind,identifier,self.context,
            )
            self.assertFalse(review['authorized'])
            self.assertNotIn('secret_enc',review['definition'])
            result=await self.management.approve_authorization(
                kind,identifier,review['digest'],self.context,
            )
            self.assertTrue(result['authorized'])
            self.assertTrue((await self.management.review_authorization(
                kind,identifier,self.context,
            ))['authorized'])

    async def test_explicit_config_action_captures_and_revokes_builtin_revision(self):
        identifier=await self.db.add_task('dream-mode','* * * * *','dream',next_run=1)

        captured=await self.management.capture_current_authorizations(
            'scheduled_task',[identifier],self.context,
        )
        self.assertTrue(captured[0]['authorized'])
        self.assertEqual(captured[0]['schedules_reconciled'],1)
        definition=await self.authority.definition('task',identifier)
        delegated=await self.authority.resolve(
            'task',definition,'occurrence','child',
        )
        self.assertTrue(await self.authority.validate(delegated))

        await self.db.update_task(identifier,enabled=0,next_run=None)
        revoked=await self.management.capture_current_authorizations(
            'scheduled_task',[identifier],self.context,
        )
        self.assertFalse(revoked[0]['authorized'])
        self.assertFalse(await self.authority.validate(delegated))

    async def test_approved_one_shot_executes_end_to_end_exactly_once(self):
        from openagent_core.core.scheduler import Scheduler

        identifier=await self.db.add_task(
            'One shot','@once:1','hello',next_run=1,
        )
        review=await self.management.review_authorization(
            'scheduled_task',identifier,self.context,
        )
        approved=await self.management.approve_authorization(
            'scheduled_task',identifier,review['digest'],self.context,
        )
        self.assertEqual(approved['schedules_reconciled'],0)

        calls=[]
        scheduler=Scheduler(
            self.db,self.service.agent,execution_service=self.execution,
        )

        async def perform(task,**_kwargs):
            calls.append(task['_runtime_run_id'])
            await self.db.update_task_run(
                task['_runtime_run_id'],status='success',output='done',
                finished_at=time.time(),
            )

        scheduler._execute_task=perform
        await scheduler._check_and_run()
        if scheduler._workflow_tasks:
            await asyncio.gather(*tuple(scheduler._workflow_tasks))
        await scheduler._check_and_run()

        task=await self.db.get_task(identifier)
        runs=await self.db.list_task_runs(identifier)
        self.assertFalse(task['enabled'])
        self.assertIsNone(task['next_run'])
        self.assertEqual(len(calls),1)
        self.assertEqual(len(runs),1)
        self.assertEqual(runs[0]['status'],'success')
        self.assertFalse(
            await self.execution.definition_authorized('task',task),
        )

    async def test_approved_one_shot_real_child_keeps_delegation_until_publish(self):
        """The durable child run is part of the already-admitted occurrence.

        A one-shot is disabled atomically when its task_runs row is claimed.
        Its child session therefore has to prove ancestry back to that claimed
        occurrence instead of relying on the now-disabled definition.  The
        simpler test above replaces the child executor and cannot cover this
        second Runtime admission boundary.
        """
        from openagent_core.core.scheduler import Scheduler

        identifier=await self.db.add_task(
            'One shot with child','@once:1','hello',next_run=1,
        )
        review=await self.management.review_authorization(
            'scheduled_task',identifier,self.context,
        )
        await self.management.approve_authorization(
            'scheduled_task',identifier,review['digest'],self.context,
        )

        scheduler=Scheduler(
            self.db,self.service.agent,execution_service=self.execution,
        )
        await scheduler._check_and_run()
        if scheduler._workflow_tasks:
            await asyncio.gather(
                *tuple(scheduler._workflow_tasks), return_exceptions=True,
            )

        task=await self.db.get_task(identifier)
        runs=await self.db.list_task_runs(identifier)
        self.assertFalse(task['enabled'])
        self.assertEqual(len(runs),1)
        self.assertEqual(runs[0]['status'],'success',runs[0].get('error'))
        self.assertFalse(
            await self.execution.definition_authorized('task',task),
        )
