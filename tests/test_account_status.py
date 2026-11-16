"""Each serving account says whether it works, is rate-limited, or needs a new sign-in."""
from openagent_server.gateway.api.accounts import _normalise_account, account_status, provider_status

NOW = 1_800_000_000_000


def test_a_revoked_sign_in_reads_as_expired_not_as_a_limit():
    raw = {"id": "a", "limited": True, "last_error": 'HTTP 401: {"code": "refresh_token_invalidated"}'}
    assert account_status(raw, NOW) == "auth_expired"
    assert account_status({"id": "b", "expires_at_ms": NOW - 1, "has_refresh_token": False}, NOW) == "auth_expired"


def test_a_limit_that_has_not_ended_is_rate_limited():
    assert account_status({"id": "a", "limited": True, "limited_until_ms": NOW + 60_000}, NOW) == "rate_limited"
    assert account_status({"id": "a", "limited": True, "limited_until_ms": NOW - 1}, NOW) == "ok"


def test_the_error_text_is_used_only_to_classify():
    out = _normalise_account({"id": "a", "last_error": "session has ended, secret-ish detail"}, NOW)
    assert out["status"] == "auth_expired" and "last_error" not in out


def test_provider_status_is_the_best_account_state():
    assert provider_status({"reachable": False, "accounts": []}) == "unreachable"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}, {"status": "ok"}]}) == "ok"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}, {"status": "rate_limited"}]}) == "rate_limited"
    assert provider_status({"reachable": True, "accounts": [{"status": "auth_expired"}]}) == "auth_expired"
