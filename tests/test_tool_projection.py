"""Live tool cards retain exact calls and trusted execution destinations."""
from __future__ import annotations

import json
import unittest

from openagent_server.gateway.collaboration_hub import SharedAgentHub
from openagent_server.gateway.api.operational import _execution_host_from_binding


HOST = {"kind": "capability", "device_label": "Alice laptop",
        "source_id": "trusted/filesystem", "instance_id": "connection-one", "generation": "3:4"}


class LiveToolCards(unittest.TestCase):
    def setUp(self):
        self.hub = SharedAgentHub()
        self.hub.begin("chat", "Read the temporary file", run_id="run-one")

    @property
    def turn(self):
        return self.hub.sessions["chat"]["turns"][-1]

    def status(self, call_id="call-one", **values):
        tool = {"tool_name": "read_text_file", "tool_call_id": call_id,
                "tool_args": {"path": "fixture.txt"}, "result": None,
                "execution_host": dict(HOST), **values}
        self.hub.publish({"type": "status", "session_id": "chat", "text": json.dumps(tool)})

    def test_start_and_completion_update_same_card_and_keep_timestamp(self):
        self.status()
        first = self.turn["tools"][0]
        timestamp = first["timestamp"]
        revision = self.hub.sessions["chat"]["revision"]
        self.assertIsNone(first["toolInfo"]["result"])
        self.status(result={"text": "Fixture contents"})
        self.assertEqual(len(self.turn["tools"]), 1)
        card = self.turn["tools"][0]
        self.assertEqual(card["id"], "call-one")
        self.assertEqual(card["timestamp"], timestamp)
        self.assertEqual(json.loads(card["toolInfo"]["result"]), {"text": "Fixture contents"})
        self.assertEqual(card["toolInfo"]["execution_host"], HOST)
        self.assertGreater(self.hub.sessions["chat"]["revision"], revision)
        self.assertEqual(self.turn["runId"], "run-one")

    def test_same_named_tool_on_two_calls_has_distinct_cards(self):
        self.status("one", execution_host=HOST)
        self.status("two", execution_host={**HOST, "device_label": "Bob laptop", "instance_id": "connection-two"})
        self.status("one", result="finished")
        cards = self.turn["tools"]
        self.assertEqual([card["id"] for card in cards], ["one", "two"])
        self.assertEqual(cards[0]["toolInfo"]["result"], "finished")
        self.assertIsNone(cards[1]["toolInfo"]["result"])
        self.assertEqual(cards[1]["toolInfo"]["execution_host"]["instance_id"], "connection-two")

    def test_plain_or_invalid_status_never_fabricates_tool_cards(self):
        for status in ("Working", "{invalid", "[]", "null", '{"tool_name":"read_text_file"}',
                       '{"tool_call_id":"missing-name"}'):
            self.hub.publish({"type": "status", "session_id": "chat", "text": status})
        self.assertFalse(self.turn.get("tools"))
        self.assertEqual([message["role"] for message in self.turn["messages"]], ["user"])
        self.hub.publish({"type": "status", "session_id": "chat", "text": "x" * 30000})
        self.assertEqual(len(self.turn["status"]), 16384)

    def test_arguments_results_and_entire_tool_list_are_bounded(self):
        self.status(tool_args={"payload": "a" * 24000}, result="r" * 24000)
        info = self.turn["tools"][0]["toolInfo"]
        self.assertEqual(info["tool_args"], {"truncated": True})
        self.assertEqual(len(info["result"]), 12000)
        for number in range(25):
            self.status(f"long-{number}", result="x" * 12000)
        self.assertLessEqual(len(json.dumps(self.turn["tools"])), 131072)
        self.assertTrue(self.turn["truncated"])
        self.assertEqual(self.turn["tools"][-1]["id"], "long-24")
        self.assertNotIn("call-one", {card["id"] for card in self.turn["tools"]})

    def test_count_limit_marks_missing_cards_and_keeps_latest_operations(self):
        for number in range(130):
            self.status(f"small-{number}")
        self.assertLessEqual(len(self.turn["tools"]), 128)
        self.assertTrue(self.turn.get("truncated"))
        self.assertEqual(self.turn["tools"][-1]["id"], "small-129")

    def test_unbounded_extra_metadata_cannot_escape_total_payload_limit(self):
        self.status(unknown_payload={"large": "x" * 262144})
        self.assertLessEqual(len(json.dumps(self.turn.get("tools", []))), 131072)
        self.assertTrue(self.turn["truncated"])


class ExecutionDestination(unittest.TestCase):
    def test_only_binding_can_attest_destination_not_arguments_or_result(self):
        spoof = {"kind": "capability", "device_label": "Forged", "source_id": "forged/source"}
        for envelope in ({"execution_host": spoof}, {"arguments": {"execution_host": spoof}},
                         {"tool_args": {"execution_host": spoof}}, {"result": {"execution_host": spoof}},
                         {"result": {"binding": {"execution_host": spoof}}}):
            with self.subTest(envelope=envelope):
                self.assertIsNone(_execution_host_from_binding(json.dumps(envelope)))
        raw = json.dumps({"binding": {"execution_host": HOST}, "arguments": {"execution_host": spoof},
                          "result": {"execution_host": spoof}})
        self.assertEqual(_execution_host_from_binding(raw), HOST)

    def test_only_display_fields_are_projected_and_unknown_is_explicit(self):
        secret_host = {**HOST, "credentials": "SECRET", "token": "SECRET", "command": "SECRET", "owner": "SECRET"}
        projected = _execution_host_from_binding(json.dumps({"binding": {"execution_host": secret_host}}))
        self.assertEqual(projected, HOST)
        self.assertNotIn("SECRET", json.dumps(projected))
        unknown = {"kind": "unknown", "device_label": "Destination not recorded"}
        self.assertEqual(_execution_host_from_binding(json.dumps({"binding": {"execution_host": unknown}})), unknown)

    def test_malformed_or_unsupported_attestations_fail_closed(self):
        malformed = [None, "invalid json", "[]", "null", "{}", json.dumps({"binding": None}),
                     json.dumps({"binding": {"execution_host": "Alice laptop"}}),
                     json.dumps({"binding": {"execution_host": {"kind": "client", "device_label": "Alice"}}}),
                     json.dumps({"binding": {"execution_host": {"kind": "capability", "device_label": 42}}}),
                     json.dumps({"binding": {"execution_host": {"kind": "capability"}}})]
        for raw in malformed:
            with self.subTest(raw=raw):
                self.assertIsNone(_execution_host_from_binding(raw))


if __name__ == "__main__":
    unittest.main()
