"""Real HTTP handlers, native identity/session ACLs and exact capability dispatch."""
import asyncio
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import aiosqlite
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from openagent_core.core.on_behalf_context import install_on_behalf_identity, reset_on_behalf_identity
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.runtime_service import NativeRuntimeService
from openagent_server.gateway.capabilities import CapabilityRegistry
from openagent_server.gateway.api import devices
from openagent_server.device_directory import directory_for
from test_runtime_service import FakeAgent
from test_runtime_access import Request


class DeviceApi(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = FakeAgent(Path(self.temp.name) / 'state.sqlite3')
        seed = SqliteRuntimeStore(self.agent.memory_db.db_path)
        await seed.start(); await seed.close()
        self.authorized = True
        async def authorized(request, certificate): return self.authorized
        self.gateway = SimpleNamespace(agent=self.agent, capabilities=CapabilityRegistry(), _request_device_still_authorized=authorized)
        self.service = self.gateway.runtime_service = NativeRuntimeService(self.gateway, self.agent)
        await self.service.start()
        native_request = Request(self.gateway, 'alice')
        self.identity = await self.service.authorizer.bind_request(native_request)
        token = install_on_behalf_identity(self.identity)
        try:
            async for _ in self.service.facade.run_stream('hello', session_id='session', run_id='create-session'): pass
        finally: reset_on_behalf_identity(token)
        self.db = await aiosqlite.connect(self.agent.memory_db.db_path)
        self.db.row_factory = aiosqlite.Row
        async def connected(): return self.db
        self.agent.memory_db._ensure_connected = connected
        self.sent = []
        self.gateway.capabilities.record_device_use = directory_for(self.gateway).used
        async def send(ws, frame):
            self.sent.append(frame)
            if frame['type'] == 'client_tool_call':
                self.gateway.capabilities.resolve_result(self.host, {'call_id': frame['call_id'], 'generation': 1, 'result': {'content': []}})
            return True
        self.host = await self.gateway.capabilities.register(device_id='other-owned-computer', owner_handle='alice', account_id='network', network_id='network',
            client_instance_id='desktop', generation=1, device_label='Owned computer', ws=SimpleNamespace(closed=False), send_json=send,
            servers=[{'name': 'computer-control', 'tools': [{'name': 'computer', 'input_schema': {'type': 'object', 'properties': {'action': {'type': 'string'}}}}]}])
        await directory_for(self.gateway).remember(self.host)
        @web.middleware
        async def identity(request, handler):
            for key, value in native_request.items(): request[key] = value
            return await handler(request)
        async def process_host(request):
            # A trusted certificate-ingress seam; no claim of physical-device
            # enrollment or cryptographic acceptance is made by this fixture.
            device=request.match_info['device']
            if device not in {'process-a','process-b'}: raise web.HTTPForbidden()
            ws=web.WebSocketResponse();await ws.prepare(request)
            hello=await ws.receive_json(timeout=10)
            connection=await self.gateway.capabilities.register(device_id=device,owner_handle='alice',account_id='network',network_id='network',
                client_instance_id=hello['client_instance_id'],generation=hello['generation'],device_label=device,ws=ws,
                send_json=lambda socket,frame: send_process(socket,frame),servers=hello['servers'])
            try:
                await ws.send_json({'type':'capability_hello_ack','protocol':'client-capabilities/1','device_id':device,
                    'account_id':'network','network_id':'network','client_instance_id':connection.client_instance_id,'generation':1,'accepted':True})
                async for msg in ws:
                    if msg.type!=web.WSMsgType.TEXT:break
                    frame=json.loads(msg.data)
                    if frame.get('type')=='client_tool_result':self.gateway.capabilities.resolve_result(connection,frame)
                    elif frame.get('type')=='capability_heartbeat':
                        await ws.send_json({'type':'capability_heartbeat_ack','generation':1})
            finally:await self.gateway.capabilities.unregister(connection)
            return ws
        async def send_process(socket,frame):await socket.send_json(frame);return True
        app = web.Application(middlewares=[identity]); app['gateway'] = self.gateway
        app.router.add_get('/fixture/capabilities/{device}', process_host)
        app.router.add_get('/api/devices', devices.handle_devices)
        app.router.add_get('/api/devices/computer-targets', devices.handle_targets)
        app.router.add_post('/api/devices/computer', devices.handle_computer)
        app.router.add_get('/api/sessions/{session_id}/devices', devices.handle_session_devices)
        app.router.add_get('/api/sessions/{session_id}/computer-targets', devices.handle_targets)
        app.router.add_post('/api/sessions/{session_id}/computer', devices.handle_computer)
        app.router.add_get('/api/sessions/{session_id}/computer-stream', devices.handle_stream)
        app.router.add_get('/api/sessions/{session_id}/participants', devices.handle_participants)
        self.client = TestClient(TestServer(app)); await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.gateway.capabilities.unregister(self.host)
        await self.db.close(); await self.service.close(); self.temp.cleanup()

    async def test_round_trip_uses_catalog_authority_and_records_session_device(self):
        response = await self.client.get('/api/devices'); self.assertEqual(200, response.status)
        self.assertTrue((await response.json())['devices'][0]['online'])
        response = await self.client.get('/api/sessions/session/computer-targets'); self.assertEqual(200, response.status)
        target = (await response.json())['targets'][0]
        response = await self.client.post('/api/sessions/session/computer', json={'tool_ref': target['tool_ref'], 'action': 'left_click', 'coordinate': [4, 7]})
        self.assertEqual(200, response.status, await response.text())
        self.assertEqual('other-owned-computer', self.host.device_id)
        self.assertEqual({'action': 'left_click', 'coordinate': [4, 7]}, self.sent[0]['args'])
        response = await self.client.get('/api/sessions/session/devices')
        self.assertEqual('Owned computer', (await response.json())['devices'][0]['label'])
        response = await self.client.post('/api/sessions/session/computer', json={'tool_ref': 'forged', 'action': 'get_screenshot'})
        self.assertEqual(409, response.status)
        self.assertEqual(1, len(self.sent))

    async def test_missing_session_and_current_certificate_revocation_fail_closed(self):
        response = await self.client.get('/api/sessions/unknown/devices'); self.assertEqual(404, response.status)
        response = await self.client.get('/api/sessions/session/computer-targets'); target = (await response.json())['targets'][0]
        self.authorized = False
        response = await self.client.post('/api/sessions/session/computer', json={'tool_ref': target['tool_ref'], 'action': 'get_screenshot'})
        self.assertEqual(403, response.status)
        self.assertFalse(self.sent)

    async def test_agent_desktop_uses_native_host_and_separates_view_from_control(self):
        import sys
        from unittest.mock import patch

        from openagent_server.agent_desktop import AgentDesktop

        async def active(principal):
            return principal.subject_id == "alice"

        async def owner():
            return self.owner

        self.owner = "alice"
        self.service.directory.principal_active = active
        self.service.directory.owner_handle = owner
        self.agent.product_environment = dict(os.environ, OPENAGENT_DESKTOP_VIEWERS="")
        fixture = Path(self.temp.name) / "native-desktop.py"
        fixture.write_text("""
import json
import pathlib
import sys

role, log = sys.argv[1:3]
request = json.loads(sys.stdin.readline())
with pathlib.Path(log).open("a") as file:
    file.write(json.dumps([role, request]) + chr(10))
action = request["action"]
if action == "monitors":
    result = {"monitors": [{"id": "7", "width": 800, "height": 600}]}
elif action == "screenshot":
    result = {"width": 400, "height": 300, "mimeType": "image/png", "data": "iVBORw0KGgo="}
else:
    result = {}
print(json.dumps({"id": request["id"], "ok": True, "result": result}))
""")
        log = Path(self.temp.name) / "native-desktop.ndjson"
        control = (sys.executable, str(fixture), "control", str(log))
        view = (sys.executable, str(fixture), "view", str(log))
        endpoint = "/api/devices/computer"
        with patch.object(AgentDesktop, "_commands", return_value=(control, view)):
            response = await self.client.get(endpoint + "-targets")
            self.assertEqual(200, response.status, await response.text())
            inventory = await response.json()
            self.assertEqual("available", inventory["host"]["desktop"])
            target, = inventory["targets"]
            self.assertTrue(target["agent_host"])
            self.assertTrue(target["can_control"])
            reference = target["tool_ref"]

            personal = (await (await self.client.get("/api/sessions/session/computer-targets")).json())["targets"][0]
            response = await self.client.post(endpoint, json={"tool_ref": personal["tool_ref"], "action": "get_screenshot"})
            self.assertEqual(409, response.status)
            response = await self.client.post(endpoint, json={"tool_ref": reference, "action": "get_screenshot"})
            self.assertEqual(200, response.status, await response.text())
            self.assertEqual("image", (await response.json())["content"][1]["type"])
            click = {"tool_ref": reference, "action": "left_click", "coordinate": [399, 299], "screen_size": [400, 300]}
            response = await self.client.post(endpoint, json=click)
            self.assertEqual(200, response.status, await response.text())

            self.owner = "bob"
            inventory = await (await self.client.get(endpoint + "-targets")).json()
            self.assertEqual("restricted", inventory["host"]["desktop"])
            self.assertEqual([], inventory["targets"])
            response = await self.client.post(endpoint, json={"tool_ref": reference, "action": "get_screenshot"})
            self.assertEqual(403, response.status)
            self.agent.product_environment["OPENAGENT_DESKTOP_VIEWERS"] = "alice"
            inventory = await (await self.client.get(endpoint + "-targets")).json()
            self.assertFalse(inventory["targets"][0]["can_control"])
            response = await self.client.post(endpoint, json={"tool_ref": reference, "action": "get_screenshot"})
            self.assertEqual(200, response.status)
            response = await self.client.post(endpoint, json=click)
            self.assertEqual(403, response.status)
            self.authorized = False
            response = await self.client.post(endpoint, json={"tool_ref": reference, "action": "get_screenshot"})
            self.assertEqual(403, response.status)

        actions = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(["monitors", "screenshot", "click", "screenshot"], [call["action"] for _, call in actions])
        self.assertEqual(["view", "view", "control", "view"], [role for role, _ in actions])
        self.assertEqual((1.0, 1.0), (actions[2][1]["x"], actions[2][1]["y"]))
        self.assertEqual([], self.sent)

    async def test_authoritative_session_participants(self):
        response = await self.client.get('/api/sessions/session/participants')
        self.assertEqual(200, response.status)
        self.assertEqual({'alice'}, {p['handle'] for p in (await response.json())['participants']})

    async def test_browser_computer_is_not_a_desktop_target(self):
        from openagent_device_tools.sidecars import AGENT_IN_CHROME_MANIFEST
        browser = next(tool for tool in AGENT_IN_CHROME_MANIFEST.tools if tool.name == 'computer')
        schema = browser.input_schema
        await self.gateway.capabilities.update_catalog(self.host, generation=1, servers=[
            *({**server, 'tools': list(server['tools'])} for server in self.host.catalog.values()),
            {'name': 'agent-in-chrome', 'tools': [{'name': 'computer', 'input_schema': schema}]},
        ])
        response = await self.client.get('/api/sessions/session/computer-targets')
        self.assertEqual(200, response.status)
        self.assertEqual(1, len((await response.json())['targets']))

    async def test_idle_desktop_keeps_exact_stream_open(self):
        from unittest.mock import patch
        self.host.media_protocols = ('openagent-video/1',)
        context = await self.service.authorizer.context_for_identity(self.identity, 'session')
        token = install_on_behalf_identity(self.identity)
        try:
            from dataclasses import replace
            context = replace(context, capabilities=tuple(await self.service._capability_context(context)))
        finally:
            reset_on_behalf_identity(token)
        lease = next(lease for lease in context.capabilities if lease.source_id.endswith('/computer-control'))
        iterator = self.gateway.capabilities.stream_tool(self.host.origin(self.gateway.capabilities),
            'computer-control', 'computer', {}, execution_context=context, source_id=lease.source_id)
        original_wait = asyncio.wait_for
        async def short_wait(awaitable, timeout):
            return await original_wait(awaitable, .01 if timeout == 20 else timeout)
        with patch('openagent_server.gateway.capabilities.asyncio.wait_for', short_wait):
            pending = asyncio.create_task(anext(iterator))
            await asyncio.sleep(.04)
            self.assertFalse(pending.done(), 'An unchanged desktop must not disconnect')
            stream = next(iter(self.host.media))
            self.gateway.capabilities.receive_media(self.host, {'type': 'client_media_packet',
                'stream_id': stream, 'generation': 1, 'packet': {'type': 'frame'}})
            self.assertEqual({'type': 'frame'}, await original_wait(pending, 1))
            await iterator.aclose()

    async def test_live_stream_exact_generation_close_and_revocation(self):
        self.host.media_protocols=('openagent-video/1',)
        await self.gateway.capabilities.update_catalog(self.host,generation=1,servers=[{**server,'tools':list(server['tools'])} for server in self.host.catalog.values()])
        response=await self.client.get('/api/sessions/session/computer-targets')
        target=(await response.json())['targets'][0]
        self.assertEqual('openagent-video/1',target['live_media'])
        ws=await self.client.ws_connect('/api/sessions/session/computer-stream')
        await ws.send_json({'tool_ref':target['tool_ref'],'options':{'fps':20}})
        for _ in range(100):
            if self.host.media:break
            await asyncio.sleep(.01)
        stream=next(iter(self.host.media))
        self.gateway.capabilities.receive_media(self.host,{'type':'client_media_packet','stream_id':stream,'generation':0,'packet':{'type':'bad'}})
        self.gateway.capabilities.receive_media(self.host,{'type':'client_media_packet','stream_id':stream,'generation':1,'packet':{'type':'config','protocol':'openagent-video/1'}})
        self.assertEqual('config',(await ws.receive_json(timeout=2))['type'])
        self.authorized=False
        self.gateway.capabilities.receive_media(self.host,{'type':'client_media_packet','stream_id':stream,'generation':1,'packet':{'type':'frame','seq':0}})
        self.assertEqual('error',(await ws.receive_json(timeout=2))['type'])
        await ws.close()
        for _ in range(100):
            if not self.host.media:break
            await asyncio.sleep(.01)
        self.assertFalse(self.host.media)
        self.assertTrue(any(f['type']=='client_media_close' for f in self.sent))

    async def test_live_stream_validates_options_before_start(self):
        response=await self.client.get('/api/sessions/session/computer-targets');target=(await response.json())['targets'][0]
        ws=await self.client.ws_connect('/api/sessions/session/computer-stream')
        await ws.send_json({'tool_ref':target['tool_ref'],'options':{'fps':200}})
        self.assertEqual('error',(await ws.receive_json(timeout=2))['type']);await ws.close()
        self.assertFalse(self.host.media)

    @unittest.skipUnless(os.environ.get('OPENAGENT_TEST_DEVICE_PROCESSES')=='1','requires qualified desktop SDK/native artifact')
    async def test_two_owned_process_hosts_execute_and_disconnect_without_fallback(self):
        from dataclasses import replace
        from openagent_core.runtime import execution_scope
        root=Path(__file__).resolve().parents[1]/'apps/app/desktop'
        processes=[]
        token=install_on_behalf_identity(self.identity)
        try:
            for device in ('process-a','process-b'):
                url=str(self.client.make_url('/fixture/capabilities/'+device)).replace('http:','ws:')
                processes.append(await asyncio.create_subprocess_exec(shutil.which('node'),str(root/'e2e/capability-process-host.cjs'),url,device,
                    cwd=root,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL))
            for _ in range(500):
                hosts=self.gateway.capabilities.owned_connections(self.identity)
                if len([host for host in hosts if host.device_id.startswith('process-')])==2:break
                await asyncio.sleep(.02)
            self.assertEqual(2,len([host for host in hosts if host.device_id.startswith('process-')]))
            context=await self.service.authorizer.context_for_identity(self.identity,'session')
            context=replace(context,capabilities=tuple(await self.service.capability_context_resolver(context)))
            catalog=self.service.runtime.capabilities
            with execution_scope(self.service.runtime,context,None):
                tools={tool.target_label:tool for tool in await catalog.discover(context) if tool.name=='exec'}
                for label in ('process-a','process-b'):
                    result=await catalog.call_tool(tools[label].tool_ref,{'command':'echo '+label},context,surface='app')
                    self.assertEqual(label,json.loads(result['content'][0]['text'])['output'].strip())
                processes[0].terminate();await processes[0].wait()
                for _ in range(100):
                    if not any(host.device_id=='process-a' for host in self.gateway.capabilities.owned_connections(self.identity)):break
                    await asyncio.sleep(.02)
                with self.assertRaises((LookupError,RuntimeError)):
                    await catalog.call_tool(tools['process-a'].tool_ref,{'command':'echo forbidden'},context,surface='app')
                result=await catalog.call_tool(tools['process-b'].tool_ref,{'command':'echo still-owned'},context,surface='app')
                self.assertEqual('still-owned',json.loads(result['content'][0]['text'])['output'].strip())
        finally:
            reset_on_behalf_identity(token)
            for process in processes:
                if process.returncode is None:process.terminate()
                await asyncio.wait_for(process.wait(),timeout=5)
