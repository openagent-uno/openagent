"""Verify raw Slack HTTP events before handing them to a channel adapter.

This helper opens no server, stores no token and performs no connector/tool
execution. Installations, durable queues and host routing belong to the channel
ingress operator. Signature verification alone never authorizes a host binding.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import time


@dataclass(frozen=True, slots=True)
class SlackEventEnvelope:
    app_id: str
    account_id: str
    event_id: str
    event: dict


def verify_slack_event(raw_body: bytes, *, signing_secret: str,
                       timestamp: str, signature: str,
                       expected_app_id: str, expected_account_id: str,
                       now: float | None = None) -> SlackEventEnvelope:
    """Check signature, five-minute window, app and installation, fail closed.

    Use exact request bytes, not JSON reserialization. A durable queue must
    deduplicate account/app/event IDs before ACK; do not run an agent inline in
    Slack's request acknowledgement window. URL verification and interactions
    are separate request kinds, not ordinary message events.
    """
    if not isinstance(raw_body, bytes) or len(raw_body) > 1_048_576:
        raise ValueError("Slack request body must be at most 1 MiB")
    if not signing_secret or not expected_app_id or not expected_account_id:
        raise ValueError("Slack signing and installation configuration is required")
    if (not isinstance(timestamp, str) or not 1 <= len(timestamp) <= 20
            or not timestamp.isascii() or not timestamp.isdigit()):
        raise PermissionError("Invalid Slack request timestamp")
    if abs((time.time() if now is None else now) - int(timestamp)) > 300:
        raise PermissionError("Stale Slack request")
    base = b"v0:" + timestamp.encode("ascii") + b":" + raw_body
    expected = "v0=" + hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    if (not isinstance(signature, str) or not signature.isascii()
            or len(signature) != 67 or not hmac.compare_digest(expected, signature)):
        raise PermissionError("Invalid Slack signature")
    payload = json.loads(raw_body)
    if not isinstance(payload, dict) or payload.get("type") != "event_callback":
        raise ValueError("Expected a Slack event callback")
    if payload.get("api_app_id") != expected_app_id or payload.get("team_id") != expected_account_id:
        raise PermissionError("Slack event belongs to a different installation")
    event_id, event = payload.get("event_id"), payload.get("event")
    if not isinstance(event_id, str) or not event_id or len(event_id.encode()) > 512:
        raise ValueError("Slack event ID is missing or invalid")
    if not isinstance(event, dict):
        raise ValueError("Slack event body is missing")
    return SlackEventEnvelope(expected_app_id, expected_account_id, event_id, event)
