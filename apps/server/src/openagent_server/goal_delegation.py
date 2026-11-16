"""Durable delegation for a conversation goal.

A goal is a person's standing instruction to keep working in one conversation.
While a turn runs, the goal continues inside that turn. After a runtime
restart the turn is gone, and starting a new one is deferred work: it needs a
durable delegation, like a loop. The delegation is captured when the agent's
owner sets, edits or resumes the goal, covers that session and that exact
objective, and applies only while the goal is active. Anyone else's goal has
none and pauses with the reason after a restart.
"""
from __future__ import annotations

from openagent_core.core.logging import elog


async def sync(service, session_id: str, context) -> str | None:
    """Capture or withdraw the goal's delegation after a person changed it.

    Returns the new grant id, or ``None`` when the goal has no delegation
    (not active, removed, or ``context`` may not grant one). Never raises.
    """
    automations = service.automations
    try:
        try:
            definition = await automations.definition("goal", session_id)
        except LookupError:
            await automations.revoke("goal", session_id, context)
            return None
        return await automations.capture("goal", definition, context)
    except (PermissionError, ValueError):
        return None
    except Exception as exc:  # noqa: BLE001 - the goal change already succeeded
        elog("goal.delegation_sync_failed", level="warning", session_id=session_id,
             error_type=type(exc).__name__)
        return None


async def context_for(service, session_id: str):
    """The deferred execution context of an active goal's delegation, or ``None``."""
    automations = service.automations
    try:
        definition = await automations.definition("goal", session_id)
        if not definition.get("enabled"):
            return None
        return await automations.resolve("goal", definition, "goal-restart", session_id)
    except (LookupError, PermissionError, ValueError):
        return None


async def _announce_turn_end(service, session_id: str, reason: str) -> None:
    """Make clients that have the conversation open reload it (best effort)."""
    try:
        from openagent_core.runtime import runtime_scope
        from openagent_core.stream.child_stream import broadcast_child_emitter

        with runtime_scope(service.runtime):
            emitter = broadcast_child_emitter()
        if emitter is not None:
            await emitter({"kind": "turn_complete", "session_id": session_id, "reason": reason})
    except Exception as exc:  # noqa: BLE001 - a notification must never fail recovery
        elog("goal.restart_notify_failed", level="warning", session_id=session_id,
             error_type=type(exc).__name__)


async def resume_interrupted(service) -> list[dict]:
    """Restart work on goals the previous runtime stop interrupted. Never raises."""
    import asyncio

    from openagent_core.session_goal import resume_after_restart

    async def authority(session_id):
        return await context_for(service, session_id)

    watchers = set()

    async def watch(request, context):
        try:
            record = await service.runtime.wait(request.run_id, context)
            reason = "completed" if record.status == "success" else (
                "cancelled" if record.status == "cancelled" else "error")
        except Exception:  # noqa: BLE001
            reason = "error"
        await _announce_turn_end(service, request.session_id, reason)

    async def submit(request, context):
        await service.runtime.submit(request, context)
        task = asyncio.create_task(watch(request, context))
        watchers.add(task)
        task.add_done_callback(watchers.discard)

    results = await resume_after_restart(service.agent.memory_db, authority=authority, submit=submit)
    for result in results:
        elog("goal.restart_recovery", level="warning" if result.get("action") == "failed" else "info",
             **result)
        if result.get("action") == "paused":
            # The goal panel must show the pause and its reason.
            gateway = getattr(service, "gateway", None)
            if gateway is not None and hasattr(gateway, "broadcast_resource"):
                try:
                    await gateway.broadcast_resource("session", "updated", result["session_id"])
                except Exception:  # noqa: BLE001
                    pass
    service._goal_recovery_watchers = watchers
    return results
