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

        async def no_official_source(context, resource):
            return None

        service = SimpleNamespace(
            agent=SimpleNamespace(config=self.config),
            official_connectors=SimpleNamespace(authorize_source=no_official_source),
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

    def typed_context(self, *, actor="155490357", account="123456", conversation=None,
                      binding="telegram", thread=None, hint=None):
        from openagent_server.bridges.gateway_transport import GatewayBridgeTransport
        from openagent_channel_bridges.base import _legacy_session_hint
        channel = SimpleNamespace(binding_id=binding, provider="telegram", account_id=account,
            actor_id=actor, conversation_id=conversation or actor, thread_id=thread)
        token = _legacy_session_hint.set(hint or f"tg:{actor}")
        try:
            session_id = GatewayBridgeTransport._session_for_context(None, channel)
        finally:
            _legacy_session_hint.reset(token)
        return replace(self.context, session_id=session_id)

    async def test_current_typed_private_session_retains_explicit_owner_vault_access(self):
        self.config['channels']['telegram']['token'] = '123456:testing-token'
        current = self.typed_context()
        self.assertEqual(current.session_id, 'telegram:ee34281961563f423cfca54efcdf90d5eeed0d75dcf5798d3fb22695c961be88')
        self.assertTrue(owner_bridge_vault_turn(current, self.config))
        old = self.context
        self.context = current
        try:
            await self.test_explicit_private_telegram_sender_can_discover_vault_and_gate()
        finally:
            self.context = old

    async def test_typed_identity_binding_and_owner_revocation_fail_closed(self):
        self.config['channels']['telegram']['token'] = '123456:testing-token'
        self.assertTrue(owner_bridge_vault_turn(self.typed_context(), self.config))
        for candidate in (
            self.typed_context(actor='999'), self.typed_context(account='654321'),
            self.typed_context(conversation='-1001234'), self.typed_context(binding='other-agent'),
            self.typed_context(thread='7'), self.typed_context(hint='tg:999'),
            replace(self.context, session_id='telegram:' + '0' * 64),
            replace(self.typed_context(), initiator=PrincipalRef('openagent', 'network', 'other', 'user')),
            replace(self.typed_context(), audience=(self.bridge, PrincipalRef('openagent','network','other','user'))),
        ):
            with self.subTest(session=candidate.session_id):
                self.assertFalse(owner_bridge_vault_turn(candidate, self.config))
        self.config['runtime_tool_audiences']['vault_owner_channels']['telegram'] = []
        self.assertFalse(owner_bridge_vault_turn(self.typed_context(), self.config))

    async def test_typed_owner_policy_uses_the_same_configured_environment_bot(self):
        from unittest.mock import patch
        with patch.dict('os.environ', {'TELEGRAM_BOT_TOKEN': '123456:environment-token'}):
            self.assertTrue(owner_bridge_vault_turn(self.typed_context(), self.config))
        for token in ('', 'malformed', ':empty', 'other:invalid'):
            self.config['channels']['telegram']['token'] = token
            with patch.dict('os.environ', {'TELEGRAM_BOT_TOKEN': ''}):
                self.assertFalse(owner_bridge_vault_turn(self.typed_context(), self.config))
