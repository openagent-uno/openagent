"""Native memory reads require current source ACLs for every output recipient."""

from __future__ import annotations
import aiosqlite
from openagent_core.contracts import ResourceRef
from openagent_identity.runtime_access import AccessContext
from openagent_core.memory.operational.access import resource_is_visible
from openagent_core.memory_access import CanonicalHistorySearch

_AUTOMATION_TABLES = {
    "workflow_definition": "workflow_tasks",
    "workflow_run": "workflow_runs",
    "scheduled_definition": "scheduled_tasks",
    "scheduled_run": "task_runs",
    "event_definition": "events",
    "event_delivery": "event_deliveries",
}


class NativeMemoryAccess:
    def __init__(self, service):
        self.service = service
        self.db = service.agent.memory_db

    async def access(self, principal, context=None):
        if principal.authority != "openagent" or principal.kind not in {
            "user",
            "agent",
        }:
            raise PermissionError("Unsupported native memory principal")
        typed = f"{principal.kind}:{principal.subject_id}"
        identities = {
            (principal.kind, principal.subject_id),
            (principal.kind, typed),
            ("installation", principal.tenant_id),
        }
        ids = {typed, principal.key}
        snapshot = await self.service.directory.snapshot(principal.tenant_id)
        if (
            principal.subject_id
            not in snapshot["users" if principal.kind == "user" else "agents"]
        ):
            raise PermissionError("Memory principal is no longer active")
        if principal.kind == "user":
            for device in snapshot["devices"]:
                if device["handle"] == principal.subject_id:
                    ids.add("device:" + device["device_id"])
                    identities.update(
                        {
                            ("device", device["device_id"]),
                            ("device", "device:" + device["device_id"]),
                        }
                    )
        return AccessContext(
            principal.tenant_id,
            typed,
            principal.kind,
            principal.subject_id,
            "",
            frozenset(ids),
            frozenset(identities),
        )

    async def search_history(
        self, context, *, query, scopes, limit=5, offset=0, session_id=None
    ):
        await self.service.runtime.authorize(
            context,
            "memory.search",
            ResourceRef("memory-catalog", context.tenant_id, "history"),
            audience=(context.initiator,),
        )
        return await CanonicalHistorySearch(self.db, self.access).search_history(
            context,
            query=query,
            scopes=scopes,
            limit=limit,
            offset=offset,
            session_id=session_id,
        )

    async def authorize(self, context, action, resource, *, audience=()):
        if resource.tenant_id != context.tenant_id:
            return False
        recipients = (
            tuple(audience) if action == "memory.publish" else (context.initiator,)
        )
        if not recipients or (
            action == "memory.publish" and set(recipients) != set(context.audience)
        ):
            return False
        try:
            accesses = [await self.access(principal) for principal in recipients]
        except (PermissionError, ValueError):
            return False
        if action == "memory.search":
            return resource.kind == "memory-catalog"
        if action not in {"memory.read", "memory.publish"}:
            return False
        if resource.kind in {"vault-note", "skill"}:
            # The standalone vault/skills have an explicit per-agent owner.
            # Hosts can opt these shared stores into installation publication.
            domain = "vault" if resource.kind == "vault-note" else "skills"
            shared = (
                self.service.agent.config.get("runtime_tool_audiences") or {}
            ).get(domain) == "installation"
            if shared:
                return True
            owner = await self.service.directory.owner_handle()
            return bool(
                owner
                and all(p.kind == "user" and p.subject_id == owner for p in recipients)
            )
        async with aiosqlite.connect(self.db.db_path) as connection:
            connection.row_factory = aiosqlite.Row
            if resource.kind == "session":
                row = await self.service.authorizer._session(
                    connection, resource.resource_id
                )
            elif resource.kind in _AUTOMATION_TABLES:
                table = _AUTOMATION_TABLES[resource.kind]
                row = await (
                    await connection.execute(
                        f"SELECT o.* FROM operational_resource_owners o JOIN {table} d ON d.id=o.resource_id "
                        "WHERE o.tenant_id=? AND o.resource_type=? AND o.resource_id=?",
                        (resource.tenant_id, resource.kind, resource.resource_id),
                    )
                ).fetchone()
            elif resource.kind == "ui_view":
                row = await (
                    await connection.execute(
                        "SELECT id AS resource_id,'ui_view' AS resource_type,tenant_id,owner_principal_id,visibility,acl_version "
                        "FROM ui_views WHERE id=? AND tenant_id=? AND deleted_at_ms IS NULL AND status!='deleted'",
                        (resource.resource_id, resource.tenant_id),
                    )
                ).fetchone()
            else:
                return False
            if row is None:
                return False
            for access in accesses:
                if not await resource_is_visible(
                    connection, row, access, permission="view"
                ):
                    return False
            return True
