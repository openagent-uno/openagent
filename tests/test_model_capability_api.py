"""Provider sign-ins and edits refresh what each model can receive."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock
from openagent_core.engine import MemoryDB
from openagent_core.core.on_behalf_context import OnBehalfIdentity
from openagent_server.gateway.api.providers import handle_refresh_capabilities, handle_update
from openagent_server.gateway.api.models import handle_update_db


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


class ModelCapabilityAPITests(unittest.IsolatedAsyncioTestCase):
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

    async def _catalog(self, provider, api_key=None, base_url=None):
        return [{"id": "original-model", "input_modalities": ["text", "image", "file"]}]

    async def test_a_new_endpoint_refreshes_the_declared_inputs(self):
        with mock.patch("openagent_core.models.discovery.list_provider_models", self._catalog):
            response = await handle_update(Request(self.gateway, "/api/providers/%d" % self.provider, self.provider,
                                                   {"base_url": "http://proxy.invalid/v1"}))
        self.assertEqual(200, response.status)
        metadata = (await self.db.get_model_enriched(self.model))["metadata"]
        self.assertEqual((["text", "image", "file"], "provider"),
                         (metadata["input_modalities"], metadata["input_modalities_source"]))

    async def test_the_refresh_endpoint_reports_what_changed(self):
        request = Request(self.gateway, "/api/providers/%d/refresh-capabilities" % self.provider, self.provider, {})
        request.method = "POST"
        with mock.patch("openagent_core.models.discovery.list_provider_models", self._catalog):
            response = await handle_refresh_capabilities(request)
        self.assertEqual(200, response.status)
        self.assertIn(b"original:original-model", response.body)

    async def test_inputs_set_by_hand_survive_a_refresh(self):
        response = await handle_update_db(Request(self.gateway, "/api/models/%d" % self.model, self.model,
                                                  {"input_modalities": ["text", "audio"]}))
        self.assertEqual(200, response.status)
        with mock.patch("openagent_core.models.discovery.list_provider_models", self._catalog):
            await handle_update(Request(self.gateway, "/api/providers/%d" % self.provider, self.provider,
                                        {"base_url": "http://proxy.invalid/v1"}))
        metadata = (await self.db.get_model_enriched(self.model))["metadata"]
        self.assertEqual((["text", "audio"], "manual"), (metadata["input_modalities"], metadata["input_modalities_source"]))


if __name__ == "__main__":
    unittest.main()
