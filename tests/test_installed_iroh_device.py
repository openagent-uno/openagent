"""Authenticated Iroh -> runtime -> exact device -> real local tool effects."""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
import json
from pathlib import Path
import re
import tempfile

import aiohttp
from aiohttp import web
import test_installed_iroh_startup as startup
from iroh_device_fixture import device_fixture


class InstalledIrohDeviceTests(startup.InstalledIrohStartupTests):
    # This class adds its own acceptance scenario; the base startup scenario is
    # still run once by its original module's suite.
    test_two_registered_accounts_reach_single_runtime_and_isolate_replay = None

    @staticmethod
    def tool_data(text):
        try:
            return startup.InstalledIrohStartupTests.tool_data(text)
        except (ValueError, SyntaxError):
            if text in {
                'Tool was removed or changed after discovery',
                'Unknown or revoked tool reference; discover current tools',
                'The exact capability instance is unavailable',
            }:
                return {'isError': True, 'message': text}
            raise

    async def asyncSetUp(self):
        self.scenarios = {}
        self.devices = {}
        self.references = {}
        self.discoveries = {}
        self.model_diagnostics = []
        await super().asyncSetUp()

    async def model_reply(self, request):
        self.assertEqual(request.headers.get('Authorization'), 'Bearer fixture-only-secret')
        body = await request.json()
        self.model_requests.append(body)
        messages = body.get('messages', [])
        candidates = [(index, re.search(r'Fixture device scenario: ([a-z-]+)', str(message.get('content',''))))
                      for index,message in enumerate(messages) if message.get('role')=='user']
        candidates = [(index,match.group(1)) for index,match in candidates if match]
        self.model_diagnostics.append({'tools':len(body.get('tools',[])), 'candidates':candidates, 'user':[str(m.get('content',''))[-200:] for m in messages if m.get('role')=='user']})
        call = None
        final = 'Fixture complete.'
        if body.get('tools') and candidates:
            start, scenario = candidates[-1]
            specification = self.scenarios[scenario]
            results = [self.tool_data(message['content']) for message in messages[start:] if message.get('role')=='tool']
            step = len(results)
            if step == 0:
                call = ('tool_search_list_servers', {})
            else:
                sources = results[0]
                local = [source for source in sources if source['source_ref'].startswith('app/')]
                self.discoveries[scenario] = local
                device = self.devices.get(specification.get('device'))
                if specification['mode'] in {'absent','stale'}:
                    self.assertEqual(local, [], sources)
                    if specification['mode']=='stale' and step==1:
                        call = ('tool_search_call_tool', {'tool_ref':self.references[specification['device']], 'args':device.shell_arguments})
                    elif specification['mode']=='stale':
                        self.assertTrue(results[-1].get('isError'), results[-1])
                    final = 'Fixture device unavailable.'
                else:
                    self.assertEqual({source['source_ref'].rsplit('/',1)[-1] for source in local}, {'shell','editor','filesystem'})
                    self.assertTrue(all('/'+device.client_instance_id+'/' in source['source_ref'] for source in local), local)
                    def source(name):
                        return next(value['source_ref'] for value in local if value['source_ref'].endswith('/'+name))
                    if step == 1:
                        call = ('tool_search_list_tools', {'source_ref':source('shell')})
                    elif step == 2:
                        reference = next(tool['tool_ref'] for tool in results[1] if tool['name']=='shell_exec')
                        self.references[specification['device']] = reference
                        if specification['mode']=='revoke':
                            await device.set_consent(False)
                        call = ('tool_search_call_tool', {'tool_ref':reference, 'args':device.shell_arguments})
                    elif specification['mode']=='revoke':
                        self.assertTrue(results[-1].get('isError'), results[-1])
                        final = 'Fixture revocation applied.'
                    elif step == 3:
                        self.assertFalse(results[-1].get('isError'), results[-1])
                        call = ('tool_search_list_tools', {'source_ref':source('editor')})
                    elif step == 4:
                        reference = next(tool['tool_ref'] for tool in results[3] if tool['name']=='edit')
                        call = ('tool_search_call_tool', {'tool_ref':reference,'args':device.editor_arguments})
                    elif step == 5:
                        self.assertFalse(results[-1].get('isError'), results[-1])
                        call = ('tool_search_list_tools', {'source_ref':source('filesystem')})
                    elif step == 6:
                        reference = next(tool['tool_ref'] for tool in results[5] if tool['name']=='read_text_file')
                        call = ('tool_search_call_tool', {'tool_ref':reference,'args':device.filesystem_arguments})
                    else:
                        self.assertFalse(results[-1].get('isError'), results[-1])
                        self.assertIn('after fixture', json.dumps(results[-1]))
                        final = 'Fixture local files verified.'
        elif body.get('tools'):
            start = max((index for index,message in enumerate(messages) if message.get('role')=='user'), default=0)
            results = [self.tool_data(message['content']) for message in messages[start:] if message.get('role')=='tool']
            if not results:
                call = ('tool_search_list_servers', {})
            else:
                self.assertFalse(any(source['source_ref'].startswith('app/') for source in results[0]))
        elif 'response_format' in body:
            final = json.dumps({'summary':'Fixture complete','topics':['fixture']})
        delta = {'role':'assistant'}
        if call:
            delta['tool_calls'] = [{'index':0,'id':'fixture-'+str(len(results)),'type':'function',
                'function':{'name':call[0],'arguments':json.dumps(call[1])}}]
            reason = 'tool_calls'
        else:
            delta['content'] = final
            reason = 'stop'
        if body.get('stream'):
            response = web.StreamResponse(headers={'Content-Type':'text/event-stream'})
            await response.prepare(request)
            for content,finish in ((delta,None),({},reason)):
                chunk = {'id':'fixture','object':'chat.completion.chunk','created':1,'model':'fixture',
                    'choices':[{'index':0,'delta':content,'finish_reason':finish}]}
                await response.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            await response.write(b'data: [DONE]\n\n')
            await response.write_eof()
            return response
        for item in delta.get('tool_calls',[]):
            item.pop('index', None)
        return web.json_response({'id':'fixture','object':'chat.completion','created':1,'model':'fixture',
            'choices':[{'index':0,'message':delta,'finish_reason':reason}],
            'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}})

    async def test_two_devices_effects_revocation_disconnect_and_no_origin(self):
        with tempfile.TemporaryDirectory(prefix='openagent-v1-device-') as directory:
            root = Path(directory)
            startup.set_agent_dir(root)
            server = startup.AgentServer.from_config({'name':'fixture','_local_e2e':True,
                'memory':{'db_path':str(root/'state.sqlite3')},'channels':{},'voice':{'prefetch':False}})
            await server.agent.memory_db.connect()
            provider_id = await server.agent.memory_db.upsert_provider(name='fixture',framework='api-based',
                api_key='fixture-only-secret',base_url=str(self.provider.make_url('/v1')))
            await server.agent.memory_db.upsert_model(provider_id=provider_id,model='fixture',tier_hint='smart')
            from openagent_core.engine import module_pool
            server.agent.set_capability_pool(module_pool((), db_path=server.agent.memory_db.db_path))
            await server.agent.load_model_catalog()
            store = startup.CoordinatorStore(server.agent.memory_db)
            await store.set_network_role(role='coordinator',network_id='test-network',name='test')
            await server.agent.memory_db.close()
            nodes,proxies,dialers = [],[],[]
            try:
                await asyncio.wait_for(server.start(),20)
                state = server._network_state
                node_id = await state.node_id()
                await store.register_agent(handle='fixture',node_id=node_id,owner_handle='alice')
                relay,addresses = await state.iroh_node.local_node_addr()
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as http, AsyncExitStack() as stack:
                    urls,identities = {},{}
                    for handle in ('alice','bob'):
                        identity = startup.load_or_create_identity(root/(handle+'.key'))
                        identities[handle] = identity
                        node = startup.IrohNode(identity); nodes.append(node)
                        await node.start()
                        invitation = await store.create_invitation(role='user',created_by='test',ttl_seconds=300,uses=1,bind_to_handle=handle)
                        certificate = await startup.register(node=node,coordinator_node_id=node_id,
                            coordinator_pubkey_bytes=state.identity.public_bytes,handle=handle,password='temporary-test-password',
                            invite_code=invitation.code,device_identity=identity,network_id='test-network',relay_url=relay,addresses=list(addresses))
                        dialer = startup.SessionDialer(node=node,binding=startup.NetworkBinding('test-network','test',node_id,state.identity.public_bytes,handle,
                            coordinator_relay_url=relay,coordinator_addresses=tuple(addresses)),cert_wire=certificate)
                        dialers.append(dialer)
                        proxy = startup.LoopbackProxy(dialer=dialer,target_node_id=node_id); proxies.append(proxy)
                        await proxy.start(); urls[handle] = proxy.base_url
                        body = {'run_id':handle+'-initial','session_id':handle+'-session','idempotency_key':handle+'-initial','input':'Fixture initial session'}
                        async with http.post(proxy.base_url+'/api/runtime/runs',json=body) as response:
                            self.assertEqual(response.status,202,await response.text())
                        for _ in range(200):
                            async with http.get(proxy.base_url+'/api/runtime/runs/'+handle+'-initial') as response:
                                initial = await response.json()
                            if initial['status'] in {'success','failed','cancelled'}:break
                            await asyncio.sleep(.025)
                        self.assertEqual(initial['status'],'success',initial)
                        self.devices[handle] = await stack.enter_async_context(device_fixture(http=http,base_url=proxy.base_url,
                            workspace=root/('device-'+handle),device_id=identity.public_bytes.hex(),network_id='test-network',
                            client_instance_id='fixture-'+handle,generation=1))

                    async def turn(scenario, *, handle='alice', mode='full', device='alice', instance=True):
                        self.scenarios[scenario] = {'mode':mode,'device':device}
                        body = {'session_id':handle+'-session','request_id':scenario,'message':'Fixture device scenario: '+scenario}
                        if instance:
                            body['client_instance_id'] = self.devices[device].client_instance_id
                        async with http.post(urls[handle]+'/api/collaboration/turns',json=body) as response:
                            value = await response.json()
                            self.assertEqual(response.status,200,value)
                            self.assertFalse(value['errored'],value)
                            return value
                    for handle in ('alice','bob'):
                        result = await turn(handle+'-tools',handle=handle,device=handle)
                        self.assertIn('Fixture local files verified', result['response'], self.model_diagnostics)
                        self.devices[handle].verify_shell_effect()
                        self.devices[handle].verify_file_effect()
                    self.assertNotEqual(self.references['alice'],self.references['bob'])
                    await turn('no-client-origin',mode='absent',instance=False)
                    await turn('other-device-selected',mode='absent',device='bob')
                    await turn('revoked-after-discovery',mode='revoke')
                    await turn('revoked-tool-reference',mode='stale')
                    await self.devices['alice'].close()
                    await turn('disconnected-old-device',mode='stale')
                    await turn('ordinary-bob-ingress',handle='bob',device='bob',mode='absent',instance=False)
                    for device in self.devices.values():
                        device.verify_shell_effect()
                        device.verify_file_effect()
                    # Device tools persisted through the public catalog invocation ledger.
                    rows = await (await server.agent.memory_db._conn.execute(
                        "SELECT tool_server,tool_name FROM tool_invocations WHERE tool_server LIKE 'app/%' AND status='success'")).fetchall()
                    self.assertEqual(len(rows),6,rows)
            finally:
                for proxy in proxies: await proxy.stop()
                for dialer in dialers: await dialer.close()
                for node in nodes: await node.stop()
                await server.stop()
                startup.set_agent_dir(None)
