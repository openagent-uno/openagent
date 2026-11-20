from __future__ import annotations

import sys
import asyncio

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


@pytest.mark.parametrize("name,command_key", (
    ("computer-control", "OPENAGENT_COMPUTER_CONTROL_COMMAND"),
    ("agent-in-chrome", "OPENAGENT_AGENT_IN_CHROME_COMMAND"),
))
def test_opted_in_server_computer_tools_use_host_destination(
    name, command_key, tmp_path, monkeypatch,
) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    monkeypatch.setenv(command_key, '["/opt/verified/sidecar"]')
    db = tmp_path / "agent" / "openagent.db"
    db.parent.mkdir()
    config = {"server_host_tools": {
        "tools": [name],
        "browser": {"cdp_port": 28911, "profile_dir": str(tmp_path / "profile"),
                    "external_supervisor": True},
    }}
    resolver = standalone_spec_resolver(config, environment={
        "PATH": "/usr/bin", "DISPLAY": ":101", "XAUTHORITY": "/tmp/auth",
        "TELEGRAM_BOT_TOKEN": "must-not-leak",
    })
    spec = resolver(_row(name), str(db))

    assert spec["command"] == ["/opt/verified/sidecar"]
    assert spec["_cwd"] == str(db.parent.resolve())
    assert spec["env"]["DISPLAY"] == ":101"
    assert "TELEGRAM_BOT_TOKEN" not in spec["env"]
    if name == "agent-in-chrome":
        assert spec["env"]["OPENAGENT_CHROME_CDP_PORT"] == "28911"
        assert spec["env"]["OPENAGENT_CHROME_PROFILE_DIR"] == str(tmp_path / "profile")
        assert spec["env"]["OPENAGENT_BROWSER_LOCATION"] == "server"
        assert spec["env"]["OPENAGENT_BROWSER_EXTERNAL"] == "1"
    assert resolver({**_row(name), "kind": "custom", "builtin_name": None}, str(db)) is False


def test_opted_in_server_computer_rows_preserve_user_disabled_state() -> None:
    from openagent_server.bootstrap import ensure_server_computer_rows

    class FakeDB:
        def __init__(self):
            self.rows = []
            self.inserted = []

        async def list_mcps(self):
            return self.rows

        async def upsert_mcp(self, name, **kwargs):
            self.inserted.append((name, kwargs))
            self.rows.append({"name": name, **kwargs})

    db = FakeDB()
    config = {"server_host_tools": {"tools": ["agent-in-chrome", "computer-control"]}}
    asyncio.run(ensure_server_computer_rows(db, config))
    assert {name for name, _ in db.inserted} == {"agent-in-chrome", "computer-control"}
    db.rows[0]["enabled"] = False
    asyncio.run(ensure_server_computer_rows(db, config))
    assert len(db.inserted) == 2
    assert db.rows[0]["enabled"] is False


class _FakeCatalogDB:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.inserted = []

    async def list_mcps(self):
        return self.rows

    async def upsert_mcp(self, name, **kwargs):
        self.inserted.append((name, kwargs))
        self.rows.append({"name": name, **kwargs})


def test_fresh_catalog_receives_default_workspace_tool_rows(tmp_path) -> None:
    from openagent_server.bootstrap import ensure_server_computer_rows, standalone_spec_resolver

    db = _FakeCatalogDB()
    asyncio.run(ensure_server_computer_rows(db, {}))

    assert {name for name, _ in db.inserted} == {"filesystem", "editor", "shell"}
    assert all(kw["kind"] == "default" and kw["builtin_name"] == name
               for name, kw in db.inserted)
    resolver = standalone_spec_resolver({}, environment={"PATH": "/usr/bin"})
    for row in db.rows:
        assert resolver(row, str(tmp_path / "openagent.db"))["name"] == row["name"]


def test_workspace_tool_seeding_keeps_existing_and_honours_selection() -> None:
    from openagent_server.bootstrap import ensure_server_computer_rows

    legacy = {"name": "filesystem", "kind": "default", "builtin_name": None,
              "command": "npx", "enabled": False}
    db = _FakeCatalogDB([legacy])
    asyncio.run(ensure_server_computer_rows(db, {"server_host_tools": {"tools": ["filesystem", "shell"]}}))
    assert [name for name, _ in db.inserted] == ["shell"]
    assert db.rows[0] is legacy and legacy["enabled"] is False

    untouched = _FakeCatalogDB()
    asyncio.run(ensure_server_computer_rows(untouched, {"server_host_tools": False}))
    assert untouched.inserted == []


def test_server_host_tools_reject_unknown_names() -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    with pytest.raises(ValueError, match="unsupported server host tools"):
        standalone_spec_resolver({"server_host_tools": {"tools": ["ui-manager"]}})


def test_legacy_web_search_row_resolves_independent_package(tmp_path) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    binary = tmp_path / "bin" / "openagent-web-search-mcp"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    db = tmp_path / "agent" / "openagent.db"
    db.parent.mkdir()
    resolver = standalone_spec_resolver({}, environment={
        "PATH": str(binary.parent),
        "HOME": "/home/agent",
        "BROWSER_HEADLESS": "true",
        "RELEVANCE_THRESHOLD": "0.4",
        "OPENAI_API_KEY": "must-not-leak",
    })

    spec = resolver(_row("web-search"), str(db))

    assert spec["command"] == [str(binary)]
    assert spec["_cwd"] == str(db.parent.resolve())
    assert spec["env"]["BROWSER_HEADLESS"] == "true"
    assert spec["env"]["RELEVANCE_THRESHOLD"] == "0.4"
    assert "OPENAI_API_KEY" not in spec["env"]
    assert resolver({
        "name": "web-search",
        "kind": "custom",
        "builtin_name": None,
    }, str(db)) is None


def test_legacy_web_search_row_explains_missing_independent_package(tmp_path) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    resolver = standalone_spec_resolver({}, environment={
        "PATH": str(tmp_path / "empty"),
        "HOME": "/home/agent",
    })

    with pytest.raises(RuntimeError, match="openagent-web-search-mcp is not installed"):
        resolver(_row("web-search"), str(tmp_path / "openagent.db"))


def test_server_browser_proxy_reaches_only_the_browser_sidecar(tmp_path, monkeypatch) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    monkeypatch.setenv("OPENAGENT_AGENT_IN_CHROME_COMMAND", '["/opt/verified/sidecar"]')
    db = tmp_path / "agent" / "openagent.db"
    db.parent.mkdir()
    config = {"server_host_tools": {
        "tools": ["agent-in-chrome", "shell"],
        "browser": {"proxy": " socks5://127.0.0.1:1080 "},
    }}
    resolver = standalone_spec_resolver(config, environment={"PATH": "/usr/bin"})
    assert resolver(_row("agent-in-chrome"), str(db))["env"]["OPENAGENT_CHROME_PROXY"] == "socks5://127.0.0.1:1080"
    assert "OPENAGENT_CHROME_PROXY" not in resolver(_row("shell"), str(db))["env"]

    for invalid in ("", "socks5://a b", 1080):
        config["server_host_tools"]["browser"]["proxy"] = invalid
        with pytest.raises(ValueError):
            standalone_spec_resolver(config, environment={"PATH": "/usr/bin"})(_row("agent-in-chrome"), str(db))


def test_exclusive_profile_reaches_only_the_browser_sidecar(tmp_path, monkeypatch) -> None:
    from openagent_server.bootstrap import standalone_spec_resolver

    monkeypatch.setenv("OPENAGENT_AGENT_IN_CHROME_COMMAND", '["/opt/verified/sidecar"]')
    db = tmp_path / "agent" / "openagent.db"
    db.parent.mkdir()
    config = {"server_host_tools": {"tools": ["agent-in-chrome", "shell"],
                                    "browser": {"profile_dir": str(tmp_path / "p"), "exclusive_profile": True}}}
    resolver = standalone_spec_resolver(config, environment={"PATH": "/usr/bin"})
    assert resolver(_row("agent-in-chrome"), str(db))["env"]["OPENAGENT_CHROME_PROFILE_EXCLUSIVE"] == "1"
    assert "OPENAGENT_CHROME_PROFILE_EXCLUSIVE" not in resolver(_row("shell"), str(db))["env"]
    config["server_host_tools"]["browser"]["exclusive_profile"] = "yes"
    assert "OPENAGENT_CHROME_PROFILE_EXCLUSIVE" not in standalone_spec_resolver(config, environment={"PATH": "/usr/bin"})(_row("agent-in-chrome"), str(db))["env"]
