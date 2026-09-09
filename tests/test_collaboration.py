import asyncio
import unittest

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from openagent_cli.collaboration import CollaborationClient


class CollaborationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.posts, self.views = [], []
        self.connections = 0

        async def post(request):
            body = await request.json()
            self.posts.append((request.path, body))
            return web.json_response(
                {"request_id": body["request_id"], "response": "ok"}
            )

        async def observe(request):
            self.connections += 1
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.send_json({"type": "auth_ok", "shared": True})
            self.views.append(await ws.receive_json())
            await ws.send_json(
                {
                    "type": "shared_state",
                    "session_id": "chat",
                    "revision": self.connections,
                    "turns": [],
                }
            )
            await ws.close()
            return ws

        app = web.Application()
        app.router.add_post("/api/collaboration/turns", post)
        app.router.add_post("/api/collaboration/stop", post)
        app.router.add_get("/ws/collaboration", observe)
        self.server = TestServer(app)
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        self.http = ClientSession()
        self.addAsyncCleanup(self.http.close)
        self.client = CollaborationClient(self.http, str(self.server.make_url("")))

    async def test_steering_commands_and_stop_preserve_request_identity(self):
        await self.client.send_turn("chat", "one", "Correction", delivery="steer")
        await self.client.send_turn("chat", "two", "/compact")
        await self.client.stop_turn("chat", "one")
        self.assertEqual(
            self.posts[0][1],
            {
                "session_id": "chat",
                "request_id": "one",
                "message": "Correction",
                "delivery": "steer",
            },
        )
        self.assertEqual(self.posts[1][1]["message"], "/compact")
        self.assertEqual(
            self.posts[2],
            ("/api/collaboration/stop", {"session_id": "chat", "request_id": "one"}),
        )

    async def test_reconnect_reobserves_without_sending_or_stopping(self):
        iterator = self.client.observe(
            ["chat"], focus={"kind": "session", "id": "chat"}
        )
        frames = []
        async with asyncio.timeout(3):
            async for frame in iterator:
                frames.append(frame)
                if frame.get("revision") == 2:
                    break
        await iterator.aclose()
        self.assertEqual(self.views[0], self.views[1])
        self.assertEqual(self.posts, [])
        self.assertEqual(frames[0]["type"], "shared_reset")
        self.assertGreaterEqual(
            sum(frame["type"] == "shared_reset" for frame in frames), 2
        )

    async def test_invalid_input_never_reaches_transport(self):
        for sid, mode in [("../private", "queue"), ("chat", "invalid")]:
            with self.assertRaises(ValueError):
                await self.client.send_turn(sid, "request", "Hello", delivery=mode)
        iterator = self.client.observe(["chat"] * 17)
        with self.assertRaises(ValueError):
            await anext(iterator)
        self.assertEqual(self.posts, [])


if __name__ == "__main__":
    unittest.main()
