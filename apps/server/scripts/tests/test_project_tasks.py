"""Exercise the standalone HTTP task contract on Core's real broker, runtime store and catalog."""
import asyncio
import time
from types import SimpleNamespace
import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from openagent_core import Runtime, RuntimeSettings, RuntimeServices
from openagent_core.computer_tasks import ComputerConnection
from openagent_core.contracts import ExecutionContext, PrincipalRef
from openagent_storage_sqlite import SqliteRuntimeStore
from openagent_server.project_tasks import StandaloneProjectTasks, install_routes


class TestMachine:
    __test__ = False

    def __init__(self):
        self.machines = {}
        self.checkpoints = {}

    def bind(self, broker):
        self.broker = broker

    async def close(self):
        pass

    async def ensure(self, allocation):
        self.machines.setdefault(allocation.key, allocation)
        return 'machine-' + allocation.key

    async def connection(self, allocation, machine):
        assert self.machines[allocation.key] == allocation
        return ComputerConnection(machine, machine, 1, time.time() + 60)

    async def catalog(self, context, selectors):
        return {"servers": [{"host_id": selectors["host_id"], "generation": 1, "server": "editor",
                              "catalog_digest": "a" * 64, "version": "1",
                              "tools": [{"name": "inspect", "input_schema": {}}]}]}

    async def call(self, context, scope, name, args):
        await self.broker.admit_target(context, scope["host_id"], scope["generation"])
        alloc = self.machines[scope["host_id"].removeprefix('machine-')]
        return alloc.task.project

    async def checkpoint(self, lease, request):
        allocation = self.machines[lease.allocation]
        patch = ("project " + allocation.task.project).encode()
        self.checkpoints[(allocation.key, request)] = ({"tree": "f"*40, "base_commit": allocation.task.base_version,
                                                       "bytes": len(patch), "sha256": "e"*64}, patch)
        return self.checkpoints[(allocation.key, request)][0]

    async def read_checkpoint(self, allocation, request):
        return self.checkpoints[(allocation.key, request)]


class Host:
    def __init__(self):
        self.agent = SimpleNamespace(name="studio", config={"project_tasks": {"projects": [
            {"id": "book", "title": "Book", "tenant": "team", "members": ["alice", "bob"],
             "revisions": [{"label": "Release", "commit": "1"*40}]}]}})
        self.authorizer = self
        self.waiter = asyncio.Event()
        self.entries = 0

    async def authorize(self, context, action, resource, *, audience=()):
        if resource.kind in {"computer-project-version", "computer-task"}:
            return await self.project_tasks.computer_access(context, action, resource)
        if resource.kind == "session" and resource.resource_id.startswith("project-task-"):
            return await self.project_tasks.session_access(context, action, resource.resource_id)
        return context.audience == (context.initiator,)

    async def context(self, request, session):
        principal = PrincipalRef("openagent", "team", request.headers["X-Fixture-Member"], "user")
        return ExecutionContext(principal, principal, principal, session, self.agent.name, (principal,))

    async def execute(self, request, context, runtime):
        self.entries += 1
        async with self.project_tasks.request_scope(request, context, runtime):
            await self.waiter.wait()
            tools = await runtime.capabilities.discover(context)
            assert len(tools) == 1 and tools[0].name == "inspect"
            result = await runtime.capabilities.call_tool(tools[0].tool_ref, {}, context)
            return str(result)


@pytest.mark.asyncio
async def test_durable_project_views_are_per_owner_and_follow_current_grants(tmp_path):
    host = Host()
    engine = create_async_engine("sqlite+aiosqlite:///" + str(tmp_path / "projects.sqlite"))
    host.project_tasks = StandaloneProjectTasks(host, engine, TestMachine())
    host.runtime = Runtime(RuntimeSettings("studio"), RuntimeServices(SqliteRuntimeStore(tmp_path/"runs.sqlite"), host, host))
    await host.project_tasks.initialize()
    await host.runtime.start()
    app = web.Application()
    install_routes(app, host)
    alice, bob = ({"X-Fixture-Member": p} for p in ("alice", "bob"))
    try:
        async with TestClient(TestServer(app)) as client:
            path = "/api/project-tasks"
            data = dict(request_id=str(uuid.uuid4()), project="book", revision="1"*40, instruction="Describe this project")
            created = await client.post(path, json=data, headers=alice)
            assert created.status == 202
            aid = (await created.json())["id"]
            assert (await (await client.post(path, json=data, headers=alice)).json())["id"] == aid
            assert (await client.post(path, json={**data, "instruction": "Changed"}, headers=alice)).status == 409
            assert (await client.get(path+"/"+aid, headers=bob)).status == 404
            bid = (await (await client.post(path, json=data, headers=bob)).json())["id"]
            assert bid != aid
            async with asyncio.timeout(20):
                while host.entries != 2:
                    await asyncio.sleep(.05)
            assert [t["id"] for t in (await (await client.get(path, headers=alice)).json())["tasks"]] == [aid]
            host.waiter.set()
            await asyncio.gather(*host.project_tasks.jobs.values())
            for user, ident in [(alice, aid), (bob, bid)]:
                result = await client.get(path+"/"+ident, headers=user)
                assert result.status == 200
                detail = await result.json()
                assert detail["status"] == "success" and detail["review"] and detail["computer"], detail
                diff = await (await client.get(path+"/"+ident+"/diff", headers=user)).json()
                assert diff["diff"] == "project book"
            assert len(host.project_tasks.broker.provider.machines) == 2
            host.agent.config["project_tasks"]["projects"][0]["members"].remove("alice")
            assert (await client.get(path+"/"+aid+"/diff", headers=alice)).status == 404
            assert (await client.get(path+"/"+aid, headers=alice)).status == 404
            assert (await (await client.get(path, headers=alice)).json())["tasks"] == []
            assert (await client.get(path+"/"+bid, headers=bob)).status == 200
    finally:
        host.waiter.set()
        await host.project_tasks.close()
        await host.runtime.close()


@pytest.mark.asyncio
async def test_retry_preparation_and_checkpoint_never_reexecutes_an_admitted_run(tmp_path):
    class InterruptedProvider(TestMachine):
        def __init__(self):
            super().__init__()
            self.preparing = asyncio.Event()
            self.ready = asyncio.Event()
            self.checkpoint_failure = True

        async def ensure(self, allocation):
            self.preparing.set()
            await self.ready.wait()
            return await super().ensure(allocation)

        async def checkpoint(self, lease, request):
            if self.checkpoint_failure:
                self.checkpoint_failure = False
                raise OSError("Temporary checkpoint failure")
            return await super().checkpoint(lease, request)

    provider = InterruptedProvider()
    host = Host()
    engine = create_async_engine("sqlite+aiosqlite:///" + str(tmp_path / "projects.sqlite"))
    host.project_tasks = StandaloneProjectTasks(host, engine, provider)
    host.runtime = Runtime(RuntimeSettings("studio"), RuntimeServices(SqliteRuntimeStore(tmp_path / "runs.sqlite"), host, host))
    await host.project_tasks.initialize()
    await host.runtime.start()
    app = web.Application()
    install_routes(app, host)
    alice = {"X-Fixture-Member": "alice"}
    bob = {"X-Fixture-Member": "bob"}
    base = "/api/project-tasks"
    request = {"request_id": str(uuid.uuid4()), "project": "book", "revision": "1"*40, "instruction": "Review"}
    try:
        async with TestClient(TestServer(app)) as client:
            assert (await client.post(base, json={**request, "request_id": 123}, headers=alice)).status == 400
            first, second = await asyncio.gather(*(client.post(base, json=request, headers=alice) for _ in range(2)))
            assert await first.json() == await second.json()
            ident = (await first.json())["id"]
            url = base + "/" + ident
            await provider.preparing.wait()
            # Interrupt after the durable project reservation but before native run admission.
            job = host.project_tasks.jobs[ident]
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)
            assert (await (await client.get(url, headers=alice)).json())["can_retry"]
            assert (await client.post(url+"/retry", headers=bob, json={})).status == 404
            host.waiter.set()
            provider.ready.set()
            assert (await client.post(url+"/retry", headers=alice, json={})).status == 202
            await asyncio.gather(*host.project_tasks.jobs.values())
            detail = await (await client.get(url, headers=alice)).json()
            assert detail["status"] == "success" and detail["can_checkpoint"] and not detail["can_retry"]
            assert (await client.post(url+"/retry", headers=alice, json={})).status == 202
            assert (await client.post(url+"/checkpoint", headers=bob, json={})).status == 404
            assert (await client.post(url+"/checkpoint", headers=alice, json={})).status == 200
            assert (await (await client.get(url, headers=alice)).json())["review"]
            assert host.entries == len(provider.machines) == 1
    finally:
        provider.ready.set()
        host.waiter.set()
        await host.project_tasks.close()
        await host.runtime.close()
