"""The member view never grants access to definitions or configuration writes."""

import json
from dataclasses import replace
from types import SimpleNamespace

from aiohttp import web
import pytest

from openagent_core.memory.db import MemoryDB
from openagent_identity.coordinator.store import CoordinatorStore
from openagent_server.automation_management import park_retired_observability_tasks
from openagent_server.gateway.api import agent_identity, events, mcps, scheduled_tasks, workflow_tasks
from openagent_server.catalog_service import NativeCatalogService
from openagent_server.management_access import ManagementAccess
from openagent_server.official_connectors import OfficialConnectors
from openagent_server.runtime_access import NativeRuntimeAuthorizer
from openagent_server.runtime_directory import NativeRuntimeDirectory
from openagent_server.runtime_service import NativeRuntimeService, bind_runtime_identity
from openagent_storage_sqlite import SqliteRuntimeStore


class Request(dict):
    def __init__(self, gateway, handle, path, method="GET", *, kind="device_cert", query=None):
        cert = SimpleNamespace(network_id="network", handle=handle,
                               device_pubkey_hex=f"device-{handle}", capabilities=())
        super().__init__(device_cert=cert, user_handle=handle, network_id="network",
                         auth_kind=kind, device_auth_epoch=1)
        self.app = {"gateway": gateway}
        self.method, self.path, self.query = method, path, query or {}


@pytest.fixture
async def gateway(tmp_path):
    db = MemoryDB(str(tmp_path / "agent.sqlite"))
    await db.connect()
    storage = SqliteRuntimeStore(db.db_path)
    await storage.start()
    directory = CoordinatorStore(db)
    await directory.set_network_role(role="coordinator", network_id="network", coordinator_node_id="node")
    for handle in ("alice", "bob", "former"):
        await directory.create_user(handle=handle, pake_record=b"fixture", pake_algo="fixture")
    await directory.register_agent(handle="agent", node_id="node", owner_handle="alice")
    await directory.set_user_status("former", "suspended")

    async def still_authorized(_request, cert):
        return cert.handle != "revoked"

    agent = SimpleNamespace(name="Test agent", config={}, memory_db=db, _db=db)
    config_path = tmp_path / "openagent.yaml"
    config_path.write_text('name: Test agent\nsystem_prompt: Private persona\n')
    gw = SimpleNamespace(agent=agent, config_path=config_path, _request_device_still_authorized=still_authorized,
                         _network_state=SimpleNamespace(identity=SimpleNamespace(public_hex="node")))
    runtime = object.__new__(NativeRuntimeService)
    runtime.agent, runtime.gateway = agent, gw
    runtime.dashboards = None
    runtime.directory = NativeRuntimeDirectory(gw, agent)
    runtime.authorizer = NativeRuntimeAuthorizer(gw, db.db_path, source_authorizer=runtime._authorize_source)
    runtime.management_access = ManagementAccess(runtime)
    runtime.catalog_management = NativeCatalogService(agent, runtime.authorizer)
    runtime.official_connectors = OfficialConnectors(runtime)
    await runtime.management_access.start()
    gw.runtime_service = runtime
    try:
        yield gw
    finally:
        await storage.close()
        await db._conn.close()


@pytest.mark.parametrize("path,key,reader,handler", [
    ("/api/scheduled-tasks", "tasks", "get_tasks", scheduled_tasks.handle_list),
    ("/api/workflows", "workflows", "list_workflows", workflow_tasks.handle_list),
    ("/api/events", "events", "list_events", events.handle_list),
])
async def test_member_automation_lists_allow_only_safe_metadata(gateway, path, key, reader, handler):
    async def rows(**_kwargs):
        return [{"id": "definition", "name": "Daily report", "enabled": 1,
                 "prompt": "Private prompt", "secret": "Private hook", "graph": {"private": "data"}}]

    setattr(gateway.agent.memory_db, reader, rows)
    response = await bind_runtime_identity(Request(gateway, "bob", path), handler)
    assert json.loads(response.body) == {
        key: [], "summaries": [{"id": "definition", "name": "Daily report", "enabled": True}],
    }
    for request in (Request(gateway, "bob", path, "POST"), Request(gateway, "bob", path + "/definition"),
                    Request(gateway, "former", path), Request(gateway, "revoked", path),
                    Request(gateway, "bob", path, kind="agent"), Request(gateway, "bob", path, kind="token")):
        with pytest.raises(web.HTTPForbidden):
            await bind_runtime_identity(request, handler)

    async def owner_route(request):
        assert not request.get("management_member_overview")
        return web.Response()

    assert (await bind_runtime_identity(Request(gateway, "alice", path), owner_route)).status == 200


async def test_visibility_and_owner_transfer_are_owner_only(gateway):
    runtime = gateway.runtime_service
    access = runtime.management_access
    alice = await runtime.context(Request(gateway, "alice", "/api/agent/access"), "settings")
    bob = await runtime.context(Request(gateway, "bob", "/api/agent/access"), "settings")
    assert (await access.settings(bob))["visibility"] == "members"
    assert not await access.can_browse(replace(bob, deferred=True, delegation_id="task-grant"))
    with pytest.raises(PermissionError):
        await access.update(bob, "owner")
    with pytest.raises(PermissionError):
        await access.transfer(bob, "bob")
    with pytest.raises(ValueError):
        await access.transfer(alice, "former")
    await access.update(alice, "owner")
    with pytest.raises(web.HTTPForbidden):
        await bind_runtime_identity(Request(gateway, "bob", "/api/scheduled-tasks"), scheduled_tasks.handle_list)
    result = await access.transfer(alice, "@bob")
    assert result["owner_handle"] == "bob"
    assert not result["can_manage"]
    assert (await access.settings(bob))["can_manage"]
    with pytest.raises(PermissionError):
        await access.update(alice, "members")
    await access.update(bob, "members")
    assert await access.can_browse(alice)


async def test_operator_recovery_and_reenrollment_preserve_primary_owner(gateway):
    store = CoordinatorStore(gateway.agent.memory_db)
    await store.register_agent(handle="peer", node_id="peer-node", owner_handle="system")
    assert not await store.transfer_agent_owner("peer-node", "bob", current_owner="bob")
    assert await store.transfer_agent_owner("peer-node", "alice")
    assert not await store.enroll_agent(handle="peer", node_id="foreign-node", owner_handle="bob", label=None)
    assert not await store.enroll_agent(handle="alias", node_id="peer-node", owner_handle="bob", label=None)
    assert await store.enroll_agent(handle="peer", node_id="peer-node", owner_handle="bob", label=None)
    row = next(row for row in await store.list_agents() if row.handle == "peer")
    assert row.owner_handle == "alice"
    assert not await store.remove_agent("peer", expected_owner="bob")


async def test_members_never_receive_connector_config_or_persona(gateway):
    async def rows():
        return [{"name": "test-source", "enabled": True, "headers": {"Authorization": "Secret"}}]

    gateway.agent.memory_db.list_mcps = rows
    payload = json.loads((await mcps.handle_list(Request(gateway, "bob", "/api/mcps"))).body)
    assert payload == {"mcps": [], "summaries": [{"id": "test-source", "name": "test-source", "enabled": True}]}
    context = await gateway.runtime_service.context(Request(gateway, "bob", "/api/connectors"), "catalog")
    connectors = gateway.runtime_service.official_connectors
    assert (await connectors.list(context, browse=True))["read_only"]
    catalog = await connectors.catalog(context, browse=True)
    assert catalog["connectors"] and not any(item["available"] for item in catalog["connectors"])
    with pytest.raises(PermissionError):
        await connectors.list(context)
    identity = json.loads((await agent_identity.handle_get(Request(gateway, "bob", "/api/agent/identity"))).body)
    assert identity == {"name": "Test agent", "thumbnail": None, "framework_prompt_mutable": False, "can_manage": False}


async def test_retirement_preserves_custom_tasks_and_legacy_definitions(gateway):
    db = gateway.agent.memory_db
    retired_id = await db.add_task(name="quality-scorer", prompt="Legacy", cron_expression="0 * * * *")
    custom_id = await db.add_task(name="Review quality reports", prompt="Custom", cron_expression="0 * * * *")
    await park_retired_observability_tasks(db)
    retired = await db.get_task(retired_id)
    assert not retired["enabled"] and retired["next_run"] is None and retired["prompt"] == "Legacy"
    assert (await db.get_task(custom_id))["enabled"]
