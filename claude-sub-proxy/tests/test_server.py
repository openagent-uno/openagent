"""Server-layer regression tests for concurrency/backpressure.

These tests deliberately avoid live Claude traffic. They patch the module-level
client and exercise the proxy's admission/lease logic directly.
"""

from __future__ import annotations

import pytest

from claude_sub_proxy.auth import AccountToken, NoAvailableAccountError
from claude_sub_proxy import server
from claude_sub_proxy.cc_anthropic import AnthropicHTTPError


class FakeClient:
    def complete(self, payload, *, token=None):
        return {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    def stream(self, payload, *, token=None):
        yield {"type": "message_start", "message": {"id": "m", "role": "assistant"}}
        yield {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}
        yield {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}
        yield {"type": "message_stop"}


class FakeTokenManager:
    def __init__(self):
        self.accounts = [
            AccountToken(id="account-1", name="account-1", priority=1, token="token-1"),
            AccountToken(id="account-2", name="account-2", priority=20, token="token-2"),
        ]
        self.limited = set()
        self.successes = []

    def select_account(self, *, exclude_ids=None):
        exclude = set(exclude_ids or set())
        for account in self.accounts:
            if account.id not in exclude and account.id not in self.limited:
                return account
        raise NoAvailableAccountError("no accounts")

    def mark_rate_limited(self, account_id, cooldown_s, *, reason=""):
        self.limited.add(account_id)

    def mark_success(self, account_id):
        self.successes.append(account_id)

    def account_statuses(self):
        return []


class RateLimitThenOkClient:
    def __init__(self):
        self.tokens = []

    def complete(self, payload, *, token=None):
        self.tokens.append(token)
        if token == "token-1":
            raise AnthropicHTTPError(
                429,
                {"error": {"type": "rate_limit_error", "message": "account limit"}},
            )
        return {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    def stream(self, payload, *, token=None):
        self.tokens.append(token)
        if token == "token-1":
            raise AnthropicHTTPError(
                429,
                {"error": {"type": "rate_limit_error", "message": "account limit"}},
            )
        yield {"type": "message_start", "message": {"id": "m", "role": "assistant"}}
        yield {"type": "message_stop"}


class ProviderRateLimitThenOkClient(RateLimitThenOkClient):
    def complete(self, payload, *, token=None):
        self.tokens.append(token)
        if token == "token-1":
            raise AnthropicHTTPError(
                529,
                {
                    "error": {
                        "type": "provider_error",
                        "message": (
                            "The model provider is rate-limiting requests. "
                            "Please wait a moment and try again."
                        ),
                    }
                },
            )
        return {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }


def test_no_thread_watchdog_left():
    assert not hasattr(server, "_watchdog_executor")
    assert not hasattr(server, "_wait_for_upstream")


def test_health_exposes_backpressure_settings():
    health = server.health()
    assert health["status"] == "ok"
    assert health["settings"]["stream_chunk_watchdog"] == "disabled"
    assert "upstream_max_queue" in health["settings"]
    assert "active" in health["metrics"]
    assert "queued" in health["metrics"]


def test_stream_lease_releases_slots(monkeypatch):
    monkeypatch.setattr(server, "_client", FakeClient())
    monkeypatch.setattr(server, "_token_mgr", FakeTokenManager())
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    server._next_upstream_at = 0.0

    events = list(server._stream_with_pacing({}))

    assert events[-1]["type"] == "message_stop"
    snapshot = server._metrics_snapshot()
    assert snapshot["active"] == 0
    assert snapshot["queued"] == 0
    assert snapshot["released"] >= 1
    assert snapshot["completed"] >= 1


def test_queue_full_is_controlled_error(monkeypatch):
    monkeypatch.setattr(server, "_token_mgr", FakeTokenManager())
    monkeypatch.setattr(server.settings, "upstream_admission_timeout", 0.0)
    held = []
    while server._queue_slots.acquire(blocking=False):
        held.append(True)
    try:
        with pytest.raises(server.UpstreamOverloaded):
            list(server._stream_with_pacing({}))
    finally:
        for _ in held:
            server._queue_slots.release()

    snapshot = server._metrics_snapshot()
    assert snapshot["rejected"] >= 1
    assert "queue" in snapshot["last_error"]


def test_complete_rotates_to_next_account_on_rate_limit(monkeypatch):
    token_mgr = FakeTokenManager()
    client = RateLimitThenOkClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 0)
    server._next_upstream_at = 0.0

    resp = server._complete_with_pacing({})

    assert resp["content"][0]["text"] == "ok"
    assert client.tokens == ["token-1", "token-2"]
    assert token_mgr.limited == {"account-1"}
    assert token_mgr.successes == ["account-2"]


def test_complete_rotates_on_provider_rate_limiting_message(monkeypatch):
    token_mgr = FakeTokenManager()
    client = ProviderRateLimitThenOkClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 0)
    server._next_upstream_at = 0.0

    resp = server._complete_with_pacing({})

    assert resp["content"][0]["text"] == "ok"
    assert client.tokens == ["token-1", "token-2"]
    assert token_mgr.limited == {"account-1"}
    assert token_mgr.successes == ["account-2"]


def test_stream_rotates_to_next_account_before_yield(monkeypatch):
    token_mgr = FakeTokenManager()
    client = RateLimitThenOkClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 0)
    server._next_upstream_at = 0.0

    events = list(server._stream_with_pacing({}))

    assert events[-1]["type"] == "message_stop"
    assert client.tokens == ["token-1", "token-2"]
    assert token_mgr.limited == {"account-1"}
    assert token_mgr.successes == ["account-2"]


# --- HTTP 529 overloaded_error: back off + retry the SAME account ---------

_OVERLOADED_BODY = {"error": {"type": "overloaded_error", "message": "Overloaded"}}


class OverloadedThenOkClient:
    """First call to any account is a 529 overloaded_error; then succeeds."""

    def __init__(self):
        self.tokens = []

    def complete(self, payload, *, token=None):
        self.tokens.append(token)
        if len(self.tokens) == 1:
            raise AnthropicHTTPError(529, _OVERLOADED_BODY)
        return {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }

    def stream(self, payload, *, token=None):
        self.tokens.append(token)
        if len(self.tokens) == 1:
            raise AnthropicHTTPError(529, _OVERLOADED_BODY)
        yield {"type": "message_start", "message": {"id": "m", "role": "assistant"}}
        yield {"type": "message_stop"}


class AlwaysOverloadedClient:
    def __init__(self):
        self.tokens = []

    def complete(self, payload, *, token=None):
        self.tokens.append(token)
        raise AnthropicHTTPError(529, _OVERLOADED_BODY)

    def stream(self, payload, *, token=None):
        self.tokens.append(token)
        raise AnthropicHTTPError(529, _OVERLOADED_BODY)
        yield  # pragma: no cover - generator marker


def _no_sleep(monkeypatch):
    monkeypatch.setattr(server, "_rate_limit_sleep", lambda attempt: 0.0)
    monkeypatch.setattr(server.time, "sleep", lambda *a, **k: None)


def test_complete_retries_same_account_on_overloaded(monkeypatch):
    token_mgr = FakeTokenManager()
    client = OverloadedThenOkClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 1)
    _no_sleep(monkeypatch)
    server._next_upstream_at = 0.0

    resp = server._complete_with_pacing({})

    assert resp["content"][0]["text"] == "ok"
    # Retried the SAME account on overload — no rotation, account not penalised.
    assert client.tokens == ["token-1", "token-1"]
    assert token_mgr.limited == set()
    assert token_mgr.successes == ["account-1"]


def test_complete_raises_upstream_overloaded_when_exhausted(monkeypatch):
    token_mgr = FakeTokenManager()
    client = AlwaysOverloadedClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 1)
    _no_sleep(monkeypatch)
    server._next_upstream_at = 0.0

    with pytest.raises(server.UpstreamOverloaded):
        server._complete_with_pacing({})

    # Retried (attempts = retries + 1) and never excluded the account.
    assert client.tokens == ["token-1", "token-1"]
    assert token_mgr.limited == set()


def test_stream_retries_same_account_on_overloaded(monkeypatch):
    token_mgr = FakeTokenManager()
    client = OverloadedThenOkClient()
    monkeypatch.setattr(server, "_token_mgr", token_mgr)
    monkeypatch.setattr(server, "_client", client)
    monkeypatch.setattr(server.settings, "upstream_min_interval", 0.0)
    monkeypatch.setattr(server.settings, "rate_limit_retries", 1)
    _no_sleep(monkeypatch)
    server._next_upstream_at = 0.0

    events = list(server._stream_with_pacing({}))

    assert events[-1]["type"] == "message_stop"
    assert client.tokens == ["token-1", "token-1"]
    assert token_mgr.limited == set()
    assert token_mgr.successes == ["account-1"]
