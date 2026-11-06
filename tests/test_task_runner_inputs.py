"""The ephemeral task runner consumes its inputs before the agent can act.

``openagent`` and ``openagent-cli`` are replaced by small fakes on PATH. The
fake server runs a "tool call" as its own child, with the server's uid,
environment and working directory, exactly where a host tool such as
``shell`` runs. The fake ``ask`` triggers that probe, so the result records
what a tool could read during the agent turn.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

RUNNER = Path(__file__).resolve().parents[1] / "apps/server/deploy/task-runner/openagent-task-run"
SECRET = "sk-test-not-a-real-key-7f3a"

FAKE_SERVER = """
import json, os, signal, subprocess, sys, time
args = sys.argv[1:]
agent_dir = args[1]
probe = os.environ["PROBE_DIR"]
if "invite" in args:
    print("oa1-test-ticket")
    sys.exit(0)
open(os.path.join(probe, "serve-started"), "w").close()
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
with open(os.path.join(agent_dir, "coordinator_addr.json"), "w") as f:
    f.write("{}")
trigger = os.path.join(agent_dir, "tool-call")
while not os.path.exists(trigger):
    time.sleep(0.05)
findings = {}
for path in json.loads(os.environ["PROBE_PATHS"]):
    read = subprocess.run(["cat", path], capture_output=True, text=True)
    findings[path] = read.stdout if read.returncode == 0 else None
listing = subprocess.run(["ls", "-A", os.environ["PROBE_INPUT_DIR"]], capture_output=True, text=True)
findings["listing"] = listing.stdout.split()
with open(os.path.join(probe, "tool-findings.json"), "w") as f:
    json.dump(findings, f)
while True:
    time.sleep(0.1)
"""

FAKE_CLI = """
import json, os, sys, time
args = sys.argv[1:]
probe = os.environ["PROBE_DIR"]
def record(name):
    with open(os.path.join(probe, name + ".json"), "w") as f:
        json.dump({"argv": args, "stdin": sys.stdin.read()}, f)
if args[0] == "connect":
    sys.exit(0)
if args[0] == "request":
    record("request")
    print(json.dumps({"results": [{"path": "/api/providers", "status": 201}]}))
    sys.exit(0)
if args[0] == "ask":
    record("ask")
    agent_dir = os.path.join(os.environ["TMPDIR"], "openagent-task", "agent")
    open(os.path.join(agent_dir, "tool-call"), "w").close()
    findings = os.path.join(probe, "tool-findings.json")
    while not os.path.exists(findings):
        time.sleep(0.05)
    print(json.dumps({"status": "ok", "text": "done"}))
    sys.exit(0)
sys.exit(2)
"""


@pytest.fixture
def harness(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("openagent", FAKE_SERVER), ("openagent-cli", FAKE_CLI)):
        path = bin_dir / name
        path.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
        path.chmod(0o755)
    inputs = tmp_path / "task"
    inputs.mkdir()
    (inputs / "openagent.yaml").write_text(
        "server_host_tools:\n  browser:\n    proxy: http://user:" + SECRET + "@proxy.test:8080\n",
        encoding="utf-8")
    (inputs / "setup.json").write_text(json.dumps([
        {"method": "POST", "path": "/api/providers", "body": {"api_key": SECRET}}]), encoding="utf-8")
    (inputs / "message.txt").write_text("Summarize the page.", encoding="utf-8")
    probe = tmp_path / "probe"
    probe.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    paths = [str(inputs / name) for name in ("openagent.yaml", "setup.json", "message.txt")]
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
           "TMPDIR": str(work), "PROBE_DIR": str(probe),
           "PROBE_PATHS": json.dumps(paths), "PROBE_INPUT_DIR": str(inputs)}
    return {"inputs": inputs, "probe": probe, "work": work, "env": env, "tmp": tmp_path}


def _run(harness, *extra):
    inputs = harness["inputs"]
    return subprocess.run(
        [sys.executable, str(RUNNER), "--config", str(inputs / "openagent.yaml"),
         "--message-file", str(inputs / "message.txt"), "--setup-file", str(inputs / "setup.json"),
         "--output", str(harness["tmp"] / "result.json"), "--startup-timeout", "20",
         "--timeout", "20", *extra],
        env=harness["env"], capture_output=True, text=True, timeout=60)


def test_a_tool_call_during_the_turn_cannot_read_the_inputs(harness):
    done = _run(harness)
    assert done.returncode == 0, done.stderr

    findings = json.loads((harness["probe"] / "tool-findings.json").read_text())
    assert findings.pop("listing") == []
    assert findings and all(content is None for content in findings.values()), findings

    result = json.loads((harness["tmp"] / "result.json").read_text())
    assert result["status"] == "ok" and result["exit_code"] == 0


def test_setup_and_message_reach_the_cli_on_stdin_only(harness):
    done = _run(harness)
    assert done.returncode == 0, done.stderr

    request = json.loads((harness["probe"] / "request.json").read_text())
    ask = json.loads((harness["probe"] / "ask.json").read_text())
    assert request["argv"][:3] == ["request", "--batch-file", "-"]
    assert json.loads(request["stdin"])[0]["body"]["api_key"] == SECRET
    assert ask["argv"][:3] == ["ask", "--message-file", "-"]
    assert ask["stdin"] == "Summarize the page."
    for argv in (request["argv"], ask["argv"]):
        assert not any(SECRET in item or str(harness["inputs"]) in item for item in argv)


def test_the_agent_directory_config_is_private_to_the_runner(harness):
    done = _run(harness)
    assert done.returncode == 0, done.stderr
    config = harness["work"] / "openagent-task" / "agent" / "openagent.yaml"
    assert stat.S_IMODE(config.stat().st_mode) == 0o600


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root ignores directory modes")
def test_inputs_that_cannot_be_removed_stop_the_run_before_the_server(harness):
    harness["inputs"].chmod(0o500)  # like a read-only Secret volume
    try:
        done = _run(harness)
    finally:
        harness["inputs"].chmod(0o700)
    assert done.returncode == 10
    assert "cannot remove input" in done.stderr and "--keep-inputs" in done.stderr
    assert SECRET not in done.stderr + done.stdout
    assert not (harness["probe"] / "serve-started").exists()
    assert not (harness["probe"] / "ask.json").exists()


def test_keep_inputs_is_an_explicit_opt_out(harness):
    done = _run(harness, "--keep-inputs")
    assert done.returncode == 0, done.stderr
    assert sorted(p.name for p in harness["inputs"].iterdir()) == [
        "message.txt", "openagent.yaml", "setup.json"]


def test_symlinked_inputs_are_refused_because_their_target_would_survive(harness):
    target = harness["tmp"] / "secret-store"
    target.mkdir()
    real = target / "setup.json"
    (harness["inputs"] / "setup.json").replace(real)
    (harness["inputs"] / "setup.json").symlink_to(real)
    done = _run(harness)
    assert done.returncode == 10
    assert "symbolic link" in done.stderr
    assert not (harness["probe"] / "serve-started").exists()
