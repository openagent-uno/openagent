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


if __name__ == "__main__":
    unittest.main()
