"""The two shared tool implementations — backend-agnostic.

Registered identically by the standalone stdio server and the embedded
openagent-server builtin. They always return a structured dict (never raise
for expected conditions like an unknown target or an unreachable peer), so
the model always gets a clean result.
"""

from __future__ import annotations

import asyncio
import uuid

from .backends.base import Backend
from .errors import redact


async def list_agents(backend: Backend) -> dict:
    """Return the configured targets — alias + description only.

    Never dials, and never leaks the connection descriptor (ticket, full
    node_id, relay, addresses). ``reachable`` is a placeholder for a cached
    liveness hint (always null in v1 — no probe-on-list).
    """
    targets = await backend.list_targets()
    return {
        "agents": [
            {
                "name": t.name,
                "description": t.description,
                "node_id_short": (t.node_id or "")[:12],
                "reachable": None,
            }
            for t in targets
        ]
    }


async def ask_agent(
    backend: Backend,
    *,
    target: str,
    message: str,
    session_id: str | None = None,
    timeout_secs: int | None = None,
) -> dict:
    """Send *message* to the configured agent *target* and return its reply.

    Result: ``{target, session_id, response, model, errored, error, created}``.
    A null/omitted ``session_id`` starts a NEW conversation on the target and
    the returned ``session_id`` (once the target runs the peer-session patch)
    is the handle to continue it — pass it back to resume.
    """
    by_name = {t.name: t for t in await backend.list_targets()}
    if target not in by_name:
        return _errored(
            target, session_id,
            f"unknown target {target!r}; configured targets: {sorted(by_name)}",
        )
    if not (message or "").strip():
        return _errored(target, session_id, "message is required")

    default_timeout = float(getattr(backend, "default_timeout", 900.0))
    if timeout_secs is None:
        timeout = default_timeout
    else:
        timeout = max(1.0, min(float(timeout_secs), default_timeout))

    # Own the session id so the caller is ALWAYS told how to resume — even if
    # the reply times out. A long job keeps running on the target and its
    # result persists to the (first-class) session, so re-calling ask_agent
    # with this session_id fetches the result once it's ready. The target
    # namespaces the id deterministically, so resuming with it hits the same
    # conversation whether or not we received the reply.
    created = session_id is None
    sid = session_id or uuid.uuid4().hex

    try:
        data = await backend.dial(by_name[target], message, sid, timeout)
    except asyncio.TimeoutError:
        return {
            "target": target, "session_id": sid, "response": "", "model": "",
            "errored": True, "created": created,
            "error": (
                f"no reply within {timeout:.0f}s — the job may still be running "
                f"on {target!r}. Call ask_agent again with session_id='{sid}' "
                "to fetch the result once it's ready (don't restart the task)."
            ),
        }
    except Exception as e:  # transport / dial failure — surface, don't crash the tool
        return _errored(target, sid, redact(f"{type(e).__name__}: {e}"))

    # Target says a turn is still running (a long job, or a resume while the
    # previous turn is in flight) — surface as PENDING, not an error, with how
    # to fetch the result. Do NOT restart the task.
    if data.get("still_running"):
        rsid = data.get("session_id") or sid
        return {
            "target": target, "session_id": rsid, "response": "", "model": "",
            "errored": False, "pending": True, "created": created,
            "error": (
                f"still working — no result yet. Call ask_agent again with "
                f"session_id='{rsid}' shortly to fetch it (don't restart the task)."
            ),
        }

    return {
        "target": target,
        "session_id": data.get("session_id") or sid,
        "response": data.get("response", ""),
        "model": data.get("model", ""),
        "errored": bool(data.get("errored", False)),
        "error": data.get("error"),
        "created": created,
        "pending": False,
    }


def _errored(target: str, session_id: str | None, msg: str) -> dict:
    return {
        "target": target,
        "session_id": session_id,
        "response": "",
        "model": "",
        "errored": True,
        "error": msg,
        "created": False,
    }
