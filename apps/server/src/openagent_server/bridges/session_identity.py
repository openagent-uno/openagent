"""Stable session identity shared by the gateway adapter and host policies."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass


LEGACY_PRIVATE_SESSION_API_VERSION = 1


@dataclass(frozen=True)
class LegacyPrivateSessions:
    """Explicit operator attestation of an old Telegram account/actor binding.

    Routing only, never an admission or publication grant. New installations
    keep scoped identities; an operator must deliberately bind existing rows.
    No transcript, primary key or approval is rewritten.
    """
    binding_id: str
    account_id: str
    actor_ids: frozenset[str]

    @classmethod
    def from_config(cls, value):
        if (not isinstance(value, dict) or set(value) != {'version','binding_id','account_id','actor_ids'}
                or type(value['version']) is not int or value['version'] != LEGACY_PRIVATE_SESSION_API_VERSION
                or not isinstance(value['binding_id'], str) or not 1 <= len(value['binding_id']) <= 128
                or not isinstance(value['account_id'], str) or not value['account_id'].isascii()
                or not value['account_id'].isdigit() or not isinstance(value['actor_ids'], list)
                or not 1 <= len(value['actor_ids']) <= 1000
                or any(not isinstance(actor,str) or not actor.isascii() or not actor.isdigit() for actor in value['actor_ids'])
                or len(set(value['actor_ids'])) != len(value['actor_ids'])):
            raise ValueError('Invalid versioned legacy private-session binding')
        return cls(value['binding_id'], value['account_id'], frozenset(value['actor_ids']))

    def resolve(self, context, hint):
        if context.actor_id not in self.actor_ids:
            return None
        if (context.provider != 'telegram' or context.binding_id != self.binding_id
                or context.account_id != self.account_id):
            raise PermissionError('Legacy session binding belongs to another account or channel')
        if (context.conversation_kind != 'direct' or context.thread_id is not None
                or context.conversation_id != context.actor_id):
            return None
        base = 'tg:' + context.actor_id
        if hint is None or hint == base:
            return base
        if isinstance(hint, str) and hint.startswith(base + ':'):
            return hint  # Explicitly selected/reset legacy child, never another actor.
        raise PermissionError('Legacy session selector does not belong to this actor')


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
