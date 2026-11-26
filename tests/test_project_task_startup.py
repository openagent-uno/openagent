"""Exercise optional project storage from a fresh standalone runtime and gateway."""
import asyncio
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid5

import pytest


@pytest.mark.parametrize("profile", ["files", "projects", "documents"])
def test_project_task_startup(profile, tmp_path):
    # Other product tests deliberately import and use both storage backends.
    result = subprocess.run([sys.executable, __file__, profile, str(tmp_path)],
                            capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stderr


async def check_startup(profile, root):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from openagent_core.contracts import ResourceRef
    from openagent_core.memory.db import MemoryDB
    from openagent_server.gateway.server import Gateway
    from openagent_server.runtime_service import NativeRuntimeService
    from test_runtime_access import Request
    from test_runtime_service import FakeAgent

    projects = profile == "projects"
    documents = profile == "documents"
    agent = FakeAgent(root / "state.sqlite3")
    agent.product_environment = {}
    agent.config = {"memory": {"vault": {"backend": "documents" if documents else "files"}}}
    if projects:
        agent.config["project_tasks"] = {
            "lima_home": str(root), "lima_executable": sys.executable,
            "projects": [{"id": "guide", "tenant": "network", "members": ["alice"],
                          "revisions": [{"commit": "a" * 40, "base": "sealed-guide"}]}],
        }
    agent.memory_db = MemoryDB(str(root / "state.sqlite3"))
    await agent.memory_db.connect()
    state = SimpleNamespace(identity=SimpleNamespace(public_hex="fixture"), network_name="network", role="coordinator")
    gateway = Gateway(agent, state)
    gateway._request_device_still_authorized = AsyncMock(return_value=True)
    gateway.runtime_service = service = NativeRuntimeService(gateway, agent)

    @web.middleware
    async def device(request, handler):
        request.update(Request(gateway, "alice"))
        return await handler(request)

    try:
        await service.start()
        app = web.Application(middlewares=[device])
        app["gateway"] = gateway
        gateway._register_routes(app)
        async with TestClient(TestServer(app)) as client:
            health = await client.get("/api/health")
            assert health.status == 200 and (await health.json())["status"] == "ok"
            response = await client.get("/api/project-tasks")
            assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
            listing = await response.json()
            assert [item["id"] for item in listing["projects"]] == (["guide"] if projects else [])
            assert listing["tasks"] == []
            assert (await client.get("/api/project-tasks/missing")).status == 404
            assert (await client.post("/api/project-tasks", json={})).status == (400 if projects else 404)

        identity = await service.authorizer.bind_request(Request(gateway, "alice"))
        reserved = "project-task-" + str(uuid5(NAMESPACE_URL, "missing"))
        for session, allowed in (("ordinary-session", True), (reserved, False)):
            context = await service.authorizer.context_for_identity(identity, session)
            resource = ResourceRef("session", "network", session)
            assert await service.authorizer.authorize(context, "run.submit", resource) is allowed
        assert (service.project_tasks is not None) is projects
        assert (service.document_vault is not None) is documents
        dependencies = {"sqlalchemy", "openagent_core.computer_tasks"}
        expected = {"files": set(), "documents": {"sqlalchemy"}, "projects": dependencies}[profile]
        loaded = dependencies.intersection(sys.modules)
        assert loaded == expected, f"{profile} loaded {sorted(loaded)}, expected {sorted(expected)}"
    finally:
        await service.close()
        await agent.memory_db.close()


if __name__ == "__main__":
    asyncio.run(check_startup(sys.argv[1], Path(sys.argv[2])))
