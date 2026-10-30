"""Actual canonical gateway handler/registry with owned certificate-auth ingress.

The bearer/certificate middleware is a controlled fixture, not production
cryptographic authentication proof. The registry, resource dispatch, Core catalog
and MCP Apps HTTP handler are the real product implementations.
"""
from __future__ import annotations
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
from aiohttp import web, WSMsgType
from aiohttp.test_utils import TestServer
from openagent_core.capabilities import CapabilityCatalog
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.core.execution_origin import current_execution_origin, execution_origin_scope
from openagent_core.mcp.catalog import register_interactive_capabilities, revoke_interactive_capabilities
from openagent_core.mcp_apps import McpAppService
from openagent_server.gateway.capabilities import CapabilityRegistry
from openagent_server.gateway.api.mcp_apps import handle
from openagent_host_tools.config import PluginConfigStore, PluginSpec
from openagent_host_tools.paths import HostPaths

ROOT=Path(sys.argv[1]).resolve()
PEER=Path(__file__).with_name('fixtures')/'stdio_mcp_app.py'
HTML=Path(__file__).parent.parent/'fixtures'/'counter.html'
DEVICE,INSTANCE,NETWORK,SESSION='fixture-device','fixture-instance','fixture-network','session-alice'
AUTH='Bearer owned-fixture-certificate'
URI='ui://fixture/shared'

class Authorizer:
    allowed=True
    async def authorize(self,context,*_args,**_kwargs):
        return self.allowed and context.author.subject_id=='alice'

async def main():
    policy=Authorizer();registry=CapabilityRegistry();catalog=CapabilityCatalog(policy)
    principal=PrincipalRef('fixture',NETWORK,'alice')
    context=ExecutionContext(principal,principal,principal,SESSION,'agent-1',(principal,))
    cache={'connection':None,'origin':None,'leases':()};pending=None
    paths=HostPaths.discover(ROOT/'host')
    PluginConfigStore(paths).save([PluginSpec(name=name,command=(sys.executable,str(PEER),name,str(ROOT/'peers'),str(HTML))) for name in ('alpha','beta')])
    apps=McpAppService(catalog)
    async def resolve_context(request,session_id):
        if session_id!=SESSION:raise PermissionError('Wrong session')
        return context
    async def resolve_leases(_context):
        origin=current_execution_origin()
        return cache['leases'] if origin is not None and origin==cache['origin'] else ()
    service=SimpleNamespace(runtime=SimpleNamespace(settings=SimpleNamespace(workspace=ROOT/"runtime"),capabilities=catalog,services=SimpleNamespace(registry=SimpleNamespace(bind=lambda *_:None),store=None)),authorizer=policy,
        context=resolve_context,capability_context_resolver=resolve_leases,mcp_apps=apps)
    certificate=SimpleNamespace(network_id=NETWORK,handle='alice',device_pubkey_hex=DEVICE,capabilities=())
    @web.middleware
    async def verified_fixture(request,handler):
        if request.path.startswith('/api/'):
            if request.headers.get('Authorization')!=AUTH:raise web.HTTPForbidden()
            request['device_cert']=certificate;request['auth_kind']='device_cert';request['device_auth_epoch']=7
        return await handler(request)
    app=web.Application(middlewares=[verified_fixture]);app['gateway']=SimpleNamespace(runtime_service=service,capabilities=registry)
    async def socket(request):
        ws=web.WebSocketResponse();await ws.prepare(request);connection=None
        async def send(channel,frame):
            if channel.closed:return False
            await channel.send_json(frame);return True
        try:
            first=await asyncio.wait_for(ws.receive_json(),10)
            if first.get('type')!='capability_hello' or first.get('network_id')!=NETWORK:raise ValueError('Wrong fixture hello')
            connection=await registry.register(device_id=DEVICE,account_id=NETWORK,network_id=NETWORK,client_instance_id=first['client_instance_id'],generation=first['generation'],auth_epoch=7,device_label='Owned source fixture',ws=ws,send_json=send,servers=first['servers'])
            cache['connection']=connection;cache['origin']=connection.origin(registry)
            cache['leases']=register_interactive_capabilities(catalog,cache['origin'],source_namespace='owned/client/'+str(first['generation']))
            await send(ws,{'type':'capability_hello_ack','protocol':'client-capabilities/1','device_id':DEVICE,'account_id':NETWORK,'network_id':NETWORK,'client_instance_id':INSTANCE,'generation':first['generation'],'accepted':True})
            async for message in ws:
                if message.type!=WSMsgType.TEXT:break
                frame=json.loads(message.data)
                if frame['type']=='client_tool_result':registry.resolve_result(connection,frame)
                elif frame['type']=='capability_catalog_update':await registry.update_catalog(connection,generation=frame['generation'],servers=frame['servers'])
                elif frame['type']=='capability_heartbeat':connection.last_seen_at=time.time();await send(ws,{'type':'capability_heartbeat_ack','generation':connection.generation})
                else:raise ValueError('Unexpected fixture frame '+frame['type'])
        finally:
            if connection is not None:await registry.unregister(connection)
        return ws
    app.router.add_get('/capabilities',socket)
    app.router.add_post('/api/sessions/{session_id}/mcp-apps/{operation:.+}',handle)
    server=TestServer(app);await server.start_server()
    print(json.dumps({'origin':str(server.make_url('')).rstrip('/'),'headers':{'Authorization':AUTH,'X-OpenAgent-Client-Instance':INSTANCE},'device':DEVICE,'instance':INSTANCE,'network':NETWORK,'session':SESSION,'hostHome':str(ROOT/'host')}),flush=True)
    async def tools():
        if cache['origin'] is None:raise RuntimeError('Channel not registered')
        scoped=replace(context,capabilities=cache['leases'])
        with execution_origin_scope(cache['origin']):definitions=await catalog.discover(scoped)
        return {tool.source_id.rsplit('/',1)[-1]:tool.tool_ref for tool in definitions if tool.name=='show'}
    try:
        while True:
            line=await asyncio.to_thread(sys.stdin.readline)
            if not line:break
            command=json.loads(line);action=command['action'];result={}
            try:
                if action=='tools':result={'tools':await tools()}
                elif action=='hold':(ROOT/'peers'/'alpha.hold').touch()
                elif action=='begin_read':
                    refs=await tools();scoped=replace(context,capabilities=cache['leases'])
                    with execution_origin_scope(cache['origin']):pending=asyncio.create_task(catalog.read_tool_resource(refs['alpha'],URI,scoped))
                elif action=='cancel_read':
                    if pending is None:raise RuntimeError('No pending read')
                    pending.cancel();await asyncio.gather(pending,return_exceptions=True);pending=None
                    (ROOT/'peers'/'alpha.hold').unlink(missing_ok=True)
                elif action=='stats':
                    result={name:[json.loads(line) for line in (ROOT/'peers'/f'{name}.jsonl').read_text().splitlines()] if (ROOT/'peers'/f'{name}.jsonl').exists() else [] for name in ('alpha','beta')}
                elif action=='revoke':
                    policy.allowed=False
                    if cache['connection'] is not None:await registry.unregister(cache['connection']);await cache['connection'].ws.close()
                    revoke_interactive_capabilities(catalog,cache['leases'])
                elif action=='shutdown':break
                else:raise ValueError('Unknown fixture action')
                print(json.dumps({'ack':action,**result}),flush=True)
            except Exception as exc:print(json.dumps({'ack':action,'error':str(exc)}),flush=True)
    finally:
        if pending is not None:pending.cancel();await asyncio.gather(pending,return_exceptions=True)
        await registry.close_all();await apps.shutdown();await server.close()

asyncio.run(main())
