"""Which chat commands may run while a shared turn owns the conversation.

A live run showed it: in a shared conversation, ``/goal resume`` sent while
the agent was working came back as "Send session commands through the shared
collaboration API." and did nothing, and the collaboration API did not know
``/goal`` either. Goal commands only change the durable goal row by session
id, so they must work mid-turn; commands that drive the live turn stay with
the collaboration runtime.
"""
from __future__ import annotations

import unittest

from openagent_core.chat_commands import COMMAND_SPECS
from openagent_server.gateway import collaboration
from openagent_server.gateway.server import (
    COMMANDS_OUTSIDE_SHARED_RUNTIME,
    command_bypasses_shared_runtime,
)


class SharedSessionCommandTests(unittest.TestCase):
    def test_goal_help_and_usage_run_during_a_shared_turn(self):
        for name in ("goal", "GOAL", " goal ", "help", "usage"):
            self.assertTrue(command_bypasses_shared_runtime(name), name)

    def test_turn_driving_commands_stay_with_the_collaboration_runtime(self):
        for name in ("stop", "compact", "clear", "new", "reset", "model", "queue",
                     "status", "context", "update", "restart", "", None):
            self.assertFalse(command_bypasses_shared_runtime(name), name)

    def test_the_collaboration_api_accepts_goal(self):
        self.assertIn("goal", collaboration.COMMANDS)

    def test_every_bypassing_command_is_a_known_command(self):
        known = {spec.name for spec in COMMAND_SPECS}
        self.assertLessEqual(COMMANDS_OUTSIDE_SHARED_RUNTIME, known)


if __name__ == "__main__":
    unittest.main()
