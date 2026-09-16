from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from openagent_core.engine import MemoryDB
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_server.gateway.api.providers import handle_update
from openagent_server.gateway.api.models import handle_update_db
from openagent_server.provider_management import authorize_request
from aiohttp import web


class Request(dict):
    can_read_body = True
    method = "PUT"

    def __init__(self, gateway, path, identifier, body):
        super().__init__(device_cert=object(), auth_kind="device_cert")
        self.app = {"gateway": gateway}
        self.path = path
        self.match_info = {"id": str(identifier)}
        self.body = body

    async def json(self):
        return self.body


class ProviderManagementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = MemoryDB(str(Path(self.temp.name) / "state.sqlite3"))
        await self.db.connect()
        self.current = "alice"
        self.active = True
        self.reloads = 0

        async def bind(request):
            return OnBehalfIdentity(
                "network", "user", self.current, "ab" * 32, "device_cert"
            )

        async def active(*args):
            return self.active

        async def owner():
            return "alice"

        async def reload():
            self.reloads += 1

        self.gateway = SimpleNamespace(
            _request_device_still_authorized=active,
            agent=SimpleNamespace(memory_db=self.db),
        )
        self.gateway.runtime_service = SimpleNamespace(
            gateway=self.gateway,
            agent=SimpleNamespace(
                memory_db=self.db, name="worker", load_model_catalog=reload
            ),
            authorizer=SimpleNamespace(bind_request=bind),
            directory=SimpleNamespace(principal_active=active, owner_handle=owner),
            runtime=None,
        )
        self.provider = await self.db.upsert_provider(
            name="original", framework="api-based", api_key="preserved-secret"
        )
        self.model = await self.db.upsert_model(
            provider_id=self.provider, model="original-model"
        )

    async def asyncTearDown(self):
        await self.db.close()
        self.temp.cleanup()

    async def test_partial_rename_updates_same_rows_and_keeps_credentials(self):
        response = await handle_update(
            Request(
                self.gateway,
                "/api/providers/" + str(self.provider),
                self.provider,
                {"name": "renamed"},
            )
        )
        self.assertEqual(response.status, 200)
        row = await self.db.get_provider(self.provider)
        self.assertEqual(row["name"], "renamed")
        self.assertEqual(row["api_key"], "preserved-secret")
        self.assertEqual(len(await self.db.list_providers()), 1)
        response = await handle_update_db(
            Request(
                self.gateway,
                "/api/models/" + str(self.model),
                self.model,
                {"model": "renamed-model"},
            )
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(
            (await self.db.get_model(self.model))["model"], "renamed-model"
        )
        self.assertEqual(len(await self.db.list_models()), 1)
        self.assertEqual(self.reloads, 2)

    async def test_owner_and_current_revocation_gate_provider_mutation(self):
        request = Request(
            self.gateway,
            "/api/providers/" + str(self.provider),
            self.provider,
            {"name": "wrong"},
        )
        self.current = "bob"
        with self.assertRaises(web.HTTPForbidden):
            await authorize_request(request)
        self.current = "alice"
        self.active = False
        with self.assertRaises(web.HTTPForbidden):
            await authorize_request(request)
        self.assertEqual(
            (await self.db.get_provider(self.provider))["name"], "original"
        )
