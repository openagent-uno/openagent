import unittest
from dataclasses import replace
from types import SimpleNamespace

from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef
from openagent_server.bridge_vault_access import owner_bridge_vault_turn
from openagent_server.memory_access import NativeMemoryAccess
from openagent_server.runtime_service import NativeRuntimeService


class BridgeVaultAccessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = PrincipalRef("openagent", "network", "__bridge_telegram", "user")
        self.context = ExecutionContext(
            self.bridge, self.bridge, self.bridge, "tg:155490357", "Friday", (self.bridge,)
        )
        self.config = {
            "channels": {"telegram": {"allowed_users": ["155490357"]}},
            "runtime_tool_audiences": {
                "vault_owner_channels": {"telegram": ["155490357"]}
            },
        }

    async def test_explicit_private_telegram_sender_can_discover_vault_and_gate(self):
        async def owner_handle():
            return "alessandro"

        service = SimpleNamespace(
            agent=SimpleNamespace(config=self.config),
            runtime=SimpleNamespace(capabilities=SimpleNamespace(has_source=lambda *_: True)),
            directory=SimpleNamespace(owner_handle=owner_handle),
            dashboards=None,
            _interactive_sources={},
        )
        for source in ("vault", "vault-gate"):
            resource = ResourceRef("capability", "network", source)
            self.assertTrue(await NativeRuntimeService._authorize_source(
                service, self.context, "tool.discover", resource, audience=self.context.audience
            ))
        memory = NativeMemoryAccess(SimpleNamespace(
            agent=SimpleNamespace(config=self.config, memory_db=SimpleNamespace(db_path="unused")),
            directory=SimpleNamespace(owner_handle=owner_handle),
        ))
        note = ResourceRef("vault-note", "network", "notes/example.md")
        self.assertTrue(await memory.authorize(self.context, "memory.read", note))
        self.assertTrue(await memory.authorize(
            self.context, "memory.publish", note, audience=self.context.audience
        ))

    async def test_other_contexts_do_not_inherit_private_vault(self):
        self.assertTrue(owner_bridge_vault_turn(self.context, self.config))
        for changed in (
            replace(self.context, session_id="tg:999"),
            replace(self.context, session_id="wa:155490357"),
            replace(self.context, audience=(self.bridge, PrincipalRef("openagent", "network", "other", "user"))),
            replace(self.context, initiator=PrincipalRef("openagent", "network", "__bridge_whatsapp", "user")),
            replace(self.context, deferred=True, delegation_id="background-test"),
        ):
            self.assertFalse(owner_bridge_vault_turn(changed, self.config))
        without_channel_allowlist = {
            **self.config,
            "channels": {"telegram": {"allowed_users": []}},
        }
        self.assertFalse(owner_bridge_vault_turn(self.context, without_channel_allowlist))
