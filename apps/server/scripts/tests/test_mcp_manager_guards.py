"""mcp-manager.remove_mcp guardrails — builtins can be disabled, not deleted.

On 1.1 the tool writes no SQLite itself: it resolves the host's
``catalog_management`` service from the current runtime and execution context
(``NativeCatalogService`` in the product), which refuses product-owned sources.
"""
from __future__ import annotations

import asyncio
import sys
import textwrap
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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
                removed = await mgr.remove_mcp("custom-one")
                assert removed["ok"] is True and removed["availability"] == "next_turn", removed

            assert await db.get_mcp("shell") is not None
            assert await db.get_mcp("vault") is not None
            assert await db.get_mcp("custom-one") is None
        finally:
            await db.close()
    finally:
        tmp.unlink(missing_ok=True)


@test("mcp_manager_guards", "member discovers granted MCPs and sees reconnect status without manager access")
async def t_member_mcp_catalog_and_stdio_recovery(ctx: TestContext) -> None:
    from tempfile import TemporaryDirectory

    from openagent_core import RunRequest, Runtime, RuntimeServices, RuntimeSettings
    from openagent_core.capabilities import CapabilityCatalog, CapabilityUnavailable
    from openagent_core.memory.db import MemoryDB
    from openagent_core.modules import ModuleCatalog, ModuleConfig, RuntimeProfile
    from openagent_core.mcp.pool import MCPPool
    from openagent_module_mcp import MCPDescriptor
    from openagent_server.catalog_service import NativeCatalogService
    from openagent_server.runtime_access import NativeRuntimeAuthorizer
    from openagent_server.runtime_service import NativeRuntimeService
    from openagent_storage_sqlite import SqliteRuntimeStore

    with TemporaryDirectory(dir=ctx.db_path.parent) as temporary:
        path = Path(temporary)
        ready = path / "files-ready"
        server = path / "stdio_fixture.py"
        server.write_text(textwrap.dedent("""\
            from pathlib import Path
            import sys
            from time import sleep
            if sys.argv[1] == "files" and not Path(sys.argv[2]).exists():
                sleep(30)
            from mcp.server.fastmcp import FastMCP
            mcp = FastMCP(sys.argv[1])
            @mcp.tool()
            def probe() -> str:
                return "fixture-" + sys.argv[1]
            mcp.run(transport="stdio")
        """), encoding="utf-8")
        db_path = path / "agent.db"
        db = MemoryDB(str(db_path))
        await db.connect()
        try:
            sources = []
            for name in ("shell", "files"):
                command = [sys.executable]
                args = [str(server), name, str(ready)]
                await db.upsert_mcp(name, kind="custom", command=command, args=args, enabled=True)
                sources.append({"name": name, "command": command, "args": args})
            agent = SimpleNamespace(memory_db=db, config={}, name="fixture")
            gateway = SimpleNamespace(agent=agent, _request_device_still_authorized=AsyncMock(return_value=True))
            native = NativeRuntimeService.__new__(NativeRuntimeService)
            native.agent = agent
            native.project_tasks = None
            native.dashboards = None
            native.official_connectors = SimpleNamespace(authorize_source=AsyncMock(return_value=None))
            native._interactive_sources = {}
            native.directory = SimpleNamespace(owner_handle=AsyncMock(return_value="owner"))
            native.authorizer = NativeRuntimeAuthorizer(gateway, db_path, source_authorizer=native._authorize_source)
            native.catalog_management = NativeCatalogService(agent, native.authorizer)
            await native.catalog_management.start()
            pool = MCPPool.from_config(sources, include_defaults=False)
            observations = {}
            manager_refs = []

            class ProbeExecutor:
                async def execute(self, request, context, runtime):
                    descriptors = await runtime.capabilities.discover(context)
                    available = {item.source_id for item in descriptors}
                    unavailable = await runtime.capabilities.temporarily_unavailable_sources(context)
                    source = "mcp" if request.run_id == "owner-turn" else (
                        "files" if request.run_id == "recovered-turn" else "shell")
                    tool = next(item for item in descriptors if item.source_id == source and (
                        source != "mcp" or item.name == "list_mcps"))
                    if source == "mcp":
                        manager_refs.append(tool.tool_ref)
                    elif manager_refs:
                        try:
                            await runtime.capabilities.call_tool(manager_refs[0], {}, context)
                        except (PermissionError, CapabilityUnavailable):
                            pass
                        else:
                            raise AssertionError("A member used an owner-only tool reference")
                    result = await runtime.capabilities.call_tool(tool.tool_ref, {}, context)
                    observations[request.run_id] = (available, unavailable, result)
                    return "Fixture finished"

            catalog = CapabilityCatalog(native.authorizer, allow_dynamic=True)
            module = ModuleConfig(frozenset({"service", "agent_tools"}), {
                "catalog_mode": "dynamic", "pool_factory": lambda _: pool,
            })
            runtime = native.runtime = Runtime(
                RuntimeSettings("fixture", path, environment=(("OPENAGENT_MCP_STARTUP_RETRY_SECONDS", "0.1"),)),
                RuntimeServices(SqliteRuntimeStore(db_path), ProbeExecutor(), native.authorizer,
                                catalog, catalog_management=native.catalog_management),
                profile=RuntimeProfile(1, {"mcp": module}),
                module_catalog=ModuleCatalog((MCPDescriptor(),)),
            )

            class VerifiedRequest(dict):
                app = {"gateway": gateway}

            async def turn(run_id, handle):
                cert = SimpleNamespace(handle=handle, network_id="fixture-network",
                                       device_pubkey_hex=handle + "-device", capabilities=[])
                identity = await native.authorizer.bind_request(
                    VerifiedRequest(auth_kind="device_cert", device_cert=cert))
                context = await native.authorizer.context_for_identity(identity, handle + "-session")
                await runtime.submit(RunRequest(run_id, context.session_id, run_id, "Probe"), context)
                result = await asyncio.wait_for(runtime.wait(run_id, context), 10)
                assert result.status == "success", result
                return observations[run_id]

            with patch("openagent_core.mcp.pool._MCP_CONNECT_TIMEOUT", 2):
                await runtime.start()
                try:
                    available, unavailable, output = await turn("member-turn", "member")
                    assert available == {"shell"}, available
                    assert {source for source, _ in unavailable} == {"files"}, unavailable
                    assert "fixture-shell" in str(output), output
                    timeout = next(item for item in pool.connection_status() if item["mcp_name"] == "files")
                    assert timeout["failure"]["code"] == "timeout", timeout
                    ready.touch()

                    available, _, output = await turn("owner-turn", "owner")
                    assert {"mcp", "mcp-manager", "shell"} <= available, available
                    assert {row["name"] for row in output} == {"shell", "files"}, output

                    async with asyncio.timeout(12):
                        while pool.toolkit_by_name("files") is None:
                            await asyncio.sleep(0.05)
                    available, unavailable, output = await turn("recovered-turn", "member")
                    assert available == {"shell", "files"}, available
                    assert not unavailable, unavailable
                    assert "fixture-files" in str(output), output
                finally:
                    await runtime.close()
        finally:
            await db.close()
