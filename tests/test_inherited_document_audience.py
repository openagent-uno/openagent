"""A bridge worker retains document history only for its live private audience."""
from contextlib import AsyncExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from openagent_core import PrincipalRef, ResourceRef, RunRequest, Runtime, RuntimeServices, RuntimeSettings
from openagent_core.engine import MemoryDB
from openagent_server.runtime_service import NativeRuntimeService
from test_runtime_access import Request


@pytest.mark.asyncio
async def test_owner_bridge_root_must_still_have_its_admitted_recipients(tmp_path):
    db = MemoryDB(str(tmp_path / "state.sqlite"))
    agent = SimpleNamespace(name="agent", memory_db=db, config={
        "channels": {"telegram": {"allowed_users": ["100"]}},
        "runtime_tool_audiences": {"vault_owner_channels": {"telegram": ["100"]}},
    })
    gateway = SimpleNamespace(agent=agent, _request_device_still_authorized=AsyncMock(return_value=True))
    service = NativeRuntimeService(gateway, agent)
    store = service.store
    service.runtime = Runtime(RuntimeSettings(agent.name, tmp_path), RuntimeServices(store, object(), service.authorizer))
    async with AsyncExitStack() as cleanup:
        await db.connect()
        cleanup.push_async_callback(db.close)
        await service.runtime.start()
        cleanup.push_async_callback(service.runtime.close)
        request = Request(gateway, "__bridge_telegram")
        request["device_cert"].capabilities = ("bridge",)
        root = await service.context(request, "tg:100")
        await store.accept(RunRequest("parent", root.session_id, "parent", "test"), root)
        await store.transition("parent", "running")
        sources = frozenset({"existing-revision"})
        await store.bind_document_sources(root, "parent", tuple(sources))
        child = root.child(session_id="worker", run_id="parent",
                           agent=PrincipalRef("openagent", root.tenant_id, agent.name, "agent"))
        await store.accept(RunRequest("child", child.session_id, "child", "test"), child)
        await store.transition("child", "running")
        assert await service.approved_session(child, "child", sources) == root.session_id

        store.connection.execute(
            "INSERT INTO resource_acl(tenant_id,resource_type,resource_id,principal_type,principal_id,"
            "permission,acl_version,granted_at_ms) SELECT tenant_id,'session',id,'user','peer','view',"
            "acl_version,1 FROM sessions_v2 WHERE id=?", (root.session_id,))
        expanded = await service.context(request, root.session_id)
        assert {person.subject_id for person in expanded.audience} == {"__bridge_telegram", "peer"}
        assert await service.authorizer.authorize(root, "session.read",
            ResourceRef("session", root.tenant_id, root.session_id), audience=root.audience)
        assert await service.approved_session(child, "child", sources) is None

        store.connection.execute(
            "DELETE FROM resource_acl WHERE tenant_id=? AND resource_type='session' AND resource_id=? "
            "AND principal_type='user' AND principal_id='peer'", (root.tenant_id, root.session_id))
        assert await service.approved_session(child, "child", sources) == root.session_id
