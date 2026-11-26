"""Direct human access to an enrolled project VM's optional task surfaces."""

from uuid import UUID

from aiohttp import web
from openagent_core.capabilities import CapabilityUnavailable
from openagent_core.computer_interaction import ComputerInteraction
from openagent_core.runtime import execution_scope


def _revision(tasks, ctx, row):
    for project in tasks.projects(ctx):
        if project["id"] == row["project"]:
            for revision in project["revisions"]:
                if revision["commit"] == row["revision"]:
                    return revision
    raise PermissionError("Revision access was withdrawn")


def _capabilities(revision, offered):
    grants = set(revision.get("surfaces", ()))
    terminal = set(offered) >= {"attach", "read"} and "terminal.read" in grants
    endpoint = revision.get("preview") or {}
    port, path = endpoint.get("port"), endpoint.get("path")
    preview = ("preview.read" in grants and "preview" in offered and type(port) is int
               and 1024 <= port <= 65535 and isinstance(path, str) and path.startswith("/"))
    return {"terminal": {"read": terminal, "input": terminal and {"open", "input"} <= set(offered)
                         and "terminal.input" in grants}, "preview": bool(preview)}


async def _offered(tasks, runtime, bound):
    catalog = runtime.capabilities
    with execution_scope(runtime, bound, None):
        descriptors = await catalog.discover(bound)
    found = {}
    for descriptor in descriptors:
        if descriptor.name != "shell_exec":
            continue
        contract = descriptor.metadata.get("openagent/task-surfaces")
        if not isinstance(contract, dict) or contract.get("version") != 1:
            continue
        tasks.broker.viewer_target_id(catalog, bound, descriptor)
        ops = contract.get("operations")
        if not isinstance(ops, list) or any(op not in {"attach", "open", "read", "input", "preview"} for op in ops):
            raise CapabilityUnavailable("Invalid enrolled task surface")
        if found or len(set(ops)) != len(ops):
            raise CapabilityUnavailable("Ambiguous task surface")
        found.update((op, descriptor.tool_ref) for op in ops)
    return found


def _args(body, revision, rights):
    op = body["op"]
    common = {"op", "epoch", "generation"}
    fields = {"open": set(), "preview": set(), "read": {"terminal_id", "cursor"},
              "input": {"terminal_id", "text", "request_id"}}
    if op not in fields or set(body) != common | fields[op]:
        raise ValueError("Unexpected task surface fields")
    if op == "preview":
        if not rights["preview"]:
            raise PermissionError("Preview access required")
        p = revision["preview"]
        return op, {"endpoint": f"{p['port']}:{p['path']}"}
    if not rights["terminal"]["read"] or (op == "input" and not rights["terminal"]["input"]):
        raise PermissionError("Terminal access required")
    if op == "open":
        return ("open" if rights["terminal"]["input"] else "attach"), {}
    if not isinstance(body["terminal_id"], str):
        raise ValueError("Invalid terminal identity")
    ident = str(UUID(body["terminal_id"]))
    if op == "read":
        if type(body["cursor"]) is not int or body["cursor"] < 0:
            raise ValueError("Invalid output cursor")
        return op, {"terminal_id": ident, "cursor": body["cursor"]}
    text = body["text"]
    if not isinstance(text, str) or not 0 < len(text.encode()) <= 4096:
        raise ValueError("Invalid terminal input")
    if not isinstance(body["request_id"], str):
        raise ValueError("Invalid input receipt")
    return op, {"terminal_id": ident, "text": text, "request_id": str(UUID(body["request_id"]))}


def install_surfaces(app, tasks):
    from .project_task_routes import PRIVATE, task_ref

    runtime = tasks.service.runtime
    human = ComputerInteraction(runtime)

    async def surface(request):
        if request.query:
            raise ValueError("Unexpected task query")
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("op"), str):
            raise ValueError("A task surface operation is required")
        op = body["op"]
        if op == "status" and set(body) != {"op"}:
            raise ValueError("Unexpected status fields")
        ident = request.match_info["id"]
        ctx, row = await tasks.resolve_task(request, ident)
        await human.authorize_access(ctx, interactive=False)
        lease = await tasks.broker.current_lease(ctx, task_ref(row))
        versions = {"epoch": lease.epoch, "generation": lease.generation}
        if op != "status" and any(type(body.get(k)) is not int or body[k] != v for k, v in versions.items()):
            raise web.HTTPConflict(text="Stale task computer", headers=PRIVATE)
        async with tasks.broker.tools(runtime.capabilities, ctx, lease) as bound:
            offered = await _offered(tasks, runtime, bound)
            rev = _revision(tasks, ctx, row)
            rights = _capabilities(rev, offered)
            if op == "status":
                payload = {**versions, **rights}
                interactive = False
            else:
                action, args = _args(body, rev, rights)
                interactive = action in {"open", "input"}
                await human.authorize_access(ctx, interactive=interactive)
                with execution_scope(runtime, bound, None):
                    result = await runtime.capabilities.call_source_tool(
                        offered[action], "task_surface_" + action, args, bound)
                if hasattr(result, "model_dump"):
                    result = result.model_dump(mode="json", by_alias=True)
                if not isinstance(result, dict) or result.get("isError") or not isinstance(result.get("structuredContent"), dict):
                    raise CapabilityUnavailable("Guest task surface unavailable")
                payload = {**result["structuredContent"], **versions}
            # Re-resolve membership, exact lease, grants and configured endpoint before publication.
            fresh_ctx, fresh_row = await tasks.resolve_task(request, ident)
            await human.authorize_access(fresh_ctx, interactive=interactive)
            if await tasks.broker.current_lease(fresh_ctx, task_ref(fresh_row)) != lease:
                raise CapabilityUnavailable("Task computer changed")
            fresh = _revision(tasks, fresh_ctx, fresh_row)
            now = _capabilities(fresh, offered)
            if op == "status":
                payload.update(now)
            elif _args(body, fresh, now) != (action, args):
                raise PermissionError("Task surface grant changed")
            return web.json_response(payload, headers=PRIVATE)

    app.router.add_post("/api/project-tasks/{id}/surface", surface)
