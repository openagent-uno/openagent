"""Signing an account in to a local subscription service from the app.

The server only drives the service's own browser flow (start, then complete
with the code the page hands back) and reads its accounts from its admin
surface. No token passes through the server.
"""
import json
import unittest
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestServer

from openagent_server.gateway.api import accounts


class _Service:
    """A subscription service with accounts only on its admin surface."""

    def __init__(self):
        self.calls = []
        self.accounts = [{"id": "a1", "name": "Work", "priority": 10, "limited": False,
                          "last_error": "HTTP 401: refresh_token_invalidated"}]

    def app(self):
        app = web.Application()
        app.router.add_get("/health", self.health)
        app.router.add_get("/admin/diagnostics", self.diagnostics)
        app.router.add_post("/admin/oauth/start", self.start)
        app.router.add_post("/admin/oauth/complete", self.complete)
        return app

    def _authorized(self, request):
        return request.headers.get("Authorization") == "Bearer provider-key"

    async def health(self, request):
        return web.json_response({"status": "ok"})

    async def diagnostics(self, request):
        if not self._authorized(request):
            return web.json_response({"detail": "invalid admin api key"}, status=401)
        return web.json_response({"status": "ok", "accounts": self.accounts})

    async def start(self, request):
        if not self._authorized(request):
            return web.json_response({"detail": "invalid admin api key"}, status=401)
        return web.json_response({"authorize_url": "https://login.example/authorize?x=1", "state": "st-1",
                                  "expires_in": 600, "verifier": "must-not-leak"})

    async def complete(self, request):
        body = await request.json()
        self.calls.append(body)
        if body.get("state") != "st-1":
            return web.json_response({"detail": "unknown or expired login state"}, status=400)
        account = {"id": "a2", "name": body.get("name") or "New", "priority": body.get("priority") or 20,
                   "limited": False, "access_token": "must-not-leak", "refresh_token": "must-not-leak"}
        self.accounts.append(account)
        return web.json_response({"account": account})


class _Request(dict):
    can_read_body = True

    def __init__(self, db, provider_id, body=None):
        super().__init__()
        self.app = {"gateway": SimpleNamespace(agent=SimpleNamespace(memory_db=db), runtime_service=None)}
        self.match_info = {"id": str(provider_id)}
        self._body = body or {}

    async def json(self):
        return self._body


class _Db:
    def __init__(self, providers):
        self.providers = providers

    async def get_provider(self, provider_id):
        return next((p for p in self.providers if p["id"] == provider_id), None)

    async def list_providers(self):
        return list(self.providers)


class SubscriptionSignIn(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.service = _Service()
        self.server = TestServer(self.service.app())
        await self.server.start_server()
        base = f"http://127.0.0.1:{self.server.port}/v1"
        self.db = _Db([
            {"id": 1, "name": "subscription", "framework": "api-based", "base_url": base,
             "api_key": "provider-key", "enabled": True},
            {"id": 2, "name": "vendor", "framework": "api-based", "base_url": "https://api.vendor.example/v1",
             "api_key": "k", "enabled": True},
        ])
        self._gateway_db = accounts._db
        accounts._db = lambda request: self.db

    async def asyncTearDown(self):
        accounts._db = self._gateway_db
        await self.server.close()

    async def test_accounts_come_from_the_admin_surface_with_a_status(self):
        response = await accounts.handle_list(_Request(self.db, 0))
        providers = {p["provider"]: p for p in json.loads(response.body)["providers"]}
        subscription = providers["subscription"]
        self.assertTrue(subscription["reachable"] and subscription["sign_in"])
        self.assertEqual([("Work", "auth_expired")], [(a["name"], a["status"]) for a in subscription["accounts"]])
        self.assertEqual("auth_expired", subscription["status"])
        self.assertFalse(providers["vendor"]["sign_in"])
        self.assertNotIn("last_error", json.dumps(subscription))

    async def test_start_then_complete_adds_the_account_and_leaks_no_secret(self):
        start = await accounts.handle_sign_in_start(_Request(self.db, 1))
        started = json.loads(start.body)
        self.assertEqual({"authorize_url": "https://login.example/authorize?x=1", "state": "st-1", "expires_in": 600}, started)
        done = await accounts.handle_sign_in_complete(_Request(self.db, 1, {
            "state": "st-1", "code": "http://localhost:1455/auth/callback?code=the-code&state=x", "name": "Second"}))
        self.assertEqual(200, done.status)
        payload = json.loads(done.body)
        self.assertEqual(("Second", "ok"), (payload["account"]["name"], payload["account"]["status"]))
        self.assertNotIn("must-not-leak", done.body.decode() + start.body.decode())
        self.assertEqual("the-code", self.service.calls[0]["code"])

    async def test_refusals(self):
        self.assertEqual(400, (await accounts.handle_sign_in_start(_Request(self.db, 2))).status)
        self.assertEqual(404, (await accounts.handle_sign_in_start(_Request(self.db, 9))).status)
        self.assertEqual(400, (await accounts.handle_sign_in_complete(_Request(self.db, 1, {"state": "st-1"}))).status)
        wrong = await accounts.handle_sign_in_complete(_Request(self.db, 1, {"state": "other", "code": "c"}))
        self.assertEqual(400, wrong.status)
        self.assertIn("expired login state", wrong.body.decode())


if __name__ == "__main__":
    unittest.main()
