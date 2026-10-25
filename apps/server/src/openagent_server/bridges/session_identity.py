"""Stable session identity shared by the gateway adapter and host policies."""
from __future__ import annotations

import hashlib
import json


def gateway_bridge_session_id(
    binding_id: str, provider: str, account_id: str, actor_id: str,
    conversation_id: str, thread_id: str | None, legacy_hint: str | None,
) -> str:
    """Bind a session to its provider account, actor, conversation and thread.

    Keep the tuple and serialization stable: existing transcripts and host
    access policies use the same identity across product upgrades.
    """
    data = json.dumps((binding_id, provider, account_id, actor_id,
                       conversation_id, thread_id, legacy_hint), separators=(",", ":"))
    return f"{provider}:{hashlib.sha256(data.encode()).hexdigest()}"
