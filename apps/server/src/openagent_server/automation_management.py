"""One authorized definition-management path for standalone REST and MCP."""

from __future__ import annotations
from uuid import uuid4
from contextlib import nullcontext
from openagent_core.automation import AutomationRepository, durable_module_references
from openagent_core.contracts import ResourceRef, require_authorized
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
                execution = {
                    "run_scheduled_task_now": ("get_scheduled_task", "task_id"),
                    "run_workflow": ("get_workflow", "id_or_name"),
                    "trigger_event": ("get_event", "id_or_slug"),
                    "trigger_events": ("get_event", "id_or_slug"),
                }.get(name)
                if execution is not None:
                    getter, key = execution
                    row = await self.repository.call(
                        kind, getter, {key: arguments[key]}, context, atomic=False
                    )
                    definition = await self.service.automations.definition(
                        _KIND[kind], row["id"]
                    )
                    await self.service.automations.resolve(
                        _KIND[kind], definition, "manual-admission", context.session_id
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
        with execution_scope(service.runtime, context, "management-" + str(uuid4())):
            async with (
                service.automation_management.repository.transaction() as connection
            ):
                definition = await service.automations.definition(
                    _KIND[kind], request.match_info["id"], connection=connection
                )
                if definition_digest(_KIND[kind], definition) != body["digest"]:
                    raise web.HTTPConflict(text="Automation changed since review")
                if not definition.get("enabled", True):
                    raise ValueError(
                        "Enable the definition before approving scheduled execution"
                    )
                grant = await service.automations.capture(
                    _KIND[kind], definition, context, connection=connection
                )
        return web.json_response({"delegation_id": grant, "digest": body["digest"]})
    except PermissionError:
        raise web.HTTPForbidden(text="Automation revision is not authorized") from None
    except LookupError:
        raise web.HTTPNotFound() from None
    except ValueError as error:
        raise web.HTTPBadRequest(text=str(error)) from None


async def handle_authorization(request):
    """Expose the exact reviewable revision; authentication is enforced first."""
    from aiohttp import web

    service = request.app["gateway"].runtime_service
    kind = request.match_info["kind"]
    if kind not in _KIND:
        raise web.HTTPNotFound()
    try:
        context = await service.context(request, "__automation_management__")
        await require_authorized(
            service.authorizer,
            context,
            "automation.manage",
            ResourceRef("automation", context.tenant_id, kind),
        )
        definition = await service.automations.definition(
            _KIND[kind], request.match_info["id"]
        )
        # Webhook secrets are neither the reviewed program nor publication data.
        visible = {
            key: value
            for key, value in definition.items()
            if key not in {"secret_enc", "secret_hint"}
        }
        return web.json_response(
            {
                "definition": visible,
                "digest": definition_digest(_KIND[kind], definition),
                "authorized": await service.automation_execution.definition_authorized(
                    _KIND[kind], definition
                ),
            }
        )
    except PermissionError:
        raise web.HTTPForbidden() from None
    except LookupError:
        raise web.HTTPNotFound() from None
