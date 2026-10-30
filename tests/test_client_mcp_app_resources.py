"""Exact authenticated interactive origin/lease routing for raw MCP App resources."""
import asyncio
from dataclasses import replace
import unittest
from openagent_core.capabilities import CapabilityCatalog, CapabilityUnavailable
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.core.execution_origin import execution_origin_scope
from openagent_core.mcp.catalog import register_interactive_capabilities
from openagent_server.gateway.capabilities import CapabilityRegistry, ClientCapabilityError

URI='ui://fixture/shared'
class Socket:
    closed=False
    async def close(self,**kwargs):self.closed=True

class InteractiveResourceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.registry=CapabilityRegistry();self.sent=[];self.hold=False;self.entered=asyncio.Event();self.reply_override=None
        self.catalog=CapabilityCatalog(self)
        principal=PrincipalRef('test','tenant','alice')
        self.context=ExecutionContext(principal,principal,principal,'session','agent',(principal,))
        async def send(ws,frame):
            self.sent.append(frame)
            if frame['type'] not in {'client_resource_read','client_tool_call'}:return True
            self.entered.set()
            if not self.hold:
                result=({'contents':[{'uri':URI,'mimeType':'text/html;profile=mcp-app','text':'<p>'+frame['server']+'</p>'}]}
                    if frame['type']=='client_resource_read' else {'content':[],'structuredContent':{'server':frame['server']}})
                self.registry.resolve_result(self.connection,{'call_id':frame['call_id'],'generation':4,'result':self.reply_override or result})
            return True
        self.sender=send
        servers=[{'name':name,'version':'1','resource_protocol':'mcp-app-resources/1','tools':[
            {'name':'show','input_schema':{'type':'object'},'_meta':{'ui':{'resourceUri':URI}}},
            {'name':'increment','input_schema':{'type':'object'}},
            *([{'name':'beta_only','input_schema':{'type':'object'}}] if name=='beta' else [])]} for name in ('alpha','beta')]
        self.connection=await self.registry.register(device_id='certified-device',account_id='account',network_id='network',client_instance_id='instance',generation=4,auth_epoch=7,device_label='Owned fixture',ws=Socket(),send_json=send,servers=servers)
        self.origin=self.connection.origin(self.registry)
        leases=register_interactive_capabilities(self.catalog,self.origin,source_namespace='verified/interactive')
        self.context=replace(self.context,capabilities=leases)
        with execution_origin_scope(self.origin):
            definitions=await self.catalog.discover(self.context)
        self.tool=next(tool for tool in definitions if tool.source_id.endswith('/alpha') and tool.name=='show')

    async def authorize(self,*args,**kwargs):return True
    async def asyncTearDown(self):await self.registry.close_all()

    async def direct(self,origin=None,context=None,uri=URI):
        return await self.registry.read_resource(origin or self.origin,'alpha',uri,
            execution_context=context or self.context,session_id='session',source_id=self.tool.source_id)

    async def test_same_uri_and_raw_sibling_names_remain_in_exact_original_server(self):
        with execution_origin_scope(self.origin):
            resource=await self.catalog.read_tool_resource(self.tool.tool_ref,URI,self.context)
            self.assertEqual('<p>alpha</p>',resource['contents'][0]['text'])
            result=await self.catalog.call_source_tool(self.tool.tool_ref,'increment',{},self.context)
            self.assertEqual('alpha',result['structuredContent']['server'])
            with self.assertRaises(CapabilityUnavailable):await self.catalog.call_source_tool(self.tool.tool_ref,'beta_only',{},self.context)
        self.assertTrue(all(frame.get('server')=='alpha' for frame in self.sent if frame['type'] in {'client_resource_read','client_tool_call'}))
        frame=next(frame for frame in self.sent if frame['type']=='client_resource_read')
        self.assertEqual(('account','network','session',4),(frame['account_id'],frame['network_id'],frame['session_id'],frame['generation']))

    async def test_wrong_device_instance_generation_epoch_registry_session_and_lease_are_denied(self):
        for change in ({'device_id':'other'},{'client_instance_id':'other'},{'generation':5},{'auth_epoch':8},{'auth_epoch':6},{'registry':CapabilityRegistry()}):
            with self.assertRaises(ClientCapabilityError):await self.direct(origin=replace(self.origin,**change))
        for context in [replace(self.context,session_id='another'),replace(self.context,capabilities=()),replace(self.context,deferred=True,capabilities=(),delegation_id="owned-test-delegation"),replace(self.context,capabilities=tuple(replace(lease,generation='4:6') for lease in self.context.capabilities))]:
            with self.assertRaises(ClientCapabilityError):await self.direct(context=context)
        self.assertEqual([],self.sent)

    async def test_missing_or_other_current_origin_never_reuses_saved_client_reference(self):
        for origin in [None,replace(self.origin,device_id='other')]:
            with execution_origin_scope(origin):
                with self.assertRaises(CapabilityUnavailable):await self.catalog.read_tool_resource(self.tool.tool_ref,URI,self.context)
        self.assertEqual([],self.sent)

    async def test_undeclared_old_feature_and_malformed_resource_fail_closed(self):
        with self.assertRaises(ClientCapabilityError):await self.direct(uri='ui://other/source')
        self.connection.catalog['alpha'].pop('resource_protocol')
        with self.assertRaises(ClientCapabilityError):await self.direct()
        self.connection.catalog['alpha']['resource_protocol']='mcp-app-resources/1'
        for result in [{'contents':[]},{'contents':[{'uri':'ui://other','mimeType':'text/html;profile=mcp-app','text':'x'}]},{'contents':[{'uri':URI,'mimeType':'text/html','text':'x'}]},{'contents':[{'uri':URI,'mimeType':'text/html;profile=mcp-app','text':'x'*(2*1024*1024)}]}]:
            self.reply_override=result
            with self.assertRaises(ClientCapabilityError):await self.direct()

    async def test_cancellation_and_connection_loss_do_not_replay_resource_input(self):
        self.hold=True
        pending=asyncio.create_task(self.direct());await self.entered.wait();pending.cancel()
        with self.assertRaises(asyncio.CancelledError):await pending
        read=next(frame for frame in self.sent if frame['type']=='client_resource_read')
        self.assertTrue(any(frame['type']=='client_tool_cancel' and frame['call_id']==read['call_id'] for frame in self.sent))
        self.entered.clear();pending=asyncio.create_task(self.direct());await self.entered.wait();await self.registry.unregister(self.connection)
        with self.assertRaises(ClientCapabilityError):await pending
        self.assertEqual(2,sum(frame['type']=='client_resource_read' for frame in self.sent));self.assertFalse(self.connection.pending)
