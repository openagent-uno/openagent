"""REST for per-session model pinning and session lifecycle.

``GET /api/sessions`` — list persisted chat sessions for the authenticated
    certificate (legacy ``?client_id=...`` is ignored).
``GET /api/sessions/{session_id}/model`` — current pin, side binding,
    and resolved runtime_id.
``PUT /api/sessions/{session_id}/model`` body ``{"runtime_id": "..."}`` —
    pin the session to a specific model. Subsequent turns make that model
    the entry model directly, skipping the dispatcher's default-leader
    flag and first-enabled fallback.
``DELETE /api/sessions/{session_id}/model`` — unpin. Session returns to
    normal entry-model resolution (default-leader flag → first enabled).
``DELETE /api/sessions/{session_id}`` — delete a session and its history.
``GET /api/sessions/{session_id}/runs`` — turn history for a session (the
    authorized display transcript projected by Core).
``GET /api/sessions/{session_id}/events`` — the session journal: the facts of
    each turn, written WHILE it happens. A turn that dies before it closes is
    in here and nowhere else.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

logger=logging.getLogger(__name__)

if TYPE_CHECKING:
    from aiohttp import web


from openagent_core.core.child_session import HIDDEN_CHILD_ORIGINS  # noqa: E402
from openagent_server.gateway.api._common import gateway_db as _db  # noqa: E402


async def _authenticated_access(request, db):
    """Resolve a certificate-backed principal and canonical connection."""
    from aiohttp import web
    from openagent_identity.runtime_access import AccessContext

    try:
        access = AccessContext.from_request(request)
    except PermissionError:
        return None, None, web.json_response(
            {"error": "authentication required"}, status=401
        )
    return await db._ensure_connected(), access, None


async def _authorized_session(
    request,
    db,
    session_id: str,
    *,
    permission: str = "view",
    allow_missing: bool = False,
):
    """Return ``(connection, access, acl_row, problem_response)``.

    Session payloads still come from the compatibility store while the beta
    migrates reads, but authorization always comes from the normalized,
    certificate-owned resource row.  Missing and invisible ids intentionally
    share the same 404 response so guessing a session cannot confirm it.
    """
    from aiohttp import web
    from openagent_core.memory.operational.access import resource_is_visible

    conn, access, problem = await _authenticated_access(request, db)
    if problem is not None:
        return conn, access, None, problem
    acl = await (
        await conn.execute(
            "SELECT id AS resource_id, 'session' AS resource_type, tenant_id, "
            "owner_principal_id, visibility, acl_version FROM sessions_v2 "
            "WHERE id=? AND deleted_at_ms IS NULL",
            (session_id,),
        )
    ).fetchone()
    if acl is None:
        if allow_missing:
            return conn, access, None, None
        return conn, access, None, web.json_response(
            {"error": "session not found"}, status=404
        )
    if not await resource_is_visible(conn, acl, access, permission=permission):
        return conn, access, acl, web.json_response(
            {"error": "session not found"}, status=404
        )
    return conn, access, acl, None


async def handle_list(request):
    """GET /api/sessions — list persisted sessions.

    Query params:
      ``client_id`` — deprecated and ignored; the authenticated certificate
      always determines the caller's session candidates.
      ``limit`` — max results (default 50).
    """
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)

    conn, access, problem = await _authenticated_access(request, db)
    if problem is not None:
        return problem

    # The candidate filter is always certificate-derived.  ``client_id`` is
    # retained as an ignored compatibility query parameter; accepting it as
    # an authorization identity let one member list another member's chats.
    client_id = access.handle if access.principal_type == "user" else access.principal_id

    try:
        limit = min(int(request.query.get("limit", "50")), 200)
    except (TypeError, ValueError):
        limit = 50

    gateway = request.app.get("gateway")
    # ``?parent=<sid>`` lists just the children a session spawned (delegated
    # sub-agents, or the AI-node / firing sessions under a workflow-run /
    # scheduled-task root) — powers the parent transcript's delegation cards
    # and the run screen. Otherwise return the flat list, every row now
    # carrying ``parent_session_id`` / ``origin`` / ``kind`` so the app can
    # show an origin chip and a navigable breadcrumb.
    parent = (request.query.get("parent") or "").strip()
    if parent:
        # ``sessions.metadata.parent_session_id`` is a legacy discovery
        # index, not an authorization boundary.  Resolve the caller from the
        # verified device certificate, require the canonical parent to be
        # visible, then independently authorize every child against its own
        # normalized ACL.  This also makes a guessed parent id fail closed and
        # ensures ``?client_id=<someone-else>`` can never widen this query.
        from openagent_core.memory.operational.access import resource_is_visible

        conn, access, _parent_acl, problem = await _authorized_session(
            request, db, parent
        )
        if problem is not None:
            return problem

        discovered = await db.list_child_sessions(parent, limit=limit)
        child_ids = [str(row.get("session_id") or "") for row in discovered]
        canonical_by_id = {}
        if child_ids:
            placeholders = ",".join("?" for _ in child_ids)
            canonical_rows = await (
                await conn.execute(
                    "SELECT id AS resource_id, 'session' AS resource_type, tenant_id, "
                    "owner_principal_id, visibility, acl_version, parent_session_id "
                    f"FROM sessions_v2 WHERE id IN ({placeholders}) "
                    "AND parent_session_id=? AND deleted_at_ms IS NULL",
                    (*child_ids, parent),
                )
            ).fetchall()
            canonical_by_id = {
                str(row["resource_id"]): row for row in canonical_rows
            }

        rows = []
        for row in discovered:
            child_acl = canonical_by_id.get(str(row.get("session_id") or ""))
            if child_acl is not None and await resource_is_visible(
                conn, child_acl, access
            ):
                rows.append(row)
    else:
        # The flat history hides every spawned child session — delegated
        # sub-agents, scheduled firings, and workflow nodes alike. Each is
        # navigable only in context (a parent's transcript card; a run's
        # execution screen), never as a standalone sidebar row. An explicit
        # ``?parent=`` query still lists them for those in-context surfaces.
        rows = await db.list_all_sessions(
            client_id, limit=limit, exclude_child_origins=HIDDEN_CHILD_ORIGINS,
        )

        # Legacy ownership filtering is only candidate discovery.  Recheck
        # every row against the current canonical ACL before serialization.
        from openagent_core.memory.operational.access import resource_is_visible

        session_ids = [str(row.get("session_id") or "") for row in rows]
        acl_by_id = {}
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            acl_rows = await (
                await conn.execute(
                    "SELECT id AS resource_id, 'session' AS resource_type, tenant_id, "
                    "owner_principal_id, visibility, acl_version FROM sessions_v2 "
                    f"WHERE id IN ({placeholders}) AND deleted_at_ms IS NULL",
                    tuple(session_ids),
                )
            ).fetchall()
            acl_by_id = {str(row["resource_id"]): row for row in acl_rows}
        visible_rows = []
        for row in rows:
            acl = acl_by_id.get(str(row.get("session_id") or ""))
            if acl is not None and await resource_is_visible(conn, acl, access):
                visible_rows.append(row)
        rows = visible_rows

    # Enrich with true live-turn state from the stream registry. The legacy
    # SessionManager's RAM list only means "session metadata is attached", not
    # "a turn is running"; using it here would make completed sessions look
    # live forever after reconnect.
    device_client_id = request.get("client_id")
    live_sids: set[str] = set()
    if gateway is not None and device_client_id:
        try:
            live_sids.update(await gateway.active_live_session_ids(
                client_id=device_client_id,
                handle=request.get("user_handle"),
            ))
        except Exception:
            pass
        for r in rows:
            r["_live"] = r["session_id"] in live_sids
    return web.json_response({"sessions": rows})


async def _teardown_session(gateway, db, sid: str) -> None:
    """Remove one session id everywhere: live RAM, the runtime, the persisted
    row + its derived satellites, then announce the removal. Best-effort per
    layer so one failure never strands the others (and a cascade never aborts
    half-way). Shared by the single-delete and the child-cascade so both tear a
    session down identically."""
    if gateway is not None:
        # Live stream sessions are now server-owned and may outlive the
        # WebSocket that started them. A delete is an explicit lifecycle event,
        # so close any matching live session before purging the durable row.
        for key in [
            k for k in list(getattr(gateway, "_stream_sessions", {}))
            if len(k) > 1 and k[1] == sid
        ]:
            try:
                await gateway._close_stream_session(key)
            except Exception:
                pass
        # RAM: find whichever live client owns this session and drop it.
        for client_id in list(gateway.sessions._clients.keys()):
            try:
                await gateway.sessions.delete_session(client_id, sid)
            except Exception:
                pass
        try:
            await gateway.agent.forget_session(sid)
        except Exception:
            pass
    # Persisted cleanup — covers the row + per-session satellites even when
    # RAM is already gone. ``purge_session`` is idempotent.
    try:
        await db.purge_session(sid)
    except Exception:
        pass
    # Announce so every connected client drops the row from its sidebar live
    # (a session deleted on one device vanishes on the others).
    if gateway is not None:
        try:
            gateway.broadcast_session("deleted", sid)
        except Exception:
            pass


async def handle_delete(request):
    """DELETE /api/sessions/{session_id} — delete a chat session and its
    history, cascading to the sub-agent child sessions it spawned.

    Only a *top-level manual chat* is deletable here: a row with
    ``origin == "chat"`` (or no origin, for legacy rows) and no
    ``parent_session_id``. Scheduled-task and workflow run sessions — and the
    sub-agent children themselves — are not directly deletable; they are
    managed in the context that owns them (the scheduled-task / workflow
    screens, or the parent chat). Deleting the chat cascades to every session
    it spawned (delegated sub-agents at any depth, plus any in-chat
    ``run dream mode`` firing), so no orphan child is left behind."""
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)

    session_id = request.match_info["session_id"]
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)

    gateway = request.app.get("gateway")

    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id, permission="admin"
    )
    if problem is not None:
        return problem
    from openagent_server.gateway.collaboration import guard_mutation
    guarded = guard_mutation(request, session_id)
    if guarded is not None:
        return guarded

    row = await db.get_session(session_id)
    if row is None:
        # The normalized row was visible a moment ago but its compatibility
        # source disappeared concurrently.  Fail closed instead of turning a
        # guessed id into a successful no-op delete.
        return web.json_response({"error": "session not found"}, status=404)

    # Guard: refuse to delete a run / sub-agent session. A missing row means a
    # never-persisted RAM-only chat (or one already gone) — fall through and
    # tear it down anyway, so a delete from the client always converges.
    if row is not None:
        origin = row.get("origin") or "chat"
        if origin != "chat" or row.get("parent_session_id"):
            return web.json_response(
                {
                    "error": (
                        "Only top-level chat sessions can be deleted. "
                        "Sub-agent, scheduled-run and workflow sessions are "
                        "managed from the context that spawned them."
                    ),
                    "origin": origin,
                },
                status=403,
            )

    # Collect the whole sub-agent lineage spawned by this chat, then tear down
    # children first and the parent last.  Every descendant is a distinct ACL
    # resource: parent ownership alone cannot authorize deleting a child that
    # belongs to another member.
    descendants = await db.list_descendant_sessions(session_id)
    for child_sid in descendants:
        _c, _a, _child_acl, child_problem = await _authorized_session(
            request, db, child_sid, permission="admin"
        )
        if child_problem is not None:
            return web.json_response({"error": "session not found"}, status=404)
    for child_sid in descendants:
        await _teardown_session(gateway, db, child_sid)
    await _teardown_session(gateway, db, session_id)

    return web.json_response({
        "session_id": session_id,
        "deleted": True,
        # The full set removed (parent + cascaded sub-agents) so a client can
        # prune every affected row and report an accurate count.
        "deleted_session_ids": [session_id, *descendants],
        "deleted_count": 1 + len(descendants),
    })


# Compatibility name for callers that used the old gateway test helper. The
# projection itself is owned and versioned by Core, never copied into the host.
from openagent_core.session_transcript import expand_run_messages as _expand_run_messages  # noqa: E402, F401


async def handle_get_context(request):
    """GET /api/sessions/{session_id}/context — context-window composition.

    Returns the Claude-Code-style breakdown (:mod:`openagent_core.core.context_report`):
    per-section token counts + percentages, the model's context window, and
    cumulative session cost. Used for the app's context panel initial paint /
    reconcile, the CLI ``/context`` table, and any client polling. Works for
    live chat, sub-agent, scheduled-firing, and workflow AI-node sessions
    alike (all are rows in the ``sessions`` table keyed by ``session_id``).
    """
    from aiohttp import web

    gateway = request.app.get("gateway")
    agent = getattr(gateway, "agent", None) if gateway else None
    if agent is None:
        return web.json_response({"error": "agent not available"}, status=500)

    session_id = request.match_info["session_id"]
    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id
    )
    if problem is not None:
        return problem
    try:
        from openagent_core.core.context_report import build_context_report

        report = build_context_report(agent, session_id)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc)}, status=500)

    if report is None:
        # No DB-backed session (yet) — return an empty-but-valid shape so
        # the client renders "no data" rather than erroring.
        return web.json_response({"session_id": session_id, "sections": [], "context_window": 0})
    return web.json_response(report)


async def handle_get_runs(request):
    """GET /api/sessions/{session_id}/runs — turn history as flat messages.

    Core owns the authorized display projection, including original user
    text, path-free attachment refs and ordered parts. Provider preparation
    strings are not presentation data. Query: ``?limit=20``.
    """
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)

    session_id = request.match_info["session_id"]
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id
    )
    if problem is not None:
        return problem
    try:
        limit = max(1, min(int(request.query.get("limit", "20")), 100))
    except (TypeError, ValueError):
        limit = 20

    # Resolve the certificate-bound context through the same authorizer used
    # for ordinary runtime admission. Core rechecks access after reading the
    # transcript, including each child session and attachment reference.
    gateway = request.app.get("gateway")
    service = getattr(gateway, "runtime_service", None)
    if service is None or service.runtime is None:
        return web.json_response(
            {"error": "Runtime session inspection is not ready"}, status=503
        )
    from openagent_core.workspace_administration import SessionInspection

    try:
        context = await service.context(request, session_id)
        inspection = SessionInspection(db, service.authorizer, agent=service.agent)
        transcript = await inspection.transcript(context, session_id, limit=limit)
    except (PermissionError, LookupError):
        # Missing and revoked sessions remain indistinguishable.
        return web.json_response({"error": "session not found"}, status=404)
    return web.json_response(transcript)


async def handle_get_events(request):
    """GET /api/sessions/{session_id}/events?after=<seq>&limit=<n>

    The session journal: what happened during the turns, in order, written as
    it happened. ``runs`` (the sibling endpoint) is the transcript the MODEL
    sees, assembled by the runtime when a turn ends — so a turn that died
    before it closed appears in neither the transcript nor anywhere else. This
    endpoint is where it does appear.

    A client polls it with the last ``seq`` it saw. That is the difference
    between "I heard nothing, so I will guess" and "the turn ended at seq 42,
    reason: error".
    """
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)
    session_id = request.match_info["session_id"]
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id
    )
    if problem is not None:
        return problem
    try:
        after = int(request.query.get("after", "0"))
    except (TypeError, ValueError):
        after = 0
    try:
        limit = int(request.query.get("limit", "500"))
    except (TypeError, ValueError):
        limit = 500

    events = await db.list_session_events(session_id, after_seq=after, limit=limit)

    # Two invariants, reported rather than assumed — both borrowed from dsh.
    #
    # ``unknown_types``: a type this build does not know AND that is not
    # marked ignorable. A consumer that reconstructs anything from this
    # journal must refuse when this list is non-empty instead of skipping the
    # row: a plausible history missing one fact is worse than an honest
    # refusal.
    #
    # ``unpaired_tool_calls``: every tool that was opened and never closed in
    # this window. It is the measure that would have counted, by itself, the
    # 22 dead tool lookups of 2026-08-25 — instead of leaving them to be
    # noticed by hand.
    known = getattr(db, "JOURNAL_KNOWN_TYPES", frozenset())
    ignorable = getattr(db, "JOURNAL_IGNORABLE_TYPES", frozenset())
    unknown = sorted({
        e["type"] for e in events
        if e["type"] not in known and e["type"] not in ignorable
    })

    import json as _json
    open_tools: dict[str, int] = {}
    for e in events:
        if e["type"] != "tool/status":
            continue
        try:
            info = _json.loads((e.get("data") or {}).get("text") or "{}")
        except (TypeError, ValueError):
            continue
        name = info.get("tool_name")
        if not name:
            continue
        open_tools[name] = open_tools.get(name, 0) + (-1 if "result" in info else 1)

    return web.json_response({
        "session_id": session_id,
        "events": events,
        # The caller's next cursor. Absent events, it is whatever they asked
        # from — so an idle poll is a no-op instead of a rewind.
        "last_seq": events[-1]["seq"] if events else after,
        "diagnostics": {
            "unknown_types": unknown,
            "reconstructable": not unknown,
            "unpaired_tool_calls": sorted(n for n, c in open_tools.items() if c > 0),
        },
    })


async def handle_get_metadata(request):
    """Return the authorized session summary used by App create-on-first-send."""
    from aiohttp import web
    db = _db(request)
    if db is None:
        return web.json_response({'error':'memory DB not available'},status=500)
    session_id = request.match_info['session_id']
    _conn,_access,_acl,problem = await _authorized_session(request,db,session_id)
    if problem is not None:
        return problem
    row = await db.get_session(session_id)
    metadata = (row or {}).get('metadata') or {}
    return web.json_response({'session_id':session_id,'title':metadata.get('title') or (row or {}).get('title')})


async def handle_patch_metadata(request):
    """PATCH /api/sessions/{session_id} — update session title/model.

    Body: ``{"title": "...", "model": "..."}``. Both fields optional.

    Stamps the caller as the row's owner, because this endpoint frequently
    *creates* the row: the app titles a chat from its first message, and that
    PATCH can land before anything else has persisted the session. An owner is
    not decoration — ``list_all_sessions`` filters on ``metadata.client_id``,
    so a row written here without one is invisible in every session listing,
    forever. That is survivable while a turn is running (the client keeps its
    own copy in memory), and permanent once the turn dies before the runtime
    writes its runs: the agent restarts, the chat is on disk, and the user
    never sees it again. Ownership only ever gets *added* here —
    ``upsert_session`` merges metadata, so a row that already has an owner
    keeps it, and ``user_id`` stays untouched for the runtime to claim.
    """
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)

    session_id = request.match_info["session_id"]
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)

    # PATCH is also the create-on-first-message path.  Existing rows require
    # canonical admin permission; a genuinely new id may be claimed only by
    # the authenticated certificate identity.  A legacy row lacking its v2
    # projection is not "new" and therefore cannot be claimed through this
    # compatibility endpoint.
    _conn, access, acl, problem = await _authorized_session(
        request,
        db,
        session_id,
        permission="admin",
        allow_missing=True,
    )
    if problem is not None:
        return problem
    legacy_row = await db.get_session(session_id)
    if legacy_row is not None and acl is None:
        return web.json_response({"error": "session not found"}, status=404)

    body = await request.json() if request.can_read_body else {}
    title = str(body.get("title") or "").strip() or None
    model = str(body.get("model") or "").strip() or None
    if not title and not model:
        return web.json_response({"error": "title or model is required"}, status=400)

    # Derive ownership exclusively from the verified certificate.  Human
    # handles stay cross-device; agent principals remain explicitly typed.
    owner = access.handle if access.principal_type == "user" else access.principal_id
    await db.upsert_session(
        session_id,
        # An admin grant authorizes editing; it does not transfer ownership.
        # Stamp the certificate principal only on genuine first creation.
        client_id=owner if legacy_row is None else None,
        title=title,
        model=model,
    )
    # The row and its normalized history projection are committed before any
    # client is told to refresh. This keeps other signed-in devices in sync
    # after an explicit rename instead of requiring an app restart. Older
    # test/headless gateways may not expose the broadcaster, hence the
    # capability check rather than making persistence depend on fan-out.
    gateway = request.app.get("gateway")
    broadcast = getattr(gateway, "broadcast_resource", None)
    if callable(broadcast):
        try:
            await broadcast(
                "session",
                "created" if legacy_row is None else "updated",
                session_id,
            )
        except Exception as exc:  # pragma: no cover - production fan-out is best effort
            logger.debug("session metadata broadcast failed for %s: %s", session_id, exc)
    return web.json_response({
        "session_id": session_id,
        "ok": True,
        **({"title": title} if title else {}),
        **({"model": model} if model else {}),
    })


async def handle_get(request):
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)
    session_id = request.match_info["session_id"]
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id
    )
    if problem is not None:
        return problem
    from openagent_core.session_control import SessionControl
    pin = await SessionControl(request.app["gateway"].agent).model_pin(session_id)
    return web.json_response({
        "session_id": session_id,
        # ``side`` was the legacy per-session framework lock; the v0.14
        # ``session_bindings`` → ``pinned_sessions`` migration dropped it (and
        # the ``get_session_binding`` method with it). Kept as a null in the
        # response so the field's shape stays stable for any old client.
        "side": None,
        "runtime_id": pin,
    })


async def handle_pin(request):
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)
    session_id = request.match_info["session_id"]
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id, permission="admin"
    )
    if problem is not None:
        return problem
    from openagent_server.gateway.collaboration import guard_mutation
    guarded = guard_mutation(request, session_id)
    if guarded is not None:
        return guarded
    body = await request.json() if request.can_read_body else {}
    runtime_id = str(body.get("runtime_id") or "").strip()
    if not runtime_id:
        return web.json_response({"error": "runtime_id is required"}, status=400)
    # Look the model up BY RUNTIME_ID. ``get_model`` takes the surrogate row
    # id and casts it with ``int()``, so passing a runtime_id there made
    # every pin a 500 ("invalid literal for int()"). ``runtime_id`` is not a
    # column — it is derived per row — but it decomposes into the indexed
    # (provider_name, framework, model) triple, which is what
    # ``get_model_by_runtime_id`` selects on; it returns the same enriched
    # shape (``provider_enabled`` included) as the listing, so the checks
    # below are unchanged. Reading one row beats materialising the whole
    # catalogue and scanning it in Python on every pin.
    model = await db.get_model_by_runtime_id(runtime_id)
    if model is None:
        return web.json_response(
            {"error": f"model {runtime_id!r} is not registered"},
            status=404,
        )
    if model.get("kind", "llm") != "llm":
        return web.json_response(
            {"error": "Only language models can be pinned to a session"}, status=400,
        )
    if not model.get("enabled"):
        return web.json_response(
            {"error": f"model {runtime_id!r} is disabled — enable it before pinning"},
            status=400,
        )
    # A model whose PROVIDER is disabled cannot run either, and pinning to
    # it would strand the session on a model the dispatcher will skip.
    if not model.get("provider_enabled", True):
        return web.json_response(
            {"error": f"provider {model.get('provider_name')!r} is disabled — enable it before pinning"},
            status=400,
        )
    from openagent_core.session_control import SessionControl
    try:
        await SessionControl(request.app["gateway"].agent).pin_model(session_id, runtime_id)
    except ValueError as e:
        # Cross-framework pin attempt (surfaces a human-readable message).
        return web.json_response({"error": str(e)}, status=409)
    return web.json_response({
        "session_id": session_id,
        "runtime_id": runtime_id,
        "pinned": True,
    })


async def handle_unpin(request):
    from aiohttp import web

    db = _db(request)
    if db is None:
        return web.json_response({"error": "memory DB not available"}, status=500)
    session_id = request.match_info["session_id"]
    _conn, _access, _acl, problem = await _authorized_session(
        request, db, session_id, permission="admin"
    )
    if problem is not None:
        return problem
    from openagent_server.gateway.collaboration import guard_mutation
    guarded = guard_mutation(request, session_id)
    if guarded is not None:
        return guarded
    from openagent_core.session_control import SessionControl
    await SessionControl(request.app["gateway"].agent).clear_model_pin(session_id)
    return web.json_response({
        "session_id": session_id,
        "pinned": False,
    })
