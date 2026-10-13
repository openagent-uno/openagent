import tempfile
import unittest
from pathlib import Path

from openagent_core.extensions import EngineExtensions
from openagent_server.server import AgentServer, _build_agent


class ServerHostExtensions(unittest.TestCase):
    def config(self, root):
        return {"name": "example-agent", "_local_e2e": True,
                "memory": {"db_path": str(Path(root) / "state.sqlite3")}}

    def test_default_assembly_installs_no_domain_callbacks(self):
        with tempfile.TemporaryDirectory() as root:
            # Persisted host-like fields cannot enable executable callbacks.
            config = self.config(root)
            config["support"] = {"profile": "alpha", "adapter": "untrusted.module"}
            agent = _build_agent(config)
            self.assertIsNone(agent.extensions.event_handler)
            self.assertIsNone(agent.extensions.scheduled_handler)
            self.assertIsNone(agent.extensions.output_retainer)

    def test_explicit_host_callbacks_reach_the_same_public_engine(self):
        async def event_handler(**kwargs):
            return {"handled": True}

        extensions = EngineExtensions(event_handler=event_handler)
        with tempfile.TemporaryDirectory() as root:
            server = AgentServer.from_config(self.config(root), engine_extensions=extensions)
            self.assertIs(server.agent.extensions, extensions)
            self.assertIs(server.agent.extensions.event_handler, event_handler)
