"""Product-owned callbacks preserving existing configured support profiles."""
from __future__ import annotations
from openagent_core.extensions import EngineExtensions


async def handle_event(*, agent, event, payload, session_id, delivery_id):
    from . import local_support_controller
    if not local_support_controller.enabled(event):
        return None
    return await local_support_controller.run(agent=agent, event=event, payload=payload,
        session_id=session_id, delivery_id=delivery_id)


async def handle_scheduled(*, agent, task, prompt, session_id, dry_run):
    if "[[quality-digest]]" not in prompt and "[[quality-scorer]]" not in prompt:
        return None
    from . import local_quality_scorer
    from openagent_core.core.dry_run import dry_run_scope
    from openagent_core.core.logging import elog
    pool = agent.capability_pool
    if pool is None:
        raise RuntimeError("A support quality operation requires its registered capabilities")
    task_name = task.get("name", "")
    product = "lyra" if "lyra" in task_name.lower() else "esound"
    if "[[quality-digest]]" in prompt:
        result = await local_quality_scorer.digest(pool, product=product)
        elog("task.quality_digest", name=task_name, systemic=len(result.get("systemic") or []))
        return result
    with dry_run_scope(dry_run):
        result = await local_quality_scorer.run(agent, {"model": task.get("model") or ""}, pool,
            f"scheduler:{task['id']}", product=product)
    elog("task.quality_scored", name=task_name, scored=result.get("scored"), bad=result.get("bad"))
    return result


def support_extensions(*, content_validator=None):
    from .support_delivery_receipts import retain_event_output
    from .execution_profile import select_profile
    return EngineExtensions(event_handler=handle_event, scheduled_handler=handle_scheduled,
        output_retainer=retain_event_output, content_validator=content_validator,
        execution_profile_selector=select_profile)
