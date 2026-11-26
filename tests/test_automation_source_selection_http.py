"""A certified owner can renew an exact automation revision with fewer sources."""
import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest

from openagent_core.capabilities import ToolDefinition
from openagent_core.contracts import PrincipalRef, ResourceRef
from openagent_core.engine import MemoryDB
from openagent_identity.auth import middleware
from openagent_identity.auth.device_cert import issue_cert
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_identity.identity import Identity
from openagent_identity.state import NetworkState
from openagent_server.gateway.server import Gateway
from openagent_server.runtime_service import NativeRuntimeService, bind_runtime_identity


@pytest.mark.asyncio
async def test_certified_owner_can_approve_exact_sources_after_a_revision_change(tmp_path, monkeypatch):
    class Source:
        async def discover(self, context):
            return (ToolDefinition("read", "Read a synthetic record", {"type": "object"}),)

        async def call_tool(self, name, arguments, context):
            return {"record": "fixture"}

    async with AsyncExitStack() as clean:
        db = MemoryDB(str(tmp_path / "state.sqlite"))
        await db.connect()
        clean.push_async_callback(db.close)
        store = CoordinatorStore(db)
        await store.set_network_role(role="coordinator", network_id="network", name="Fixture")
        state = await NetworkState.from_db(db=db, identity_path=tmp_path / "identity.key")
        certs = {}
        for handle in ("owner", "peer"):
            await store.create_user(handle=handle, pake_record=b"fixture", pake_algo="fixture")
            device = Identity.generate()
            await store.add_device(device_pubkey=device.public_bytes, user_handle=handle)
            certs[handle] = (issue_cert(coordinator_key=state.identity._private_key, handle=handle,
                device_pubkey=device.public_bytes, network_id="network"), device.public_hex)
        await store.register_agent(handle="agent", node_id=state.identity.public_hex, owner_handle="owner")
        actor = "owner"
        monkeypatch.setattr(middleware, "current_device_cert_wire", lambda: certs[actor][0])
        monkeypatch.setattr(middleware, "current_peer_node_id", lambda: certs[actor][1])

        async def initialize():
            pass

        agent = SimpleNamespace(name="agent", config={}, memory_db=db, capability_pool=None,
                                product_environment={}, initialize=initialize)
        agent.set_capability_pool = lambda pool: setattr(agent, "capability_pool", pool)
        gateway = Gateway(agent, state)
        gateway.runtime_service = service = NativeRuntimeService(gateway, agent)
        await service.start()
        clean.push_async_callback(service.close)
        entered = asyncio.Event()

        @web.middleware
        async def observe_request(request, handler):
            if request.method == "POST":
                entered.set()
            return await handler(request)

        app = web.Application(middlewares=[observe_request, middleware.make_auth_middleware(state.auth_state),
                                          bind_runtime_identity])
        app["gateway"] = gateway
        gateway._register_routes(app)
        client = await clean.enter_async_context(TestClient(TestServer(app)))
        task = await db.add_task("Daily records", "0 9 * * *", "Read the fixture")
        route = f"/api/automations/scheduled_task/{task}/authorization"
        catalog = service.runtime.capabilities
        backend = Source()
        rows = {}

        def register(key, owner="owner"):
            sid = service.official_connectors.source_id(key)
            rows[key] = {"owner_key": PrincipalRef("openagent", "network", owner).key,
                         "tenant_id": "network", "enabled": True, "status": "connected"}
            catalog.register(sid, backend, backend, target_label="Test records")
            return sid

        async def record(key):
            return rows.get(key)

        monkeypatch.setattr(service.official_connectors, "record", record)
        original = register("original")
        private = register("private", "peer")

        async def request(method, status=200, **kwargs):
            async with asyncio.timeout(8), client.request(method, route, **kwargs) as response:
                assert response.status == status, await response.text()
                return await response.json() if status == 200 else await response.text()

        async def resolve():
            definition = await service.automations.definition("task", task)
            return await service.automations.resolve("task", definition, "fixture", "scheduled")

        first = await request("GET")
        assert original in first["capabilities"]["grantable"] and private not in first["capabilities"]["grantable"]
        approved = await request("POST", json={"digest": first["digest"]})
        assert set(approved) == {"authorized", "digest", "delegation_id", "schedules_reconciled"}
        before = await resolve()
        assert (await request("GET"))["capabilities"]["granted"] == first["capabilities"]["grantable"]
        added = register("new")

        # The writer owns the transaction while a real approval for the
        # reviewed digest arrives. It can grant neither the old nor the new row.
        entered.clear()
        async with asyncio.timeout(8):
            async with service.automation_management.repository.transaction() as conn:
                await service.automation_management.repository.definition_store(conn).update_task(task, prompt="Updated fixture")
                stale = asyncio.create_task(request("POST", 409, json={"digest": first["digest"], "sources": [original]}))
                await entered.wait()
            await stale
        current = await request("GET")
        assert current["digest"] != first["digest"] and not current["authorized"]
        assert not await service.automations.validate(before)
        body = {"digest": current["digest"]}
        await request("POST", json={**body, "sources": [original, original]})
        limited = await resolve()
        assert (await request("GET"))["capabilities"]["granted"] == [original]
        assert await catalog.discover(limited, source_id=original)
        assert not await catalog.discover(limited, source_id=added)
        for action in ("tool.call", "tool.publish"):
            assert not await service.authorizer.authorize(limited, action,
                ResourceRef("tool", limited.tenant_id, added + "/read"), audience=limited.audience)

        actor = "peer"
        await request("POST", 403, json={**body, "sources": [original]})
        actor = "owner"
        unknown = await request("POST", 403, json={**body, "sources": [original, "missing"]})
        assert await request("POST", 403, json={**body, "sources": [original, private]}) == unknown
        for malformed in (None, original, [None], [""]):
            await request("POST", 400, json={**body, "sources": malformed})
        rows["original"]["enabled"] = False
        await request("POST", 403, json={**body, "sources": [original]})
        assert not await catalog.discover(limited, source_id=original)
        rows["original"]["enabled"] = True
        assert await service.automations.validate(limited)
        assert (await resolve()).delegation_id == limited.delegation_id
        await request("POST", json={**body, "sources": []})
        assert (await request("GET"))["capabilities"]["granted"] == []
        assert not await service.automations.validate(limited)
        assert not await catalog.discover(await resolve(), source_id=original)
