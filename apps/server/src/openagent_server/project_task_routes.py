"""Gateway routes and reserved session names for optional project tasks."""
from contextlib import asynccontextmanager
from dataclasses import replace
from uuid import UUID

from aiohttp import web
from openagent_core.capabilities import CapabilityUnavailable
from openagent_core.contracts import IdempotencyConflict

PRIVATE = {"Cache-Control": "no-store"}
SESSION = "project-task-"


def is_project_session(session):
    if not session.startswith(SESSION):
        return False
    try:
        ident = UUID(session[len(SESSION):])
    except ValueError:
        return False
    return ident.version == 5 and SESSION + str(ident) == session


def task_ref(row):
    from openagent_core.computer_tasks import ComputerTask

    return ComputerTask(row["project"], row["id"], row["revision"])


def install_routes(app, service):
    @web.middleware
    async def error_boundary(request, handler):
        if not request.path.startswith("/api/project-tasks"):
            return await handler(request)
        try:
            return await handler(request)
        except IdempotencyConflict:
            raise web.HTTPConflict(text="A different task already uses this request", headers=PRIVATE) from None
        except CapabilityUnavailable:
            raise web.HTTPConflict(text="The selected task computer is unavailable", headers=PRIVATE) from None
        except (LookupError, PermissionError):
            raise web.HTTPNotFound(text="Unknown project or task", headers=PRIVATE) from None
        except (ValueError, TypeError):
            raise web.HTTPBadRequest(text="Invalid project task request", headers=PRIVATE) from None

    app.middlewares.append(error_boundary)

    async def list_projects(request):
        tasks = getattr(service, "project_tasks", None)
        return web.json_response(await tasks.listing(request) if tasks else {"projects": [], "tasks": []}, headers=PRIVATE)

    async def route(request):
        tasks = getattr(service, "project_tasks", None)
        if tasks is None:
            raise web.HTTPNotFound()
        if request.method == "POST" and "id" in request.match_info:
            ctx, row = await tasks.resolve_task(request, request.match_info["id"])
            operation = request.path.rsplit("/", 1)[-1]
            body = await request.json() if request.can_read_body else {}
            if operation == "suspend":
                if not tasks.can_suspend(ctx, row):
                    raise PermissionError("Computer suspension requires a grant")
                lease = await tasks.broker.current_lease(ctx, task_ref(row))
                if (not isinstance(body, dict) or set(body) != {"epoch", "generation"}
                        or any(type(body[k]) is not int or body[k] != getattr(lease, k) for k in body)):
                    raise CapabilityUnavailable("The computer changed")
                run = await tasks.service.runtime.get_run(row["id"], ctx)
                if not run.terminal or row["id"] in tasks.jobs:
                    raise CapabilityUnavailable("The task is still running")
                await tasks.broker.suspend(ctx, task_ref(row), lease)
                return web.json_response({"computer": False}, headers=PRIVATE)
            if body != {}:
                raise ValueError("Unexpected connection parameters")
            if operation == "retry":
                await tasks.resume(ctx, row)
                return web.json_response({"id": row["id"]}, status=202, headers=PRIVATE)
            if operation == "checkpoint":
                await tasks.finish_checkpoint(ctx, row)
                return web.json_response({"review": True}, headers=PRIVATE)
            lease = await tasks.broker.attach(ctx, task_ref(row))
            await tasks.resolve_task(request, row["id"])
            return web.json_response({"epoch": lease.epoch, "generation": lease.generation}, headers=PRIVATE)
        if request.method == "POST":
            return web.json_response(await tasks.create(request, await request.json()), status=202, headers=PRIVATE)
        ident = request.match_info["id"]
        return web.json_response(await tasks.detail(request, ident, diff=request.path.endswith("/diff")), headers=PRIVATE)

    app.router.add_get("/api/project-tasks", list_projects)
    app.router.add_post("/api/project-tasks", route)
    app.router.add_get("/api/project-tasks/{id}", route)
    app.router.add_get("/api/project-tasks/{id}/diff", route)
    for operation in ("attach", "retry", "checkpoint", "suspend"):
        app.router.add_post("/api/project-tasks/{id}/" + operation, route)
    if getattr(service, "project_tasks", None):
        from .project_task_surfaces import install_surfaces
        from openagent_gateway import ComputerViewerGateway
        tasks = getattr(service, "project_tasks", None)

        install_surfaces(app, tasks)

        @asynccontextmanager
        async def context(request, action, run_id, session_id):
            yield replace(await service.context(request, session_id), capabilities=())

        async def resolve(request, ctx, ident):
            if ctx.session_id != SESSION + ident:
                raise LookupError("Invalid task session")
            return task_ref(await tasks.lookup(ctx, task=ident))

        ComputerViewerGateway(tasks.broker, resolve, prefix="/api/project-tasks/viewer").install(app, service.runtime, context)
