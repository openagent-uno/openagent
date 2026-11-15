"""Session loops over the scheduled-tasks REST API, without breaking existing grants."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


class DigestStability(unittest.TestCase):
    def test_the_new_column_leaves_existing_task_digests_unchanged(self):
        from openagent_server.automation_authority import definition_digest

        before = {"id": "t1", "name": "daily", "cron_expression": "0 5 * * *", "prompt": "Run.",
                  "enabled": 1, "model": None, "timezone": None, "execution_policy_json": None}
        after = {**before, "target_session_id": None}
        loop = {**before, "target_session_id": "session-1"}
        other = {**before, "target_session_id": "session-2"}

        self.assertEqual(definition_digest("task", before), definition_digest("task", after))
        self.assertNotEqual(definition_digest("task", before), definition_digest("task", loop))
        self.assertNotEqual(definition_digest("task", loop), definition_digest("task", other))


class Gateway:
    def __init__(self, db):
        self._scheduler = SimpleNamespace(db=db)
        self.events = []

    async def broadcast_resource(self, resource, action, id=None):
        self.events.append((resource, action, id))


class LoopEndpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from openagent_core.engine import MemoryDB
        from openagent_server.gateway.api import scheduled_tasks as api

        self.temp = TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / "state.sqlite"))
        await self.db.connect()
        self.denied = set()

        async def authorized(request, db, session_id, *, permission="view", allow_missing=False):
            if session_id in self.denied:
                return None, None, None, web.json_response({"error": "session not found"}, status=404)
            return None, None, {"resource_id": session_id}, None

        async def mutate(request, kind, operation):
            return await operation(self.db)

        async def no_op(*args, **kwargs):
            return None

        async def authorized_ids(request, kind):
            return None

        self.patches = [
            mock.patch("openagent_server.gateway.api.sessions._authorized_session", authorized),
            mock.patch("openagent_server.automation_management.mutate_request", mutate),
            mock.patch("openagent_server.automation_management.authorized_definition_ids", authorized_ids),
            mock.patch("openagent_server.gateway.api.operational.claim_created_resource", no_op),
            mock.patch("openagent_server.gateway.api.scheduled_tasks._resolve_read_db", lambda request: (self.db, None)),
        ]
        for patch in self.patches:
            patch.start()
        app = web.Application()
        app["gateway"] = Gateway(self.db)
        app.router.add_post("/api/scheduled-tasks", api.handle_create)
        app.router.add_get("/api/scheduled-tasks", api.handle_list)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for patch in self.patches:
            patch.stop()
        await self.db.close()
        self.temp.cleanup()

    async def create(self, **extra):
        body = {"name": "hourly check", "cron_expression": "0 * * * *", "prompt": "Check.", **extra}
        response = await self.client.post("/api/scheduled-tasks", json=body)
        return response.status, await response.json()

    async def test_a_loop_is_bound_to_its_conversation_and_listed_per_session(self):
        status, created = await self.create(session_id="session-1")
        _, plain = await self.create(name="plain")
        listed = await (await self.client.get("/api/scheduled-tasks?session_id=session-1")).json()

        self.assertEqual((201, "session-1"), (status, created["target_session_id"]))
        self.assertIsNone(plain["target_session_id"])
        self.assertEqual([created["id"]], [task["id"] for task in listed["tasks"]])

    async def test_a_conversation_the_caller_cannot_administer_is_refused(self):
        self.denied.add("session-x")

        status, _ = await self.create(session_id="session-x")

        self.assertEqual(404, status)
        self.assertEqual([], await self.db.get_tasks())
