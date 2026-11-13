"""Regression: automations the owner approved over the private bridge keep the vault.

A scheduled task approved from the owner's Telegram turn stores its durable
grant under the bridge principal. Its deferred runs matched no private route,
so ``owner_bridge_vault_turn`` refused them and the vault source vanished from
the run's authorized catalog while the grant itself stayed valid.
``owner_bridge_automation_vault`` admits exactly that deferred, delegated run
and nothing broader.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from ._framework import TestContext, test

TENANT = "net-1"
AGENT = "friday"


@dataclass(frozen=True)
class _Principal:
    authority: str
    tenant_id: str
    subject_id: str
    kind: str


@dataclass(frozen=True)
class _Context:
    initiator: _Principal
    authority: _Principal
    author: _Principal
    audience: tuple
    deferred: bool = True
    delegation_id: str | None = "grant-1"
    ingress_id: str | None = None
    session_id: str = "scheduler:task:occurrence"


BRIDGE = _Principal("openagent", TENANT, "__bridge_telegram", "user")
AGENT_AUTHOR = _Principal("openagent", TENANT, AGENT, "agent")
CONFIG = {
    "channels": {"telegram": {"enabled": True, "allowed_users": ["1001"]}},
    "runtime_tool_audiences": {"vault_owner_channels": {"telegram": ["1001"]}},
}


def _automation(**changes) -> _Context:
    base = _Context(initiator=BRIDGE, authority=BRIDGE, author=AGENT_AUTHOR, audience=(BRIDGE,))
    return replace(base, **changes)


@test("bridge_automation_vault", "owner-approved bridge automation keeps vault access")
async def t_bridge_automation_admitted(ctx: TestContext) -> None:
    from openagent_server.bridge_vault_access import owner_bridge_automation_vault

    assert owner_bridge_automation_vault(_automation(), CONFIG, AGENT)


@test("bridge_automation_vault", "the trust ends with the owner bridge policy")
async def t_bridge_automation_policy_revoked(ctx: TestContext) -> None:
    from openagent_server.bridge_vault_access import owner_bridge_automation_vault

    no_owner = {**CONFIG, "runtime_tool_audiences": {"vault_owner_channels": {"telegram": []}}}
    disabled = {**CONFIG, "channels": {"telegram": {"enabled": False, "allowed_users": ["1001"]}}}
    not_allowed = {**CONFIG, "channels": {"telegram": {"allowed_users": ["2002"]}}}
    for config in (no_owner, disabled, not_allowed, {}):
        assert not owner_bridge_automation_vault(_automation(), config, AGENT)


@test("bridge_automation_vault", "only this agent's deferred delegated run qualifies")
async def t_bridge_automation_shape(ctx: TestContext) -> None:
    from openagent_server.bridge_vault_access import owner_bridge_automation_vault

    other = _Principal("openagent", TENANT, "someone", "user")
    rejected = [
        _automation(deferred=False),
        _automation(delegation_id=None),
        _automation(ingress_id="channel:telegram"),
        _automation(author=BRIDGE),
        _automation(author=_Principal("openagent", TENANT, "other-agent", "agent")),
        _automation(author=_Principal("openagent", "net-2", AGENT, "agent")),
        _automation(audience=(BRIDGE, other)),
        _automation(audience=(other,)),
        _automation(authority=other),
        _automation(initiator=other, authority=other, audience=(other,)),
        _automation(
            initiator=_Principal("openagent", TENANT, "__bridge_unknown", "user"),
        ),
    ]
    for context in rejected:
        assert not owner_bridge_automation_vault(context, CONFIG, AGENT), context


@test("bridge_automation_vault", "live bridge turn policy is unchanged for deferred runs")
async def t_live_turn_policy_unchanged(ctx: TestContext) -> None:
    from openagent_server.bridge_vault_access import owner_bridge_vault_turn

    # The interactive policy still refuses deferred contexts; only the
    # dedicated automation rule above admits them, and only for the vault.
    assert not owner_bridge_vault_turn(_automation(), CONFIG)
