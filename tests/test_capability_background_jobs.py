"""Real transport correlation feeds only the originating runtime context."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace
import unittest

from openagent_core.capabilities import CapabilityCatalog
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.core.execution_origin import execution_origin_scope
from openagent_core.jobs import BackgroundJobs
from openagent_core.mcp.catalog import register_interactive_capabilities
from openagent_server.gateway.capabilities import CapabilityRegistry, ClientCapabilityError


class BackgroundCapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.jobs = BackgroundJobs()
        self.registry = CapabilityRegistry(background_jobs=self.jobs)
        self.sent = []
        self.catalog = CapabilityCatalog(self)
        self.principal = PrincipalRef('product', 'tenant', 'alice')
        self.context = ExecutionContext(self.principal, self.principal, self.principal,
            'shared-session', 'agent', (self.principal,))

    async def authorize(self, *args, **kwargs): return True

    async def asyncTearDown(self):
        await self.registry.close_all()
        await self.jobs.close()

    async def connect(self, device='alice-mac', generation=1):
        async def send(ws, frame):
            self.sent.append(frame)
            return True
        return await self.registry.register(device_id=device, account_id='alice',
            client_instance_id='desktop', generation=generation, device_label=device,
            ws=SimpleNamespace(closed=True), send_json=send,
            servers=[{'name':'shell', 'version':'1', 'tools':[
                {'name':'shell_exec', 'classification':'mutating', 'input_schema':{'type':'object'}},
                {'name':'shell_output', 'classification':'read_only', 'input_schema':{'type':'object'}}]}])

    async def start(self, connection, shell_id='shell-1'):
        origin=connection.origin(self.registry)
        leases=register_interactive_capabilities(self.catalog, origin,
            source_namespace=f'device/{connection.device_id}/{connection.generation}')
        context=replace(self.context, capabilities=leases)
        with execution_origin_scope(origin):
            descriptor=next(d for d in await self.catalog.discover(context) if d.name=='shell_exec')
            call=asyncio.create_task(self.catalog.call_tool(descriptor.tool_ref,
                {'command':'test fixture command', 'run_in_background':True}, context))
            for _ in range(10):
                await asyncio.sleep(0)
                if self.sent: break
            frame=self.sent.pop()
            self.registry.resolve_result(connection, {'type':'client_tool_result',
                'generation':connection.generation, 'call_id':frame['call_id'],
                'result':{'content':[{'type':'text','text':'Started'}],
                    'structuredContent':{'shell_id':shell_id, 'status':'running'}, 'isError':False}})
            result=await call
        self.assertEqual(result['structuredContent']['shell_id'],shell_id)
        return context, descriptor.source_id

    def finish(self, connection, shell_id='shell-1', **event):
        return self.registry.receive_tool_event(connection, {'type':'client_tool_event',
            'generation':connection.generation, 'event':{'type':'shell_completed',
                'server':'shell', 'shell_id':shell_id, 'status':'exited', 'exit_code':0,
                'stdout_bytes':19, **event}})

    async def test_completion_has_exact_context_and_source_and_replay_is_idempotent(self):
        conn=await self.connect()
        context, source=await self.start(conn)
        other=replace(context, initiator=PrincipalRef('product','tenant','bob'))
        self.assertTrue(self.jobs.has_running(context.session_id,context_key=context.coalescing_key))
        self.assertFalse(self.jobs.has_running(other.session_id,context_key=other.coalescing_key))
        # Deliberately no active runtime or ingress at callback time. Routing
        # fields in the untrusted event cannot select a recipient or source.
        self.finish(conn,session_id='forged',source_id='another-computer',context_key=other.coalescing_key)
        self.assertEqual(self.jobs.drain(other.session_id,context_key=other.coalescing_key),[])
        events=self.jobs.drain(context.session_id,context_key=context.coalescing_key)
        self.assertEqual(len(events),1)
        self.assertEqual(events[0].source_id,source)
        self.assertEqual(events[0].tool_name,'shell_output')
        self.assertEqual(events[0].arguments,{'shell_id':'shell-1'})
        self.assertIn('stdout_bytes=19',events[0].summary)
        self.assertTrue(self.finish(conn)['duplicate'])
        self.assertEqual(self.jobs.drain(context.session_id,context_key=context.coalescing_key),[])

    async def test_another_device_cannot_complete_and_exact_reconnect_keeps_context(self):
        conn=await self.connect()
        context,_=await self.start(conn)
        other=await self.connect('alice-second-mac')
        with self.assertRaises(ClientCapabilityError): self.finish(other)
        await self.registry.unregister(conn)
        restored=await self.connect()
        self.finish(restored)
        self.assertEqual(len(self.jobs.drain(context.session_id,context_key=context.coalescing_key)),1)

    async def test_generation_and_revocation_finish_only_original_job(self):
        conn=await self.connect()
        context,_=await self.start(conn)
        await self.registry.unregister(conn)
        new=await self.connect(generation=2)
        old=self.jobs.drain(context.session_id,context_key=context.coalescing_key)
        self.assertEqual(len(old),1)
        self.assertIn('CLIENT_REPLACED',old[0].summary)
        with self.assertRaises(ClientCapabilityError): self.finish(new)
        current,_=await self.start(new,'shell-2')
        await self.registry.unregister(new)
        await self.registry.close_device('alice-mac')
        events=self.jobs.drain(current.session_id,context_key=current.coalescing_key)
        self.assertEqual(len(events),1)
        self.assertIn('CLIENT_REVOKED',events[0].summary)
        self.assertFalse(self.jobs.has_running(current.session_id,context_key=current.coalescing_key))

    async def test_missing_trusted_context_is_rejected_before_dispatch(self):
        conn=await self.connect()
        with self.assertRaises(ClientCapabilityError) as raised:
            await self.registry.call_tool(conn.origin(self.registry),'shell','shell_exec',
                {'command':'never dispatched','run_in_background':True},session_id='shared-session')
        self.assertEqual(raised.exception.code,'MISSING_EXECUTION_CONTEXT')
        self.assertEqual(self.sent,[])


if __name__=='__main__': unittest.main()
