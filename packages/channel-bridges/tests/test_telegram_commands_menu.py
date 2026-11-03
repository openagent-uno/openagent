"""Telegram command registration recovers without reconnecting or provider IO."""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytest.importorskip("telegram")
from telegram.error import NetworkError, RetryAfter

from openagent_channel_bridges.contracts import BridgeCapabilities
from openagent_channel_bridges.telegram import TelegramBridge


def bridge(bot):
    value = TelegramBridge("000:synthetic", allowed_users=["111"], transport=object(), binding_id="binding")
    value._capabilities = BridgeCapabilities(core_commands=("session",))
    value._app = SimpleNamespace(bot=bot)
    return value


@pytest.mark.asyncio
async def test_registration_uses_negotiated_commands_and_refreshes_changed_capabilities():
    bot = SimpleNamespace(set_my_commands=AsyncMock(return_value=True))
    value = bridge(bot)
    await value._maybe_set_bot_commands_menu()
    first = bot.set_my_commands.call_args.args[0]
    names = {command.command for command in first}
    assert {"new", "clear", "stop", "status", "context", "help", "compact", "model"} == names
    await value._maybe_set_bot_commands_menu()
    bot.set_my_commands.assert_awaited_once()
    value._capabilities = BridgeCapabilities(core_commands=("instance", "session"))
    await value._maybe_set_bot_commands_menu()
    assert bot.set_my_commands.await_count == 2
    assert "restart" in {command.command for command in bot.set_my_commands.call_args.args[0]}


@pytest.mark.asyncio
@pytest.mark.parametrize("delay", [60, timedelta(seconds=60)])
async def test_retry_after_respected_and_both_sdk_duration_types_recover(monkeypatch, delay):
    monkeypatch.setenv("PTB_TIMEDELTA", "true" if isinstance(delay, timedelta) else "false")
    now = [1000.0]
    monkeypatch.setattr("openagent_channel_bridges.telegram.time.monotonic", lambda: now[0])
    bot = SimpleNamespace(set_my_commands=AsyncMock(side_effect=[RetryAfter(delay), True]))
    value = bridge(bot)
    await value._maybe_set_bot_commands_menu()
    now[0] = 1059
    await value._maybe_set_bot_commands_menu()
    bot.set_my_commands.assert_awaited_once()
    now[0] = 1060
    await value._maybe_set_bot_commands_menu()
    assert bot.set_my_commands.await_count == 2


@pytest.mark.asyncio
async def test_healthy_polling_retries_failed_registration_without_reconnecting(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("openagent_channel_bridges.telegram.time.monotonic", lambda: now[0])
    bot = SimpleNamespace(set_my_commands=AsyncMock(side_effect=[NetworkError("synthetic"), True]))
    value = bridge(bot)
    app = SimpleNamespace(bot=bot, add_handler=lambda handler: None,
                          initialize=AsyncMock(), start=AsyncMock(),
                          updater=SimpleNamespace(start_polling=AsyncMock()))

    class Builder:
        def token(self, token):
            return self

        def concurrent_updates(self, enabled):
            assert enabled is True
            return self

        def build(self):
            return app

    monkeypatch.setattr("telegram.ext.ApplicationBuilder", Builder)

    async def tick(seconds):
        now[0] += 150
        if now[0] >= 1450:
            value._should_stop = True

    monkeypatch.setattr("openagent_channel_bridges.telegram.asyncio.sleep", tick)
    await value._run()
    assert bot.set_my_commands.await_count == 2
    app.initialize.assert_awaited_once()
    app.start.assert_awaited_once()
    app.updater.start_polling.assert_awaited_once()
