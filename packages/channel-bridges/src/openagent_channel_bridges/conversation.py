"""Provider-attested conversation routing, never a host identity or grant.

Hosts persist their own session IDs and add a current principal-mapping and
permission epoch. These references contain no runtime, database or owner lookup.
"""
from __future__ import annotations

import hashlib

from .contracts import BridgeContext, BridgeConversation


def _framed(values: tuple[str, ...]) -> bytes:
    """Language-neutral framing: unsigned 32-bit big-endian UTF-8 byte lengths."""
    return b"".join(len(raw).to_bytes(4, "big") + raw
                    for raw in (value.encode("utf-8") for value in values))


def describe_conversation(context: BridgeContext) -> BridgeConversation | None:
    """Describe an attested DM, channel or thread without adopting its authority.

    A shared key deliberately excludes the current actor and proof timestamp.
    Membership changes create a new audience epoch; reordering does not. Hosts
    must independently reauthorize the actor, every recipient and the current
    mapped principal epoch before runs, history, tools and each outward delivery.
    """
    if not isinstance(context, BridgeContext):
        raise TypeError("a channel context is required")
    if (not context.audience_complete or context.audience_verified_at is None
            or not context.audience_ids or context.actor_id not in context.audience_ids):
        return None
    if context.conversation_kind == "direct":
        if set(context.audience_ids) != {context.actor_id}:
            return None
        mode, private_actor = "private", context.actor_id
    elif context.conversation_kind == "channel" and context.thread_id is None:
        mode, private_actor = "channel", None
    elif context.conversation_kind == "thread" and context.thread_id is not None:
        mode, private_actor = "thread", None
    else:
        return None
    audience = tuple(sorted(context.audience_ids, key=lambda value: value.encode("utf-8")))
    epoch = hashlib.sha256(_framed(("openagent-channel-audience/v1", *audience))).hexdigest()
    key = "oa-channel-v1-" + hashlib.sha256(_framed((
        "openagent-channel-session/v1", context.binding_id, context.provider,
        context.account_id, mode, context.conversation_id, context.thread_id or "",
        private_actor or "", epoch,
    ))).hexdigest()
    return BridgeConversation(mode, context.binding_id, context.provider,
                              context.account_id, context.conversation_id,
                              context.thread_id, private_actor, audience, epoch, key)
