"""mcp-manager.remove_mcp guardrails — builtins can be disabled, not deleted.

On 1.1 the tool writes no SQLite itself: it resolves the host's
``catalog_management`` service from the current runtime and execution context
(``NativeCatalogService`` in the product), which refuses product-owned sources.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

from ._framework import TestContext, test


class _Owner:
    async def authorize(self, context, action, resource, *, audience=()):
        return True


@test("mcp_manager_guards", "remove_mcp refuses kind='default' and kind='builtin'")
async def t_remove_rejects_builtins(ctx: TestContext) -> None:
    import openagent_core.mcp.servers.mcp_manager.server as mgr
    from openagent_core.contracts import ExecutionContext, PrincipalRef
    from openagent_core.memory.db import MemoryDB
    from openagent_core.runtime import execution_scope
    from openagent_server.catalog_service import NativeCatalogService

    tmp = ctx.db_path.with_name(f"mgrguard-{uuid.uuid4().hex[:8]}.db")
    try:
        db = MemoryDB(str(tmp))
        await db.connect()
        try:
            await db.upsert_mcp("shell", kind="default", builtin_name="shell",
                                enabled=True, source="yaml-default")
            await db.upsert_mcp("vault", kind="builtin", builtin_name="vault",
                                enabled=True, source="user")
            await db.upsert_mcp("custom-one", kind="custom",
                                command=["/bin/true"], enabled=True)
            service = NativeCatalogService(
                SimpleNamespace(memory_db=db, config={}, capability_pool=None), _Owner(),
            )
            await service.start()
            runtime = SimpleNamespace(
                service=lambda key, default=None: service if key == "catalog_management" else default,
                settings=SimpleNamespace(environment=(), workspace=None),
            )
            owner = PrincipalRef("openagent", "network", "owner")
            context = ExecutionContext(owner, owner, owner, "session", "agent", (owner,))

            with execution_scope(runtime, context, "run"):
                for name in ("shell", "vault"):
                    try:
                        await mgr.remove_mcp(name)
                    except PermissionError:
                        pass
                    else:
                        raise AssertionError(f"remove_mcp {name!r} should have been refused")

                # kind=custom goes through
                assert (await mgr.remove_mcp("custom-one")) == {"ok": True}

            assert await db.get_mcp("shell") is not None
            assert await db.get_mcp("vault") is not None
            assert await db.get_mcp("custom-one") is None
        finally:
            await db.close()
    finally:
        tmp.unlink(missing_ok=True)
