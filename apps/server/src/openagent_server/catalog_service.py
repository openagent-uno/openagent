"""Standalone MCP management with host-owned registration policy.

REST and agent tools use this service; mutable MCP configuration never determines
whether an existing source is product-owned. The ownership ledger is additive
in the same physical database and unavailable through MCP import/update fields.
"""

from __future__ import annotations
import asyncio
from pathlib import Path
import aiosqlite
from openagent_core.contracts import ResourceRef, require_authorized


class NativeCatalogService:
    def __init__(self, agent, authorizer):
        self.agent = agent
        self.db = agent.memory_db
        self.authorizer = authorizer
        self._lock = asyncio.Lock()
        self._ownership = {}
        self._pool = None
        from openagent_core.mcp.builtins import BUILTIN_MCP_SPECS, DEFAULT_MCPS

        names = set(BUILTIN_MCP_SPECS)
        names.update(
            entry.get("name") or entry.get("builtin") for entry in DEFAULT_MCPS
        )
        names.update({"vault", "agent-manager", "agent-federation", "ui-manager"})
        names.update(
            entry.get("name") or entry.get("builtin")
            for entry in (agent.config.get("mcp") or [])
            if isinstance(entry, dict)
        )
        self.managed_names = frozenset(name for name in names if name)

    @property
    def user_sources(self):
        return frozenset(
            name for name, ownership in self._ownership.items() if ownership == "user"
        )

    async def start(self):
        rows = await self.db.list_mcps()
        async with aiosqlite.connect(self.db.db_path) as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS standalone_capability_ownership "
                "(source_id TEXT PRIMARY KEY, ownership TEXT NOT NULL CHECK (ownership IN ('managed','user')))"
            )
            for row in rows:
                # First migration maps historical custom registrations only.
                # Future edits cannot promote or demote their ownership.
                owner = (
                    "managed"
                    if row["name"] in self.managed_names or row.get("kind") != "custom"
                    else "user"
                )
                await conn.execute(
                    "INSERT OR IGNORE INTO standalone_capability_ownership VALUES (?,?)",
                    (row["name"], owner),
                )
            await conn.commit()
            self._ownership = dict(
                await (
                    await conn.execute(
                        "SELECT source_id,ownership FROM standalone_capability_ownership"
                    )
                ).fetchall()
            )
        # Product-reserved identifiers remain managed even if an older client
        # rewrote their mutable mcps row before the migration.
        self._ownership.update({name: "managed" for name in self.managed_names})

    async def _refresh(self):
        pool = self._pool
        if pool is not None:
            pool.set_catalog_user_sources(self.user_sources)
            await pool.reload()

    def bind_pool(self, pool):
        """Bind the MCP module instance selected by the active graph."""
        if self._pool is not None and self._pool is not pool:
            raise RuntimeError("Catalog management is already bound to an active MCP graph")
        self._pool = pool

    def unbind_pool(self, pool):
        if self._pool is pool:
            self._pool = None

    async def _check(self, context, action, name="*"):
        await require_authorized(
            self.authorizer,
            context,
            "catalog." + action,
            ResourceRef("capability", context.tenant_id, name),
        )

    async def list(self, context):
        await self._check(context, "read")
        return [self._present(row) for row in await self.db.list_mcps()]

    async def get(self, context, name):
        await self._check(context, "read", name)
        row = await self.db.get_mcp(name)
        if row is None:
            raise LookupError(name)
        return self._present(row)

    def _present(self, row):
        return {
            **row,
            "managed": self._ownership.get(row["name"], "managed") != "user",
            "mutable_fields": ["enabled"]
            if self._ownership.get(row["name"], "managed") != "user"
            else ["command", "args", "url", "env", "headers", "oauth", "enabled"],
        }

    @staticmethod
    def _validate(values):
        allowed = {"command", "args", "url", "env", "headers", "oauth", "enabled"}
        if not isinstance(values, dict) or set(values) - allowed:
            raise ValueError("Only public MCP configuration fields may be changed")
        for key in ("command", "args"):
            if (
                key in values
                and values[key] is not None
                and (
                    not isinstance(values[key], list)
                    or any(not isinstance(v, str) for v in values[key])
                )
            ):
                raise ValueError(f"{key} must be an argument list")
        for key in ("env", "headers"):
            if key in values and (
                not isinstance(values[key], dict)
                or any(
                    not isinstance(k, str) or not isinstance(v, str)
                    for k, v in values[key].items()
                )
            ):
                raise ValueError(f"{key} must contain strings")
        if values.get("url") is not None and not isinstance(values["url"], str):
            raise ValueError("url must be a string")
        for key in ("oauth", "enabled"):
            if key in values and not isinstance(values[key], bool):
                raise ValueError(f"{key} must be boolean")

    async def create(self, context, name, **values):
        await self._check(context, "install", name)
        self._validate(values)
        if (
            not isinstance(name, str)
            or not name.strip()
            or "/" in name
            or len(name) > 256
        ):
            raise ValueError("Invalid capability source name")
        async with self._lock:
            if (
                self._ownership.get(name) == "managed"
                or await self.db.get_mcp(name) is not None
            ):
                raise ValueError("Capability source already exists")
            if not values.get("command") and not values.get("url"):
                raise ValueError("An executable or URL is required")
            from openagent_core.mcp.install_policy import check_mcp_install_allowed

            check_mcp_install_allowed(
                name=name,
                surface="standalone.catalog",
                command=values.get("command"),
                args=values.get("args"),
                url=values.get("url"),
            )
            # Persist ownership first. A failed config write cannot create a
            # managed collision or expose a runnable partially registered source.
            async with aiosqlite.connect(self.db.db_path) as conn:
                await conn.execute(
                    "INSERT OR IGNORE INTO standalone_capability_ownership VALUES (?,'user')",
                    (name,),
                )
                await conn.commit()
            self._ownership[name] = "user"
            await self.db.upsert_mcp(
                name, kind="custom", source="standalone-catalog", **values
            )
        await self._refresh()
        return await self.get(context, name)

    async def update(self, context, name, **values):
        await self._check(context, "configure", name)
        self._validate(values)
        async with self._lock:
            existing = await self.db.get_mcp(name)
            if existing is None:
                raise LookupError(name)
            if self._ownership.get(name, "managed") != "user":
                if set(values) != {"enabled"}:
                    raise PermissionError(
                        "Product-owned sources can only be enabled or disabled here"
                    )
                await self.db.set_mcp_enabled(name, values["enabled"])
            else:
                merged = {
                    key: existing.get(key)
                    for key in (
                        "command",
                        "args",
                        "url",
                        "env",
                        "headers",
                        "oauth",
                        "enabled",
                    )
                }
                merged.update(values)
                if not merged.get("command") and not merged.get("url"):
                    raise ValueError("An executable or URL is required")
                from openagent_core.mcp.install_policy import check_mcp_install_allowed

                check_mcp_install_allowed(
                    name=name,
                    surface="standalone.catalog",
                    command=merged.get("command"),
                    args=merged.get("args"),
                    url=merged.get("url"),
                )
                await self.db.upsert_mcp(
                    name, kind="custom", source="standalone-catalog", **merged
                )
        await self._refresh()
        return await self.get(context, name)

    async def delete(self, context, name):
        await self._check(context, "remove", name)
        async with self._lock:
            if self._ownership.get(name, "managed") != "user":
                raise PermissionError(
                    "This capability source is managed by the product"
                )
            if await self.db.get_mcp(name) is None:
                raise LookupError(name)
            await self.db.delete_mcp(name)
        await self._refresh()
        return {"ok": True}

    async def set_enabled(self, context, name, enabled):
        return await self.update(context, name, enabled=enabled)
