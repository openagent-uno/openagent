"""Automation grants approved from the owner's allowlisted Telegram turn.

The Telegram bridge authenticates with its own principal, so a grant it
captures is owned by ``user:__bridge_telegram``. That principal is never a
network user; it must stay active exactly while the owner bridge policy that
admitted the approval holds, or every approved event/task fails at execution
with "Automation authority changed".
"""

import copy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from openagent_core.capabilities import CapabilityCatalog, ToolDefinition
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_core.engine import MemoryDB
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_server.automation_authority import NativeAutomationAuthority
from openagent_server.bridge_vault_access import owner_bridge_vault_turn
from openagent_server.runtime_directory import NativeRuntimeDirectory

OWNER_SENDER = "155490357"
CONFIG = {
    "channels": {"telegram": {"allowed_users": [OWNER_SENDER]}},
    "runtime_tool_audiences": {"vault_owner_channels": {"telegram": [OWNER_SENDER]}},
}


class BridgeOwnerPolicy:
    """The product admission rule for bridge automation management."""

    def __init__(self, agent):
        self.agent = agent

    async def authorize(self, context, action, resource, *, audience=()):
        return owner_bridge_vault_turn(context, self.agent.config)


class Source:
    async def discover(self, context):
        return (ToolDefinition("read", "read a record", {"type": "object"}),)

    async def call_tool(self, name, arguments, context):
        return {}


class BridgeOwnerAutomationGrantTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(db_path=str(Path(self.temp.name) / "state.sqlite3"))
        await self.db.connect()
        self.store = CoordinatorStore(self.db)
        await self.store.set_network_role(role="coordinator", network_id="network", name="test")
        await self.store.create_user(handle="alice", pake_record=b"never-published", pake_algo="fixture")
        self.agent = SimpleNamespace(name="agent", memory_db=self.db, config=copy.deepcopy(CONFIG))
        self.directory = NativeRuntimeDirectory(SimpleNamespace(), self.agent)
        policy = BridgeOwnerPolicy(self.agent)
        catalog = CapabilityCatalog(policy)
        source = Source()
        catalog.register("fixed", source, source, target_label="Agent")
        self.service = SimpleNamespace(
            agent=self.agent,
            authorizer=policy,
            # The runtime service installs exactly this resolver on the gateway.
            gateway=SimpleNamespace(runtime_principal_active=self.directory.principal_active),
            runtime=SimpleNamespace(capabilities=catalog),
        )
        self.authority = NativeAutomationAuthority(self.service)
        await self.authority.start()
        self.bridge = PrincipalRef("openagent", "network", "__bridge_telegram", "user")
        self.approval = ExecutionContext(
            self.bridge, self.bridge, self.bridge, f"tg:{OWNER_SENDER}", "agent", (self.bridge,)
        )
        event_id = await self.db.add_event(
            name="Inbound", slug="inbound", action_kind="prompt",
            prompt_template="handle it", secret_enc="encrypted-placeholder",
        )
        self.event = await self.authority.definition("event", event_id)

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def _run_context(self, occurrence="delivery"):
        return await self.authority.resolve(
            "event", self.event, occurrence, f"automation:event:{self.event['id']}:{occurrence}"
        )

    async def test_grant_approved_from_owner_bridge_turn_executes(self):
        self.assertIsNotNone(await self.authority.capture("event", self.event, self.approval))
        context = await self._run_context()
        self.assertEqual(context.initiator, self.bridge)
        self.assertTrue(context.deferred)
        self.assertTrue(await self.authority.validate(context))

    async def test_removing_the_owner_from_either_list_deactivates_the_grant(self):
        await self.authority.capture("event", self.event, self.approval)
        context = await self._run_context()
        policies = self.agent.config["runtime_tool_audiences"]["vault_owner_channels"]

        policies["telegram"] = []
        self.assertFalse(await self.authority.validate(context))
        with self.assertRaises(PermissionError):
            await self._run_context("next")

        policies["telegram"] = [OWNER_SENDER]
        self.assertTrue(await self.authority.validate(context))

        self.agent.config["channels"]["telegram"]["allowed_users"] = ["999"]
        self.assertFalse(await self.authority.validate(context))

        self.agent.config["channels"] = {}
        self.assertFalse(await self.authority.validate(context))

    async def test_only_this_networks_telegram_bridge_is_trusted(self):
        self.assertTrue(await self.directory.principal_active(self.bridge))
        for principal in (
            PrincipalRef("openagent", "other-network", "__bridge_telegram", "user"),
            PrincipalRef("openagent", "network", "__bridge_whatsapp", "user"),
            PrincipalRef("openagent", "network", "__bridge_telegram", "agent"),
            PrincipalRef("external", "network", "__bridge_telegram", "user"),
        ):
            with self.subTest(principal=principal):
                self.assertFalse(await self.directory.principal_active(principal))
        # Ordinary network users keep their directory semantics.
        self.assertTrue(await self.directory.principal_active(PrincipalRef("openagent", "network", "alice")))
        self.assertFalse(await self.directory.principal_active(PrincipalRef("openagent", "network", "mallory")))

    async def test_local_coordinator_fallback_applies_the_same_policy(self):
        del self.service.gateway.runtime_principal_active
        await self.authority.capture("event", self.event, self.approval)
        context = await self._run_context()
        self.assertTrue(await self.authority.validate(context))
        self.agent.config["runtime_tool_audiences"] = {}
        self.assertFalse(await self.authority.validate(context))
        other = PrincipalRef("openagent", "other-network", "__bridge_telegram", "user")
        self.agent.config = copy.deepcopy(CONFIG)
        self.assertFalse(await self.authority.principal_active(other))


if __name__ == "__main__":
    unittest.main()
