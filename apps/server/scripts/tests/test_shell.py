"""Product-level shell tests.

The in-product shell MCP (``mcp/servers/shell``: ``ShellHub``,
``BackgroundShell``, the ``shell_*`` handlers, the runtime adapter and the
agent's background-shell autoloop) left this repository in the 1.1 split.
The shell tool is now ``openagent_shell`` from openagent-tools (wrapped by
``openagent_host_tools``), a different implementation with its own tests in
that repository (``tests/test_shell_core.py``). The 44 tests that drove the
removed internals were retired from this suite; what remains here is what
the product itself owns: the ``shell`` config block and the pool's isolation
of a broken in-process adapter.
"""
from __future__ import annotations

from ._framework import TestContext, test


@test("shell", "MCPPool: bad adapter_module is isolated (pool stays healthy)")
async def t_pool_in_process_import_failure(ctx: TestContext) -> None:
    from openagent_core.mcp.pool import MCPPool, _ServerSpec

    # Construct a pool directly with a single broken in-process spec.
    broken = _ServerSpec(
        name="broken_shell",
        in_process=True,
        adapter_module="openagent.mcp.servers.does_not_exist",
        runtime_toolkit_factory="build_runtime_toolkit",
    )
    pool = MCPPool(specs=[broken])
    # connect_all must NOT raise — the broken spec is simply skipped.
    await pool.connect_all()
    try:
        assert pool.runtime_toolkits == []
    finally:
        await pool.close_all()


@test("shell", "config.shell_settings returns defaults when unset")
async def t_config_defaults(ctx: TestContext) -> None:
    from openagent_core.core.config import shell_settings

    s = shell_settings({})
    assert s.wake_wait_window_seconds == 60.0
    assert s.autoloop_cap == 25


@test("shell", "config.shell_settings honours overrides")
async def t_config_override(ctx: TestContext) -> None:
    from openagent_core.core.config import shell_settings

    s = shell_settings({"shell": {"wake_wait_window_seconds": 0, "autoloop_cap": 5}})
    assert s.wake_wait_window_seconds == 0.0
    assert s.autoloop_cap == 5
