"""Explicit owner vault access for a verified, allowlisted channel turn."""

from __future__ import annotations

import os
from collections.abc import Mapping

TELEGRAM_BRIDGE_SUBJECT = "__bridge_telegram"


def telegram_owner_senders(config: Mapping) -> frozenset[str]:
    """Telegram senders named in both the owner policy and the channel allowlist.

    This is the single source of the bridge owner trust: an interactive turn
    is admitted only from one of these senders, and a durable grant captured
    by such a turn stays usable only while this set is non-empty.
    """
    channel = (config.get("channels") or {}).get("telegram")
    if not channel:
        return frozenset()
    policies = config.get("runtime_tool_audiences") or {}
    owner_channels = policies.get("vault_owner_channels") or {}
    owners = {str(value) for value in owner_channels.get("telegram") or []}
    allowed = {str(value) for value in channel.get("allowed_users") or []}
    return frozenset(owners & allowed)


def is_telegram_bridge_principal(principal) -> bool:
    return (
        principal.authority == "openagent"
        and principal.kind == "user"
        and principal.subject_id == TELEGRAM_BRIDGE_SUBJECT
    )


def bridge_owner_principal_active(principal, config: Mapping) -> bool:
    """Whether the Telegram bridge principal still carries owner trust.

    The bridge is not a network user, so the network directory never lists
    it. Automation grants approved from an owner bridge turn are captured
    with this principal; they remain active exactly while the trust that
    admitted the approval holds. Removing every owner sender from either the
    owner policy or the channel allowlist (or removing the channel) makes
    those grants inactive, as revoking a network user would.
    """
    return is_telegram_bridge_principal(principal) and bool(
        telegram_owner_senders(config)
    )


def owner_bridge_vault_turn(context, config: Mapping) -> bool:
    """Allow only a named Telegram sender on that bridge's private session.

    The bridge authenticates to the gateway with its own certificate, so its
    principal is not the installation owner. The operator must separately name
    the sender in both the channel allowlist and the vault owner policy.
    """
    if getattr(context, "deferred", False):
        return False
    principal = context.initiator
    if (
        not is_telegram_bridge_principal(principal)
        or context.author != principal
        or context.audience != (principal,)
    ):
        return False
    session_id = str(context.session_id or "")
    senders = telegram_owner_senders(config)
    if session_id.startswith("tg:"):
        sender_id = session_id.removeprefix("tg:")
        return sender_id.isdecimal() and sender_id in senders

    # Typed Telegram ingress binds the private session to the configured bot,
    # owner sender and direct conversation. Recompute that exact identity;
    # accepting an arbitrary telegram: prefix would expose private notes to
    # groups, other bot accounts or unapproved senders. Do not rewrite the
    # session ID or broaden the corpus to installation-wide visibility.
    channel = (config.get("channels") or {}).get("telegram") or {}
    token = channel.get("token") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not isinstance(token, str):
        return False
    account_id, separator, secret = token.partition(":")
    if not separator or not account_id.isdecimal() or not secret:
        return False
    from openagent_server.bridges.session_identity import gateway_bridge_session_id

    return any(
        sender.isdecimal() and session_id == gateway_bridge_session_id(
            "telegram", "telegram", account_id, sender, sender, None, f"tg:{sender}",
        )
        for sender in senders
    )
