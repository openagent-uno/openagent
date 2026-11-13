"""A failed Custom View publish must stay retryable and explain itself.

Regression: a revision bundle is written before the transaction that records
it. When ``BEGIN IMMEDIATE`` hit a busy writer, the bundle for revision N+1
stayed on disk and, being immutable, refused every later publish of different
content at that revision. The tool layer reported each refusal as a generic
"temporarily unavailable", so the agent retried forever.
"""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from openagent_core.memory.db import MemoryDB
from openagent_core.memory.operational.access import AccessContext
from openagent_dashboards.compiler import OAUIValidationError, compile_oaui, describe_components
from openagent_dashboards.migration import ensure_custom_views_storage
from openagent_dashboards.repository import CustomViewBusy, CustomViewRepository
from openagent_dashboards.tools import adapters


class _BusyOnce:
    """Delegate real SQL; refuse the first write transaction like SQLite does."""

    def __init__(self, conn, message="database is locked"):
        self.conn = conn
        self.message = message
        self.refused = 0

    def __getattr__(self, name):
        return getattr(self.conn, name)

    async def execute(self, sql, parameters=()):
        if sql.lstrip().upper().startswith("BEGIN") and not self.refused:
            self.refused += 1
            raise sqlite3.OperationalError(self.message)
        return await self.conn.execute(sql, parameters)


class DashboardWriteRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / "state.sqlite3"))

        async def migrate(conn):
            await ensure_custom_views_storage(conn, app_version="write-recovery-test")

        self.db.add_migration(migrate)
        await self.db.connect()
        self.conn = await self.db._ensure_connected()
        self.repo = CustomViewRepository(self.db)
        self.access = AccessContext(
            "tenant", "user:alice", "user", "alice", "device",
            frozenset({"user:alice"}), frozenset({("user", "user:alice")}),
        )
        self.view = await self.repo.create(
            self.access, surface="sidebar", title="Board", markup="<text>v1</text>",
        )

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    def bundle_dir(self, revision):
        return self.repo.bundles.revision_path(self.view["id"], revision)

    async def test_update_after_busy_publish_accepts_different_markup(self):
        busy = _BusyOnce(self.conn)
        with patch.object(self.repo, "_conn", AsyncMock(return_value=busy)):
            with self.assertRaises(CustomViewBusy):
                await self.repo.update(
                    self.view["id"], self.access, expected_revision=1,
                    markup="<text>first attempt</text>",
                )
        # The failed attempt left its unreferenced bundle behind.
        self.assertTrue(self.bundle_dir(2).exists())

        updated = await self.repo.update(
            self.view["id"], self.access, expected_revision=1,
            markup='<card><heading level="2">Second attempt</heading></card>',
        )
        self.assertEqual(updated["revision"], 2)
        self.assertIn("Second attempt", updated["markup"])
        reread = await self.repo.get(self.view["id"], self.access)
        self.assertEqual(reread["revision"], 2)
        self.assertIn("Second attempt", reread["markup"])
        leftovers = [
            item.name for item in self.bundle_dir(2).parent.iterdir()
            if item.name.startswith(".")
        ]
        self.assertEqual(leftovers, [])

    async def test_source_revision_after_busy_publish_is_recoverable(self):
        busy = _BusyOnce(self.conn, "cannot start a transaction within a transaction")
        with patch.object(self.repo, "_conn", AsyncMock(return_value=busy)):
            with self.assertRaises(CustomViewBusy):
                await self.repo.update(
                    self.view["id"], self.access, expected_revision=1,
                    markup="<text>stranded</text>",
                )
        await self.repo.configure_source(
            self.view["id"], "seed",
            {"driver": "static", "config": {"value": {"count": 3}}},
            self.access, expected_revision=1,
        )
        reread = await self.repo.get(self.view["id"], self.access)
        self.assertEqual(reread["revision"], 2)
        self.assertIn("v1", reread["markup"])

    async def test_referenced_revision_bundle_is_never_reclaimed(self):
        await self.repo.update(
            self.view["id"], self.access, expected_revision=1,
            markup="<text>published</text>",
        )
        published = self.bundle_dir(2)
        snapshot = sorted(path.name for path in published.rglob("*"))
        with self.assertRaises(Exception):
            await self.repo._claim_revision_bundle(
                self.conn, None, view_id=self.view["id"], revision=2,
                bundle={"markup": "<text>other</text>", "spec": {}},
                scripts={}, assets={},
            )
        self.assertEqual(sorted(path.name for path in published.rglob("*")), snapshot)
        reread = await self.repo.get(self.view["id"], self.access)
        self.assertIn("published", reread["markup"])


class UIManagerContractTests(unittest.IsolatedAsyncioTestCase):
    def toolkit(self, service):
        async def access():
            return SimpleNamespace(principal_type="user", device_id="device")

        return adapters.build_runtime_toolkit(service=service, access_provider=access)

    async def test_busy_and_rate_limits_are_retryable_not_generic(self):
        from openagent_dashboards.repository import CustomViewRateLimited

        service = SimpleNamespace(
            update=AsyncMock(side_effect=CustomViewBusy(CustomViewBusy.public_message)),
            refresh_source=AsyncMock(side_effect=CustomViewRateLimited("limit")),
        )
        tools = self.toolkit(service).async_functions
        busy = await tools["ui_update_view"].entrypoint(
            view_id="v", expected_revision=1, markup="<text>x</text>",
        )
        self.assertEqual((busy["error"], busy["retryable"]), ("busy", True))
        limited = await tools["ui_refresh_source"].entrypoint(view_id="v", key="k")
        self.assertEqual((limited["error"], limited["retryable"]), ("rate_limited", True))

    async def test_unexpected_failures_name_their_class_only(self):
        service = SimpleNamespace(
            update=AsyncMock(side_effect=KeyError("secret-user-value")),
        )
        tools = self.toolkit(service).async_functions
        with self.assertLogs(adapters.logger, level="ERROR") as logs:
            result = await tools["ui_update_view"].entrypoint(
                view_id="v", expected_revision=1, markup="<text>x</text>",
            )
        self.assertEqual(result["error"], "temporarily_unavailable")
        self.assertIn("KeyError", result["message"])
        self.assertNotIn("secret-user-value", result["message"])
        self.assertNotIn("secret-user-value", "\n".join(logs.output))

    async def test_schema_describes_component_properties(self):
        tools = self.toolkit(SimpleNamespace()).async_functions
        full = await tools["ui_get_schema"].entrypoint()
        self.assertIn("rows", full["componentSchema"]["components"]["table"]["properties"])
        self.assertTrue(full["componentSchema"]["components"]["card"]["container"])
        self.assertIn("repetition", full)
        one = await tools["ui_get_schema"].entrypoint(component="list")
        self.assertEqual(list(one["components"]), ["list"])
        unknown = await tools["ui_get_schema"].entrypoint(component="carousel")
        self.assertEqual((unknown["ok"], unknown["error"]), (False, "invalid_view"))


class OAUIAuthoringErrorTests(unittest.TestCase):
    def test_collection_data_alias_matches_renderer(self):
        compile_oaui(markup='<table data.bind="{{data.jobs.rows}}" />')
        compile_oaui(markup='<list data.bind="{{data.jobs.items}}" />')
        compile_oaui(markup='<key-value data.bind="{{data.jobs.summary}}" />')

    def test_errors_point_to_the_supported_alternatives(self):
        with self.assertRaises(OAUIValidationError) as prop:
            compile_oaui(markup='<table items="[]" />')
        self.assertIn("rows", str(prop.exception))
        with self.assertRaises(OAUIValidationError) as child:
            compile_oaui(markup="<list><text>x</text></list>")
        self.assertIn("card", str(child.exception))
        with self.assertRaises(OAUIValidationError) as unknown:
            compile_oaui(markup="<carousel />")
        self.assertIn("carousel", str(unknown.exception))

    def test_component_schema_covers_every_component(self):
        described = describe_components()["components"]
        from openagent_dashboards.compiler import COMPONENTS

        self.assertEqual(set(described), set(COMPONENTS))


if __name__ == "__main__":
    unittest.main()
