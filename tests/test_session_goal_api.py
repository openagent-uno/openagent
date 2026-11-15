"""The session goal REST endpoints drive openagent_core.session_goal."""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


class Gateway:
    def __init__(self):
        self.announced = []

    async def broadcast_resource(self, resource, action, id=None):
        self.announced.append((resource, action, id))


class SessionGoalAPI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from openagent_core.engine import MemoryDB
        from openagent_server.gateway.api import session_goal as api

        self.temp = TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / "state.sqlite"))
        await self.db.connect()
        self.gateway = Gateway()
        self.denied = set()

        async def authorized(request, db, session_id, *, permission="view", allow_missing=False):
            if (session_id, permission) in self.denied:
                return None, None, None, web.json_response({"error": "session not found"}, status=404)
            return None, None, {"resource_id": session_id}, None

        self.patches = [
            mock.patch("openagent_server.gateway.api.sessions._authorized_session", authorized),
            mock.patch("openagent_server.gateway.api.session_goal._db", lambda request: self.db),
            mock.patch("openagent_server.gateway.collaboration.guard_mutation", lambda request, sid: None),
        ]
        for patch in self.patches:
            patch.start()
        app = web.Application()
        app["gateway"] = self.gateway
        path = "/api/sessions/{session_id}/goal"
        app.router.add_get(path, api.handle_get)
        app.router.add_put(path, api.handle_put)
        app.router.add_patch(path, api.handle_patch)
        app.router.add_delete(path, api.handle_delete)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for patch in self.patches:
            patch.stop()
        await self.db.close()
        self.temp.cleanup()

    async def call(self, method, json=None, sid="s1"):
        response = await self.client.request(method, f"/api/sessions/{sid}/goal", json=json)
        return response.status, await response.json()

    async def test_set_manage_and_clear_a_goal(self):
        status, empty = await self.call("GET")
        self.assertEqual((200, None), (status, empty["goal"]))

        status, created = await self.call("PUT", {"objective": "publish the report", "max_continuations": 5})
        self.assertEqual(200, status)
        self.assertEqual(("active", 5, 0), (created["goal"]["status"], created["goal"]["max_continuations"],
                                            created["goal"]["continuations"]))

        _, paused = await self.call("PATCH", {"action": "pause"})
        _, resumed = await self.call("PATCH", {"action": "resume", "max_continuations": 8, "note": "draft ready"})
        _, done = await self.call("PATCH", {"action": "done"})
        self.assertEqual("paused", paused["goal"]["status"])
        self.assertEqual(("active", 8, "draft ready"), (resumed["goal"]["status"], resumed["goal"]["max_continuations"],
                                                        resumed["goal"]["note"]))
        self.assertEqual("achieved", done["goal"]["status"])

        status, cleared = await self.call("DELETE")
        self.assertEqual((200, True), (status, cleared["removed"]))
        self.assertEqual(("session", "updated", "s1"), self.gateway.announced[-1])
        self.assertEqual(5, len(self.gateway.announced))

    async def test_bad_requests_are_refused_without_changes(self):
        self.assertEqual(400, (await self.call("PUT", {"objective": "  "}))[0])
        self.assertEqual(400, (await self.call("PUT", {"objective": "x", "max_continuations": "many"}))[0])
        self.assertEqual(404, (await self.call("PATCH", {"action": "pause"}))[0])
        await self.call("PUT", {"objective": "x"})
        self.assertEqual(400, (await self.call("PATCH", {"action": "explode"}))[0])

    async def test_changes_need_admin_access(self):
        self.denied.add(("s1", "admin"))

        status, _ = await self.call("PUT", {"objective": "x"})

        self.assertEqual(404, status)
        self.assertEqual((200, None), (lambda r: (r[0], r[1]["goal"]))(await self.call("GET")))
        self.assertEqual([], self.gateway.announced)
