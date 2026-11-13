"""Explicit owner trust for a verified private legacy channel bridge turn.

Mapped Slack/Discord ingress uses the actual network user's principal instead.
"""
from __future__ import annotations

import os
from collections.abc import Mapping

TELEGRAM_BRIDGE_SUBJECT = "__bridge_telegram"
_OWNER_BRIDGES = {TELEGRAM_BRIDGE_SUBJECT: "telegram", "__bridge_whatsapp": "whatsapp"}


def owner_bridge_senders(config: Mapping, provider: str) -> frozenset[str]:
    channel = (config.get("channels") or {}).get(provider)
    if not channel or channel.get("enabled") is False:
        return frozenset()
    owner_channels = (config.get("runtime_tool_audiences") or {}).get("vault_owner_channels") or {}
    owners = {str(value) for value in owner_channels.get(provider) or []}
    allowed = {str(value) for value in channel.get("allowed_users") or []}
    return frozenset(owners & allowed)


def telegram_owner_senders(config: Mapping) -> frozenset[str]:
    """Compatibility name for the explicit Telegram owner policy."""
    return owner_bridge_senders(config, "telegram")


def is_telegram_bridge_principal(principal) -> bool:
    return is_owner_bridge_principal(principal) and principal.subject_id == TELEGRAM_BRIDGE_SUBJECT


def is_owner_bridge_principal(principal) -> bool:
    return (principal.authority == "openagent" and principal.kind == "user"
        and principal.subject_id in _OWNER_BRIDGES)


def bridge_owner_principal_active(principal, config: Mapping) -> bool:
    """A durable bridge grant remains active only while explicit owner trust does."""
    return is_owner_bridge_principal(principal) and bool(
        owner_bridge_senders(config, _OWNER_BRIDGES[principal.subject_id]))


def _private_bridge_sender(context, config: Mapping, senders: frozenset[str]) -> str | None:
    """Match one exact private route; each permission supplies its own senders."""
    if getattr(context, "deferred", False):
        return None
    principal = context.initiator
    if (not is_owner_bridge_principal(principal) or context.author != principal
            or context.authority != principal or context.audience != (principal,)):
        return None
    provider = _OWNER_BRIDGES[principal.subject_id]
    channel = (config.get("channels") or {}).get(provider) or {}
    if channel.get("enabled") is False:
        return None
    allowed = {str(value) for value in channel.get("allowed_users") or []}
    senders = senders & allowed
    session_id = str(context.session_id or "")
    prefix = "tg:" if provider == "telegram" else "wa:"
    if session_id.startswith(prefix):
        sender = session_id.removeprefix(prefix)
        return sender if sender.isdecimal() and sender in senders else None
    if provider == "telegram":
        token = channel.get("token") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not isinstance(token, str):
            return None
        account, separator, secret = token.partition(":")
        if not separator or not account.isdecimal() or not secret:
            return None
    else:
        account = str(channel.get("green_api_id") or os.environ.get("GREEN_API_ID", ""))
        if not account.isdecimal():
            return None
    from openagent_server.bridges.session_identity import gateway_bridge_session_id
    return next((sender for sender in senders if sender.isdecimal() and session_id == gateway_bridge_session_id(
        provider, provider, account, sender,
        sender if provider == "telegram" else sender + "@c.us", None, prefix + sender,
    )), None)


def owner_bridge_vault_turn(context, config: Mapping) -> bool:
    """Retain explicit owner trust on the exact configured bot/private route.

    The historical policy name also gates owner catalog/automation management;
    native device ownership is independently and explicitly configured.
    """
    principal = context.initiator
    if not is_owner_bridge_principal(principal):
        return False
    provider = _OWNER_BRIDGES[principal.subject_id]
    return _private_bridge_sender(context, config, owner_bridge_senders(config, provider)) is not None


def owner_bridge_automation_vault(context, config: Mapping, agent_name: str | None) -> bool:
    """Owner vault trust for a durable automation the owner approved over the bridge.

    A grant approved from the owner's private bridge turn is captured with the
    bridge principal, and ``bridge_owner_principal_active`` keeps it runnable
    exactly while the explicit owner bridge policy holds. Its deferred runs
    have no private route to match, so ``owner_bridge_vault_turn`` never
    admits them and the owner's own automation lost the vault. This extends
    the same trust to the vault only: the context must be this agent's own
    deferred, delegated run with no live ingress, acting for the bridge
    principal alone. Catalog/automation management and device grants are not
    widened.
    """
    principal = context.initiator
    author = context.author
    return bool(
        agent_name
        and getattr(context, "deferred", False)
        and getattr(context, "delegation_id", None)
        and not getattr(context, "ingress_id", None)
        and is_owner_bridge_principal(principal)
        and context.authority == principal
        and context.audience == (principal,)
        and author.authority == "openagent"
        and author.kind == "agent"
        and author.subject_id == agent_name
        and author.tenant_id == principal.tenant_id
        and bridge_owner_principal_active(principal, config)
    )

def bridge_device_owner(context, config: Mapping) -> str | None:
    """Resolve an explicit sender-to-native-device-owner permission only.

    This never aliases the channel principal or grants vault, catalog, session
    ownership or automation permissions. The host validates the certificate and
    current native owner separately before issuing or using any device lease.
    """
    if not is_owner_bridge_principal(context.initiator):
        return None
    provider = _OWNER_BRIDGES[context.initiator.subject_id]
    grants = (config.get("runtime_tool_audiences") or {}).get("device_owner_channels") or {}
    if not isinstance(grants, Mapping):
        return None
    mappings = grants.get(provider) or {}
    if not isinstance(mappings, Mapping):
        return None
    sender = _private_bridge_sender(context, config, frozenset(key for key in mappings if isinstance(key, str)))
    handle = mappings.get(sender) if sender is not None else None
    return handle if isinstance(handle, str) and handle and not handle.startswith("__bridge_") else None
