"""The agent-ALPN dialer accepts first-contact hints and forwards them.

``oa_agent_client`` (the federation client used by the in-process
``agent-federation`` builtin and the standalone bridge) re-exports
``openagent_identity.client.session``. Its ``AgentClient.chat`` always builds
``AgentDialer(node=..., target_node_id=..., relay_url=..., addresses=...)``;
when the identity dialer did not take those keywords, every federated
``ask_agent`` failed with ``TypeError`` before dialing.
"""
from __future__ import annotations

import asyncio
import unittest

from openagent_identity.client.session import AgentDialer
from openagent_identity.iroh_node import NetworkAlpn


class _Bi:
    def send(self):
        return object()

    def recv(self):
        return object()


class _Connection:
    def __init__(self):
        self.opened = 0

    async def open_bi(self):
        self.opened += 1
        return _Bi()


class _Node:
    def __init__(self):
        self.dials: list[tuple] = []
        self.connection = _Connection()

    async def dial(self, node_id, alpn, *, relay_url=None, addresses=None):
        self.dials.append((node_id, alpn, relay_url, addresses))
        return self.connection


class AgentDialerHintTests(unittest.TestCase):
    def test_hints_reach_the_dial_and_the_connection_is_reused(self):
        node = _Node()
        dialer = AgentDialer(
            node=node, target_node_id="ab" * 32,
            relay_url="https://relay.example", addresses=["192.0.2.1:4433"],
        )

        async def run():
            await dialer.open_agent_stream()
            await dialer.open_agent_stream()

        asyncio.run(run())
        self.assertEqual(node.dials, [("ab" * 32, NetworkAlpn.AGENT, "https://relay.example", ["192.0.2.1:4433"])])
        self.assertEqual(node.connection.opened, 2)

    def test_without_hints_the_dial_relies_on_discovery(self):
        node = _Node()
        dialer = AgentDialer(node=node, target_node_id="cd" * 32, relay_url=None, addresses=None)
        asyncio.run(dialer.open_agent_stream())
        self.assertEqual(node.dials, [("cd" * 32, NetworkAlpn.AGENT, None, None)])

    def test_the_federation_client_builds_its_dialer(self):
        # The exact construction AgentClient.chat performs.
        try:
            from oa_agent_client.session import AgentDialer as ClientDialer
        except ImportError:  # the bridge is not installed in this environment
            self.skipTest("oa_agent_client is not installed")
        dialer = ClientDialer(node=_Node(), target_node_id="ef" * 32, relay_url=None, addresses=None)
        self.assertIsNone(dialer.relay_url)


if __name__ == "__main__":
    unittest.main()
