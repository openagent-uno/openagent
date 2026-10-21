import hashlib
import hmac
import json

import pytest

from openagent_channel_bridges.slack_ingress import verify_slack_event


def request(**changes):
    payload = dict(type="event_callback", api_app_id="app", team_id="team",
                   event_id="event", event={"type": "app_mention", "user": "alice"})
    payload.update(changes)
    raw = json.dumps(payload).encode()
    sig = "v0=" + hmac.new(b"test-only-signing-key", b"v0:1000:" + raw, hashlib.sha256).hexdigest()
    return dict(raw_body=raw, signing_secret="test-only-signing-key", timestamp="1000",
                signature=sig, expected_app_id="app", expected_account_id="team", now=1001)


def test_signed_envelope_preserves_actor_without_granting_host_access():
    envelope = verify_slack_event(**request())
    assert envelope.event["user"] == "alice"
    assert envelope.account_id == "team" and envelope.event_id == "event"
    assert not hasattr(envelope, "host_principal")


@pytest.mark.parametrize("changes", [
    {"now": 1301}, {"now": 699}, {"signature": "v0=invalid"},
    {"raw_body": b"{}"}, {"expected_account_id": "other"},
    {"expected_app_id": "other"}, {"timestamp": "1000.0"},
    {"signature": "v0=" + "€" * 64}, {"timestamp": "1" * 10000},
])
def test_tampering_replay_window_and_wrong_installation_are_denied(changes):
    values = request(); values.update(changes)
    with pytest.raises(PermissionError):
        verify_slack_event(**values)


def test_non_event_request_is_not_accepted_as_a_message():
    with pytest.raises(ValueError):
        verify_slack_event(**request(type="url_verification"))
