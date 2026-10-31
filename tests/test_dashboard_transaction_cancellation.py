"""Real SQLite transaction ownership and cancellation regressions."""

import asyncio
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from openagent_core.memory.db import MemoryDB
from openagent_core.memory.operational.access import AccessContext
from openagent_dashboards.migration import REQUIRED_TABLES, ensure_custom_views_storage
from openagent_dashboards.repository import CustomViewRepository


class _InterruptedConnection:
    """Delegate real SQL; interrupt only after SQLite has executed owned DML."""

    def __init__(self, conn, *, failure=None, rollback_failure=None):
        self.conn = conn
        self.failure = failure
        self.rollback_failure = rollback_failure
        self.written = asyncio.Event()
        self.owned = False
        self.rollback_calls = 0

    def __getattr__(self, name):
        return getattr(self.conn, name)

    async def execute(self, sql, parameters=()):
        cursor = await self.conn.execute(sql, parameters)
        command = sql.lstrip().split(None, 1)[0].upper()
        if command == "BEGIN":
            self.owned = True
        elif self.owned and command in {"INSERT", "UPDATE", "DELETE"}:
            self.owned = False
            self.written.set()
            if self.failure is not None:
                raise self.failure
            await asyncio.Event().wait()
        return cursor

    async def rollback(self):
        self.rollback_calls += 1
        await self.conn.rollback()
        if self.rollback_failure is not None:
            raise self.rollback_failure


class DashboardTransactionCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / "state.sqlite3"))

        async def migrate(conn):
            await ensure_custom_views_storage(conn, app_version="transaction-test")

        self.db.add_migration(migrate)
        await self.db.connect()
        self.conn = await self.db._ensure_connected()
        self.repo = CustomViewRepository(self.db)
        self.access = AccessContext(
            "tenant", "user:alice", "user", "alice", "device",
            frozenset({"user:alice"}), frozenset({("user", "user:alice")}),
        )
        self.view = await self.create("Existing")
        await self.repo.set_grant(
            self.view["id"], self.access, principal_type="user", principal_id="bob",
            permissions=["view"], expected_acl_version=1,
        )

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def create(self, title):
        return await self.repo.create(
            self.access, surface="sidebar", title=title, markup="<text>Hello</text>",
            sources={"seed": {"driver": "static", "config": {"value": 1}}},
        )

    async def snapshot(self):
        result = {}
        for table in sorted(REQUIRED_TABLES | {"resource_acl"}):
            rows = await (await self.conn.execute(f"SELECT * FROM {table}")).fetchall()
            result[table] = sorted((tuple(row) for row in rows), key=repr)
        return result

    async def operation(self, name):
        view_id = self.view["id"]
        if name == "create":
            return await self.create("Cancelled")
        if name == "set_grant":
            return await self.repo.set_grant(
                view_id, self.access, principal_type="user", principal_id="carol",
                permissions=["view"], expected_acl_version=2,
            )
        if name == "delete_grant":
            return await self.repo.delete_grant(
                view_id, self.access, principal_type="user", principal_id="bob",
                expected_acl_version=2,
            )
        if name == "update":
            return await self.repo.update(view_id, self.access, expected_revision=1, title="Changed")
        if name == "reactivate":
            return await self.repo.reactivate(view_id, self.access, expected_revision=1)
        if name == "configure_source":
            return await self.repo.configure_source(
                view_id, "seed", {"driver": "static", "config": {"value": 2}},
                self.access, expected_revision=1,
            )
        raise AssertionError(name)

    async def assert_cancellation_rolls_back(self, operation):
        before = await self.snapshot()
        interrupted = _InterruptedConnection(self.conn)
        with patch.object(self.repo, "_conn", AsyncMock(return_value=interrupted)):
            task = asyncio.create_task(self.operation(operation))
            try:
                await asyncio.wait_for(interrupted.written.wait(), 3)
                self.assertTrue(self.conn.in_transaction)
                task.cancel("owned transaction cancellation")
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(interrupted.rollback_calls, 1)
        self.assertFalse(self.conn.in_transaction)
        self.assertEqual(await self.snapshot(), before)
        created = await self.create("After cancellation")
        self.assertEqual(created["title"], "After cancellation")

    async def test_create_cancellation_after_insert(self):
        await self.assert_cancellation_rolls_back("create")

    async def test_set_grant_cancellation_after_update(self):
        await self.assert_cancellation_rolls_back("set_grant")

    async def test_delete_grant_cancellation_after_update(self):
        await self.assert_cancellation_rolls_back("delete_grant")

    async def test_update_cancellation_after_update(self):
        await self.assert_cancellation_rolls_back("update")

    async def test_reactivate_cancellation_after_update(self):
        await self.assert_cancellation_rolls_back("reactivate")

    async def test_source_revision_cancellation_after_update(self):
        await self.assert_cancellation_rolls_back("configure_source")

    async def test_exception_identity_survives_rollback_failure(self):
        original = RuntimeError("original DML failure")
        before = await self.snapshot()
        interrupted = _InterruptedConnection(
            self.conn, failure=original, rollback_failure=RuntimeError("cleanup failed"),
        )
        with patch.object(self.repo, "_conn", AsyncMock(return_value=interrupted)):
            with self.assertRaises(RuntimeError) as raised:
                await self.create("Failed")
        self.assertIs(raised.exception, original)
        self.assertEqual(interrupted.rollback_calls, 1)
        self.assertEqual(await self.snapshot(), before)

    async def test_cancellation_identity_survives_rollback_failure(self):
        original = asyncio.CancelledError("original cancellation")
        interrupted = _InterruptedConnection(
            self.conn, failure=original, rollback_failure=RuntimeError("cleanup failed"),
        )
        with patch.object(self.repo, "_conn", AsyncMock(return_value=interrupted)):
            with self.assertRaises(asyncio.CancelledError) as raised:
                await self.create("Failed")
        self.assertIs(raised.exception, original)
        self.assertFalse(self.conn.in_transaction)

    async def test_failed_begin_never_rolls_back_an_unowned_transaction(self):
        await self.conn.execute("BEGIN IMMEDIATE")
        await self.conn.execute("UPDATE ui_views SET title='Uncommitted owner' WHERE id=?", (self.view["id"],))
        interrupted = _InterruptedConnection(self.conn)
        try:
            with patch.object(self.repo, "_conn", AsyncMock(return_value=interrupted)):
                with self.assertRaises(sqlite3.OperationalError):
                    await self.create("Nested BEGIN rejected")
            self.assertEqual(interrupted.rollback_calls, 0)
            self.assertTrue(self.conn.in_transaction)
            row = await (await self.conn.execute("SELECT title FROM ui_views WHERE id=?", (self.view["id"],))).fetchone()
            self.assertEqual(row[0], "Uncommitted owner")
        finally:
            await self.conn.rollback()
        self.assertEqual((await self.create("After owner rollback"))["title"], "After owner rollback")
