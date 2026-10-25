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


def owner_bridge_vault_turn(context, config: Mapping) -> bool:
    """Recognize only configured owner senders on the exact bot's private route.

    The historical policy name is retained for installed configuration. It
    already gates vault, catalog and automation management. No allowlisted
    contact, group, other bot account or model-authored display name becomes
    the owner. Mapped channels use the host directory instead of this bridge.
    """
    if getattr(context, "deferred", False):
        return False
    principal = context.initiator
    if (not is_owner_bridge_principal(principal) or context.author != principal
            or context.authority != principal or context.audience != (principal,)):
        return False
    provider = _OWNER_BRIDGES[principal.subject_id]
    senders = owner_bridge_senders(config, provider)
    channel = (config.get("channels") or {}).get(provider) or {}
    session_id = str(context.session_id or "")
    prefix = "tg:" if provider == "telegram" else "wa:"
    if session_id.startswith(prefix):
        sender = session_id.removeprefix(prefix)
        return sender.isdecimal() and sender in senders
    if provider == "telegram":
        token = channel.get("token") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not isinstance(token, str):
            return False
        account, separator, secret = token.partition(":")
        if not separator or not account.isdecimal() or not secret:
            return False
    else:
        account = str(channel.get("green_api_id") or os.environ.get("GREEN_API_ID", ""))
        if not account.isdecimal():
            return False
    from openagent_server.bridges.session_identity import gateway_bridge_session_id
    return any(sender.isdecimal() and session_id == gateway_bridge_session_id(
        provider, provider, account, sender,
        sender if provider == "telegram" else sender + "@c.us", None, prefix + sender,
    ) for sender in senders)
