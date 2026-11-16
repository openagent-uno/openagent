"""A gateway loss that surfaces as an intake failure must still reconnect.

Regression: a loss arriving while a channel client was still starting made the
loss hook retire that client, the intake raised, and the next loop iteration
cleared the loss without replacing the dead transport. The provider then kept
consuming updates with no gateway to deliver them.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from openagent_channel_bridges import base as base_module
from openagent_channel_bridges.base import BaseBridge
from openagent_channel_bridges.contracts import BridgeCapabilities


class Transport:
    def __init__(self):
        self.loss_event = asyncio.Event()
        self.starts = 0
        self.stops = 0

    async def start(self):
        self.starts += 1
        return BridgeCapabilities(core_commands=("session",))

    async def stop(self):
        self.stops += 1


@pytest.fixture(autouse=True)
def immediate_retries(monkeypatch):
    monkeypatch.setattr(base_module, "BRIDGE_RETRY_SECONDS", 0)
    monkeypatch.setattr(base_module, "BRIDGE_GATEWAY_RECONNECT_BASE_SECONDS", 0)
    monkeypatch.setattr(base_module, "BRIDGE_GATEWAY_RECONNECT_MAX_SECONDS", 0)


class LossDuringIntake(BaseBridge):
    name = "probe"

    def __init__(self, transport):
        super().__init__(transport=transport, binding_id="binding")
        self.runs = []

    async def _run(self):
        self.runs.append(self.transport.starts)
        if len(self.runs) == 1:
            # The transport reports the loss, then intake fails because the
            # loss hook retired the client it was still starting.
            self._gateway_lost.set()
            raise AttributeError("client retired by the loss hook")
        self._should_stop = True


@pytest.mark.asyncio
async def test_intake_failure_after_gateway_loss_reconnects_transport():
    transport = Transport()
    bridge = LossDuringIntake(transport)
    await asyncio.wait_for(bridge.start(), 5)
    assert bridge.runs == [1, 2], "the second intake must run on a reconnected transport"
    assert transport.starts == 2
    assert transport.stops >= 2  # the lost transport, then the final shutdown


@pytest.mark.asyncio
async def test_intake_failure_without_gateway_loss_keeps_transport():
    transport = Transport()

    class PlatformFailure(LossDuringIntake):
        async def _run(self):
            self.runs.append(self.transport.starts)
            if len(self.runs) == 1:
                raise RuntimeError("synthetic platform failure")
            self._should_stop = True

    bridge = PlatformFailure(transport)
    await asyncio.wait_for(bridge.start(), 5)
    assert bridge.runs == [1, 1]
    assert transport.starts == 1


telegram = pytest.importorskip("telegram")


class FakeUpdater:
    def __init__(self, owner):
        self.owner, self.running = owner, False

    async def start_polling(self):
        self.running = True
        self.owner.polled = True
        await self.owner.after_polling()

    async def stop(self):
        if not self.running:
            raise RuntimeError("This Updater is not running!")
        self.running = False


class FakeApplication:
    def __init__(self, on_initialize, after_polling):
        self.bot = SimpleNamespace(set_my_commands=AsyncMock(return_value=True))
        self.updater = FakeUpdater(self)
        self.running = self.initialized = self.polled = False
        self.on_initialize, self.after_polling = on_initialize, after_polling

    def add_handler(self, handler):
        pass

    async def initialize(self):
        self.initialized = True
        await self.on_initialize(self)

    async def start(self):
        if not self.initialized:
            raise RuntimeError("This Application was not initialized")
        self.running = True

    async def stop(self):
        if not self.running:
            raise RuntimeError("This Application is not running!")
        self.running = False

    async def shutdown(self):
        self.initialized = False


@pytest.mark.asyncio
async def test_telegram_loss_racing_client_start_reconnects_and_never_polls_orphaned(monkeypatch):
    from openagent_channel_bridges.telegram import TelegramBridge

    transport = Transport()
    bridge = TelegramBridge("000:synthetic", allowed_users=["111"], transport=transport,
                            binding_id="binding")
    apps = []

    async def on_initialize(app):
        if len(apps) == 1:
            # The gateway drops while the first client is still starting; the
            # transport's loss hook retires the client concurrently.
            bridge._gateway_lost.set()
            await bridge._on_gateway_lost()

    async def after_polling():
        bridge._should_stop = True

    class Builder:
        def token(self, token):
            return self

        def concurrent_updates(self, enabled):
            return self

        def build(self):
            app = FakeApplication(on_initialize, after_polling)
            apps.append(app)
            return app

    monkeypatch.setattr("telegram.ext.ApplicationBuilder", Builder)
    await asyncio.wait_for(bridge.start(), 5)

    assert transport.starts == 2, "the bridge must reconnect after the loss"
    assert [app.polled for app in apps] == [False, True]
    assert not any(app.updater.running or app.running for app in apps)


@pytest.mark.asyncio
async def test_telegram_run_stops_its_client_when_loss_arrives_before_polling(monkeypatch):
    from openagent_channel_bridges.telegram import TelegramBridge

    transport = Transport()
    bridge = TelegramBridge("000:synthetic", allowed_users=["111"], transport=transport,
                            binding_id="binding")
    bridge._capabilities = BridgeCapabilities(core_commands=("session",))

    async def on_initialize(app):
        # Loss observed without the hook running yet (hook still queued).
        bridge._gateway_lost.set()

    created = []

    class Builder:
        def token(self, token):
            return self

        def concurrent_updates(self, enabled):
            return self

        def build(self):
            app = FakeApplication(on_initialize, AsyncMock())
            created.append(app)
            return app

    monkeypatch.setattr("telegram.ext.ApplicationBuilder", Builder)
    await asyncio.wait_for(bridge._run(), 5)
    (app,) = created
    assert app.polled is False
    assert app.running is False and app.updater.running is False
    assert bridge._app is None
