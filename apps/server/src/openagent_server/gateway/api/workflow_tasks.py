"""Workflow tasks REST API — CRUD + run + run history for the n8n-style
workflow engine.

Endpoints:

    GET    /api/workflows                       list all workflows
    POST   /api/workflows                       create a workflow
    GET    /api/workflows/{id}                  fetch one (full graph)
    PATCH  /api/workflows/{id}                  partial update
    DELETE /api/workflows/{id}                  delete + cascade runs
    POST   /api/workflows/{id}/run              body: {inputs, wait}
    POST   /api/workflows/{id}/stop             body: {run_id, wait}
    GET    /api/workflows/{id}/runs             run history (newest first)
    GET    /api/workflow-runs/{run_id}          fetch one run + trace
    GET    /api/workflow-block-types            static catalog for the UI
    GET    /api/mcp-tools                       live MCP tool inventory

Read handlers use the agent's durable database directly, so definitions and
run history remain inspectable while background workers are intentionally
parked (for example in hermetic local E2E mode). Mutations and execution still
require the live ``Scheduler`` and return 503 when it isn't attached. Writes
bypass the MCP subprocess — the gateway talks to the same SQLite as the
workflow-manager MCP and the scheduler, so all three stay in sync.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from openagent_core.core.logging import elog
from openagent_core.memory.schedule import (
    epoch_to_iso,
    next_run_for_expression,
    validate_schedule_expression,
)
from openagent_core.workflow.blocks import iter_block_specs
from openagent_core.workflow.schedule_sync import (
    sync_workflow_schedules,
    trigger_types_from_graph,
)
from openagent_core.workflow.validate import (
    ValidationError,
    validate_graph,
)


def _resolve_scheduler(request):
    """Return (scheduler, error_response). error_response is None on success."""
    from aiohttp import web

    gw = request.app["gateway"]
    scheduler = getattr(gw, "_scheduler", None)
    if scheduler is None:
        return None, web.json_response(
            {"error": "Scheduler is not running"},
            status=503,
        )
    return scheduler, None


def _resolve_read_db(request):
    """Return the durable workflow DB without requiring a live worker.

    Production normally reaches the same ``MemoryDB`` through the scheduler.
    Safe/local inspection modes deliberately omit that background runtime, but
    the gateway still owns an initialized agent DB. Keeping this resolver
    read-only lets clients inspect durable automation state without starting a
    scheduler (or weakening the write/run guard above).
    """
    from aiohttp import web

    gw = request.app["gateway"]
    scheduler = getattr(gw, "_scheduler", None)
    db = getattr(scheduler, "db", None)
    if db is None:
        agent = getattr(gw, "agent", None) or getattr(gw, "_agent", None)
        db = getattr(agent, "memory_db", None)
    if db is None:
        return None, web.json_response(
            {"error": "No database configured"},
            status=503,
        )
    return db, None


async def _authorized_tools(request):
    from aiohttp import web
    service=getattr(request.app['gateway'],'runtime_service',None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Capability catalog is not ready")
    context=await service.context(request,'__automation_management__')
    return await service.runtime.capabilities.discover(context)


async def _resolve_mcp_inventory(request):
    result={}
    for tool in await _authorized_tools(request):
        result.setdefault(tool.source_id,{})[tool.name]=dict(tool.input_schema)
    return result


async def _resolve_mcp_callability(request):
    return {source:{name:True for name in tools} for source,tools in (await _resolve_mcp_inventory(request)).items()}


def _decorate_schedule(row: dict) -> dict:
    """Shape a workflow_schedules row for JSON."""
    out = dict(row)
    out["enabled"] = bool(out.get("enabled"))
    for key in ("next_run_at", "last_run_at", "created_at", "updated_at"):
        epoch = out.get(key)
        out[f"{key}_iso"] = epoch_to_iso(epoch) if epoch else None
    return out


async def _decorate_workflow(db, row: dict) -> dict:
    """Shape a DB row for JSON: parse graph_json, add ISO timestamps,
    fold in the per-block ``schedules[]`` array + derived
    ``trigger_types[]``. Drops legacy row-level columns
    (``trigger_kind`` / ``cron_expression`` / ``next_run_at``) from
    the response — schedule state lives in ``workflow_schedules``.
    """
    out = dict(row)
    if "graph" not in out:
        raw = out.pop("graph_json", None) or '{"version":1,"nodes":[],"edges":[],"variables":{}}'
        try:
            out["graph"] = json.loads(raw)
        except (TypeError, ValueError):
            out["graph"] = {"version": 1, "nodes": [], "edges": [], "variables": {}}
    for deprecated in ("trigger_kind", "cron_expression", "next_run_at"):
        out.pop(deprecated, None)
    for key in ("last_run_at", "created_at", "updated_at"):
        epoch = out.get(key)
        out[f"{key}_iso"] = epoch_to_iso(epoch) if epoch else None
    out["enabled"] = bool(out.get("enabled"))
    raw_cap = out.get("max_concurrent_runs")
    out["max_concurrent_runs"] = int(raw_cap) if raw_cap is not None else None
    out["trigger_types"] = trigger_types_from_graph(out.get("graph"))
    schedules = await db.list_schedules(workflow_id=out["id"])
    out["schedules"] = [_decorate_schedule(s) for s in schedules]
    return out


def _decorate_run(row: dict) -> dict:
    out = dict(row)
    for key in ("started_at", "finished_at"):
        epoch = out.get(key)
        out[f"{key}_iso"] = epoch_to_iso(epoch) if epoch else None
    return out


async def _find_workflow(db, id_or_name: str) -> dict | None:
    """Accept full id, 8-char id prefix, or unique name. Mirrors the
    MCP's ``_resolve_workflow`` for consistent UX."""
    return await db.get_workflow(id_or_name)


# ── list / get / create / update / delete ───────────────────────────


async def handle_list(request):
    from aiohttp import web

    db, err = _resolve_read_db(request)
    if err is not None:
        return err

    enabled_only = request.query.get("enabled_only", "").lower() in ("1", "true", "yes")
    has_trigger = request.query.get("has_trigger_type") or None
    rows = await db.list_workflows(enabled_only=enabled_only)
    decorated = [await _decorate_workflow(db, r) for r in rows]
    if has_trigger:
        decorated = [w for w in decorated if has_trigger in w["trigger_types"]]
    return web.json_response({"workflows": decorated})


async def handle_get(request):
    from aiohttp import web

    db, err = _resolve_read_db(request)
    if err is not None:
        return err

    row = await _find_workflow(db, request.match_info["id"])
    if row is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )
    return web.json_response(await _decorate_workflow(db, row))


async def handle_create(request):
    from aiohttp import web

    scheduler, err = _resolve_scheduler(request)
    if err is not None:
        return err

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = (body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "name is required"}, status=400)

    graph = {
        "version": 1,
        "nodes": body.get("nodes") or [],
        "edges": body.get("edges") or [],
        "variables": body.get("variables") or {},
    }
    try:
        validate_graph(
            graph,
            mcp_inventory=await _resolve_mcp_inventory(request),
            mcp_callability=await _resolve_mcp_callability(request),
        )
    except ValidationError as exc:
        return web.json_response({"error": f"graph validation failed: {exc}"}, status=400)

    cap_raw = body.get("max_concurrent_runs", None)
    if cap_raw is not None:
        try:
            cap = int(cap_raw)
        except (TypeError, ValueError):
            return web.json_response(
                {"error": "max_concurrent_runs must be an integer or null"},
                status=400,
            )
        if cap < 1:
            return web.json_response(
                {"error": "max_concurrent_runs must be >= 1 (or null for unlimited)"},
                status=400,
            )
    else:
        cap = None

    from openagent_server.automation_management import mutate_request
    async def create(store):
        identifier=await store.add_workflow(name=name,description=body.get("description") or None,
            graph=graph,enabled=bool(body.get("enabled",True)),max_concurrent_runs=cap)
        await sync_workflow_schedules(store,identifier,graph)
        return identifier
    try:
        workflow_id=await mutate_request(request,"workflow",create)
    except ValueError as exc:
        return web.json_response({"error":str(exc)},status=400)

    row = await scheduler.db.get_workflow(workflow_id)
    from .operational import claim_created_resource

    await claim_created_resource(request, "workflow_definition", workflow_id)
    elog("workflow.create", id=workflow_id, name=name)
    await request.app["gateway"].broadcast_resource(
        "workflow", "created", workflow_id,
    )
    return web.json_response(
        await _decorate_workflow(scheduler.db, row), status=201,
    )


async def handle_update(request):
    from aiohttp import web

    scheduler, err = _resolve_scheduler(request)
    if err is not None:
        return err

    existing = await _find_workflow(scheduler.db, request.match_info["id"])
    if existing is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    updates: dict[str, Any] = {}

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return web.json_response({"error": "name cannot be empty"}, status=400)
        updates["name"] = name

    if "description" in body:
        updates["description"] = body["description"] or None

    if "enabled" in body:
        updates["enabled"] = bool(body["enabled"])

    if "max_concurrent_runs" in body:
        cap_raw = body["max_concurrent_runs"]
        if cap_raw is None:
            updates["max_concurrent_runs"] = None
        else:
            try:
                cap = int(cap_raw)
            except (TypeError, ValueError):
                return web.json_response(
                    {"error": "max_concurrent_runs must be an integer or null"},
                    status=400,
                )
            if cap < 1:
                return web.json_response(
                    {"error": "max_concurrent_runs must be >= 1 (or null for unlimited)"},
                    status=400,
                )
            updates["max_concurrent_runs"] = cap

    new_graph: dict | None = None
    if any(k in body for k in ("nodes", "edges", "variables")):
        current = existing["graph"]
        new_graph = {
            "version": current.get("version", 1),
            "nodes": body["nodes"] if "nodes" in body else current.get("nodes", []),
            "edges": body["edges"] if "edges" in body else current.get("edges", []),
            "variables": (
                body["variables"]
                if "variables" in body
                else current.get("variables", {})
            ),
        }
        try:
            validate_graph(
                new_graph,
                mcp_inventory=await _resolve_mcp_inventory(request),
                mcp_callability=await _resolve_mcp_callability(request),
            )
        except ValidationError as exc:
            return web.json_response(
                {"error": f"graph validation failed: {exc}"}, status=400,
            )
        updates["graph"] = new_graph

    if not updates:
        return web.json_response(
            {"error": "No fields to update."}, status=400,
        )

    from openagent_server.automation_management import mutate_request
    async def update(store):
        await store.update_workflow(existing["id"],**updates)
        if new_graph is not None:
            await sync_workflow_schedules(store,existing["id"],new_graph)
    try:
        await mutate_request(request,"workflow",update)
    except ValueError as exc:
        return web.json_response({"error":str(exc)},status=400)

    row = await scheduler.db.get_workflow(existing["id"])
    elog(
        "workflow.update",
        id=existing["id"],
        fields=list(updates.keys()),
    )
    await request.app["gateway"].broadcast_resource(
        "workflow", "updated", existing["id"],
    )
    return web.json_response(await _decorate_workflow(scheduler.db, row))


async def handle_delete(request):
    from aiohttp import web

    scheduler, err = _resolve_scheduler(request)
    if err is not None:
        return err

    existing = await _find_workflow(scheduler.db, request.match_info["id"])
    if existing is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )

    from openagent_server.automation_management import mutate_request
    await mutate_request(request,"workflow",lambda store: store.delete_workflow(existing["id"]))
    elog("workflow.delete", id=existing["id"], name=existing.get("name", ""))
    await request.app["gateway"].broadcast_resource(
        "workflow", "deleted", existing["id"],
    )
    return web.json_response({"ok": True, "id": existing["id"]})


# ── run + run history ───────────────────────────────────────────────


async def handle_run(request):
    """Run an exact occurrence; HTTP timeouts detach without cancelling it."""
    from aiohttp import web
    from uuid import NAMESPACE_URL, uuid4, uuid5
    from openagent_core.contracts import IdempotencyConflict
    scheduler, error = _resolve_scheduler(request)
    if error is not None:
        return error
    existing = await _find_workflow(scheduler.db, request.match_info["id"])
    if existing is None:
        raise web.HTTPNotFound()
    execution=getattr(scheduler,'execution_service',None)
    if execution is None or not await execution.definition_authorized('workflow',existing):
        return web.json_response({'error':'automation_authorization_required'},status=403)
    try:
        body=await request.json() if request.can_read_body else {}
        if not isinstance(body,dict):
            raise ValueError('Expected an object')
        request_key=body.get('request_id') or str(uuid4())
        if not isinstance(request_key,str) or not request_key or len(request_key)>200:
            raise ValueError('Invalid request_id')
        timeout=max(0,min(float(body.get('timeout_s',300)),960)) if body.get('wait',True) else 3
    except (ValueError,TypeError) as error:
        raise web.HTTPBadRequest(text=str(error)) from None
    projection_id=str(uuid5(NAMESPACE_URL,f'workflow:{existing["id"]}:{request_key}'))
    task=scheduler._spawn_workflow(scheduler.run_workflow(existing,trigger="api",inputs=body.get("inputs") or {},request_id=request_key,run_id=projection_id))
    done,_=await asyncio.wait({task},timeout=timeout)
    if done:
        try:
            task.result()
        except IdempotencyConflict:
            return web.json_response({'error':'idempotency_conflict','run_id':projection_id},status=409)
        except PermissionError:
            return web.json_response({'error':'automation_authorization_changed','run_id':projection_id},status=403)
        except Exception:
            row=await scheduler.db.get_workflow_run(projection_id)
            if row is None:
                return web.json_response({'error':'runtime_execution_failed','run_id':projection_id},status=500)
    else:
        # Observe detached completion exceptions without turning request
        # disconnection into runtime cancellation.
        task.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
    row=await scheduler.db.get_workflow_run(projection_id)
    await request.app['gateway'].broadcast_resource('workflow','updated',existing['id'])
    if row is None or not done:
        return web.json_response({'run_id':projection_id,'request_id':request_key,'status':'running'},status=202)
    return web.json_response(_decorate_run(row))


async def handle_stop(request):
    """POST /api/workflows/{id}/stop — hard-stop in-flight run(s) of a
    workflow. Body: ``{run_id, wait, timeout_s}``.

    The app could start a workflow it had no way to stop: ``/run`` has always
    been here, and stopping was reachable only through the agent-facing
    ``stop_workflow`` MCP tool — so a user watching a runaway run had to ask
    the agent to kill it. The machinery was all present (the scheduler's
    cancellation drain handles workflow runs already); this is the missing
    door on the gateway, which §10 says is the *only* public surface.

    Flags each in-flight run ``cancelling`` — the same DB-backed hand-off the
    MCP tool writes, via one shared helper — and the scheduler cancels the
    executor mid-DAG within ~2s, aborting any in-flight AI block, then records
    each run ``cancelled``. Deliberately mirrors ``/api/scheduled-tasks/{id}
    /stop`` in status codes and response shape (the app treats the two as the
    same gesture), with one addition the scheduled-task side has no use for:
    ``run_id``, because a workflow may legitimately have several concurrent
    runs and the run screen stops the one it is showing.

    Stopping a run does NOT stop the workflow from firing again — that is
    ``enabled: false`` or removing its trigger-schedule block.
    """
    from aiohttp import web

    from openagent_core.workflow.cancel import await_runs_terminal, flag_workflow_runs_cancelling

    scheduler, err = _resolve_scheduler(request)
    if err is not None:
        return err

    existing = await _find_workflow(scheduler.db, request.match_info["id"])
    if existing is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )

    try:
        body = await request.json() if request.can_read_body else {}
    except Exception:
        body = {}
    run_id = (body.get("run_id") or "").strip() or None
    wait = body.get("wait", True)
    timeout_s = int(body.get("timeout_s", 30))

    # The gateway shares a process with the scheduler, so it writes the flag
    # straight to the DB (as the scheduled-task endpoint does) rather than
    # going through the MCP's request queue. The raw connection is needed for
    # the compare-and-set the public partial-update helper cannot express —
    # see ``flag_workflow_runs_cancelling`` for why that guard is load-bearing.
    conn = await scheduler.db._ensure_connected()
    flagged = await flag_workflow_runs_cancelling(
        conn, workflow_id=existing["id"], run_id=run_id,
    )
    gw = request.app["gateway"]
    # Reflect the cancelling state on subscribed clients right away.
    await gw.broadcast_resource("workflow", "updated", existing["id"])

    if not flagged:
        # Not an error: the run finished on its own, was already stopped, or
        # the run_id names a run of some other workflow. The app polls this
        # endpoint from a Stop button that may well be a frame stale, so a
        # 404/409 here would surface as a scary dialog for a benign race —
        # same call the scheduled-task endpoint makes.
        return web.json_response({
            "workflow_id": existing["id"],
            "name": existing.get("name", ""),
            "stopped": [],
            "count": 0,
            "runs": [],
            "note": (
                "No running run to stop"
                + (f" (run_id {run_id!r})" if run_id else "")
                + "."
            ),
        })

    elog("workflow.stop", id=existing["id"], count=len(flagged))
    if wait:
        runs = await await_runs_terminal(conn, flagged, timeout_s=timeout_s)
        # Re-broadcast so the screen drops its running/cancelling state.
        await gw.broadcast_resource("workflow", "updated", existing["id"])
    else:
        runs = [{"id": rid, "status": "cancelling"} for rid in flagged]

    return web.json_response({
        "workflow_id": existing["id"],
        "name": existing.get("name", ""),
        "stopped": flagged,
        "count": len(flagged),
        "runs": runs,
    })


async def handle_runs_list(request):
    from aiohttp import web

    db, err = _resolve_read_db(request)
    if err is not None:
        return err

    existing = await _find_workflow(db, request.match_info["id"])
    if existing is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )

    limit = int(request.query.get("limit", 20))
    status = request.query.get("status") or None
    runs = await db.list_workflow_runs(
        existing["id"], limit=limit, status=status,
    )
    return web.json_response({"runs": [_decorate_run(r) for r in runs]})


async def handle_run_get(request):
    from aiohttp import web

    db, err = _resolve_read_db(request)
    if err is not None:
        return err

    run_id = request.match_info["run_id"]
    row = await db.get_workflow_run(run_id)
    if row is None:
        return web.json_response({"error": f"run {run_id!r} not found"}, status=404)
    from .operational import decorate_workflow_run_detail

    detail = await decorate_workflow_run_detail(request, _decorate_run(row))
    if detail is None:
        return web.json_response({"error": "This result is no longer available"}, status=404)
    return web.json_response(detail, headers={"Cache-Control": "no-store"})


async def handle_stats(request):
    """Aggregate stats for the workflow editor's RunHistoryDrawer.

    Returns success rate, avg duration, and a last-N timeline used to
    render the sparkline + "last run" badge on the workflow list row.
    """
    from aiohttp import web

    db, err = _resolve_read_db(request)
    if err is not None:
        return err

    existing = await _find_workflow(db, request.match_info["id"])
    if existing is None:
        return web.json_response(
            {"error": f"Workflow {request.match_info['id']!r} not found"},
            status=404,
        )

    try:
        count = max(1, min(int(request.query.get("last", 10)), 50))
    except ValueError:
        return web.json_response(
            {"error": "last must be a positive integer"}, status=400,
        )
    stats = await db.workflow_run_stats(
        existing["id"], sparkline_count=count,
    )
    # Decorate last[] entries with ISO timestamps for UI display.
    for entry in stats.get("last", []):
        for key in ("started_at", "finished_at"):
            epoch = entry.get(key)
            entry[f"{key}_iso"] = epoch_to_iso(epoch) if epoch else None
    return web.json_response(stats)


# ── introspection: block catalog + MCP tool inventory ───────────────


async def handle_block_types(request):
    """Static catalog from BLOCK_CATALOG — what every block expects in
    config, what handles it publishes, and a human-readable description.
    The workflow editor's block palette and properties panel read from
    here to render their UI.
    """
    from aiohttp import web

    return web.json_response({"block_types": iter_block_specs()})


async def handle_mcp_tools(request):
    """The workflow picker uses the same authorized durable source catalog."""
    from aiohttp import web
    grouped={}
    for tool in await _authorized_tools(request):
        grouped.setdefault(tool.source_id,{'name':tool.source_id,'tools':[]})['tools'].append({
            'name':tool.name,'description':tool.description,'parameters':dict(tool.input_schema),
            'tool_ref':tool.tool_ref})
    return web.json_response({'mcps':list(grouped.values())})


async def handle_cron_describe(request):
    """Validate a cron expression and return the next N fire times.

    Powers the CronPicker's live preview in the workflow editor and
    the list-screen create form. Mirrors the scheduler MCP's
    ``describe_cron`` tool so the UI, the AI, and the CLI see the
    same output shape.

    Query params:
      - ``expression`` (required): cron (``0 9 * * *``) or one-shot
        (``@once:<epoch>``).
      - ``count`` (optional, default 3, max 20): how many upcoming
        fire times to compute.
    """
    from aiohttp import web
    from croniter import croniter

    from openagent_core.memory.schedule import (
        epoch_to_iso,
        is_one_shot_expression,
        parse_one_shot_expression,
    )

    expr = (request.query.get("expression") or "").strip()
    if not expr:
        return web.json_response(
            {"error": "expression query param is required"}, status=400,
        )
    try:
        count = max(1, min(int(request.query.get("count", 3)), 20))
    except ValueError:
        return web.json_response(
            {"error": "count must be a positive integer"}, status=400,
        )

    try:
        validate_schedule_expression(expr)
    except ValueError as exc:
        return web.json_response(
            {"expression": expr, "valid": False, "error": str(exc)},
            status=400,
        )

    upcoming: list[dict] = []
    if is_one_shot_expression(expr):
        epoch = parse_one_shot_expression(expr)
        upcoming.append({"epoch": epoch, "iso": epoch_to_iso(epoch)})
    else:
        base = time.time()
        it = croniter(expr, base)
        for _ in range(count):
            nxt = it.get_next(float)
            upcoming.append({"epoch": nxt, "iso": epoch_to_iso(nxt)})

    return web.json_response({
        "expression": expr,
        "valid": True,
        "one_shot": is_one_shot_expression(expr),
        "upcoming": upcoming,
    })
