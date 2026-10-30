"""Owned local acceptance peer; uses real adopter HTTP, Core catalog and MCP stdio."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import sys

repo = Path(sys.argv[1]).resolve()
product = sys.argv[2]
fixture_repo = Path(os.environ.get('OPENAGENT_TEST_RUNTIME_FIXTURE_ROOT', str(repo))).resolve()
sys.path.insert(0, str(fixture_repo/'runtime/openagent/tests/v1'))
if os.environ.get('OPENAGENT_TEST_INSTALLED_RUNTIME') != '1':
    sys.path.insert(0, str(fixture_repo/'runtime/openagent/src'))
fixtures = importlib.import_module('test_mcp_apps')
html = Path(sys.argv[3]).read_text()
fixtures.APP = fixtures.APP.replace('return "<!doctype html><button id=\'increment\'>Increment</button>"', 'return ' + repr(html))

async def main():
    fixture = fixtures.MCPAppsContracts()
    standalone = None
    try:
        await fixture.asyncSetUp()
        server = fixture.server
        prefix = '/api/mcp-apps'
        if product == 'standalone':
            from aiohttp import web
            from aiohttp.test_utils import TestServer
            from types import SimpleNamespace
            sys.path.insert(0, str(repo/'apps/server/src'))
            from openagent_server.gateway.api.mcp_apps import handle
            from glasspalace_agent_runtime.identity import actor_scope
            async def context(request, session_id):
                token = fixture.binding.verify(request.headers)
                value = await fixture.identity.resolve(token)
                if value.session_id != session_id:
                    raise PermissionError('Wrong verified session')
                return value
            async def leases(context):
                return context.capabilities
            service = SimpleNamespace(runtime=fixture.runtime,authorizer=fixture.authorizer,
                context=context,capability_context_resolver=leases)
            @web.middleware
            async def verified(request, handler):
                token = fixture.binding.verify(request.headers)
                with actor_scope(token):
                    return await handler(request)
            app=web.Application(middlewares=[verified])
            app['gateway']=SimpleNamespace(runtime_service=service)
            app.router.add_post('/api/sessions/{session_id}/mcp-apps/{operation:.+}',handle)
            standalone=server=TestServer(app)
            await standalone.start_server()
            prefix='/api/sessions/session-alice/mcp-apps'
        print(json.dumps({'origin':str(server.make_url('')).rstrip('/'),'prefix':prefix,'headers':fixture.headers(),'toolRef':fixture.tool_ref}),flush=True)
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:break
            command=json.loads(line)
            if command.get('action')=='revoke':fixture.plane.revoked.add('alice')
            elif command.get('action')=='shutdown':break
            print(json.dumps({'ack':command.get('action')}),flush=True)
    finally:
        if standalone is not None:
            await standalone.close()
        await fixture.asyncTearDown()

asyncio.run(main())
