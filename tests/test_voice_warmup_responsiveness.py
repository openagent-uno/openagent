"""Voice cold imports must leave owned HTTP and shutdown responsive.

No optional voice package, model, download, provider or real user state is used.
Thread gates are bounded and always released before executor shutdown.
"""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import ClientSession, ClientTimeout, web
from aiohttp.test_utils import TestServer

from openagent_server import bootstrap
from openagent_server.server import AgentServer


_SCOPE = ContextVar("owned_voice_warmup_scope", default="unset")
_VOICE = "openagent_core.voice.voice"
_PIPER = "openagent_core.voice.tts_local"


class Imports:
    def __init__(self, *, block_import=True, block_available=False):
        self.block_import = block_import
        self.block_available = block_available
        self.release_import = threading.Event()
        self.release_available = threading.Event()
        self.entered = {name: threading.Event() for name in (_VOICE, _PIPER)}
        self.finished = {name: threading.Event() for name in (_VOICE, _PIPER)}
        self.available_entered = threading.Event()
        self.available_finished = threading.Event()
        self.calls = []
        self.loads = []
        self.voice = SimpleNamespace(_load_local_model=self.load_whisper)
        self.piper = SimpleNamespace(is_available=self.available,
            _resolve_voice_name=self.resolve, _load_voice=self.load_piper)

    def import_module(self, name):
        self.calls.append((name, threading.get_ident(), _SCOPE.get()))
        if name == "faster_whisper":
            return SimpleNamespace()
        if name not in self.entered:
            raise AssertionError("Unexpected optional voice import")
        self.entered[name].set()
        try:
            if self.block_import and not self.release_import.wait(3):
                raise RuntimeError("Owned import gate timed out")
            return self.voice if name == _VOICE else self.piper
        finally:
            self.finished[name].set()

    def available(self):
        self.calls.append(("availability", threading.get_ident(), _SCOPE.get()))
        self.available_entered.set()
        try:
            if self.block_available and not self.release_available.wait(3):
                raise RuntimeError("Owned availability gate timed out")
            return True
        finally:
            self.available_finished.set()

    def resolve(self, voice):
        self.loads.append(("resolve", asyncio.get_running_loop(), threading.get_ident(), _SCOPE.get()))
        return "owned-voice"

    async def load_whisper(self):
        self.loads.append(("whisper", asyncio.get_running_loop(), threading.get_ident(), _SCOPE.get()))

    async def load_piper(self, voice):
        if voice != "owned-voice":
            raise AssertionError("Wrong owned voice")
        self.loads.append(("piper", asyncio.get_running_loop(), threading.get_ident(), _SCOPE.get()))

    def release(self):
        self.release_import.set()
        self.release_available.set()


async def wait_events(*events):
    async def waiting():
        while not all(event.is_set() for event in events):
            await asyncio.sleep(0.001)
    await asyncio.wait_for(waiting(), 1)


class VoiceWarmupResponsiveness(unittest.IsolatedAsyncioTestCase):
    def install(self, fixture):
        self.enterContext(patch.object(bootstrap, "importlib",
            SimpleNamespace(import_module=fixture.import_module)))
        self.enterContext(patch("openagent_core.core.logging.elog"))
        self.addCleanup(fixture.release)

    async def drain(self, fixture, tasks):
        fixture.release()
        await asyncio.gather(*tasks, return_exceptions=True)
        for event in fixture.finished.values():
            if event.is_set():
                continue
            # Imports that were never scheduled have no worker to drain.
            index = next(name for name, marker in fixture.finished.items() if marker is event)
            if fixture.entered[index].is_set():
                await wait_events(event)
        if fixture.available_entered.is_set():
            await wait_events(fixture.available_finished)

    async def test_http_and_heartbeat_continue_while_cold_imports_wait_with_context(self):
        fixture = Imports()
        self.install(fixture)
        loop, main_thread = asyncio.get_running_loop(), threading.get_ident()
        application = web.Application()
        async def health(request):
            return web.json_response({"owned": True})
        application.router.add_get("/health", health)
        server = TestServer(application)
        await server.start_server()
        token = _SCOPE.set("owned-runtime")
        tasks = bootstrap.start_voice_warmups({})
        _SCOPE.reset(token)
        try:
            await wait_events(*fixture.entered.values())
            heartbeat = asyncio.Event()
            loop.call_soon(heartbeat.set)
            await asyncio.wait_for(heartbeat.wait(), 1)
            async with ClientSession(timeout=ClientTimeout(total=1)) as client:
                async with client.get(server.make_url("/health")) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(await response.json(), {"owned": True})
            self.assertTrue(all(not event.is_set() for event in fixture.finished.values()))
            self.assertEqual(fixture.loads, [])
            fixture.release()
            await asyncio.gather(*tasks)
            self.assertEqual({row[0] for row in fixture.loads}, {"whisper", "resolve", "piper"})
            self.assertTrue(all(row[1] is loop and row[2] == main_thread and row[3] == "owned-runtime"
                for row in fixture.loads))
            self.assertTrue(all(thread != main_thread and context == "owned-runtime"
                for _, thread, context in fixture.calls))
        finally:
            await self.drain(fixture, tasks)
            await server.close()

    async def test_server_shutdown_cancels_import_wait_and_prevents_late_model_load(self):
        fixture = Imports()
        self.install(fixture)
        agent = SimpleNamespace(name="owned-voice-fixture", shutdown=AsyncMock())
        server = AgentServer(agent, {})
        server._stop_event = asyncio.Event()
        tasks = bootstrap.start_voice_warmups({})
        server._warmup_tasks = set(tasks)
        self.enterContext(patch("openagent_server.server.elog"))
        self.enterContext(patch("openagent_core.memory.vault.service.get_service",
            return_value=SimpleNamespace(autocommit=AsyncMock())))
        self.enterContext(patch("openagent_core.memory.vault.service.close_all", new=AsyncMock()))
        try:
            await wait_events(*fixture.entered.values())
            await asyncio.wait_for(server.stop(timeout=1), 1)
            agent.shutdown.assert_awaited_once()
            self.assertTrue(server._stop_event.is_set())
            self.assertTrue(all(task.cancelled() for task in tasks))
            self.assertTrue(all(not event.is_set() for event in fixture.finished.values()))
            fixture.release()
            await wait_events(*fixture.finished.values())
            await asyncio.sleep(0)
            self.assertEqual(fixture.loads, [])
        finally:
            await self.drain(fixture, tasks)

    async def test_cancelled_availability_probe_cannot_later_load_piper(self):
        fixture = Imports(block_import=False, block_available=True)
        self.install(fixture)
        tasks = bootstrap.start_voice_warmups({})
        try:
            await wait_events(fixture.available_entered)
            piper = next(task for task in tasks if task.get_name() == "product-piper-warmup")
            piper.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await piper
            fixture.release_available.set()
            await wait_events(fixture.available_finished)
            await asyncio.gather(*tasks, return_exceptions=True)
            self.assertFalse(any(row[0] in {"resolve", "piper"} for row in fixture.loads))
            self.assertTrue(all(thread != threading.get_ident()
                for name, thread, _ in fixture.calls if name == "availability"))
        finally:
            await self.drain(fixture, tasks)
