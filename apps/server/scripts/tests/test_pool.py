"""MCPPool lifecycle + shape tests.

Verifies the pool builds the right set of specs from config, emits the
correct Claude SDK schema, connects + detects dormant servers, and keeps
the ``<server>_<tool>`` namespacing that the runtime relies on.

The ``connect_all`` test stashes the live pool into ``ctx.extras["pool"]``
so downstream MCP / runtime / router / gateway tests can reuse it.
"""
from __future__ import annotations

from ._framework import TestContext, TestSkip, test


@test("pool", "from_config builds expected number of specs")
async def t_pool_specs(ctx: TestContext) -> None:
    from openagent_core.mcp.pool import MCPPool
    pool = MCPPool.from_config(
        mcp_config=ctx.config.get("mcp"),
        include_defaults=True,
        disable=["chrome-devtools", "web-search", "computer-control", "mcp-manager", "model-manager"],
        db_path=str(ctx.db_path),
    )
    names = [s.name for s in pool.specs]
    for expected in ("vault", "filesystem", "scheduler", "workflow-manager", "events-manager"):
        assert expected in names, f"{expected} missing from the pool defaults: {names}"
    assert "chrome-devtools" not in names
    assert "web-search" not in names


@test("pool", "connect_all + dormant detection + summary")
async def t_pool_connect(ctx: TestContext) -> None:
    from openagent_core.mcp.pool import MCPPool
    pool = MCPPool.from_config(
        mcp_config=ctx.config.get("mcp"),
        include_defaults=True,
        disable=["chrome-devtools", "web-search", "computer-control", "mcp-manager", "model-manager"],
        db_path=str(ctx.db_path),
    )
    await pool.connect_all()
    try:
        summary = pool.server_summary()
        assert pool.server_count >= 4, f"expected >=4 servers, got {pool.server_count}"
        assert summary.get("vault", 0) > 0, f"vault has no tools: {summary}"
        assert summary.get("scheduler", 0) > 0, f"scheduler has no tools: {summary}"
        # ``messaging`` is not asserted: its Node server is not part of the
        # installed Core wheel (no openagent_core/mcp/servers/messaging), so a
        # pool built from Core defaults has nothing to start for it.
        ctx.extras["pool"] = pool
        ctx.extras["initial_summary"] = summary
    except Exception:
        await pool.close_all()
        raise


@test("pool", "tool name namespacing follows <server>_<tool>")
async def t_pool_namespacing(ctx: TestContext) -> None:
    pool = ctx.extras.get("pool")
    if pool is None:
        raise TestSkip("requires pool fixture")
    seen_prefixes = set()
    for tk in pool.runtime_toolkits:
        prefix = getattr(tk, "tool_name_prefix", None)
        if not prefix:
            continue
        seen_prefixes.add(prefix)
        for fname in (getattr(tk, "functions", {}) or {}):
            assert fname.startswith(prefix + "_"), \
                f"function {fname!r} doesn't follow {prefix}_<tool> convention"
    assert "vault" in seen_prefixes
