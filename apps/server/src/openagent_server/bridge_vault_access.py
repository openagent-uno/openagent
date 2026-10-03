"""Explicit owner vault access for a verified, allowlisted channel turn."""

from __future__ import annotations

from collections.abc import Mapping


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
        principal.authority != "openagent"
        or principal.kind != "user"
        or principal.subject_id != "__bridge_telegram"
        or context.author != principal
        or context.audience != (principal,)
    ):
        return False
    session_id = str(context.session_id or "")
    if not session_id.startswith("tg:"):
        return False
    sender_id = session_id.removeprefix("tg:")
    if not sender_id.isdecimal():
        return False
    policies = config.get("runtime_tool_audiences") or {}
    owner_channels = policies.get("vault_owner_channels") or {}
    telegram_ids = owner_channels.get("telegram") or []
    channel_ids = ((config.get("channels") or {}).get("telegram") or {}).get("allowed_users") or []
    return sender_id in {str(value) for value in telegram_ids} and sender_id in {
        str(value) for value in channel_ids
    }
