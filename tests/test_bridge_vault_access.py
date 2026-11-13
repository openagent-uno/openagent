import unittest
from dataclasses import replace
from types import SimpleNamespace

from openagent_core.contracts import ExecutionContext, PrincipalRef, ResourceRef
from openagent_server.bridge_vault_access import (
    owner_bridge_automation_vault,
    owner_bridge_vault_turn,
)
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


class BridgeAutomationVaultTests(unittest.IsolatedAsyncioTestCase):
    """Scheduled runs of an automation the owner approved over the bridge."""

    def setUp(self):
        self.bridge = PrincipalRef("openagent", "network", "__bridge_telegram", "user")
        self.agent = PrincipalRef("openagent", "network", "Friday", "agent")
        self.context = ExecutionContext(
            self.agent, self.bridge, self.bridge, "scheduler:task:occurrence", "Friday",
            (self.bridge,), scopes=("capability:vault", "capability:vault-gate"),
            delegation_id="grant-1", deferred=True,
        )
        self.config = {
            "channels": {"telegram": {"allowed_users": ["155490357"]}},
            "runtime_tool_audiences": {
                "vault_owner_channels": {"telegram": ["155490357"]}
            },
        }

    def _services(self, config, name="Friday"):
        async def owner_handle():
            return "alessandro"

        async def snapshot(tenant):
            # The bridge is not a network member: the generic path refuses it.
            raise PermissionError(tenant)

        async def no_official_source(context, resource):
            return None

        agent = SimpleNamespace(config=config, memory_db=SimpleNamespace(db_path="unused"))
        if name is not None:
            agent.name = name
        runtime = SimpleNamespace(
            agent=agent,
            official_connectors=SimpleNamespace(authorize_source=no_official_source),
            runtime=SimpleNamespace(capabilities=SimpleNamespace(has_source=lambda *_: True)),
            directory=SimpleNamespace(owner_handle=owner_handle),
            dashboards=None,
            _interactive_sources={},
        )
        memory = NativeMemoryAccess(SimpleNamespace(
            agent=agent, directory=SimpleNamespace(owner_handle=owner_handle, snapshot=snapshot),
        ))
        return runtime, memory

    async def _vault_access(self, context, config, name="Friday"):
        runtime, memory = self._services(config, name)
        note = ResourceRef("vault-note", "network", "notes/example.md")
        results = [
            await NativeRuntimeService._authorize_source(
                runtime, context, "tool.discover",
                ResourceRef("capability", "network", source), audience=context.audience,
            )
            for source in ("vault", "vault-gate")
        ]
        results.append(await memory.authorize(context, "memory.read", note))
        results.append(await memory.authorize(
            context, "memory.publish", note, audience=context.audience
        ))
        return results

    async def test_owner_approved_bridge_automation_keeps_the_vault(self):
        self.assertFalse(owner_bridge_vault_turn(self.context, self.config))
        self.assertTrue(owner_bridge_automation_vault(self.context, self.config, "Friday"))
        self.assertEqual(await self._vault_access(self.context, self.config), [True] * 4)

    async def test_trust_ends_with_the_owner_bridge_policy(self):
        revoked = {**self.config, "runtime_tool_audiences": {"vault_owner_channels": {"telegram": []}}}
        disabled = {**self.config, "channels": {"telegram": {"enabled": False, "allowed_users": ["155490357"]}}}
        for config in (revoked, disabled, {}):
            self.assertFalse(owner_bridge_automation_vault(self.context, config, "Friday"))
            self.assertEqual(await self._vault_access(self.context, config), [False] * 4)

    async def test_only_this_agents_deferred_delegated_run_qualifies(self):
        other = PrincipalRef("openagent", "network", "other", "user")
        for changed in (
            # (Core already rejects deferred work without a delegation and
            # cross-tenant authors, so those shapes cannot reach the policy.)
            replace(self.context, deferred=False),
            replace(self.context, ingress_id="channel:telegram"),
            replace(self.context, author=self.bridge),
            replace(self.context, author=PrincipalRef("openagent", "network", "Other", "agent")),
            replace(self.context, audience=(self.bridge, other)),
            replace(self.context, authority=other),
            replace(self.context, initiator=PrincipalRef("openagent", "network", "__bridge_unknown", "user")),
        ):
            self.assertFalse(owner_bridge_automation_vault(changed, self.config, "Friday"), changed)
        self.assertFalse(owner_bridge_automation_vault(self.context, self.config, None))

    async def test_missing_scope_or_agent_name_fails_closed(self):
        unscoped = replace(self.context, scopes=())
        runtime, _ = self._services(self.config)
        self.assertFalse(await NativeRuntimeService._authorize_source(
            runtime, unscoped, "tool.discover",
            ResourceRef("capability", "network", "vault"), audience=unscoped.audience,
        ))
        self.assertEqual(await self._vault_access(self.context, self.config, name=None), [False] * 4)
