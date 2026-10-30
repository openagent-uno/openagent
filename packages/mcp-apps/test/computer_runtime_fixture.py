"""Real adopter gateway/catalog with a controlled authenticated CP-to-computer ingress.

The lease/signature/control-plane HTTP path has its own Go acceptance suite. This
fixture forwards the three real Computers MCP methods to an owned Node desktop
executor; it does not claim production authentication proof.
"""
import asyncio
import importlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch
from aiohttp import ClientSession, web

repo, product, origin, secret, home = sys.argv[1:6]
repo, home = Path(repo), Path(home)
sys.path.insert(0, str(repo/'runtime/openagent/tests/v1'))
if os.environ.get('OPENAGENT_TEST_INSTALLED_RUNTIME') != '1':
    sys.path.insert(0, str(repo/'runtime/openagent/src'))
fixtures=importlib.import_module('test_runtime_contract')
identity=importlib.import_module(product+'_agent_runtime.identity')
from openagent_host_tools.config import PluginConfigStore, PluginSpec
from openagent_host_tools.paths import HostPaths
from openagent_core import RunRequest
from openagent_core.runtime import execution_scope

PEER=Path(__file__).with_name('fixtures')/'stdio_mcp_app.py'
HTML=Path(__file__).parent.parent/'fixtures'/'counter.html'
PluginConfigStore(HostPaths(home)).save([PluginSpec(name=name,command=(sys.executable,str(PEER),name,str(home/'peers'),str(HTML))) for name in ('alpha','beta')])

async def main():
    fixture=fixtures.RuntimeFixture();client=ClientSession();original=fixtures.ControlPlaneFixture.mcp
    async def mcp(plane,request):
        if request.method!='POST':return await original(plane,request)
        body=await request.json();method=body.get('method')
        if method not in {'openagent/computers/mcp/catalog','openagent/computers/mcp/call','resources/read'}:
            return await original(plane,request)
        actor=plane.actor(request.headers.get('X-'+('GlassPalace' if product=='glasspalace' else 'ICS')+'-Actor-Context',''))
        if actor in plane.revoked:raise web.HTTPForbidden()
        # Attribution comes from this verified fixture ingress, never method params.
        params=body.get('params',{});session='session-'+actor
        async with client.post(origin,headers={'Authorization':'Bearer '+secret},json={'method':method,'params':params,'actor':actor,'session':session}) as response:
            value=await response.json()
            if response.status!=200:raise web.HTTPForbidden(text=json.dumps(value))
        if actor in plane.revoked:raise web.HTTPForbidden()
        return web.json_response({'jsonrpc':'2.0','id':body['id'],'result':value})
    patcher=patch.object(fixtures.ControlPlaneFixture,'mcp',mcp);patcher.start()
    started=False
    try:
        await fixture.asyncSetUp();started=True
        token=('gp_actor_' if product=='glasspalace' else 'ics_actor_')+'alice'
        with identity.actor_scope(token):
            ctx=await fixture.identity.resolve(token)
            definitions=await fixture.catalog.discover(ctx)
            tools={tool.target_label.rsplit(' / ',1)[-1]:tool for tool in definitions if tool.source_id.startswith('computer_mcp_') and tool.name=='show'}
            if set(tools)!={'alpha','beta'}:raise RuntimeError('Missing independent computer sources: '+repr(tools))
            await fixture.store.accept(RunRequest('display-run',ctx.session_id,'display-run','display'),ctx)
            await fixture.store.transition('display-run','running')
            with execution_scope(fixture.runtime,ctx,'display-run'):
                await fixture.catalog.call_tool(tools['alpha'].tool_ref,{},ctx,call_id='client-show')
        print(json.dumps({'origin':str(fixture.server.make_url('')).rstrip('/'),'prefix':'/api/mcp-apps','headers':fixture.headers(),'toolRef':tools['alpha'].tool_ref,'betaRef':tools['beta'].tool_ref,'toolCallId':'client-show'}),flush=True)
        while True:
            line=await asyncio.to_thread(sys.stdin.readline)
            if not line:break
            command=json.loads(line);action=command.get('action');result={}
            if action=='shutdown':break
            if action=='revoke':fixture.plane.revoked.add('alice')
            elif action=='stats':
                result={name:[json.loads(row) for row in (home/'peers'/f'{name}.jsonl').read_text().splitlines()] if (home/'peers'/f'{name}.jsonl').exists() else [] for name in ('alpha','beta')}
            print(json.dumps({'ack':action,**result}),flush=True)
    finally:
        if started:await fixture.asyncTearDown()
        await client.close();patcher.stop()

asyncio.run(main())
