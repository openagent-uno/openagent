"""Credential-store regressions for multi-account rotation."""

from __future__ import annotations

import json

import pytest

from claude_sub_proxy import auth
from claude_sub_proxy.auth import NoAvailableAccountError, TokenManager


def _clear_unmanaged_fallbacks(monkeypatch):
    for var in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(auth, "_read_keychain_cred", lambda: None)


def test_single_credential_file_migrates_when_written(tmp_path):
    creds_file = tmp_path / "credentials.json"
    creds_file.write_text(
        json.dumps(
            {
                "access_token": "old-access",
                "refresh_token": "old-refresh",
                "expires_at_ms": 0,
            }
        )
    )

    manager = TokenManager(creds_file)

    assert manager.get_token() == "old-access"
    manager.save_account(
        {"access_token": "next-access", "refresh_token": "next-refresh", "expires_at_ms": 0},
        name="work",
        priority=10,
    )

    data = json.loads(creds_file.read_text())
    assert data["version"] == 2
    assert [account["name"] for account in data["accounts"]] == ["work", "account-1"]
    assert [account["priority"] for account in data["accounts"]] == [10, 100]


def test_unnamed_accounts_append_array_slots(tmp_path, monkeypatch):
    _clear_unmanaged_fallbacks(monkeypatch)
    manager = TokenManager(tmp_path / "credentials.json")

    first = manager.save_account({"access_token": "token-1", "refresh_token": "", "expires_at_ms": 0})
    second = manager.save_account({"access_token": "token-2", "refresh_token": "", "expires_at_ms": 0})

    assert first["name"] == "account-1"
    assert second["name"] == "account-2"
    assert [account["name"] for account in manager.list_accounts()] == ["account-1", "account-2"]


def test_priority_order_limit_skip_and_switch_back(tmp_path, monkeypatch):
    _clear_unmanaged_fallbacks(monkeypatch)
    now = [100_000]
    monkeypatch.setattr(auth, "_now_ms", lambda: now[0])
    manager = TokenManager(tmp_path / "credentials.json")
    account_1 = manager.save_account(
        {"access_token": "token-1", "refresh_token": "", "expires_at_ms": 0},
        name="account-1",
        priority=1,
    )
    account_2 = manager.save_account(
        {"access_token": "token-2", "refresh_token": "", "expires_at_ms": 0},
        name="account-2",
        priority=20,
    )

    assert manager.select_account().id == account_1["id"]

    manager.mark_rate_limited(account_1["id"], 60, reason="limit")
    selected = manager.select_account()
    assert selected.id == account_2["id"]
    assert selected.token == "token-2"

    now[0] += 60_001
    assert manager.select_account().id == account_1["id"]

    updated = manager.set_priority("account-2", 0)
    assert updated["priority"] == 0
    assert manager.list_accounts()[0]["name"] == "account-2"

    deleted = manager.delete_account("account-2")
    assert deleted["id"] == account_2["id"]
    manager.mark_rate_limited(account_1["id"], 60, reason="limit")
    with pytest.raises(NoAvailableAccountError):
        manager.select_account()
