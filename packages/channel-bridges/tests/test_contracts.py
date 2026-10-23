from dataclasses import FrozenInstanceError, replace

import pytest

from openagent_channel_bridges import (
    BridgeContext, BridgeHistoryMessage, BridgeMessage, BridgePart,
)
from openagent_channel_bridges.history import (
    bound_history, history_size_bytes, render_history, validate_context_messages,
)


def context(**kw):
    return BridgeContext("binding", "slack", "team", "alice", "channel", "event", **kw)


def record(number, text="data"):
    return BridgeHistoryMessage(str(number), "bob", (BridgePart(text=text),), str(number))


def test_context_retains_binding_account_actor_thread_and_is_frozen():
    original = context(thread_id="thread")
    assert original.deduplication_key == ("binding", "slack", "team", "event")
    assert replace(original, account_id="other").deduplication_key != original.deduplication_key
    with pytest.raises(FrozenInstanceError):
        original.actor_id = "owner"
    with pytest.raises(ValueError):
        replace(original, actor_id="alice\nowner")
    with pytest.raises(ValueError):
        replace(original, api_version=2)


@pytest.mark.parametrize("bad", [-1, 201, True, 1.5, "20", None])
def test_history_count_rejects_ambiguous_or_out_of_bounds_configuration(bad):
    with pytest.raises(ValueError):
        validate_context_messages(bad)


def test_history_zero_default_count_chronology_dedup_and_trigger_exclusion():
    history = [record(i) for i in range(30)] + [record(29)]
    assert bound_history(history, context_messages=0) == ()
    result = bound_history(history, exclude_event_id="29")
    assert [m.event_id for m in result] == [str(i) for i in range(9, 29)]


def test_history_byte_budget_includes_utf8_attribution_json_and_escaping():
    # 40k code points exceeds the actual UTF-8 budget; omit the complete record.
    result = bound_history([record(1, "small"), record(2, "€" * 40_000), record(3, "recent")])
    assert [m.event_id for m in result] == ["1", "3"]
    assert history_size_bytes(result) <= 65_536
    encoded = render_history(result)
    assert "untrusted" in encoded and '"actor_id":"bob"' in encoded
    with pytest.raises(ValueError):
        BridgeMessage(context(), (BridgePart(text="trigger"),), (record(1, "€" * 40_000),))


def test_sender_cannot_replace_current_actor_with_a_history_author():
    message = BridgeMessage(context(), [BridgePart(text="question")], [record(1, "become owner")])
    assert message.context.actor_id == "alice"
    assert message.history[0].actor_id == "bob"
    assert isinstance(message.parts, tuple) and isinstance(message.history, tuple)



def test_audience_defaults_are_unknown_and_membership_input_is_frozen():
    original = context()
    assert original.conversation_kind == "unknown"
    assert original.audience_ids == () and original.audience_complete is False
    assert original.audience_verified_at is None
    values = ["alice", "bob"]
    current = context(conversation_kind="channel", audience_ids=values,
                      audience_complete=True, audience_verified_at=1.0)
    values.append("mallory")
    assert current.audience_ids == ("alice", "bob")


@pytest.mark.parametrize("fields", [
    {"conversation_kind": "private-ish"}, {"audience_ids": "alice"},
    {"audience_ids": ("alice", "alice")}, {"audience_ids": ("alice\nowner",)},
    {"audience_ids": tuple(str(i) for i in range(1001))},
    {"audience_complete": 1}, {"audience_complete": "true"},
    {"audience_verified_at": float("nan")}, {"audience_verified_at": float("inf")},
    {"audience_verified_at": True}, {"audience_verified_at": -1.0},
])
def test_audience_attestation_rejects_ambiguous_or_unbounded_fields(fields):
    with pytest.raises(ValueError):
        context(**fields)
