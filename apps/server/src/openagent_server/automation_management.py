"""One authorized definition-management path for standalone REST and MCP."""

from __future__ import annotations
import time
from uuid import uuid4
from contextlib import nullcontext
from openagent_core.automation import AutomationRepository, durable_module_references
from openagent_core.contracts import ResourceRef, require_authorized
from openagent_core.core.logging import elog
from openagent_core.runtime import current_execution_context, execution_scope
from openagent_server.automation_authority import definition_digest

_MUTATIONS = {
    "scheduled_task": frozenset(
        {
            "create_scheduled_task",
            "create_one_shot_task",
            "update_scheduled_task",
            "delete_scheduled_task",
        }
    ),
    "event": frozenset(
        {
            "create_event",
            "update_event",
            "enable_event",
            "disable_event",
            "rotate_event_secret",
            "delete_event",
            "guarded_update_event",
        }
    ),
    "workflow": frozenset(
        {
            "create_workflow",
            "update_workflow",
            "delete_workflow",
            "add_block",
            "update_block",
            "remove_block",
            "connect_blocks",
            "disconnect_blocks",
        }
    ),
}
_KIND = {"scheduled_task": "task", "event": "event", "workflow": "workflow"}
_TABLE = {
    "scheduled_task": "scheduled_tasks",
    "event": "events",
    "workflow": "workflow_tasks",
}


class AutomationRevisionChanged(ValueError):
    """The reviewed digest no longer names the current persisted revision."""


class NativeAutomationManagement:
    def __init__(self, service):
        self.service = service
        self.repository = AutomationRepository(service.agent.memory_db.db_path)

    async def references_for_removed_modules(self, removed_modules, **_profiles):
        return await durable_module_references(self.repository, removed_modules)

    @staticmethod
    async def _definitions(connection, kind):
        cursor = await connection.execute(f"SELECT * FROM {_TABLE[kind]}")
        return {row["id"]: dict(row) for row in await cursor.fetchall()}

    async def mutate(self, kind, operation, context):
        if kind not in _KIND:
            raise ValueError("Unknown automation kind")
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind),
        )
        if (
            current_execution_context() is not None
            and current_execution_context() != context
        ):
            raise PermissionError("Management cannot replace an active turn identity")
        scope = (
            nullcontext()
            if current_execution_context() is not None
            else execution_scope(
                self.service.runtime, context, "management-" + str(uuid4())
            )
        )
        with scope:
            async with self.repository.transaction() as connection:
                before = await self._definitions(connection, kind)
                result = await operation(self.repository.definition_store(connection))
                await self._capture_changes(connection, kind, before, context)
                return result

    async def _capture_changes(self, connection, kind, before, context):
        after = await self._definitions(connection, kind)
        for identifier in before.keys() - after.keys():
            await self.service.automations.revoke(
                _KIND[kind], identifier, context, connection=connection
            )
        for identifier, definition in after.items():
            old = before.get(identifier)
            if (
                old is None
                or definition_digest(_KIND[kind], old)
                != definition_digest(_KIND[kind], definition)
                or old.get("enabled") != definition.get("enabled")
            ):
                await self.service.automations.capture(
                    _KIND[kind], definition, context, connection=connection
                )

    async def call(self, kind, name, arguments, context):
        if kind not in _KIND:
            raise ValueError("Unknown automation kind")
        mutation = name in _MUTATIONS[kind]
        execution = {
            "run_scheduled_task_now": ("get_scheduled_task", "task_id"),
            "run_workflow": ("get_workflow", "id_or_name"),
            "trigger_event": ("get_event", "id_or_slug"),
            "trigger_events": ("get_event", "id_or_slug"),
        }.get(name)
        delegated_execution = bool(
            execution is not None and context.deferred and context.delegation_id
        )
        if delegated_execution:
            # A durable automation does not inherit the owner's broad
            # automation.read permission. It may still compose with another
            # exact, separately approved automation. Validate both grants and
            # their principal boundary below instead of opening the whole
            # management catalog to the unattended run.
            if not await self.service.automations.validate(context):
                raise PermissionError("Automation delegation is revoked")
        else:
            await require_authorized(
                self.service.authorizer,
                context,
                "automation.manage" if mutation else "automation.read",
                ResourceRef("automation", context.tenant_id, kind),
            )
        if (
            current_execution_context() is not None
            and current_execution_context() != context
        ):
            raise PermissionError("Management cannot replace an active turn identity")
        scope = (
            nullcontext()
            if current_execution_context() is not None
            else execution_scope(
                self.service.runtime, context, "management-" + str(uuid4())
            )
        )
        with scope:
            if not mutation:
                if execution is not None:
                    getter, key = execution
                    row = await self.repository.call(
                        kind, getter, {key: arguments[key]}, context, atomic=False
                    )
                    definition = await self.service.automations.definition(
                        _KIND[kind], row["id"]
                    )
                    admitted = await self.service.automations.resolve(
                        _KIND[kind], definition, "manual-admission", context.session_id
                    )
                    if delegated_execution and (
                        admitted.authority != context.authority
                        or admitted.initiator != context.initiator
                        or admitted.audience != context.audience
                    ):
                        raise PermissionError(
                            "Automation target belongs to another principal boundary"
                        )
                # Original enqueue/stop functions commit before waiting for a
                # scheduler writer. They must not hold a write transaction
                # while waiting for that same writer to acknowledge the work.
                return await self.repository.call(
                    kind, name, dict(arguments), context, atomic=False
                )
            async with self.repository.transaction() as connection:
                before = await self._definitions(connection, kind)
                result = await self.repository.call(
                    kind, name, dict(arguments), context
                )
                await self._capture_changes(connection, kind, before, context)
                return result

    async def review_authorization(self, kind, identifier, context):
        """Return one exact reviewable revision without granting it."""
        if kind not in _KIND:
            raise ValueError("Unknown automation kind")
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind),
        )
        definition = await self.service.automations.definition(
            _KIND[kind], identifier,
        )
        # Webhook credentials authenticate callers; they are never part of the
        # review payload or the behavioral digest.
        visible = {
            key: value
            for key, value in definition.items()
            if key not in {"secret_enc", "secret_hint"}
        }
        return {
            "definition": visible,
            "digest": definition_digest(_KIND[kind], definition),
            "authorized": await self.service.automation_execution.definition_authorized(
                _KIND[kind], definition,
            ),
        }

    @staticmethod
    async def _reconcile_schedule_cursor(connection, kind, definition):
        """Project stale recurring cursors forward when a revision is approved.

        A historical definition can have been paused for weeks. Granting it
        must not launch every installation's entire backlog at once. Recurring
        schedules resume at their next future slot; explicit one-shot entries
        remain due because their single requested occurrence is intentional.
        Queued task/workflow requests and event deliveries are untouched: they
        already have durable occurrence IDs and can safely resume exactly once.
        """
        from openagent_core.memory.schedule import (
            is_one_shot_expression,
            next_run_for_expression,
        )

        now = time.time()
        reconciled = 0
        if kind == "scheduled_task":
            expression = definition.get("cron_expression") or ""
            if (
                definition.get("enabled", True)
                and expression
                and not is_one_shot_expression(expression)
                and (
                    definition.get("next_run") is None
                    or float(definition["next_run"]) <= now
                )
            ):
                await connection.execute(
                    "UPDATE scheduled_tasks SET next_run=?,updated_at=? WHERE id=?",
                    (
                        next_run_for_expression(
                            expression, now, definition.get("timezone") or None,
                        ),
                        now,
                        definition["id"],
                    ),
                )
                reconciled = 1
        elif kind == "workflow":
            cursor = await connection.execute(
                "SELECT id,cron_expression,next_run_at,timezone "
                "FROM workflow_schedules WHERE workflow_id=? AND enabled=1",
                (definition["id"],),
            )
            for schedule in await cursor.fetchall():
                expression = schedule["cron_expression"] or ""
                if (
                    expression
                    and not is_one_shot_expression(expression)
                    and (
                        schedule["next_run_at"] is None
                        or float(schedule["next_run_at"]) <= now
                    )
                ):
                    await connection.execute(
                        "UPDATE workflow_schedules SET next_run_at=?,updated_at=? "
                        "WHERE id=?",
                        (
                            next_run_for_expression(
                                expression, now, schedule["timezone"] or None,
                            ),
                            now,
                            schedule["id"],
                        ),
                    )
                    reconciled += 1
        return reconciled

    async def approve_authorization(self, kind, identifier, digest, context):
        """Grant only the enabled definition revision named by ``digest``."""
        if kind not in _KIND:
            raise ValueError("Unknown automation kind")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError("Supply the exact digest returned by revision review")
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind),
        )
        if (
            current_execution_context() is not None
            and current_execution_context() != context
        ):
            raise PermissionError("Management cannot replace an active turn identity")
        scope = (
            nullcontext()
            if current_execution_context() is not None
            else execution_scope(
                self.service.runtime, context, "management-" + str(uuid4())
            )
        )
        with scope:
            async with self.repository.transaction() as connection:
                definition = await self.service.automations.definition(
                    _KIND[kind], identifier, connection=connection,
                )
                current_digest = definition_digest(_KIND[kind], definition)
                if current_digest != digest:
                    raise AutomationRevisionChanged(
                        "Automation changed since review"
                    )
                if not definition.get("enabled", True):
                    raise ValueError(
                        "Enable the definition before approving scheduled execution"
                    )
                grant = await self.service.automations.capture(
                    _KIND[kind], definition, context, connection=connection,
                )
                reconciled = await self._reconcile_schedule_cursor(
                    connection, kind, definition,
                )
        elog(
            "automation.authorization_granted",
            kind=kind,
            definition_id=identifier,
            schedules_reconciled=reconciled,
        )
        gateway = self.service.gateway
        broadcaster = getattr(gateway, "broadcast_resource", None)
        if callable(broadcaster):
            resource = {
                "scheduled_task": "scheduled_task",
                "workflow": "workflow",
                "event": "event",
            }[kind]
            await broadcaster(resource, "updated", identifier)
        return {
            "delegation_id": grant,
            "digest": digest,
            "authorized": True,
            "schedules_reconciled": reconciled,
        }

    async def capture_current_authorizations(self, kind, identifiers, context):
        """Capture revisions produced by one explicit authenticated action.

        Product-owned built-ins are written by config synchronizers rather
        than the public automation CRUD tools. A user PATCHing that config is
        still an explicit management action, so capture the resulting exact
        revisions under the same verified principal. Startup synchronization
        never calls this method and therefore cannot adopt historical rows.
        """
        if kind not in _KIND:
            raise ValueError("Unknown automation kind")
        await require_authorized(
            self.service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind),
        )
        if (
            current_execution_context() is not None
            and current_execution_context() != context
        ):
            raise PermissionError("Management cannot replace an active turn identity")
        scope = (
            nullcontext()
            if current_execution_context() is not None
            else execution_scope(
                self.service.runtime, context, "management-" + str(uuid4())
            )
        )
        results = []
        with scope:
            async with self.repository.transaction() as connection:
                for identifier in dict.fromkeys(identifiers):
                    definition = await self.service.automations.definition(
                        _KIND[kind], identifier, connection=connection,
                    )
                    grant = await self.service.automations.capture(
                        _KIND[kind], definition, context, connection=connection,
                    )
                    reconciled = await self._reconcile_schedule_cursor(
                        connection, kind, definition,
                    )
                    results.append({
                        "id": identifier,
                        "authorized": grant is not None,
                        "schedules_reconciled": reconciled,
                    })
        return results


async def mutate_request(request, kind, operation):
    from aiohttp import web
    import sqlite3

    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Automation management is not ready")
    try:
        context = await service.context(request, "__automation_management__")
        return await service.automation_management.mutate(kind, operation, context)
    except PermissionError:
        raise web.HTTPForbidden(text="Automation revision is not authorized") from None
    except sqlite3.IntegrityError:
        raise web.HTTPConflict(
            text="An automation with this identifier already exists"
        ) from None
    except LookupError:
        raise web.HTTPNotFound(text="Automation not found") from None
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error)) from None


async def authorized_definition_ids(request, kind):
    """Return authorized IDs for a REST projection, or ``None`` while offline.

    Read-only/local inspection modes intentionally expose durable definitions
    without starting the runtime. In that case callers omit the status rather
    than claiming either approval or denial. A live runtime always projects an
    explicit answer.
    """
    service = getattr(request.app["gateway"], "runtime_service", None)
    execution = getattr(service, "automation_execution", None)
    if execution is None:
        return None
    return set(await execution.authorized_definition_ids(_KIND[kind]))


async def handle_authorize(request):
    """Approve exactly the reviewed historical definition, without rewriting it."""
    from aiohttp import web

    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Automation management is not ready")
    kind = request.match_info["kind"]
    if kind not in _KIND:
        raise web.HTTPNotFound()
    try:
        body = await request.json()
        if (
            not isinstance(body, dict)
            or set(body) != {"digest"}
            or not isinstance(body["digest"], str)
        ):
            raise ValueError("Supply the exact digest of the reviewed definition")
        context = await service.context(request, "__automation_management__")
        result = await service.automation_management.approve_authorization(
            kind, request.match_info["id"], body["digest"], context,
        )
        return web.json_response(result)
    except AutomationRevisionChanged as error:
        raise web.HTTPConflict(text=str(error)) from None
    except PermissionError:
        raise web.HTTPForbidden(text="Automation revision is not authorized") from None
    except LookupError:
        raise web.HTTPNotFound() from None
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error)) from None


async def handle_authorization(request):
    """Expose the exact reviewable revision; authentication is enforced first."""
    from aiohttp import web

    service = getattr(request.app["gateway"], "runtime_service", None)
    if service is None:
        raise web.HTTPServiceUnavailable(text="Automation management is not ready")
    kind = request.match_info["kind"]
    if kind not in _KIND:
        raise web.HTTPNotFound()
    try:
        context = await service.context(request, "__automation_management__")
        return web.json_response(
            await service.automation_management.review_authorization(
                kind, request.match_info["id"], context,
            )
        )
    except PermissionError:
        raise web.HTTPForbidden() from None
    except LookupError:
        raise web.HTTPNotFound() from None
