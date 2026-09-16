"""Native scheduler/events adapter over the same durable Runtime admission."""

from __future__ import annotations
import asyncio
from dataclasses import replace
from uuid import NAMESPACE_URL, uuid4, uuid5
from openagent_core.contracts import RunRequest, canonical_json
from openagent_core.runtime import current_run_id
from openagent_server.automation_authority import definition_digest


class _Operation:
    def __init__(self, operation):
        self.operation = operation

    async def execute(self, request, context, runtime):
        return await self.operation()


class NativeAutomationExecution:
    def __init__(self, service):
        self.service = service
        self.task_hooks = {}

    def register_task_hook(self, name, hook):
        if hook is None:
            self.task_hooks.pop(name, None)
        else:
            self.task_hooks[name] = hook

    async def definition_authorized(self, kind, definition):
        try:
            current = await self.service.automations.definition(kind, definition["id"])
            await self.service.automations.resolve(
                kind, current, "authorization-check", "authorization-check"
            )
            return True
        except (LookupError, PermissionError):
            return False

    async def authorized_definition_ids(self, kind):
        db = self.service.agent.memory_db
        method = {
            "task": db.get_tasks,
            "event": db.list_events,
            "workflow": db.list_workflows,
        }[kind]
        rows = await method()
        authorized = []
        for row in rows:
            if await self.definition_authorized(kind, row):
                authorized.append(row["id"])
        return tuple(authorized)

    async def _execute(self, kind, definition, occurrence, operation, payload=None):
        canonical = await self.service.automations.definition(kind, definition["id"])
        identifier = str(
            uuid5(NAMESPACE_URL, f"openagent:{kind}:{definition['id']}:{occurrence}")
        )
        session_id = f"automation:{kind}:{definition['id']}:{occurrence}"
        context = await self.service.automations.resolve(
            kind, canonical, str(occurrence), session_id
        )
        parent = current_run_id()
        if parent:
            context = replace(context, parent_run_id=parent)
        # Deadline remains explicit and separate from delivery/accept timeouts.
        timeout = float(
            (self.service.agent.config.get("automation") or {}).get(
                "deadline_seconds", 960
            )
        )
        request = RunRequest(
            identifier,
            session_id,
            identifier,
            canonical_json(
                {
                    "kind": kind,
                    "definition_id": definition["id"],
                    "digest": definition_digest(kind, canonical),
                    "occurrence_id": str(occurrence),
                    "payload": payload,
                }
            ),
            deadline_seconds=timeout,
        )
        await self.service.runtime.execute_operation(
            request, context, _Operation(operation)
        )
        record = await self.service.runtime.wait(identifier, context)
        if record.status != "success":
            raise RuntimeError(f"Automation run ended with status {record.status}")
        return record.output

    async def run_task(self, scheduler, task, *, trigger, request_id, payload, execute):
        occurrence = (
            task.get("_preclaimed_run_id")
            or request_id
            or current_run_id()
            or str(uuid4())
        )
        run_id = str(
            task.get("_preclaimed_run_id")
            or uuid5(NAMESPACE_URL, f"task:{task['id']}:{occurrence}")
        )
        selected = {**task, "_runtime_run_id": run_id}

        async def operation():
            async def base(value):
                return await execute(
                    value, trigger=trigger, request_id=request_id, context=payload
                )

            chain = base
            for hook in reversed(tuple(self.task_hooks.values())):
                next_call = chain

                async def wrapped(value, hook=hook, next_call=next_call):
                    return await hook(value, next_call)

                chain = wrapped
            result = await chain(selected)
            projection = await scheduler.db.get_task_run(run_id)
            if projection and projection.get("status") not in {
                "success",
                "completed",
                "skipped",
            }:
                raise RuntimeError("Scheduled task did not complete successfully")
            return result

        return await self._execute("task", task, occurrence, operation, payload)

    async def run_workflow(
        self,
        scheduler,
        wf,
        *,
        trigger,
        inputs,
        request_id,
        entry_node_id,
        run_id,
        execute,
    ):
        occurrence = run_id or request_id or current_run_id() or str(uuid4())
        identifier = run_id or str(
            uuid5(NAMESPACE_URL, f"workflow:{wf['id']}:{occurrence}")
        )

        async def operation():
            await execute(
                wf,
                trigger=trigger,
                inputs=inputs,
                request_id=request_id,
                entry_node_id=entry_node_id,
                run_id=identifier,
            )
            projection = await scheduler.db.get_workflow_run(identifier)
            if projection and projection.get("status") not in {
                "success",
                "completed",
                "skipped",
            }:
                raise RuntimeError("Workflow did not complete successfully")
            return projection

        return await self._execute(
            "workflow",
            wf,
            occurrence,
            operation,
            {"inputs": inputs, "entry_node_id": entry_node_id},
        )

    async def run_event(
        self,
        *,
        agent,
        db,
        scheduler,
        event,
        payload,
        delivery_id,
        source,
        broadcast,
        execute,
    ):
        async def operation():
            result = await execute(
                agent=agent,
                db=db,
                scheduler=scheduler,
                event=event,
                payload=payload,
                delivery_id=delivery_id,
                source=source,
                broadcast=broadcast,
            )
            if result and result.get("status") not in {
                "success",
                "completed",
                "skipped",
            }:
                raise RuntimeError("Event action did not complete successfully")
            return result

        return await self._execute("event", event, delivery_id, operation, payload)
