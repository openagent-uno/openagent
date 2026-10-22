"""A configured channel whose SDK is missing fails once, clearly, at startup.

The bridges import their SDK inside the platform loop, so a missing package
used to surface as a retry every 30 seconds for the life of the process.
"""

import sys
import types
import unittest
from unittest import mock

from openagent_server import server

URLS = {name: "ws://127.0.0.1:1/ws" for name in ("telegram", "discord", "slack", "whatsapp")}
CHANNELS = {
    "telegram": {"token": "fixture"},
    "discord": {"token": "fixture", "allowed_users": ["1"]},
    "slack": {"bot_token": "fixture", "app_token": "fixture"},
    "whatsapp": {"green_api_id": "1", "green_api_token": "fixture"},
}


class BridgeSdkPreflightTests(unittest.TestCase):
    def test_missing_sdks_are_reported_once_and_their_channels_skipped(self):
        with mock.patch.object(server, "_bridge_sdk_available", return_value=False), \
                self.assertLogs(server.logger, level="ERROR") as logs:
            bridges = server._build_bridges({"channels": CHANNELS}, URLS)
        self.assertEqual([bridge.name for bridge in bridges], ["telegram"])
        self.assertEqual(len(logs.records), 3)
        joined = "\n".join(logs.output)
        for extra in ("discord", "slack", "whatsapp"):
            self.assertIn(f"openagent-framework[{extra}]", joined)

    def test_installed_sdk_builds_the_bridge(self):
        with mock.patch.dict(sys.modules, {"discord": types.ModuleType("discord")}):
            bridges = server._build_bridges(
                {"channels": {"discord": CHANNELS["discord"]}}, URLS
            )
        self.assertEqual([bridge.name for bridge in bridges], ["discord"])

    def test_unconfigured_channel_needs_no_sdk(self):
        self.assertIsNone(server._missing_bridge_sdk("telegram"))
        self.assertIsNone(server._missing_bridge_sdk("webhook"))

    def test_explicit_mapping_selects_normal_runtime_transport_without_owner_alias(self):
        from openagent_server.bridges.native_transport import NativeChannelTransport
        identity = {"tenant_id": "network", "account_id": "guild",
                    "user_bindings": {"1": "alice", "2": "bob"}}
        config = {"channels": {"discord": {**CHANNELS["discord"], "identity": identity}}}
        service = types.SimpleNamespace(agent=types.SimpleNamespace(config=config))
        with mock.patch.dict(sys.modules, {"discord": types.ModuleType("discord")}):
            bridges = server._build_bridges(config, {"discord": ""}, runtime_service=service)
        self.assertEqual(len(bridges), 1)
        self.assertIsInstance(bridges[0].transport, NativeChannelTransport)
        self.assertIs(bridges[0].transport.service, service)
        self.assertEqual(bridges[0].transport.binding_id, "discord")

    def test_explicit_mapping_never_silently_falls_back_to_legacy_without_runtime(self):
        config = {"channels": {"discord": {**CHANNELS["discord"], "identity": {}}}}
        with mock.patch.dict(sys.modules, {"discord": types.ModuleType("discord")}), \
                self.assertLogs(server.logger, level="ERROR"):
            self.assertEqual(server._build_bridges(config, URLS), [])


if __name__ == "__main__":
    unittest.main()
