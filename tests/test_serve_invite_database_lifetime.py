"""Serving packs durable invites without reopening or owning the live DB."""
import asyncio
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import aiosqlite

from openagent_core.memory.db import MemoryDB
from openagent_identity import cli_commands as invites
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.coordinator_addr_cache import write_cache
from openagent_identity.ticket import InviteTicket
from openagent_server.cli import _repack_serve_invites_after_start


class ServeInviteDatabaseLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "owned.sqlite3"
        self.config = {"memory": {"db_path": str(self.path)}}
        self.network = {"name": "owned-network", "network_id": "owned-invite-network"}
        self.db = MemoryDB(str(self.path))
        self.addAsyncCleanup(self.db.close)

    async def open_live(self):
        await self.db.connect()
        return CoordinatorStore(self.db)

    async def first(self, **kwargs):
        return await invites.mint_first_user_invite(
            agent_dir=self.root, config=self.config, network_row=self.network, **kwargs,
        )

    async def listed(self, **kwargs):
        return await invites.list_active_invite_tickets(
            agent_dir=self.root, config=self.config, network_row=self.network, **kwargs,
        )

    async def repack(self, db):
        return await _repack_serve_invites_after_start(
            agent_dir=self.root, config=self.config, network_row=self.network,
            db=db, require_address_hints=True,
        )

    def cache(self, node_id, port):
        write_cache(self.root, node_id=node_id, relay_url=None,
                    direct_addresses=[f"127.0.0.1:{port}"])

    async def test_borrowed_database_keeps_invite_id_expiry_and_refreshes_addresses(self):
        store = await self.open_live()
        with patch.object(self.db, "connect", AsyncMock(side_effect=AssertionError("must not reconnect"))) as connect, \
             patch.object(self.db, "close", AsyncMock(side_effect=AssertionError("borrower must not close"))) as close:
            provisional = await self.first(db=self.db)
            self.assertIsNotNone(provisional)
            ticket = InviteTicket.decode(provisional[0])
            original = await store.list_invitations(include_expired=True)
            self.cache(ticket.coordinator_node_id, 43123)
            bootstrap, active = await self.repack(self.db)
            self.assertEqual(bootstrap[1], provisional[1])
            self.assertEqual(len(active), 1)
            self.assertEqual(active[0]["code"], original[0].code)
            self.assertEqual(active[0]["expires_at"], original[0].expires_at)
            self.assertEqual(active[0]["uses_left"], original[0].uses_left)
            self.assertEqual(active[0]["created_by"], "auto-bootstrap")
            self.assertEqual(InviteTicket.decode(bootstrap[0]).addresses, ("127.0.0.1:43123",))
            self.assertEqual(InviteTicket.decode(active[0]["ticket"]).addresses, ("127.0.0.1:43123",))
            self.cache(ticket.coordinator_node_id, 43124)
            refreshed, _ = await self.repack(self.db)
            self.assertEqual(refreshed[1], provisional[1])
            self.assertEqual(InviteTicket.decode(refreshed[0]).addresses, ("127.0.0.1:43124",))
            self.assertEqual(await store.list_invitations(include_expired=True), original)
            connect.assert_not_awaited()
            close.assert_not_awaited()
        await self.db._conn.execute("SELECT 1")

    async def test_poststart_reader_works_with_real_sqlite_writer_without_schema_reopen(self):
        store = await self.open_live()
        initial = await self.first(db=self.db)
        self.cache(InviteTicket.decode(initial[0]).coordinator_node_id, 43123)
        await store.create_user(handle="owned-user", pake_record=b"owned-test-record", pake_algo="owned-test")
        # Another real writer can coexist with these WAL reads. A second
        # MemoryDB.connect would rerun write DDL and fail on this lock.
        writer = sqlite3.connect(self.path, timeout=0)
        self.addCleanup(writer.close)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("BEGIN IMMEDIATE")
        try:
            with self.assertRaises(sqlite3.OperationalError):
                blocker = sqlite3.connect(self.path, timeout=0)
                try:
                    blocker.execute("CREATE TABLE owned_forbidden_reopen (value INTEGER)")
                finally:
                    blocker.close()
            with patch.object(self.db, "connect", AsyncMock(side_effect=AssertionError("poststart DDL reopen"))) as connect, \
                 patch.object(self.db, "close", AsyncMock(side_effect=AssertionError("borrowed close"))) as close:
                bootstrap, active = await self.repack(self.db)
                self.assertIsNone(bootstrap)  # Existing users must never get another first-user invite.
                self.assertEqual(len(active), 1)
                self.assertEqual(active[0]["code"], initial[1]["code"])
                connect.assert_not_awaited()
                close.assert_not_awaited()
        finally:
            writer.rollback()

    async def test_disconnected_borrowed_database_never_falls_back_to_open(self):
        with patch.object(invites, "_open_db", AsyncMock(side_effect=AssertionError("no fallback"))) as opened:
            for operation in (self.first, self.listed):
                with self.subTest(operation=operation.__name__), self.assertRaises(RuntimeError):
                    await operation(db=self.db)
            for db in (None, self.db):
                with self.subTest(database=db), self.assertRaises(RuntimeError):
                    await self.repack(db)
            opened.assert_not_awaited()

    async def test_borrowed_query_error_and_cancel_leave_host_connection_alive(self):
        await self.open_live()
        for operation, method in ((self.first, "list_users"), (self.listed, "list_invitations")):
            for primary in (RuntimeError("owned query failure"), asyncio.CancelledError()):
                with self.subTest(operation=operation.__name__, failure=type(primary).__name__), \
                     patch.object(CoordinatorStore, method, AsyncMock(side_effect=primary)), \
                     patch.object(self.db, "close", AsyncMock(side_effect=AssertionError("borrowed close"))) as close:
                    with self.assertRaises(type(primary)) as caught:
                        await operation(db=self.db)
                    self.assertIs(caught.exception, primary)
                    close.assert_not_awaited()
                await self.db._conn.execute("SELECT 1")

    async def assert_partial_connect_cleanup(self, primary):
        connection = None

        async def partially_connected():
            nonlocal connection
            connection = await aiosqlite.connect(self.path)
            self.db._conn = connection
            raise primary

        with patch.object(invites, "MemoryDB", return_value=self.db), \
             patch.object(self.db, "connect", side_effect=partially_connected):
            with self.assertRaises(type(primary)) as caught:
                await invites._open_db(self.config)
        self.assertIs(caught.exception, primary)
        self.assertIsNone(self.db._conn)
        with self.assertRaises(ValueError):
            await connection.execute("SELECT 1")
        worker = getattr(connection, "_thread", connection)
        await asyncio.to_thread(worker.join, 1)
        self.assertFalse(worker.is_alive(), "The partial-connect SQLite worker leaked")

    async def test_partial_connect_error_closes_real_worker(self):
        await self.assert_partial_connect_cleanup(sqlite3.OperationalError("owned migration failure"))

    async def test_partial_connect_cancel_closes_real_worker(self):
        await self.assert_partial_connect_cleanup(asyncio.CancelledError())

    async def test_cleanup_error_does_not_mask_original_connect_error_or_cancel(self):
        for primary in (sqlite3.OperationalError("owned schema failure"), asyncio.CancelledError()):
            with self.subTest(failure=type(primary).__name__), \
                 patch.object(invites, "MemoryDB", return_value=self.db), \
                 patch.object(self.db, "connect", AsyncMock(side_effect=primary)), \
                 patch.object(self.db, "close", AsyncMock(side_effect=RuntimeError("cleanup failure"))):
                with self.assertRaises(type(primary)) as caught:
                    await invites._open_db(self.config)
                self.assertIs(caught.exception, primary)

    async def test_standalone_helpers_close_only_the_connection_they_open(self):
        for operation in (self.first, self.listed):
            with self.subTest(operation=operation.__name__), \
                 patch.object(invites, "MemoryDB", return_value=self.db), \
                 patch.object(self.db, "close", wraps=self.db.close) as close:
                await operation()
                close.assert_awaited_once()
                self.assertIsNone(self.db._conn)


if __name__ == "__main__":
    unittest.main()
