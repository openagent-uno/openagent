"""Standalone page visibility, separate from capability and execution grants."""

import aiosqlite
from openagent_identity.coordinator.store import CoordinatorStore


AUTOMATION_COLLECTIONS = frozenset({"/api/scheduled-tasks", "/api/workflows", "/api/events"})
MEMBER_OVERVIEW = "management_member_overview"


def member_overview(key, rows):
    # Legacy clients still see the expected collection shape. Never send
    # a definition, connection configuration, or execution result to a member.
    return {key: [], "summaries": [
        {"id": row.get("id", row["name"]), "name": row["name"], "enabled": bool(row["enabled"])}
        for row in rows
    ]}


class ManagementAccess:
    def __init__(self, runtime):
        self.runtime = runtime
        self.db_path = runtime.agent.memory_db.db_path

    async def start(self):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""CREATE TABLE IF NOT EXISTS standalone_management_access (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                visibility TEXT NOT NULL CHECK (visibility IN ('members', 'owner'))
            )""")
            await db.commit()

    async def verified_member(self, context):
        principal = context.initiator
        if (principal.kind != "user" or context.author != principal
                or context.authority != principal or context.audience != (principal,)
                or context.deferred or context.delegation_id or context.parent_run_id):
            return False
        binding = await self.runtime.authorizer._binding(context)
        return bool(binding and binding.identity.auth_kind == "device_cert"
                    and await self.runtime.directory.principal_active(principal))

    async def visibility(self):
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute("SELECT visibility FROM standalone_management_access WHERE singleton=1") as cursor:
                row = await cursor.fetchone()
        return row[0] if row else "members"

    async def can_browse(self, context):
        return await self.verified_member(context) and await self.visibility() == "members"

    async def settings(self, context):
        if not await self.verified_member(context):
            raise PermissionError("A verified network member is required")
        owner = await self.runtime.directory.owner_handle()
        store = CoordinatorStore(self.runtime.agent.memory_db)
        network = await store.get_network_role()
        can_manage = bool(owner and owner != "system" and owner == context.initiator.subject_id)
        return {
            "owner_handle": owner if owner != "system" else None,
            "visibility": await self.visibility(),
            "can_manage": can_manage,
            "can_transfer": bool(can_manage and network and network["role"] == "coordinator"),
        }

    async def update(self, context, visibility):
        if not isinstance(visibility, str) or visibility not in {"members", "owner"}:
            raise ValueError("Visibility must be 'members' or 'owner'")
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("BEGIN IMMEDIATE")
            if not (await self.settings(context))["can_manage"]:
                raise PermissionError("Only the primary owner can change page visibility")
            await db.execute("""INSERT INTO standalone_management_access VALUES (1, ?)
                ON CONFLICT(singleton) DO UPDATE SET visibility=excluded.visibility""", (visibility,))
            await db.commit()
        return await self.settings(context)

    async def transfer(self, context, new_owner, agent_handle=None):
        if not await self.verified_member(context):
            raise PermissionError("A verified network member is required")
        store = CoordinatorStore(self.runtime.agent.memory_db)
        network = await store.get_network_role()
        if not network or network["role"] != "coordinator":
            raise PermissionError("Transfer ownership on the network coordinator")
        node_id = network["coordinator_node_id"]
        if agent_handle is not None:
            node_id = next((row.node_id for row in await store.list_agents() if row.handle == agent_handle), None)
            if node_id is None:
                raise LookupError("Agent is not registered on this network")
        await self.transfer_registered_agent(context, store, node_id, new_owner)
        return await self.settings(context) if agent_handle is None else {"updated": True}

    async def transfer_registered_agent(self, context, store, node_id, new_owner):
        if not await self.verified_member(context):
            raise PermissionError("A verified network member is required")
        if not isinstance(new_owner, str):
            raise ValueError("An active network user's handle is required")
        new_owner = new_owner.strip().lower().removeprefix("@")
        target = await store.get_user(new_owner)
        if new_owner == "system" or target is None or target.status != "active":
            raise ValueError("An active network user's handle is required")
        if not await store.transfer_agent_owner(node_id, new_owner, current_owner=context.initiator.subject_id):
            raise PermissionError("Only the current owner can transfer ownership")
