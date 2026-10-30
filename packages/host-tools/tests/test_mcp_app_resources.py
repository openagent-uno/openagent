"""Real MCP stdio HTML transport with explicit ownership and no shared daemon."""
from __future__ import annotations
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
from openagent_capability_host.host import CapabilityHost
from openagent_capability_host.mcp_stdio import MCPStdioServer
from openagent_capability_host.config import PluginSpec
from openagent_capability_host.paths import HostPaths
from openagent_tool_protocol.types import HostError
from openagent_host_tools.control import dispatch_control

URI='ui://fixture/counter'
SCRIPT='''from mcp.server.fastmcp import FastMCP
import asyncio,json,os
from pathlib import Path
mcp=FastMCP("resource-fixture")
root=Path(os.environ["RESOURCE_FIXTURE_HOME"])
(root/"peer-pid").write_text(str(os.getpid()))
@mcp.tool(meta={"ui":{"resourceUri":"ui://fixture/counter"}})
def show() -> str:return "counter"
@mcp.resource("ui://fixture/counter",mime_type="text/html;profile=mcp-app")
async def resource() -> str:
 path=root/"reads";path.write_text(str(int(path.read_text())+1) if path.exists() else "1")
 if (root/"hold").exists():await asyncio.sleep(20)
 return "x"*(3*1024*1024) if (root/"oversize").exists() else "<button>Counter</button>"
mcp.run(transport="stdio")
'''


class McpAppResourceTransport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mcp-resource-owned-');self.root=Path(self.temp.name)
        script=self.root/'peer.py';script.write_text(SCRIPT)
        self.adapter=MCPStdioServer(PluginSpec(name='resource-fixture',command=(sys.executable,str(script)),env={'RESOURCE_FIXTURE_HOME':str(self.root)}),restart_limit=0)
        self.host=None
        try:
            await self.adapter.start()
            self.host=CapabilityHost(paths=HostPaths(self.root/'host'),servers=(self.adapter,))
            await self.host.start();await self.host.set_consent(True)
        except BaseException:
            await self.adapter.close();self.temp.cleanup();raise

    async def asyncTearDown(self):
        # Retained handles prove which subprocess is owned. Close/await it
        # before deleting the owned temporary home; never locate a user broker.
        process=self.adapter.process
        if self.host is not None:await self.host.close()
        await self.adapter.close()
        if process is not None:self.assertIsNotNone(process.returncode)
        self.temp.cleanup()

    async def test_real_metadata_negotiation_and_raw_control_response(self):
        rows=await self.host.catalog();self.assertEqual('mcp-app-resources/1',rows[0]['resource_protocol'])
        metadata=rows[0]['tools'][0]['_meta'];self.assertEqual(URI,metadata['ui']['resourceUri']);self.assertTrue(metadata['openagent/resource-generation'])
        reply=await dispatch_control(self.host,{'id':'resource-1','type':'read_resource','server':'resource-fixture','uri':URI,'principal':'exact-test-principal'})
        self.assertTrue(reply.frame['ok']);resource=reply.frame['result'];self.assertEqual(URI,resource['contents'][0]['uri']);self.assertEqual('text/html;profile=mcp-app',resource['contents'][0]['mimeType'])
        self.assertNotIn('content',resource);self.assertEqual('1',(self.root/'reads').read_text())

    async def test_undeclared_resource_missing_principal_and_old_protocol_are_not_dispatched(self):
        for uri in ['ui://another/server','file:///private','https://example.com/widget',URI+'\x00']:
            with self.assertRaises(HostError):await self.host.read_resource('resource-fixture',uri,principal='owner')
        reply=await dispatch_control(self.host,{'id':'missing-principal','type':'read_resource','server':'resource-fixture','uri':URI})
        self.assertFalse(reply.frame['ok'])
        self.adapter.manifest=replace(self.adapter.manifest,resource_protocol=None)
        with self.assertRaisesRegex(HostError,'does not support'):await self.host.read_resource('resource-fixture',URI,principal='owner')
        self.assertFalse((self.root/'reads').exists())

    async def test_consent_revocation_cancels_owned_pending_read_without_replay(self):
        (self.root/'hold').touch()
        pending=asyncio.create_task(self.host.read_resource('resource-fixture',URI,principal='owner',call_id='pending-read'))
        async with asyncio.timeout(5):
            while not (self.root/'reads').exists():await asyncio.sleep(.01)
        await self.host.set_consent(False)
        with self.assertRaises((asyncio.CancelledError,HostError)):await pending
        self.assertEqual('1',(self.root/'reads').read_text())

    async def test_restarting_provider_changes_the_host_owned_resource_generation(self):
        first=self.adapter.manifest.tools[0].metadata['openagent/resource-generation']
        await self.adapter.close();await self.adapter.start()
        second=self.adapter.manifest.tools[0].metadata['openagent/resource-generation'];self.assertNotEqual(first,second)
        self.assertEqual(second,(await self.host.catalog())[0]['tools'][0]['_meta']['openagent/resource-generation'])

    async def test_large_html_is_rejected_explicitly(self):
        (self.root/'oversize').touch()
        with self.assertRaisesRegex(HostError,'2 MiB'):await self.host.read_resource('resource-fixture',URI,principal='owner')
        self.assertEqual('1',(self.root/'reads').read_text())
