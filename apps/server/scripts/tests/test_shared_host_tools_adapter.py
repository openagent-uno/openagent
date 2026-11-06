"""Product composition contracts for the independently released tool owners.

Tool implementations and native/browser internals are qualified upstream. This
suite checks the standalone host's selection, workspace and environment policy.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import sys

from openagent_server.bootstrap import standalone_spec_resolver
from ._framework import TestContext, test as register_test


def test_workspace_tools_use_the_public_host_facade_and_safe_environment():
    with TemporaryDirectory() as temporary:
        workspace = Path(temporary).resolve()
        resolver = standalone_spec_resolver({}, environment={
            "PATH": "/qualified/bin", "HOME": str(workspace),
            "PYTHONPATH": "/untrusted", "PRIVATE_API_TOKEN": "fixture-only",
        })
        for name in ("filesystem", "editor", "shell"):
            spec = resolver({"name": name, "kind": "builtin"}, workspace / "state.sqlite3")
            assert spec["command"] == [sys.executable, "-m", "openagent_host_tools.mcp_server", name]
            assert spec["_cwd"] == str(workspace)
            assert spec["env"]["PATH"] == "/qualified/bin"
            assert "PYTHONPATH" not in spec["env"]
            assert "PRIVATE_API_TOKEN" not in spec["env"]


def test_computer_sources_require_host_opt_in_and_exact_managed_rows():
    with TemporaryDirectory() as temporary:
        db = Path(temporary) / "state.sqlite3"
        row = {"name": "computer-control", "kind": "default", "builtin_name": "computer-control"}
        assert standalone_spec_resolver({})(row, db) is False
        resolver = standalone_spec_resolver({"server_host_tools": {"tools": ["computer-control"]}})
        assert resolver(dict(row, kind="custom"), db) is False
        candidate = SimpleNamespace(name="computer-control", command=("/old/command",), reason=None)
        command = ("/qualified/control.app/Contents/MacOS/control",)
        with patch("openagent_host_tools.sidecars.discover_sidecars", return_value=[candidate]), patch(
            "openagent_device_tools.media.native_desktop_command", return_value=command
        ):
            assert resolver(row, db)["command"] == list(command)


def test_browser_profile_and_port_are_scoped_to_the_agent_workspace():
    with TemporaryDirectory() as temporary:
        resolver = standalone_spec_resolver({"server_host_tools": {"tools": ["agent-in-chrome"]}})
        candidate = SimpleNamespace(name="agent-in-chrome", command=("/qualified/node", "/qualified/mcp-server.js"), reason=None)
        row = {"name": "agent-in-chrome", "kind": "default", "builtin_name": "agent-in-chrome"}
        with patch("openagent_host_tools.sidecars.discover_sidecars", return_value=[candidate]):
            first = resolver(row, Path(temporary) / "one/state.sqlite3")
            same = resolver(row, Path(temporary) / "one/state.sqlite3")
            second = resolver(row, Path(temporary) / "two/state.sqlite3")
        assert first["env"]["OPENAGENT_BROWSER_LOCATION"] == "server"
        assert first["env"]["OPENAGENT_CHROME_PROFILE_DIR"] == same["env"]["OPENAGENT_CHROME_PROFILE_DIR"]
        assert first["env"]["OPENAGENT_CHROME_PROFILE_DIR"] != second["env"]["OPENAGENT_CHROME_PROFILE_DIR"]
        assert first["env"]["OPENAGENT_CHROME_CDP_PORT"] == same["env"]["OPENAGENT_CHROME_CDP_PORT"]


@register_test("host-tools", "workspace tools compose the public host facade")
async def workspace_contract(_ctx: TestContext):
    test_workspace_tools_use_the_public_host_facade_and_safe_environment()


@register_test("host-tools", "computer sources require exact host-managed opt-in")
async def computer_contract(_ctx: TestContext):
    test_computer_sources_require_host_opt_in_and_exact_managed_rows()


@register_test("host-tools", "browser profile belongs to the agent workspace")
async def browser_contract(_ctx: TestContext):
    test_browser_profile_and_port_are_scoped_to_the_agent_workspace()
