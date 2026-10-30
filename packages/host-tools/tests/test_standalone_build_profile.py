"""Validate the actual standalone Cargo subprocess profile without compiling."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def build_script(monkeypatch):
    script = Path(__file__).resolve().parents[1] / "scripts/build_standalone.py"
    monkeypatch.syspath_prepend(str(script.parent))
    spec = importlib.util.spec_from_file_location("standalone_build_profile_fixture", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("configured,expected", [(None,"12.0"),("","12.0"),("11.0","12.0"),("10.15.7","12.0"),("12.0","12.0"),("13.3","13.3"),("14.1.2","14.1.2")])
def test_cargo_macos_profile_applies_floor_and_preserves_higher_target(build_script, monkeypatch, configured, expected):
    monkeypatch.setattr(build_script.sys, "platform", "darwin")
    if configured is None:
        monkeypatch.delenv("MACOSX_DEPLOYMENT_TARGET", raising=False)
    else:
        monkeypatch.setenv("MACOSX_DEPLOYMENT_TARGET", configured)
    before = dict(build_script.os.environ)
    env = build_script._computer_cargo_environment()
    assert env["MACOSX_DEPLOYMENT_TARGET"] == expected
    assert dict(build_script.os.environ) == before


@pytest.mark.parametrize("invalid", ["latest","12.beta","12.0.0.1","-1.0"," 13.0","١٣.٠"])
def test_cargo_macos_profile_rejects_malformed_targets(build_script, monkeypatch, invalid):
    monkeypatch.setattr(build_script.sys, "platform", "darwin")
    monkeypatch.setenv("MACOSX_DEPLOYMENT_TARGET", invalid)
    with pytest.raises(SystemExit, match="numeric macOS version"):
        build_script._computer_cargo_environment()


def test_cargo_profile_does_not_change_other_platform_environment(build_script, monkeypatch):
    monkeypatch.setattr(build_script.sys, "platform", "linux")
    monkeypatch.setenv("MACOSX_DEPLOYMENT_TARGET", "not-used-by-linux")
    assert build_script._computer_cargo_environment() == dict(build_script.os.environ)


def test_standalone_passes_profile_to_the_real_cargo_subprocess_boundary(build_script, monkeypatch, tmp_path):
    monkeypatch.setattr(build_script.sys, "platform", "darwin")
    monkeypatch.setattr(build_script, "ROOT", tmp_path)
    monkeypatch.setattr(build_script.shutil, "which", lambda command: "/owned/cargo")
    monkeypatch.setenv("MACOSX_DEPLOYMENT_TARGET", "11.0")
    calls = []
    monkeypatch.setattr(build_script.subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs)))
    output = build_script._build_computer_control(tmp_path / "source")
    assert len(calls) == 1
    command, options = calls[0]
    assert command[:4] == ["/owned/cargo", "build", "--release", "--locked"]
    assert options["env"]["MACOSX_DEPLOYMENT_TARGET"] == "12.0"
    assert options["check"] is True
    assert output == tmp_path / "build/computer-control/release/openagent-computer-control"
