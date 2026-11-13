"""The shared broker must never keep serving an older installation's tools."""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import textwrap
from pathlib import Path

import pytest

from openagent_host_tools import HostPaths, __version__
from openagent_host_tools import control as control_module
from openagent_host_tools import local_broker
from openagent_host_tools.local_broker import (
    LocalBrokerClient,
    LocalBrokerServer,
    _legacy_broker_pid,
    _probe_broker,
    _unix_socket_path,
    broker_is_older,
    connect_or_start_broker,
)

pytestmark = pytest.mark.skipif(os.name == "nt", reason="Unix socket variant")


def _broker_env(paths: HostPaths) -> dict[str, str]:
    env = os.environ.copy()
    env["OPENAGENT_HOST_TOOLS_HOME"] = str(paths.home)
    return env


async def _wait_connectable(paths: HostPaths) -> None:
    for _ in range(400):
        probe = LocalBrokerClient(paths)
        try:
            await probe.connect()
            return
        except (OSError, EOFError):
            await asyncio.sleep(0.01)
        finally:
            await probe.close()
    raise AssertionError("broker did not accept connections")


async def _kill_reported_broker(paths: HostPaths) -> None:
    info = await _probe_broker(paths)
    pid = (info or {}).get("broker_pid")
    if isinstance(pid, int) and pid != os.getpid():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    _unix_socket_path(paths).unlink(missing_ok=True)


def test_version_order_only_moves_forward():
    assert broker_is_older(None, "1.0.0b16")
    assert broker_is_older("1.0.0b15", "1.0.0b16")
    assert broker_is_older("1.0.0b16", "1.0.0")
    assert broker_is_older("1.0.0rc1", "1.0.0")
    assert broker_is_older("1.0.0", "1.0.1b1")
    assert not broker_is_older("1.0.0b16", "1.0.0b16")
    assert not broker_is_older("1.0.0b17", "1.0.0b16")
    # Unknown formats are left alone rather than fought over.
    assert not broker_is_older("dev-build", "1.0.0b16")


async def test_initialize_reports_version_pid_and_retire_feature(tmp_path: Path):
    paths = HostPaths.discover(tmp_path / "user")
    server = LocalBrokerServer(paths)
    task = asyncio.create_task(server.run())
    try:
        await _wait_connectable(paths)
        info = await _probe_broker(paths)
        assert info is not None
        assert info["host_tools_version"] == __version__
        assert info["broker_pid"] == os.getpid()
        assert info["features"]["retire"] == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_sigterm_exits_while_a_client_stays_connected(tmp_path: Path):
    """Regression: Python 3.12 ``wait_closed`` hung on connected shims."""

    paths = HostPaths.discover(tmp_path / "user")
    broker = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "openagent_host_tools",
        "--broker",
        env=_broker_env(paths),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    client = LocalBrokerClient(paths)
    try:
        await _wait_connectable(paths)
        await client.connect()
        broker.terminate()
        await asyncio.wait_for(broker.wait(), timeout=10)
        assert broker.returncode == 0
        assert not _unix_socket_path(paths).exists()
    finally:
        await client.close()
        if broker.returncode is None:
            broker.kill()
            await broker.wait()


async def test_newer_client_retires_older_broker(tmp_path: Path, monkeypatch):
    paths = HostPaths.discover(tmp_path / "user")
    monkeypatch.setattr(control_module, "__version__", "1.0.0b1")
    old = LocalBrokerServer(paths)
    old_task = asyncio.create_task(old.run())
    connected: LocalBrokerClient | None = None
    try:
        await _wait_connectable(paths)
        # A peer of the old broker stays connected, as a Desktop shim would.
        peer = LocalBrokerClient(paths)
        await peer.connect()

        connected = await asyncio.wait_for(connect_or_start_broker(paths), timeout=30)

        await asyncio.wait_for(old_task, timeout=10)
        assert await peer.receive() is None  # the retired broker dropped its peers
        await peer.close()
        info = await _probe_broker(paths)
        assert info is not None
        assert info["host_tools_version"] == __version__
        assert info["broker_pid"] != os.getpid()
    finally:
        if connected is not None:
            await connected.close()
        old_task.cancel()
        await asyncio.gather(old_task, return_exceptions=True)
        await _kill_reported_broker(paths)


async def test_newer_broker_is_kept(tmp_path: Path, monkeypatch):
    paths = HostPaths.discover(tmp_path / "user")
    monkeypatch.setattr(control_module, "__version__", "99.0.0")
    server = LocalBrokerServer(paths)
    task = asyncio.create_task(server.run())

    def no_spawn(_paths):
        raise AssertionError("a newer broker must not be replaced")

    monkeypatch.setattr(local_broker, "_spawn_broker", no_spawn)
    try:
        await _wait_connectable(paths)
        client = await connect_or_start_broker(paths)
        await client.close()
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


_LEGACY_BROKER = textwrap.dedent(
    """
    import json, os, signal, socket, sys, threading
    signal.signal(signal.SIGTERM, signal.SIG_IGN)  # like a hung legacy teardown
    path, pid_file = sys.argv[1], sys.argv[2]
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen()
    with open(pid_file, "w", encoding="ascii") as handle:
        handle.write(str(os.getpid()))

    def serve(conn):
        stream = conn.makefile("rwb")
        for line in stream:
            request = json.loads(line)
            result = {"protocol": "openagent-host-tools/1", "features": {"mcp_app_resources": 1}}
            frame = {"id": request.get("id"), "type": "response", "ok": True, "result": result}
            stream.write((json.dumps(frame) + "\\n").encode())
            stream.flush()

    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()
    """
)


async def test_legacy_broker_without_version_is_replaced(tmp_path: Path, monkeypatch):
    paths = HostPaths.discover(tmp_path / "user")
    paths.ensure()
    monkeypatch.setattr(local_broker, "_RETIRE_TIMEOUT_SECONDS", 2.0)
    script = tmp_path / "openagent-host-tools-legacy.py"
    script.write_text(_LEGACY_BROKER, encoding="utf-8")
    legacy = await asyncio.create_subprocess_exec(
        sys.executable,
        str(script),
        str(_unix_socket_path(paths)),
        str(paths.broker_pid),
        "--broker",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    connected: LocalBrokerClient | None = None
    try:
        await _wait_connectable(paths)
        assert _legacy_broker_pid(paths) == legacy.pid

        connected = await asyncio.wait_for(connect_or_start_broker(paths), timeout=30)

        await asyncio.wait_for(legacy.wait(), timeout=5)
        assert legacy.returncode == -signal.SIGKILL  # SIGTERM was ignored
        info = await _probe_broker(paths)
        assert info is not None
        assert info["host_tools_version"] == __version__
    finally:
        if connected is not None:
            await connected.close()
        if legacy.returncode is None:
            legacy.kill()
            await legacy.wait()
        await _kill_reported_broker(paths)


async def test_unverified_pid_is_never_signalled(tmp_path: Path):
    paths = HostPaths.discover(tmp_path / "user")
    paths.ensure()
    sleeper = await asyncio.create_subprocess_exec("sleep", "30")
    try:
        paths.broker_pid.write_text(str(sleeper.pid), encoding="ascii")
        assert _legacy_broker_pid(paths) is None
        paths.broker_pid.write_text(str(os.getpid()), encoding="ascii")
        assert _legacy_broker_pid(paths) is None
    finally:
        sleeper.kill()
        await sleeper.wait()
