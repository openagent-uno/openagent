"""Native recipient and principal resolution from the authoritative network."""

from __future__ import annotations
import aiosqlite
from openagent_core.contracts import PrincipalRef
from openagent_identity.coordinator.store import CoordinatorStore


class NativeRuntimeDirectory:
    def __init__(self, gateway, agent):
        self.gateway, self.agent = gateway, agent

    async def snapshot(self, tenant):
        store = CoordinatorStore(self.agent.memory_db)
        network = await store.get_network_role()
        if not network or network["network_id"] != tenant:
            raise PermissionError("Principal belongs to another network")
        if network["role"] == "coordinator":
            return await store.runtime_directory()
        if network["role"] == "member":
            from openagent_identity.client.login import read_runtime_directory

            state = self.gateway._network_state
            return await read_runtime_directory(
                node=state.iroh_node, coordinator_node_id=network["coordinator_node_id"]
            )
        raise PermissionError("No authoritative network directory is configured")

    async def owner_handle(self):
        state = getattr(self.gateway, "_network_state", None)
        if state is None:
            return None
        store = CoordinatorStore(self.agent.memory_db)
        network = await store.get_network_role()
        if network is None:
            return None
        if network["role"] == "coordinator":
            agents = await store.list_agents()
            return next(
                (
                    row.owner_handle
                    for row in agents
                    if row.node_id == state.identity.public_hex
                ),
                None,
            )
        if network["role"] == "member":
            from openagent_identity.client.login import list_agents

            rows = await list_agents(
                node=state.iroh_node, coordinator_node_id=network["coordinator_node_id"]
            )
            return next(
                (
                    row.get("owner_handle")
                    for row in rows
                    if row.get("node_id") == state.identity.public_hex
                ),
                None,
            )
        return None

    async def principal_active(self, principal):
        if principal.authority != "openagent" or principal.kind not in {
            "user",
            "agent",
        }:
            return False
        try:
            data = await self.snapshot(principal.tenant_id)
        except Exception:
            return False
        return (
            principal.subject_id
            in data["users" if principal.kind == "user" else "agents"]
        )

    async def audience(self, session_id, tenant):
        data = await self.snapshot(tenant)
        async with aiosqlite.connect(self.agent.memory_db.db_path) as connection:
            connection.row_factory = aiosqlite.Row
            session = await (
                await connection.execute(
                    "SELECT visibility,acl_version FROM sessions_v2 WHERE id=? AND tenant_id=? AND deleted_at_ms IS NULL",
                    (session_id, tenant),
                )
            ).fetchone()
            if session is None:
                raise PermissionError("Session is unavailable")
            grants = await (
                await connection.execute(
                    "SELECT principal_type,principal_id FROM resource_acl WHERE tenant_id=? AND resource_type='session' "
                    "AND resource_id=? AND acl_version=? AND permission IN ('view','admin')",
                    (tenant, session_id, session["acl_version"]),
                )
            ).fetchall()
        recipients = set()
        shared = session["visibility"] in {"installation_shared", "public"}
        devices = {item["device_id"]: item["handle"] for item in data["devices"]}
        for grant in grants:
            kind, identifier = grant["principal_type"], grant["principal_id"]
            if kind in {"user", "agent"}:
                continue  # The authorizer already resolves concrete principals.
            if kind == "device":
                handle = devices.get(str(identifier).removeprefix("device:").lower())
                if handle is not None:
                    recipients.add(PrincipalRef("openagent", tenant, handle, "user"))
            elif kind in {"installation", "public"}:
                shared = True
            else:
                raise PermissionError(
                    "Unsupported recipient group needs an explicit directory adapter"
                )
        if shared:
            recipients.update(
                PrincipalRef("openagent", tenant, handle, kind)
                for kind, key in (("user", "users"), ("agent", "agents"))
                for handle in data[key]
            )
        return tuple(sorted(recipients, key=lambda principal: principal.key))
