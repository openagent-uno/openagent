from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from click.testing import CliRunner

from openagent_cli import main


class _Client:
    target_handle = "agent"

    def __init__(self, reply=None, delay=0.0):
        self.reply = reply or {"type": "response", "text": "done", "model": "m", "attachments": []}
        self.delay = delay
        self.sent = []
        self.interrupted = []
        self.disconnected = False

    async def send_message(self, text, session_id):
        self.sent.append((text, session_id))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.reply

    async def send_interrupt(self, session_id, *, reason="manual"):
        self.interrupted.append((session_id, reason))

    async def disconnect(self):
        self.disconnected = True

    async def rest_request(self, method, path, data=None):
        self.requests = getattr(self, "requests", []) + [(method, path, data)]
        if path == "/api/providers":
            return 201, {"ok": True, "provider": {"id": 7}}
        if path == "/api/fail":
            return 400, {"error": "bad"}
        return 200, {"ok": True}


def _opener(client):
    async def open_gateway(network, password, agent, *, principal_handle=None, quiet):
        client.opened = (network, password, agent, principal_handle)
        return client, object()
    return open_gateway


class CLIAskTests(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()

    def test_one_turn_json_from_stdin(self):
        client = _Client()
        with patch.object(main, "_open_gateway_for_rest", new=_opener(client)):
            result = self.runner.invoke(
                main.cli,
                ["ask", "--message-file", "-", "--session", "s-1", "--json"],
                input="Summarize the report",
                env={"OPENAGENT_CLI_PASSWORD": "from-env"},
            )
        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["text"], "done")
        self.assertEqual(payload["session_id"], "s-1")
        self.assertEqual(client.sent, [("Summarize the report", "s-1")])
        self.assertEqual(client.opened[1], "from-env")
        self.assertTrue(client.disconnected)

    def test_error_reply_has_server_exit_code(self):
        client = _Client(reply={"type": "error", "text": "provider failed"})
        with patch.object(main, "_open_gateway_for_rest", new=_opener(client)):
            result = self.runner.invoke(main.cli, ["ask", "--message", "hi", "--json"])
        self.assertEqual(result.exit_code, main.EXIT_SERVER, result.output)
        self.assertEqual(json.loads(result.output)["status"], "error")

    def test_timeout_interrupts_the_turn(self):
        client = _Client(delay=5)
        with patch.object(main, "_open_gateway_for_rest", new=_opener(client)):
            result = self.runner.invoke(
                main.cli, ["ask", "--message", "hi", "--session", "s-2", "--timeout", "1", "--json"],
            )
        self.assertEqual(result.exit_code, main.EXIT_UNAVAILABLE, result.output)
        self.assertEqual(json.loads(result.output)["status"], "timed_out")
        self.assertEqual(client.interrupted, [("s-2", "timeout")])
        self.assertTrue(client.disconnected)

    def test_requires_exactly_one_message_source(self):
        result = self.runner.invoke(main.cli, ["ask"])
        self.assertEqual(result.exit_code, 2)
        result = self.runner.invoke(main.cli, ["ask", "--message", "  "])
        self.assertEqual(result.exit_code, 2)

    def test_connect_without_repl_reports_join_failure(self):
        async def failed(**kwargs):
            self.assertFalse(kwargs["interactive"])
            return False
        with patch.object(main, "_run_connect", new=failed):
            result = self.runner.invoke(
                main.cli, ["connect", "oa1invalid", "--no-interactive"],
                env={"OPENAGENT_CLI_PASSWORD": "secret"},
            )
        self.assertEqual(result.exit_code, main.EXIT_AUTH, result.output)

    def test_request_batch_reuses_previous_response(self):
        client = _Client()
        steps = [
            {"method": "POST", "path": "/api/providers", "body": {"name": "local"}},
            {"method": "post", "path": "/api/models", "body": {"provider_id": "${0.provider.id}", "model": "m"}},
        ]
        with patch.object(main, "_open_gateway_for_rest", new=_opener(client)):
            result = self.runner.invoke(main.cli, ["request", "--batch-file", "-"], input=json.dumps(steps))
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(client.requests[1], ("post", "/api/models", {"provider_id": 7, "model": "m"}))
        self.assertEqual([r["status"] for r in json.loads(result.output)["results"]], [201, 200])

    def test_request_stops_at_first_http_error(self):
        client = _Client()
        steps = [{"method": "GET", "path": "/api/fail"}, {"method": "GET", "path": "/api/models"}]
        with patch.object(main, "_open_gateway_for_rest", new=_opener(client)):
            result = self.runner.invoke(main.cli, ["request", "--batch-file", "-"], input=json.dumps(steps))
        self.assertEqual(result.exit_code, main.EXIT_INVALID_REQUEST, result.output)
        self.assertEqual(len(client.requests), 1)

    def test_request_rejects_paths_outside_the_api(self):
        result = self.runner.invoke(main.cli, ["request", "GET", "/etc/passwd"])
        self.assertEqual(result.exit_code, 2)


if __name__ == "__main__":
    unittest.main()
