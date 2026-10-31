"""Transactional host startup: real SQLite worker, no provider or network I/O."""
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from openagent_core.memory.db import MemoryDB
from openagent_server.server import AgentServer


class StartupAbort(BaseException):
    pass


class CleanupAbort(BaseException):
    pass


class ServerStartupRollbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = MemoryDB(str(Path(self.directory.name) / "owned.sqlite3"))
        self.addAsyncCleanup(self.database.close)
        self.agent = SimpleNamespace(
            name="owned-startup-fixture", _db=self.database,
            shutdown=AsyncMock(side_effect=self.database.close),
        )
        self.server = AgentServer(self.agent, {})
        self.connection = None
        self.worker = None
        # No ambient Vault instance or event-log state is owned by this fixture.
        patches = [
            patch("openagent_server.server.elog"),
            patch("openagent_core.memory.vault.service.get_service",
                  return_value=SimpleNamespace(autocommit=AsyncMock())),
            patch("openagent_core.memory.vault.service.close_all", new=AsyncMock()),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    async def open_owned_database(self):
        await self.database.connect()
        self.connection = self.database._conn
        # aiosqlite0.22 has an explicit worker; earlier versions were a Thread.
        self.worker = getattr(self.connection, "_thread", self.connection)
        self.assertTrue(self.worker.is_alive())
        self.server._stop_event = asyncio.Event()

    async def assert_database_closed(self):
        self.assertIsNone(self.database._conn)
        with self.assertRaises(ValueError):
            await self.connection.execute("SELECT 1")
        await asyncio.to_thread(self.worker.join, 1)
        self.assertFalse(self.worker.is_alive(), "The owned SQLite worker leaked")
        self.agent.shutdown.assert_awaited_once()
        self.assertTrue(self.server._stop_event.is_set())

    async def test_budget_startup_error_closes_real_db_after_partial_gateway_failure(self):
        primary = RuntimeError("budget manager startup failed")
        network = SimpleNamespace(stop=AsyncMock())

        async def start():
            await self.open_owned_database()
            self.server._network_state = network
            self.server._gateway = SimpleNamespace(
                runtime_service=SimpleNamespace(runtime=None),
                stop=AsyncMock(side_effect=RuntimeError("partial gateway cleanup")),
            )
            raise primary

        self.server.start = start
        with self.assertRaises(RuntimeError) as caught:
            await asyncio.wait_for(self.server.__aenter__(), 3)
        self.assertIs(caught.exception, primary)
        network.stop.assert_awaited_once()
        await self.assert_database_closed()

    async def test_startup_cancellation_is_preserved_after_real_db_cleanup(self):
        opened = asyncio.Event()
        observed = []

        async def start():
            await self.open_owned_database()
            # A service object can exist before its runtime attribute is set.
            self.server._gateway = SimpleNamespace(
                runtime_service=SimpleNamespace(), stop=AsyncMock(),
            )
            opened.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError as error:
                observed.append(error)
                raise

        self.server.start = start
        task = asyncio.create_task(self.server.__aenter__())
        await asyncio.wait_for(opened.wait(), 3)
        task.cancel("cancel startup fixture")
        with self.assertRaises(asyncio.CancelledError) as caught:
            await asyncio.wait_for(task, 3)
        self.assertIs(caught.exception, observed[0])
        self.assertEqual(caught.exception.args, ("cancel startup fixture",))
        await self.assert_database_closed()

    async def test_cleanup_baseexception_still_stops_network_and_agent(self):
        primary = StartupAbort("startup interrupted")
        network = SimpleNamespace(stop=AsyncMock())

        async def start():
            await self.open_owned_database()
            self.server._network_state = network
            self.server._bridges = [SimpleNamespace(
                name="owned-bridge", stop=AsyncMock(side_effect=CleanupAbort()),
            )]
            raise primary

        self.server.start = start
        with self.assertLogs("openagent_server.server", level="WARNING"):
            with self.assertRaises(StartupAbort) as caught:
                await asyncio.wait_for(self.server.__aenter__(), 3)
        self.assertIs(caught.exception, primary)
        network.stop.assert_awaited_once()
        await self.assert_database_closed()

    async def test_stop_cancellation_in_earlier_phase_cannot_skip_critical_cleanup(self):
        await self.open_owned_database()
        network = SimpleNamespace(stop=AsyncMock())
        self.server._network_state = network
        self.server._bridges = [SimpleNamespace(
            name="owned-bridge", stop=AsyncMock(side_effect=asyncio.CancelledError("bridge stopped")),
        )]
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(self.server.stop(), 3)
        network.stop.assert_awaited_once()
        await self.assert_database_closed()

    async def test_network_baseexception_cannot_skip_agent_or_mask_startup_failure(self):
        primary = RuntimeError("startup failed before ready")

        async def start():
            await self.open_owned_database()
            self.server._network_state = SimpleNamespace(stop=AsyncMock(side_effect=CleanupAbort()))
            raise primary

        self.server.start = start
        with self.assertLogs("openagent_server.server", level="WARNING"):
            with self.assertRaises(RuntimeError) as caught:
                await asyncio.wait_for(self.server.__aenter__(), 3)
        self.assertIs(caught.exception, primary)
        await self.assert_database_closed()

    async def test_cleanup_failure_or_cancellation_does_not_replace_primary_error(self):
        for cleanup in (RuntimeError("cleanup failed"), asyncio.CancelledError(), CleanupAbort()):
            with self.subTest(cleanup=type(cleanup).__name__):
                primary = RuntimeError("original startup error")
                server = AgentServer(self.agent, {})
                server.start = AsyncMock(side_effect=primary)
                server.stop = AsyncMock(side_effect=cleanup)
                with self.assertLogs("openagent_server.server", level="WARNING"):
                    with self.assertRaises(RuntimeError) as caught:
                        await server.__aenter__()
                self.assertIs(caught.exception, primary)
                server.stop.assert_awaited_once()

    async def test_successful_context_does_not_rollback_before_exit(self):
        self.server.start = self.open_owned_database
        async with self.server as entered:
            self.assertIs(entered, self.server)
            self.agent.shutdown.assert_not_awaited()
            self.assertTrue(self.worker.is_alive())
        await self.assert_database_closed()
