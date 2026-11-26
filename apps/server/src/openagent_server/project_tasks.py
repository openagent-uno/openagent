"""Standalone project catalog and durable task links. Core owns execution, leases and checkpoints."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import json
import logging
import re
import shutil
import time
from uuid import UUID, uuid5, NAMESPACE_URL

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from openagent_core.capabilities import CapabilityUnavailable
from openagent_core.computer_tasks import ComputerAllocation, ComputerTask, TaskComputerBroker
from openagent_core.contracts import IdempotencyConflict, RunRequest

from .project_task_routes import PRIVATE as PRIVATE, install_routes as install_routes
from .project_task_routes import SESSION, is_project_session, task_ref

metadata = sa.MetaData()
requests = sa.Table(
    "oa_standalone_project_tasks", metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("allocation", sa.String(64), unique=True, nullable=False),
    sa.Column("owner", sa.Text, nullable=False),
    sa.Column("agent", sa.Text, nullable=False),
    sa.Column("project", sa.Text, nullable=False),
    sa.Column("revision", sa.String(40), nullable=False),
    sa.Column("instruction", sa.Text, nullable=False),
    sa.Column("preparation", sa.Text, nullable=False),
    sa.Column("created", sa.BigInteger, nullable=False, default=time.time_ns),
)
sa.Index("oa_standalone_project_owner_tasks", requests.c.owner, requests.c.agent, requests.c.created, requests.c.id)
COMMIT = re.compile(r"[a-f0-9]{40}")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}")
CHECKPOINT = "final"
log = logging.getLogger(__name__)
COMPUTER_ACTIONS = {"computer.provision", "computer.attach", "computer.use", "computer.publish",
                    "computer.review", "computer.checkpoint", "computer.viewer.capture", "computer.viewer.input"}


class StandaloneProjectTasks:
    def __init__(self, service, engine, provider, *, capacity=None):
        self.service = service
        self.engine = engine
        self.broker = TaskComputerBroker(engine, service.authorizer, provider, provider,
                                         **({"required_capacity": capacity} if capacity is not None else {}))
        provider.bind(self.broker)
        self.jobs = {}

    @classmethod
    async def from_service(cls, service):
        settings = service.agent.config.get("project_tasks")
        if not settings:
            return None
        # The native executor must constrain model shortcuts as well as the catalog.
        from openagent_core import capability_scope  # noqa: F401
        from openagent_core.lima_computers import LimaComputerProvider
        from sqlalchemy.engine import URL
        from sqlalchemy.ext.asyncio import create_async_engine
        bases = {}
        members_by_revision = set()
        for project in settings["projects"]:
            members = project["members"]
            if (not ID.fullmatch(project["id"]) or not isinstance(project["tenant"], str)
                    or not project["tenant"].strip() or not isinstance(members, list) or not members
                    or not all(isinstance(member, str) and member.strip() for member in members)):
                raise ValueError("Expected a project, tenant and list of member handles")
            for item in project["revisions"]:
                commit = item["commit"]
                if not COMMIT.fullmatch(commit):
                    raise ValueError("An immutable full project revision is required")
                grants = {(project["tenant"], member, project["id"], commit) for member in members}
                if members_by_revision & grants:
                    raise ValueError("A member must have one grant for each project revision")
                members_by_revision.update(grants)
                key = (project["id"], commit)
                if key in bases and bases[key][0] != item["base"]:
                    raise ValueError("A project revision must refer to one sealed machine")
                bases[key] = (item["base"], commit)
        executable = shutil.which(settings.get("lima_executable", "limactl"))
        if not executable:
            raise ValueError("The configured Lima executable is unavailable")
        engine = create_async_engine(URL.create("sqlite+aiosqlite", database=str(service.agent.memory_db.db_path)),
                                     connect_args={"timeout": 30})
        try:
            capacity = None
            cfg = settings.get("computer_pool")
            if cfg is not None:
                from openagent_core.computer_capacity import ComputerPoolLimits, SqlComputerCapacity
                limits = {k: v for k, v in cfg.items() if k != "id"}
                capacity = SqlComputerCapacity(engine, cfg["id"], ComputerPoolLimits(**limits))
            provider = LimaComputerProvider(settings["lima_home"], bases, executable=executable,
                                            **({"capacity": capacity} if capacity is not None else {}))
            result = cls(service, engine, provider, capacity=capacity)
            await result.initialize()
        except BaseException:
            await engine.dispose()
            raise
        return result

    async def initialize(self):
        from openagent_core.memory.host_scoped_sessions import host_scoped_sessions, initialize_host_scoped_sessions
        async with self.engine.begin() as db:
            await db.run_sync(metadata.create_all)
            await initialize_host_scoped_sessions(db)
            # Include reservations created by earlier project-task clients before accepting traffic.
            sid = sa.literal(SESSION) + requests.c.id
            pending = sa.select(sid).where(~sa.exists(sa.select(1).where(host_scoped_sessions.c.session_id == sid)))
            await db.execute(sqlite_insert(host_scoped_sessions).from_select(["session_id"], pending)
                             .on_conflict_do_nothing(index_elements=["session_id"]))
        await self.broker.initialize()

    async def close(self):
        for job in self.jobs.values():
            job.cancel()
        await asyncio.gather(*self.jobs.values(), return_exceptions=True)
        await self.broker.provider.close()
        await self.engine.dispose()

    def projects(self, ctx):
        user = getattr(ctx, "initiator", None)
        if (user is None or ctx.deferred or user.authority != "openagent" or user.kind != "user"
                or user != ctx.authority or user != ctx.author or ctx.audience != (user,)
                or ctx.agent_id != self.service.agent.name):
            return []
        cfg = self.service.agent.config.get("project_tasks") or {}
        return [p for p in cfg.get("projects", ()) if p["tenant"] == ctx.tenant_id and isinstance(p["members"], list) and user.subject_id in p["members"]]

    def approved(self, ctx, project, revision):
        return any(p["id"] == project and any(r["commit"] == revision for r in p["revisions"])
                   for p in self.projects(ctx))

    def can_suspend(self, ctx, row):
        return callable(getattr(self.broker, "suspend", None)) and any(
            "computer.suspend" in r.get("surfaces", ()) for p in self.projects(ctx) if p["id"] == row["project"]
            for r in p["revisions"] if r["commit"] == row["revision"]
        )

    async def lookup(self, ctx, *, task=None, allocation=None):
        condition = requests.c.id == task if task is not None else requests.c.allocation == allocation
        async with self.engine.connect() as db:
            row = (await db.execute(sa.select(requests).where(
                condition, requests.c.owner == ctx.initiator.key, requests.c.agent == ctx.agent_id
            ))).mappings().one_or_none()
        if row is None or not self.approved(ctx, row["project"], row["revision"]):
            raise LookupError("Unknown project task")
        return row

    async def computer_access(self, ctx, action, resource):
        if resource.tenant_id != ctx.tenant_id:
            return False
        if resource.kind == "computer-project-version" and action == "computer.base.read":
            try:
                project, revision = json.loads(resource.resource_id)
                return self.approved(ctx, project, revision)
            except (ValueError, TypeError):
                return False
        if resource.kind == "computer-task" and (action in COMPUTER_ACTIONS or action == "computer.suspend"):
            try:
                row = await self.lookup(ctx, allocation=resource.resource_id)
                return ctx.session_id == SESSION + row["id"] and (action != "computer.suspend" or self.can_suspend(ctx, row))
            except LookupError:
                return False
        return False

    async def session_access(self, ctx, action, session):
        try:
            row = await self.lookup(ctx, task=session[len(SESSION):])
        except LookupError:
            return False
        if action == "run.submit":
            # Only admission via the broker may start a run in this reserved session.
            return ctx.session_id == session and (ctx.catalog_partition or "").startswith("computer-" + row["allocation"] + "-")
        return True

    @asynccontextmanager
    async def request_scope(self, request, ctx, runtime):
        if not is_project_session(request.session_id):
            yield request
            return
        from openagent_core import capability_scope
        row = await self.lookup(ctx, task=request.run_id)
        if request.session_id != SESSION + row["id"] or not await self.session_access(ctx, "run.submit", request.session_id):
            raise PermissionError("The selected run does not belong to this computer")
        inventory = await runtime.capabilities.discover(ctx)
        if not inventory:
            raise CapabilityUnavailable("The task computer has no active tools")
        with capability_scope({tool.source_id for tool in inventory}):
            yield request

    async def create(self, request, data):
        if not isinstance(data, dict) or set(data) != {"request_id", "project", "revision", "instruction"}:
            raise ValueError("Expected request_id, project, revision and instruction")
        if not isinstance(data["request_id"], str):
            raise ValueError("Expected a request UUID")
        key = UUID(data["request_id"])
        instruction = data["instruction"]
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction.encode()) > 16384:
            raise ValueError("Enter a task instruction under 16 KiB")
        actor = await self.service.context(request, "__project_tasks__")
        project, revision = data["project"], data["revision"]
        if not self.approved(actor, project, revision):
            raise LookupError("Unknown project revision")
        ident = str(uuid5(NAMESPACE_URL, json.dumps([actor.initiator.key, actor.agent_id, str(key)])))
        ctx = replace(await self.service.context(request, SESSION + ident), capabilities=())
        if not self.approved(ctx, project, revision):
            raise PermissionError("The task requires a private project session")
        ref = ComputerTask(project, ident, revision)
        allocation = ComputerAllocation.for_context(ctx, ref).key
        from openagent_core.memory.host_scoped_sessions import host_scoped_sessions
        async with self.engine.begin() as db:
            await db.execute(sqlite_insert(host_scoped_sessions).values(session_id=ctx.session_id)
                             .on_conflict_do_nothing(index_elements=["session_id"]))
            await db.execute(sqlite_insert(requests).values(id=ident, allocation=allocation, owner=ctx.initiator.key,
                             agent=ctx.agent_id, project=project, revision=revision, instruction=instruction,
                             preparation="accepted").on_conflict_do_nothing(index_elements=["id"]))
        row = await self.lookup(ctx, task=ident)
        if (row["project"], row["revision"], row["instruction"]) != (project, revision, instruction):
            raise IdempotencyConflict("The original task request is different")
        await self.resume(ctx, row)
        return {"id": ident}

    async def resume(self, ctx, row):
        ident = row["id"]
        if ident in self.jobs:
            return
        try:
            await self.service.runtime.get_run(ident, ctx)
        except LookupError:
            # Another request can finish the same read before this one resumes.
            # Keep scheduling atomic within the standalone writer.
            if ident not in self.jobs:
                job = asyncio.create_task(self.work(ctx, row))
                self.jobs[ident] = job
                job.add_done_callback(lambda done: self.jobs.pop(ident, None) if self.jobs.get(ident) is done else None)

    async def finish_checkpoint(self, ctx, row):
        run = await self.service.runtime.get_run(row["id"], ctx)
        if not run.terminal or row["id"] in self.jobs:
            raise CapabilityUnavailable("The task is still running")
        ref = task_ref(row)
        lease = await self.broker.attach(ctx, ref)
        async with self.broker.tools(self.service.runtime.capabilities, ctx, lease) as bound:
            await self.broker.checkpoint(bound, lease, CHECKPOINT)
            await self.mark(row["id"], "reviewed")

    async def mark(self, ident, phase):
        async with self.engine.begin() as db:
            await db.execute(requests.update().where(requests.c.id == ident).values(preparation=phase))

    async def work(self, ctx, row):
        ident = row["id"]
        ref = task_ref(row)
        try:
            await self.mark(ident, "preparing")
            await self.broker.provision(ctx, ref)
            lease = await self.broker.attach(ctx, ref)
            runtime = self.service.runtime
            async with self.broker.tools(runtime.capabilities, ctx, lease) as bound:
                await runtime.submit(RunRequest(ident, ctx.session_id, ident, row["instruction"]), bound)
                await self.mark(ident, "admitted")
                waiter = asyncio.create_task(runtime.wait(ident, bound))
                try:
                    while not waiter.done():
                        done, _ = await asyncio.wait({waiter}, timeout=20)
                        if done:
                            break
                        if await self.broker.attach(ctx, ref) != lease:
                            raise CapabilityUnavailable("The selected computer generation changed")
                    await waiter
                    await self.broker.checkpoint(bound, lease, CHECKPOINT)
                    await self.mark(ident, "reviewed")
                finally:
                    waiter.cancel()
                    await asyncio.gather(waiter, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("Project task preparation or checkpoint failed (%s)", type(error).__name__)
            # The native run remains authoritative after admission; an unknown
            # external outcome is never replayed by opening a detail page.
            await self.mark(ident, "unavailable")

    def visible_projects(self, ctx):
        visible = {}
        for project in self.projects(ctx):
            item = visible.setdefault(project["id"], {
                "id": project["id"], "title": project.get("title", project["id"]), "revisions": [],
            })
            for revision in project["revisions"]:
                commit = revision["commit"]
                item["revisions"].append({"commit": commit, "label": revision.get("label", commit[:12])})
        return list(visible.values())

    async def listing(self, request):
        limit = int(request.query.get("limit", "50"))
        if not 1 <= limit <= 100:
            raise ValueError("Invalid page size")
        cursor = request.query.get("cursor")
        ctx = await self.service.context(request, "__project_tasks__")
        projects = self.visible_projects(ctx)
        async with self.engine.connect() as db:
            query = sa.select(requests.c.id, requests.c.project, requests.c.revision, requests.c.instruction, requests.c.created).where(
                requests.c.owner == ctx.initiator.key, requests.c.agent == ctx.agent_id)
            selected = request.query.get("project")
            allowed = [(p["id"], r["commit"]) for p in projects if not selected or p["id"] == selected
                       for r in p["revisions"]]
            query = query.where(sa.tuple_(requests.c.project, requests.c.revision).in_(allowed))
            if cursor:
                stamp, ident = cursor.split(".", 1)
                query = query.where(sa.tuple_(requests.c.created, requests.c.id) < (int(stamp), str(UUID(ident))))
            page = (await db.execute(query.order_by(requests.c.created.desc(), requests.c.id.desc()).limit(limit + 1))).mappings().all()
        fresh = await self.service.context(request, "__project_tasks__")
        if fresh.initiator != ctx.initiator or self.visible_projects(fresh) != projects:
            raise PermissionError("Project authorization changed")
        items = [{k: row[k] for k in ("id", "project", "revision", "instruction")} for row in page[:limit]]
        next_cursor = f"{page[limit-1]['created']}.{page[limit-1]['id']}" if len(page) > limit else None
        return {"projects": projects, "tasks": items, "next_cursor": next_cursor}

    async def resolve_task(self, request, ident):
        ctx = replace(await self.service.context(request, SESSION + ident), capabilities=())
        row = await self.lookup(ctx, task=ident)
        return ctx, row

    async def detail(self, request, ident, *, diff=False):
        ctx, row = await self.resolve_task(request, ident)
        ref = task_ref(row)
        if diff:
            receipt, patch = await self.broker.read_checkpoint(ctx, ref, CHECKPOINT)
            await self.resolve_task(request, ident)
            return {"receipt": receipt, "diff": patch[:131072].decode("utf-8", "replace"), "truncated": len(patch) > 131072}
        out = {k: row[k] for k in ("id", "project", "revision", "instruction")}
        out.update(status=row["preparation"], result=None, review=False, computer=False, can_retry=False, can_checkpoint=False)
        runtime = self.service.runtime
        try:
            run = await runtime.get_run(ident, ctx)
        except LookupError:
            if ident not in self.jobs:
                out.update(status="interrupted", can_retry=True)
            await self.resolve_task(request, ident)
            return out
        out["status"] = run.status
        if run.terminal:
            answer = await runtime.final_answer(ident, ctx)
            out["result"] = (answer.final_answer or {}).get("text")
            out["review"] = row["preparation"] == "reviewed"
            out["can_checkpoint"] = not out["review"] and ident not in self.jobs
        try:
            lease = await self.broker.current_lease(ctx, ref)
            out["computer"] = True
            out["lease"] = {"epoch": lease.epoch, "generation": lease.generation}
            if run.terminal and ident not in self.jobs and self.can_suspend(ctx, row):
                out["suspend"] = out["lease"]
        except CapabilityUnavailable:
            pass
        await self.resolve_task(request, ident)
        return out
