"""Installed Iroh/PAKE and real model/tool loop using a local HTTP fixture."""
import asyncio
import ast
import json
from aiohttp import web
from aiohttp.test_utils import TestServer
from pathlib import Path
import tempfile
import unittest
import aiohttp
from openagent_core.core.paths import set_agent_dir
from openagent_server.server import AgentServer
from openagent_identity.identity import load_or_create_identity
from openagent_identity.iroh_node import IrohNode
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.client.login import register
from openagent_identity.client.session import SessionDialer, NetworkBinding, LoopbackProxy


class InstalledIrohStartupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.model_requests=[]
        app=web.Application();app.router.add_post('/v1/chat/completions',self.model_reply)
        self.provider=TestServer(app);await self.provider.start_server()

    async def asyncTearDown(self):
        await self.provider.close()

    @staticmethod
    def tool_data(text):
        try:return json.loads(text)
        except ValueError:return ast.literal_eval(text)

    async def model_reply(self,request):
        self.assertEqual(request.headers.get('Authorization'),'Bearer fixture-only-secret')
        body=await request.json();self.model_requests.append(body)
        messages=body.get('messages',[])
        start=max((i for i,m in enumerate(messages) if m.get('role')=='user' and 'Fixture' in str(m.get('content',''))),default=0)
        results=[m for m in messages[start:] if m.get('role')=='tool']
        app_turn='dashboard' in str(messages[start].get('content','')).lower()
        call=None;final='Fixture complete.'
        if body.get('tools'):
            if len(results)==0:call=('tool_search_list_servers',{})
            elif len(results)==1:
                sources=self.tool_data(results[0]['content'])
                app_sources=[item for item in sources if item['source_ref'].startswith('app-dashboard/')]
                if app_turn:
                    self.assertEqual(len(app_sources),1,sources)
                    call=('tool_search_list_tools',{'source_ref':app_sources[0]['source_ref']})
                else:self.assertEqual(app_sources,[],sources)
            elif len(results)==2 and app_turn:
                discovery=self.tool_data(results[1]['content'])
                ref=next(tool['tool_ref'] for tool in discovery['tools'] if tool['name']=='ui_create_view')
                call=('tool_search_call_tool',{'tool_ref':ref,'args':{'title':'Fixture dashboard','markup':'<text>Created through the model</text>'}})
            elif app_turn:
                result=self.tool_data(results[2]['content']);self.assertTrue(result['ok'],result)
                final='Fixture dashboard created: '+result['view']['id']
        elif 'response_format' in body:final=json.dumps({'summary':'Fixture completed','topics':['fixture']})
        delta={'role':'assistant'}
        if call:
            delta['tool_calls']=[{'index':0,'id':'fixture-'+str(len(results)),'type':'function','function':{'name':call[0],'arguments':json.dumps(call[1])}}]
            reason='tool_calls'
        else:delta['content']=final;reason='stop'
        if body.get('stream'):
            response=web.StreamResponse(headers={'Content-Type':'text/event-stream'});await response.prepare(request)
            for content,finish in ((delta,None),({},reason)):
                chunk={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'fixture','choices':[{'index':0,'delta':content,'finish_reason':finish}]}
                await response.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            await response.write(b'data: [DONE]\n\n');await response.write_eof();return response
        for item in delta.get('tool_calls',[]):item.pop('index',None)
        return web.json_response({'id':'fixture','object':'chat.completion','created':1,'model':'fixture','choices':[{'index':0,'message':delta,'finish_reason':reason}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})

    async def test_two_registered_accounts_reach_single_runtime_and_isolate_replay(self):
        with tempfile.TemporaryDirectory(prefix='openagent-v1-iroh-') as directory:
            root=Path(directory)
            set_agent_dir(root)
            server=AgentServer.from_config({'name':'fixture','_local_e2e':True,
                'memory':{'db_path':str(root/'state.sqlite3')},'channels':{},'voice':{'prefetch':False}})
            await server.agent.memory_db.connect()
            provider_id=await server.agent.memory_db.upsert_provider(name='fixture',framework='api-based',api_key='fixture-only-secret',base_url=str(self.provider.make_url('/v1')))
            await server.agent.memory_db.upsert_model(provider_id=provider_id,model='fixture',tier_hint='smart')
            from openagent_modules.legacy import module_pool
            server.agent.set_capability_pool(module_pool((),db_path=server.agent.memory_db.db_path))
            await server.agent.load_model_catalog()
            store=CoordinatorStore(server.agent.memory_db)
            await store.set_network_role(role='coordinator',network_id='test-network',name='test')
            await server.agent.memory_db.close()
            nodes=[]; proxies=[]; dialers=[]
            try:
                await asyncio.wait_for(server.start(),20)
                state=server._network_state
                node_id=await state.node_id()
                await store.register_agent(handle='fixture',node_id=node_id,owner_handle='alice')
                relay,addresses=await state.iroh_node.local_node_addr()
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=45)) as http:
                    urls={}
                    for handle in ('alice','bob'):
                        identity=load_or_create_identity(root/(handle+'.key'))
                        node=IrohNode(identity);nodes.append(node)
                        await node.start()
                        invitation=await store.create_invitation(role='user',created_by='test',ttl_seconds=300,uses=1,bind_to_handle=handle)
                        certificate=await register(node=node,coordinator_node_id=node_id,
                            coordinator_pubkey_bytes=state.identity.public_bytes,handle=handle,password='temporary-test-password',
                            invite_code=invitation.code,device_identity=identity,network_id='test-network',relay_url=relay,addresses=list(addresses))
                        dialer=SessionDialer(node=node,binding=NetworkBinding('test-network','test',node_id,state.identity.public_bytes,handle,
                            coordinator_relay_url=relay,coordinator_addresses=tuple(addresses)),cert_wire=certificate)
                        dialers.append(dialer)
                        proxy=LoopbackProxy(dialer=dialer,target_node_id=node_id);proxies.append(proxy)
                        await proxy.start();urls[handle]=proxy.base_url
                        async with http.get(proxy.base_url+'/api/health') as response:
                            self.assertEqual(response.status,200)
                        body={'run_id':handle+'-run','session_id':handle+'-session','idempotency_key':handle+'-request','input':'Fixture ordinary turn'}
                        async with http.post(proxy.base_url+'/api/runtime/runs',json=body) as response:
                            self.assertEqual(response.status,202,await response.text())
                            self.assertEqual((await response.json())['run_id'],handle+'-run')
                            cursor=await server.agent.memory_db._conn.execute(
                                "SELECT author_principal_id FROM session_messages WHERE run_id=? AND role='user'",(handle+'-run',))
                            persisted=await cursor.fetchone()
                            self.assertEqual(json.loads(persisted[0])['subject_id'],handle)
                        for _ in range(200):
                            async with http.get(proxy.base_url+'/api/runtime/runs/'+handle+'-run') as response:
                                result=await response.json()
                            if result['status'] in {'success','error','cancelled'}:break
                            await asyncio.sleep(0.05)
                        self.assertEqual(result['status'],'success',result)
                        self.assertEqual(result['output'],'Fixture complete.')
                        calls_before=len(self.model_requests)
                        async with http.post(proxy.base_url+'/api/runtime/runs',json=body) as response:
                            self.assertEqual(response.status,202,await response.text())
                        self.assertEqual(len(self.model_requests),calls_before)
                    async with http.get(urls['alice']+'/api/sessions/app-created') as response:
                        self.assertEqual(response.status,404)
                    async with http.patch(urls['alice']+'/api/sessions/app-created',json={'title':'App session'}) as response:
                        self.assertEqual(response.status,200,await response.text())
                    async with http.get(urls['alice']+'/api/sessions/app-created') as response:
                        self.assertEqual(response.status,200,await response.text())
                    async with http.get(urls['bob']+'/api/sessions/app-created') as response:
                        self.assertEqual(response.status,404)
                    async with http.get(urls['alice']+'/api/runtime/runs/bob-run') as response:
                        self.assertIn(response.status,(403,404))
                    async with http.ws_connect(urls['alice']+'/ws') as socket:
                        await socket.send_json({'type':'app_capability_register','product':'openagent-app','dashboard_tools':1})
                        for _ in range(15):
                            frame=await socket.receive_json(timeout=5)
                            if frame.get('type')=='app_capability_registered':
                                connection_id=frame['connection_id'];self.assertTrue(connection_id);break
                        else:
                            self.fail('App did not receive authenticated registration acknowledgement')
                        body={'session_id':'alice-session','request_id':'alice-dashboard','message':'Fixture create dashboard','app_connection_id':connection_id}
                        async with http.post(urls['alice']+'/api/collaboration/turns',json=body) as response:
                            result=await response.json();self.assertEqual(response.status,200,result)
                            self.assertFalse(result['errored'],result)
                            self.assertIn('Fixture dashboard created:',result['response'])
                        cursor=await server.agent.memory_db._conn.execute("SELECT COUNT(*) FROM ui_views WHERE title='Fixture dashboard'")
                        self.assertEqual((await cursor.fetchone())[0],1)
                        async with http.post(urls['alice']+'/api/collaboration/turns',json=body) as response:
                            self.assertEqual(response.status,200,await response.text())
                        cursor=await server.agent.memory_db._conn.execute("SELECT COUNT(*) FROM ui_views WHERE title='Fixture dashboard'")
                        self.assertEqual((await cursor.fetchone())[0],1)
                    self.assertTrue(self.model_requests)
                    system='\n'.join(m['content'] for m in self.model_requests[0]['messages'] if m.get('role')=='system')
                    self.assertIn('tool_search_list_tools(source_ref)',system)
                    self.assertNotIn('fixture-only-secret',system)
            finally:
                for proxy in proxies: await proxy.stop()
                for dialer in dialers: await dialer.close()
                for node in nodes: await node.stop()
                await server.stop()
                set_agent_dir(None)
