"""The ``openagent/agent/1`` ALPN admits only the peers ``network.peers`` names.

Drives a real standalone server over real Iroh: a second node dials the
agent ALPN exactly as federation does (no certificate — the QUIC handshake
proves its node id) and the outcome is read from the HTTP answer. The unit
tests in ``apps/server/scripts/tests/test_peer_policy.py`` pin the policy
table; this file pins that the server actually loads it from the yaml and
puts it in front of the shared gateway app.
"""
import asyncio
import tempfile
import unittest
from pathlib import Path

import aiohttp

from openagent_core.core.paths import set_agent_dir
from openagent_identity.client.session import GatewayStream, LoopbackProxy
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.identity import load_or_create_identity
from openagent_identity.iroh_node import IrohNode, NetworkAlpn
from openagent_server.server import AgentServer


class AgentProtocolPeerPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="openagent-peer-policy-")
        self.root = Path(self.directory.name)
        set_agent_dir(self.root)
        self.cleanups = []

    async def asyncTearDown(self):
        for cleanup in reversed(self.cleanups):
            await cleanup()
        self.directory.cleanup()

    async def _peer(self, name):
        node = IrohNode(load_or_create_identity(self.root / f"{name}.key"))
        await node.start()
        self.cleanups.append(node.stop)
        return node

    async def _serve(self, network):
        config = {
            "name": "fixture",
            "_local_e2e": True,
            "memory": {"db_path": str(self.root / "state.sqlite3")},
            "channels": {},
            "voice": {"prefetch": False},
        }
        if network is not None:
            config["network"] = network
        server = AgentServer.from_config(config)
        await server.agent.memory_db.connect()
        await CoordinatorStore(server.agent.memory_db).set_network_role(
            role="coordinator", network_id="test-network", name="test",
        )
        await server.agent.memory_db.close()
        await asyncio.wait_for(server.start(), 30)
        self.cleanups.append(server.stop)
        return server

    async def _agent_url(self, peer, server):
        """A loopback base URL whose requests ride ``peer``'s agent-ALPN streams."""
        state = server._network_state
        target = await state.node_id()
        relay, addresses = await state.iroh_node.local_node_addr()

        async def open_stream():
            connection = await peer.dial(
                target, NetworkAlpn.AGENT, relay_url=relay, addresses=list(addresses),
            )
            bi = await connection.open_bi()
            return GatewayStream(send=bi.send(), recv=bi.recv(), target_node_id=target)

        proxy = LoopbackProxy(stream_factory=open_stream)
        await proxy.start()
        self.cleanups.append(proxy.stop)
        return proxy.base_url

    async def _request(self, method, url, **kwargs):
        timeout = aiohttp.ClientTimeout(total=45)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.request(method, url, **kwargs) as response:
                return response.status, await response.text()

    async def test_without_network_peers_every_peer_is_refused(self):
        server = await self._serve(None)
        stranger = await self._peer("stranger")
        base = await self._agent_url(stranger, server)

        for method, path in (("GET", "/api/agent-info"), ("POST", "/api/chat"), ("GET", "/api/config")):
            status, text = await self._request(method, base + path)
            self.assertEqual(status, 403, (method, path, text))
            self.assertIn("agent protocol is closed", text)

    async def test_allowlist_admits_its_peer_and_refuses_a_stranger(self):
        colleague = await self._peer("colleague")
        stranger = await self._peer("stranger")
        server = await self._serve({
            "peers": {"allowlist": {"node_ids": [(await colleague.node_id()).upper()]}},
        })
        colleague_base = await self._agent_url(colleague, server)
        stranger_base = await self._agent_url(stranger, server)

        status, text = await self._request("GET", colleague_base + "/api/agent-info")
        self.assertEqual(status, 200, text)

        status, text = await self._request("GET", stranger_base + "/api/agent-info")
        self.assertEqual(status, 403, text)
        self.assertIn("not in network.peers.allowlist", text)

        # Even an admitted colleague cannot make this host spawn a process:
        # registering an MCP is reserved to the installation owner.
        spawn = {"name": "planted", "command": "/bin/sh", "args": ["-c", "true"]}
        for base in (stranger_base, colleague_base):
            status, text = await self._request("POST", base + "/api/mcps", json=spawn)
            self.assertEqual(status, 403, text)
        self.assertIsNone(await server.agent.memory_db.get_mcp("planted"))


if __name__ == "__main__":
    unittest.main()
