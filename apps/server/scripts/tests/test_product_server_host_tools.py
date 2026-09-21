from __future__ import annotations

import sys

import pytest


def _row(name: str) -> dict[str, object]:
    return {"name": name, "kind": "default", "builtin_name": name}


@pytest.mark.parametrize("name", ("filesystem", "editor", "shell"))
def test_standalone_resolves_server_workspace_tools(name, tmp_path) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    db = tmp_path / "agent" / "openagent.db"
    db.parent.mkdir()
    resolver = standalone_spec_resolver(
        {},
        environment={
            "PATH": "/usr/bin",
            "HOME": "/home/agent",
            "TELEGRAM_BOT_TOKEN": "must-not-leak",
            "OPENAI_API_KEY": "must-not-leak",
            "OPENAGENT_SAFETY_APPROVALS": "1",
        },
    )

    spec = resolver(_row(name), str(db))

    assert spec["name"] == name
    assert spec["command"] == [
        sys.executable, "-m", "openagent_host_tools.mcp_server", name,
    ]
    assert spec["_cwd"] == str(db.parent.resolve())
    assert spec["env"]["PATH"] == "/usr/bin"
    assert spec["env"]["OPENAGENT_SAFETY_APPROVALS"] == "1"
    assert "TELEGRAM_BOT_TOKEN" not in spec["env"]
    assert "OPENAI_API_KEY" not in spec["env"]


def test_standalone_server_tools_are_configurable(tmp_path) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    db = tmp_path / "openagent.db"
    only_shell = standalone_spec_resolver({
        "server_host_tools": {"tools": ["shell"]},
    })
    disabled = standalone_spec_resolver({"server_host_tools": False})

    assert only_shell(_row("shell"), str(db))["name"] == "shell"
    assert only_shell(_row("filesystem"), str(db)) is False
    assert disabled(_row("shell"), str(db)) is False


@pytest.mark.parametrize("name", ("ui-manager", "computer-control", "agent-in-chrome"))
def test_physical_client_tools_remain_contextual(name, tmp_path) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    assert standalone_spec_resolver({})(_row(name), str(tmp_path / "db")) is False
