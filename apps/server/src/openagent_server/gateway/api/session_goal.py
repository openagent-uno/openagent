"""REST for a conversation's goal (``openagent_core.session_goal``).

``GET /api/sessions/{session_id}/goal`` — ``{"goal": {...} | null}``.
``PUT /api/sessions/{session_id}/goal`` body ``{"objective", "max_continuations"?}``
    — set or replace the goal; it starts active with a fresh budget.
``PATCH /api/sessions/{session_id}/goal`` body ``{"action"?: "pause"|"resume"|"done",
    "objective"?, "max_continuations"?, "note"?}`` — manage the existing goal.
``DELETE /api/sessions/{session_id}/goal`` — remove it.

Reads need view access to the session; changes need admin access, like the
per-session model pin. A change touches only the goal row, never the live
turn or the shared queue, so it is allowed while a shared (collaboration)
transport owns the conversation: a person must be able to pause, resume or
edit a goal while the agent works. Every change is announced as a ``session``
``updated`` resource event so open clients refresh their goal panel.
"""
from __future__ import annotations

from openagent_server.gateway.api._common import gateway_db as _db


async def _goal_access(request, *, permission: str):
    from aiohttp import web

    from openagent_server.gateway.api import sessions as sessions_api

    db = _db(request)
    if db is None:
        return None, None, web.json_response({"error": "memory DB not available"}, status=500)
    session_id = request.match_info["session_id"]
    _conn, _access, _acl, problem = await sessions_api._authorized_session(
        request, db, session_id, permission=permission)
    if problem is not None:
        return None, None, problem
    return db, session_id, None


async def _announce(request, session_id: str) -> None:
    gateway = request.app.get("gateway") if hasattr(request.app, "get") else None
    if gateway is not None and hasattr(gateway, "broadcast_resource"):
        await gateway.broadcast_resource("session", "updated", session_id)


def _payload(goal) -> dict:
    return {"goal": goal.to_dict() if goal is not None else None}


async def _body(request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        body = await request.json()
    except ValueError:
        return {"__invalid__": True}
    return body if isinstance(body, dict) else {"__invalid__": True}


def _max(body: dict):
    value = body.get("max_continuations")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("max_continuations must be an integer")
    return value


async def handle_get(request):
    from aiohttp import web
    from openagent_core.session_goal import GoalStore

    db, session_id, problem = await _goal_access(request, permission="view")
    if problem is not None:
        return problem
    return web.json_response(_payload(await GoalStore(db).get(session_id)))


async def handle_put(request):
    from aiohttp import web
    from openagent_core.session_goal import GoalStore

    db, session_id, problem = await _goal_access(request, permission="admin")
    if problem is not None:
        return problem
    body = await _body(request)
    if body.get("__invalid__"):
        return web.json_response({"error": "a JSON object is required"}, status=400)
    objective = str(body.get("objective") or "").strip()
    if not objective:
        return web.json_response({"error": "objective is required"}, status=400)
    try:
        goal = await GoalStore(db).set(session_id, objective, max_continuations=_max(body))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    await _announce(request, session_id)
    return web.json_response(_payload(goal))


async def handle_patch(request):
    from aiohttp import web
    from openagent_core.session_goal import GoalStore

    db, session_id, problem = await _goal_access(request, permission="admin")
    if problem is not None:
        return problem
    body = await _body(request)
    if body.get("__invalid__"):
        return web.json_response({"error": "a JSON object is required"}, status=400)
    store = GoalStore(db)
    if await store.get(session_id) is None:
        return web.json_response({"error": "this session has no goal"}, status=404)
    action = body.get("action")
    if action not in (None, "pause", "resume", "done"):
        return web.json_response({"error": "action must be pause, resume or done"}, status=400)
    try:
        if "objective" in body or "max_continuations" in body:
            objective = body.get("objective")
            await store.update(session_id, objective=None if objective is None else str(objective),
                               max_continuations=_max(body))
        if body.get("note") is not None:
            await store.note(session_id, str(body["note"]))
        if action == "pause":
            await store.pause(session_id, "Paused by the user.")
        elif action == "resume":
            await store.resume(session_id)
        elif action == "done":
            await store.complete(session_id, "Marked done by the user.")
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    await _announce(request, session_id)
    return web.json_response(_payload(await store.get(session_id)))


async def handle_delete(request):
    from aiohttp import web
    from openagent_core.session_goal import GoalStore

    db, session_id, problem = await _goal_access(request, permission="admin")
    if problem is not None:
        return problem
    removed = await GoalStore(db).clear(session_id)
    if removed:
        await _announce(request, session_id)
    return web.json_response({"goal": None, "removed": removed})
