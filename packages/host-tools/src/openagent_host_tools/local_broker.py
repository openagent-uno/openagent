"""Single-instance local broker over a user-only Unix socket / Windows named pipe."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import queue
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

from ._version import __version__
from .control import ControlReply, dispatch_control
from .host import CapabilityHost
from .paths import HostPaths
from .types import HostError, ToolResult

# Control messages are newline-delimited JSON. Screenshots and other MCP media
# can be much larger than asyncio's 64 KiB StreamReader default; keep this in
# step with the bounded MCP stdio line size so a supported result can cross the
# sidecar and local-broker boundaries without being truncated.
_MAX_LOCAL_BROKER_LINE_BYTES = 128 * 1024 * 1024

# Bound every step of broker teardown that waits on peers. Python 3.12's
# ``Server.wait_closed`` waits for every accepted connection, so a connected
# Desktop shim used to keep a SIGTERM'd broker alive indefinitely.
_ENDPOINT_CLOSE_TIMEOUT_SECONDS = 5.0
# How long a client waits for an older broker to go away after asking it to
# retire (or, for a legacy broker without ``retire``, after SIGTERM).
_RETIRE_TIMEOUT_SECONDS = 10.0


class BrokerAlreadyRunning(RuntimeError):
    pass


class LocalBrokerServer:
    def __init__(self, paths: HostPaths | None = None):
        self.paths = paths or HostPaths.discover()
        self.paths.ensure()
        self.host = CapabilityHost(paths=self.paths)
        self._lock_file = None
        self._unix_socket: socket.socket | None = None
        self._unix_socket_identity: tuple[int, int] | None = None
        self._unix_server: asyncio.AbstractServer | None = None
        self._windows_listener = None
        self._windows_stop = threading.Event()
        self._connections: set[asyncio.StreamWriter] = set()
        self._stop: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def request_stop(self) -> None:
        """Stop serving (thread-safe); used by ``retire`` and embedders."""

        loop, stop = self._loop, self._stop
        if loop is None or stop is None:
            return
        try:
            loop.call_soon_threadsafe(stop.set)
        except RuntimeError:
            pass

    @property
    def unix_socket_path(self) -> Path:
        # sockaddr_un is capped at roughly 104 bytes on macOS. A hashed,
        # user-specific path in the OS temp directory stays short even when a
        # test/config override has a very deep path. The socket itself is 0600.
        return _unix_socket_path(self.paths)

    @property
    def windows_pipe_name(self) -> str:
        digest = hashlib.sha256(str(self.paths.home).encode()).hexdigest()[:16]
        return rf"\\.\pipe\openagent-host-tools-{digest}"

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop = asyncio.Event()
        singleton_acquired = False
        host_start_attempted = False
        try:
            self._acquire_singleton()
            singleton_acquired = True
            if os.name != "nt":
                self._prepare_unix_socket()
            host_start_attempted = True
            await self.host.start()
            if os.name == "nt":
                await self._run_windows()
            else:
                await self._run_unix()
        finally:
            try:
                await self._close_unix_endpoint()
            finally:
                try:
                    if host_start_attempted:
                        await self.host.close()
                finally:
                    if singleton_acquired:
                        self._release_singleton()

    def _prepare_unix_socket(self) -> None:
        """Claim the pathname before host startup and remember exactly what we own."""

        path = self.unix_socket_path
        _remove_stale_unix_socket(path)
        bound = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        identity: tuple[int, int] | None = None
        try:
            bound.bind(str(path))
            identity = _unix_socket_identity(path)
            path.chmod(0o600)
            bound.setblocking(False)
        except BaseException:
            bound.close()
            _unlink_owned_unix_socket(path, identity)
            raise
        self._unix_socket = bound
        self._unix_socket_identity = identity

    async def _run_unix(self) -> None:
        bound = self._unix_socket
        if bound is None:
            raise RuntimeError("local capability socket was not prepared")
        server = await asyncio.start_unix_server(
            self._handle_unix,
            sock=bound,
            limit=_MAX_LOCAL_BROKER_LINE_BYTES,
        )
        # asyncio owns the bound socket after a successful server creation.
        self._unix_socket = None
        self._unix_server = server
        await server.start_serving()
        assert self._stop is not None
        # Return on retire; cancellation (SIGTERM/SIGINT) also lands here. The
        # endpoint is torn down by ``run`` so both paths share bounded cleanup.
        await self._stop.wait()

    async def _close_unix_endpoint(self) -> None:
        server = self._unix_server
        self._unix_server = None
        if server is not None:
            server.close()
            # Accepted connections keep ``wait_closed`` pending on Python
            # 3.12+. Abort them so their handlers release principals now.
            for writer in list(self._connections):
                transport = writer.transport
                if transport is not None and not transport.is_closing():
                    transport.abort()
            try:
                await asyncio.wait_for(
                    server.wait_closed(), timeout=_ENDPOINT_CLOSE_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                print(
                    "openagent-host-tools: broker connections did not close in "
                    f"{_ENDPOINT_CLOSE_TIMEOUT_SECONDS:g}s; continuing shutdown",
                    file=sys.stderr,
                )
        bound = self._unix_socket
        self._unix_socket = None
        if bound is not None:
            bound.close()
        identity = self._unix_socket_identity
        self._unix_socket_identity = None
        if os.name != "nt":
            _unlink_owned_unix_socket(self.unix_socket_path, identity)

    async def _handle_unix(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writes = asyncio.Lock()
        tasks: set[asyncio.Task[None]] = set()
        event_buffers: dict[asyncio.Task[Any], list[bytes]] = {}
        should_close = asyncio.Event()
        principals: dict[str, str | dict[str, Any]] = {}
        self._connections.add(writer)

        async def on_event(event: dict[str, Any]) -> None:
            data = (
                json.dumps({"type": "event", "event": event}, separators=(",", ":")) + "\n"
            ).encode()
            current = asyncio.current_task()
            if current is not None and current in event_buffers:
                event_buffers[current].append(data)
                return
            async with writes:
                if writer.is_closing():
                    return
                writer.write(data)
                await writer.drain()

        async def process(request: dict[str, Any]) -> None:
            request_type = request.get("type")
            principal = request.get("principal")
            if request_type in {"call", "provider_control", "read_resource"}:
                principal = principal or "local-control-client"
                principals[_principal_id(principal)] = principal
            current = asyncio.current_task()
            assert current is not None
            buffered: list[bytes] = []
            event_buffers[current] = buffered
            try:
                reply = await dispatch_control(self.host, request)
            finally:
                event_buffers.pop(current, None)
            if (
                request_type == "release_principal"
                and reply.frame.get("ok") is True
                and principal
            ):
                principals.pop(_principal_id(principal), None)
            data = (json.dumps(reply.frame, separators=(",", ":")) + "\n").encode()
            async with writes:
                writer.write(data)
                for event_data in buffered:
                    writer.write(event_data)
                await writer.drain()
            if reply.close:
                should_close.set()
            if reply.retire:
                self.request_stop()

        self.host.subscribe_events(on_event)
        self.host.subscribe_catalog(on_event)
        try:
            while not should_close.is_set():
                line = await reader.readline()
                if not line:
                    break
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError("request must be an object")
                except (ValueError, json.JSONDecodeError) as exc:
                    request = {"id": None, "type": "invalid", "_parse_error": str(exc)}
                task = asyncio.create_task(process(request))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
                if request.get("type") in {"shutdown", "retire"}:
                    await should_close.wait()
                    break
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            self._connections.discard(writer)
            self.host.unsubscribe_events(on_event)
            self.host.unsubscribe_catalog(on_event)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            # A control socket belongs to one Desktop/CLI host process. If it
            # disappears without a release frame (crash/SIGKILL), reclaim the
            # principals and their background shells/browser references. A WS
            # reconnect does not close this socket, so it preserves resources.
            for principal in principals.values():
                try:
                    await self.host.release_principal(principal)
                except Exception:
                    continue
            writer.close()
            try:
                await writer.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def _run_windows(self) -> None:  # pragma: no cover - exercised on Windows CI
        from multiprocessing import AuthenticationError
        from multiprocessing.connection import Listener

        loop = asyncio.get_running_loop()
        self._windows_listener = Listener(
            self.windows_pipe_name,
            family="AF_PIPE",
            authkey=_load_or_create_authkey(self.paths),
        )

        def accept_loop() -> None:
            while not self._windows_stop.is_set():
                try:
                    conn = self._windows_listener.accept()
                except AuthenticationError:
                    # One rejected peer must not stop accepting the owner's
                    # subsequent authenticated connections.
                    continue
                except (OSError, EOFError):
                    break
                threading.Thread(
                    target=self._serve_windows_connection,
                    args=(conn, loop),
                    daemon=True,
                ).start()

        thread = threading.Thread(target=accept_loop, name="host-tools-pipe", daemon=True)
        thread.start()
        try:
            assert self._stop is not None
            await self._stop.wait()
        finally:
            self._windows_stop.set()
            self._windows_listener.close()

    def _serve_windows_connection(self, conn, loop: asyncio.AbstractEventLoop) -> None:
        output: queue.Queue[bytes | None] = queue.Queue()
        principals: dict[str, str | dict[str, Any]] = {}
        pending: set[Any] = set()
        event_buffers: dict[asyncio.Task[Any], list[bytes]] = {}

        def on_event(event: dict[str, Any]) -> None:
            data = json.dumps(
                {"type": "event", "event": event}, separators=(",", ":")
            ).encode()
            try:
                current = asyncio.current_task()
            except RuntimeError:
                current = None
            if current is not None and current in event_buffers:
                event_buffers[current].append(data)
            else:
                output.put(data)

        def writer() -> None:
            while True:
                payload = output.get()
                if payload is None:
                    break
                try:
                    conn.send_bytes(payload)
                except (OSError, EOFError):
                    break

        writer_thread = threading.Thread(target=writer, daemon=True)
        writer_thread.start()

        def done(future, request: dict[str, Any]) -> None:
            pending.discard(future)
            try:
                reply, buffered = future.result()
                principal = request.get("principal")
                if (
                    request.get("type") == "release_principal"
                    and reply.frame.get("ok") is True
                    and principal
                ):
                    principals.pop(_principal_id(principal), None)
                output.put(json.dumps(reply.frame, separators=(",", ":")).encode())
                for event_data in buffered:
                    output.put(event_data)
                if reply.close:
                    output.put(None)
                if reply.retire:
                    self.request_stop()
            except Exception as exc:  # noqa: BLE001
                output.put(
                    json.dumps(
                        {
                            "id": None,
                            "type": "response",
                            "ok": False,
                            "error": {"code": "host_error", "message": str(exc)},
                        }
                    ).encode()
                )

        self.host.subscribe_events(on_event)
        self.host.subscribe_catalog(on_event)

        async def dispatch_buffered(
            request: dict[str, Any]
        ) -> tuple[ControlReply, list[bytes]]:
            current = asyncio.current_task()
            assert current is not None
            buffered: list[bytes] = []
            event_buffers[current] = buffered
            try:
                reply = await dispatch_control(self.host, request)
                return reply, buffered
            finally:
                event_buffers.pop(current, None)

        try:
            while True:
                raw = conn.recv_bytes()
                request = json.loads(raw)
                if request.get("type") in {"call", "provider_control", "read_resource"}:
                    principal = request.get("principal") or "local-control-client"
                    principals[_principal_id(principal)] = principal
                future = asyncio.run_coroutine_threadsafe(
                    dispatch_buffered(request), loop
                )
                pending.add(future)
                future.add_done_callback(lambda item, req=request: done(item, req))
                if request.get("type") in {"shutdown", "retire"}:
                    break
        except (OSError, EOFError, json.JSONDecodeError):
            pass
        finally:
            self.host.unsubscribe_events(on_event)
            self.host.unsubscribe_catalog(on_event)
            for future in list(pending):
                future.cancel()
            for principal in principals.values():
                try:
                    asyncio.run_coroutine_threadsafe(
                        self.host.release_principal(principal), loop
                    ).result()
                except Exception:
                    continue
            output.put(None)
            writer_thread.join(timeout=2)
            conn.close()

    def _acquire_singleton(self) -> None:
        lock_path = self.paths.internal / "broker.lock"
        self._lock_file = open(lock_path, "a+b")
        # msvcrt.locking needs a byte to lock. Initialize only an empty file;
        # a contender must not modify an already-owned lock before it knows
        # whether acquisition succeeded.
        self._lock_file.seek(0, os.SEEK_END)
        if self._lock_file.tell() == 0:
            self._lock_file.write(b"0")
            self._lock_file.flush()
        try:
            if os.name == "nt":
                import msvcrt

                self._lock_file.seek(0)
                msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._lock_file.close()
            self._lock_file = None
            raise BrokerAlreadyRunning("local capability broker is already running") from exc
        # Keep the readable owner marker separate from the locked byte: on
        # Windows, msvcrt prevents another process from reading the locked
        # region at all. Only the successful owner may publish this PID.
        try:
            self.paths.broker_pid.write_text(str(os.getpid()), encoding="ascii")
            if os.name != "nt":
                self.paths.broker_pid.chmod(0o600)
        except BaseException:
            self._release_singleton()
            raise

    def _release_singleton(self) -> None:
        if self._lock_file is None:
            return
        try:
            # Remove before unlocking so a successor can never publish its PID
            # and then have this broker erase it during teardown.
            self.paths.broker_pid.unlink(missing_ok=True)
            if os.name == "nt":
                import msvcrt

                self._lock_file.seek(0)
                msvcrt.locking(self._lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            self._lock_file.close()
            self._lock_file = None


class LocalBrokerClient:
    def __init__(self, paths: HostPaths | None = None):
        self.paths = paths or HostPaths.discover()
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._pipe = None

    async def connect(self) -> None:
        if os.name == "nt":  # pragma: no cover - exercised on Windows CI
            from multiprocessing.connection import Client

            digest = hashlib.sha256(str(self.paths.home).encode()).hexdigest()[:16]
            address = rf"\\.\pipe\openagent-host-tools-{digest}"
            self._pipe = await asyncio.to_thread(
                Client,
                address,
                family="AF_PIPE",
                authkey=_load_or_create_authkey(self.paths),
            )
        else:
            self._reader, self._writer = await asyncio.open_unix_connection(
                str(_unix_socket_path(self.paths)),
                limit=_MAX_LOCAL_BROKER_LINE_BYTES,
            )

    async def send(self, value: dict[str, Any]) -> None:
        raw = json.dumps(value, separators=(",", ":")).encode()
        if os.name == "nt":  # pragma: no cover
            await asyncio.to_thread(self._pipe.send_bytes, raw)
        else:
            assert self._writer is not None
            self._writer.write(raw + b"\n")
            await self._writer.drain()

    async def receive(self) -> dict[str, Any] | None:
        if os.name == "nt":  # pragma: no cover
            try:
                raw = await asyncio.to_thread(self._pipe.recv_bytes)
            except (OSError, EOFError):
                return None
        else:
            assert self._reader is not None
            raw = await self._reader.readline()
            if not raw:
                return None
        return json.loads(raw)

    async def close(self) -> None:
        if self._pipe is not None:  # pragma: no cover
            await asyncio.to_thread(self._pipe.close)
            self._pipe = None
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self._writer = None
            self._reader = None


_CONNECT_ERRORS = (OSError, EOFError, ConnectionRefusedError, FileNotFoundError)
_VERSION_RE = re.compile(r"^(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?$")
_PRE_RANK = {"a": 0, "b": 1, "rc": 2}


def _version_key(value: Any) -> tuple | None:
    """Order the PEP 440 subset host-tools releases use (``1.0.0b16``)."""

    if not isinstance(value, str):
        return None
    match = _VERSION_RE.match(value.strip())
    if match is None:
        return None
    release = tuple(int(part) for part in match.group(1).split("."))
    release += (0,) * (4 - len(release))
    pre = match.group(2)
    # A final release sorts after all of its pre-releases.
    pre_key = (_PRE_RANK[pre], int(match.group(3))) if pre else (3, 0)
    post = int(match.group(4)) if match.group(4) else -1
    return (release, pre_key, post)


def broker_is_older(reported: Any, own: str = __version__) -> bool:
    """Whether a running broker should yield to this installation.

    A broker that reports no version predates the handshake and is always
    older. An unparsable or newer version is left alone: clients only ever
    move the shared broker forward, so two installations cannot ping-pong.
    """

    if reported is None:
        return True
    theirs, ours = _version_key(reported), _version_key(own)
    if theirs is None or ours is None:
        return False
    return theirs < ours


async def _probe_broker(paths: HostPaths) -> dict[str, Any] | None:
    """Return the running broker's ``initialize`` result, or None if absent."""

    probe = LocalBrokerClient(paths)
    try:
        await probe.connect()
    except _CONNECT_ERRORS:
        await probe.close()
        return None
    try:
        await probe.send(
            {"id": "version-probe", "type": "initialize", "protocol": "openagent-host-tools/1"}
        )
        while True:
            frame = await asyncio.wait_for(probe.receive(), timeout=5.0)
            if frame is None:
                return None
            if frame.get("id") == "version-probe":
                if frame.get("ok"):
                    return dict(frame.get("result") or {})
                return {}
    except (asyncio.TimeoutError, *_CONNECT_ERRORS, ValueError):
        return {}
    finally:
        await probe.close()


async def _broker_gone(paths: HostPaths, timeout: float) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        probe = LocalBrokerClient(paths)
        try:
            await probe.connect()
        except _CONNECT_ERRORS:
            return True
        finally:
            await probe.close()
        if asyncio.get_running_loop().time() >= deadline:
            return False
        await asyncio.sleep(0.05)


def _legacy_broker_pid(paths: HostPaths) -> int | None:
    """PID of a pre-handshake broker, only if it is verifiably our broker."""

    if os.name == "nt":
        return None
    try:
        pid = int(paths.broker_pid.read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        return None
    if pid <= 1 or pid == os.getpid():
        return None
    try:
        command = subprocess.run(
            ["ps", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    # The pid file is 0600 inside the user-only host home; still require the
    # process to look like a host-tools broker so a recycled PID is never hit.
    if "--broker" not in command.split() or "host" not in command or "tools" not in command:
        return None
    return pid


async def _retire_broker(paths: HostPaths, info: dict[str, Any]) -> bool:
    features = info.get("features") if isinstance(info.get("features"), dict) else {}
    if features.get("retire"):
        client = LocalBrokerClient(paths)
        try:
            await client.connect()
            await client.send({"id": "retire", "type": "retire"})
            while True:
                frame = await asyncio.wait_for(client.receive(), timeout=5.0)
                if frame is None or frame.get("id") == "retire":
                    break
        except (asyncio.TimeoutError, *_CONNECT_ERRORS, ValueError):
            pass
        finally:
            await client.close()
        return await _broker_gone(paths, _RETIRE_TIMEOUT_SECONDS)
    pid = _legacy_broker_pid(paths)
    if pid is None:
        return False
    for signum in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            return await _broker_gone(paths, _RETIRE_TIMEOUT_SECONDS)
        except PermissionError:
            return False
        # Legacy brokers can hang in teardown while peers stay connected, so
        # SIGTERM gets a bounded grace period before SIGKILL.
        if await _broker_gone(paths, _RETIRE_TIMEOUT_SECONDS / 2):
            return True
    return await _broker_gone(paths, _RETIRE_TIMEOUT_SECONDS / 2)


async def _retire_older_broker(paths: HostPaths) -> None:
    info = await _probe_broker(paths)
    if not info:
        # Absent, or answered without a usable initialize: keep current behaviour.
        return
    reported = info.get("host_tools_version")
    if not broker_is_older(reported):
        return
    retired = await _retire_broker(paths, info)
    print(
        "openagent-host-tools: running broker "
        f"{reported or 'without version (legacy)'} is older than {__version__}; "
        + ("retired it" if retired else "could not retire it, using it as is"),
        file=sys.stderr,
    )


async def connect_or_start_broker(paths: HostPaths | None = None) -> LocalBrokerClient:
    paths = paths or HostPaths.discover()
    try:
        await _retire_older_broker(paths)
    except Exception as exc:  # noqa: BLE001 - never block startup on the upgrade path
        print(f"openagent-host-tools: broker version check failed: {exc}", file=sys.stderr)
    client = LocalBrokerClient(paths)
    try:
        await client.connect()
        return client
    except _CONNECT_ERRORS:
        await client.close()
    _spawn_broker(paths)
    deadline = asyncio.get_running_loop().time() + 8.0
    last_error: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
        candidate = LocalBrokerClient(paths)
        try:
            await candidate.connect()
            return candidate
        except (OSError, EOFError, ConnectionRefusedError, FileNotFoundError) as exc:
            last_error = exc
            await candidate.close()
    raise RuntimeError(f"local capability broker did not start: {last_error}")


def _spawn_broker(paths: HostPaths) -> None:
    env = os.environ.copy()
    env["OPENAGENT_HOST_TOOLS_HOME"] = str(paths.home)
    if getattr(sys, "frozen", False):
        command = [sys.executable, "--broker"]
    else:
        command = [sys.executable, "-m", "openagent_host_tools", "--broker"]
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "env": env,
        "close_fds": True,
    }
    if os.name == "nt":  # pragma: no cover
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(command, **kwargs)


class LocalCapabilityClient:
    """Python API for the shared broker, matching ``CapabilityHost`` methods."""

    def __init__(self, paths: HostPaths | None = None):
        self.paths = paths or HostPaths.discover()
        self._transport: LocalBrokerClient | None = None
        self._listener: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._pending_transport: dict[str, LocalBrokerClient] = {}
        self._indeterminate_on_disconnect: set[str] = set()
        self._event_sinks: set[Any] = set()
        self._catalog_sinks: set[Any] = set()
        self._disconnect_sinks: set[Any] = set()
        self._terminal_events: dict[tuple[str, str], dict[str, Any]] = {}
        self._tool_classifications: dict[tuple[str, str], str] = {}
        self._tool_classification_rules: dict[tuple[str, str], dict[str, dict[str, str]]] = {}
        self._catalog_transport: LocalBrokerClient | None = None
        self._catalog_lock = asyncio.Lock()
        self._next_id = 0
        self._lifecycle_lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lifecycle_lock:
            if (
                self._transport is not None
                and self._listener is not None
                and not self._listener.done()
            ):
                return
            stale = self._transport
            self._transport = await connect_or_start_broker(self.paths)
            transport = self._transport
            if stale is not transport:
                self._tool_classifications.clear()
                self._tool_classification_rules.clear()
                self._catalog_transport = None
            self._listener = asyncio.create_task(
                self._listen(transport), name="host-tools-broker-client"
            )
        if stale is not None and stale is not transport:
            await stale.close()
        try:
            await self._request("initialize", protocol="openagent-host-tools/1")
        except Exception:
            await self._connection_lost(transport)
            raise

    async def status(self) -> dict[str, Any]:
        return await self._request("status")

    async def catalog(self) -> list[dict[str, Any]]:
        return await self._load_catalog(force=True)

    def _install_catalog(
        self, servers: list[dict[str, Any]], transport: LocalBrokerClient
    ) -> None:
        self._tool_classifications = {
            (str(server.get("name") or server.get("id") or ""), str(tool.get("name") or "")): str(
                tool.get("classification") or "mutating"
            )
            for server in servers
            if isinstance(server, dict)
            for tool in (server.get("tools") or [])
            if isinstance(tool, dict)
        }
        self._tool_classification_rules = {
            (
                str(server.get("name") or server.get("id") or ""),
                str(tool.get("name") or ""),
            ): _wire_classification_rules(tool.get("classification_by_argument"))
            for server in servers
            if isinstance(server, dict)
            for tool in (server.get("tools") or [])
            if isinstance(tool, dict) and tool.get("classification_by_argument")
        }
        self._catalog_transport = transport

    async def _load_catalog(self, *, force: bool = False) -> list[dict[str, Any]]:
        async with self._catalog_lock:
            transport = self._transport
            if transport is None:
                await self.start()
                transport = self._transport
            assert transport is not None
            if not force and self._catalog_transport is transport:
                return []
            result = await self._request("catalog")
            servers = [
                dict(server)
                for server in (result.get("servers") or [])
                if isinstance(server, dict)
            ]
            if self._transport is transport:
                self._install_catalog(servers, transport)
            return servers

    async def _ensure_tool_classification(
        self,
        server: str,
        tool: str,
        args: dict[str, Any],
    ) -> str:
        key = (server, tool)
        classification = self._tool_classifications.get(key)
        if classification is None:
            await self._load_catalog()
        # Unknown tools fail closed as mutating. The broker will still reject
        # them before dispatch, but a transport loss after a future catalog/call
        # race must never encourage an unsafe automatic retry.
        return _classification_for_arguments(
            self._tool_classifications.get(key, "mutating"),
            self._tool_classification_rules.get(key, {}),
            args,
        )

    async def set_consent(self, enabled: bool, *, version: int = 1):
        result = await self._request("set_consent", enabled=enabled, consent_version=version)
        return result["consent"]

    async def call(
        self,
        server: str,
        tool: str,
        args: dict[str, Any],
        *,
        principal: str | dict[str, Any],
        call_id: str | None = None,
        idempotency_key: str | None = None,
        deadline_ms: int | float | None = None,
        arguments_sha256: str | None = None,
    ) -> ToolResult:
        classification = await self._ensure_tool_classification(server, tool, args)
        result = await self._request(
            "call",
            indeterminate_on_disconnect=classification == "mutating",
            call_id=call_id,
            server=server,
            tool=tool,
            args=args,
            principal=principal,
            idempotency_key=idempotency_key,
            deadline_ms=deadline_ms,
            arguments_sha256=arguments_sha256,
        )
        return ToolResult.from_wire(result)

    async def cancel(self, call_id: str) -> bool:
        result = await self._request("cancel", call_id=call_id)
        return bool(result.get("cancelled"))

    async def read_resource(self, server: str, uri: str, *, principal: str | dict[str, Any],
                            call_id: str | None = None, deadline_ms: int | float | None = None) -> dict[str, Any]:
        return await self._request("read_resource", server=server, uri=uri, principal=principal,
            call_id=call_id or ("resource-" + secrets.token_hex(12)), deadline_ms=deadline_ms)

    async def provider_control(self, server: str, tool: str, arguments: dict[str, Any], *, principal: str | dict[str, Any], call_id: str | None = None) -> ToolResult:
        result = await self._request("provider_control", server=server, tool=tool, args=arguments,
                                     principal=principal, call_id=call_id or ("operator-" + secrets.token_hex(12)))
        return ToolResult.from_wire(result)

    async def release_principal(self, principal: str | dict[str, Any]) -> None:
        await self._request("release_principal", principal=principal)
        principal_id = _principal_id(principal)
        for key, event in list(self._terminal_events.items()):
            if event.get("principal") == principal_id:
                self._terminal_events.pop(key, None)

    async def ack_event(self, principal: str | dict[str, Any], shell_id: str) -> bool:
        result = await self._request("ack_event", principal=principal, shell_id=shell_id)
        principal_id = _principal_id(principal)
        self._terminal_events.pop((principal_id, str(shell_id)), None)
        return bool(result.get("acknowledged"))

    def subscribe_events(self, sink) -> None:
        self._event_sinks.add(sink)
        for event in self._terminal_events.values():
            try:
                result = sink(dict(event))
                if asyncio.iscoroutine(result):
                    asyncio.create_task(result)
            except Exception:
                continue

    def unsubscribe_events(self, sink) -> None:
        self._event_sinks.discard(sink)

    def subscribe_catalog(self, sink) -> None:
        self._catalog_sinks.add(sink)

    def unsubscribe_catalog(self, sink) -> None:
        self._catalog_sinks.discard(sink)

    def subscribe_disconnect(self, sink) -> None:
        self._disconnect_sinks.add(sink)

    def unsubscribe_disconnect(self, sink) -> None:
        self._disconnect_sinks.discard(sink)

    async def close(self) -> None:
        transport = self._transport
        listener = self._listener
        if transport is not None:
            try:
                await self._request("shutdown")
            except Exception:
                pass
        async with self._lifecycle_lock:
            if self._transport is transport:
                self._transport = None
            if self._listener is listener:
                self._listener = None
        if listener is not None and listener is not asyncio.current_task():
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
        if transport is not None:
            await transport.close()
        for request_id, future in self._pending.items():
            if not future.done():
                future.set_exception(self._disconnect_error(request_id))
        self._pending.clear()
        self._pending_transport.clear()
        self._indeterminate_on_disconnect.clear()
        self._terminal_events.clear()
        self._tool_classifications.clear()
        self._tool_classification_rules.clear()
        self._catalog_transport = None

    async def _request(
        self,
        request_type: str,
        *,
        indeterminate_on_disconnect: bool = False,
        **fields: Any,
    ) -> dict[str, Any]:
        if self._transport is None:
            await self.start()
        self._next_id += 1
        request_id = f"py-{self._next_id}"
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        if indeterminate_on_disconnect:
            self._indeterminate_on_disconnect.add(request_id)
        payload = {"id": request_id, "type": request_type}
        payload.update({key: value for key, value in fields.items() if value is not None})
        transport = self._transport
        assert transport is not None
        self._pending_transport[request_id] = transport
        try:
            try:
                await transport.send(payload)
            except (OSError, EOFError, ConnectionError) as exc:
                await self._connection_lost(transport)
                raise self._disconnect_error(request_id) from exc
            return await future
        finally:
            self._pending.pop(request_id, None)
            self._pending_transport.pop(request_id, None)
            self._indeterminate_on_disconnect.discard(request_id)

    async def _listen(self, transport: LocalBrokerClient) -> None:
        try:
            while True:
                frame = await transport.receive()
                if frame is None:
                    break
                if frame.get("type") == "event":
                    event = frame.get("event")
                    if isinstance(event, dict):
                        if event.get("type") == "catalog_changed":
                            servers = event.get("servers")
                            if (
                                isinstance(servers, list)
                                and self._transport is transport
                            ):
                                self._install_catalog(
                                    [
                                        dict(server)
                                        for server in servers
                                        if isinstance(server, dict)
                                    ],
                                    transport,
                                )
                            for sink in list(self._catalog_sinks):
                                try:
                                    result = sink(dict(event))
                                    if asyncio.iscoroutine(result):
                                        await result
                                except Exception:
                                    continue
                            continue
                        if event.get("type") == "shell_completed" and event.get("shell_id"):
                            key = (
                                str(event.get("principal") or ""),
                                str(event["shell_id"]),
                            )
                            self._terminal_events[key] = dict(event)
                        for sink in list(self._event_sinks):
                            try:
                                result = sink(dict(event))
                                if asyncio.iscoroutine(result):
                                    await result
                            except Exception:
                                continue
                    continue
                request_id = str(frame.get("id") or "")
                future = self._pending.get(request_id)
                if future is None or future.done():
                    continue
                if frame.get("ok"):
                    future.set_result(dict(frame.get("result") or {}))
                else:
                    error = frame.get("error") or {}
                    future.set_exception(
                        HostError(
                            str(error.get("code") or "host_error"),
                            str(error.get("message") or "local broker request failed"),
                            dict(error.get("data") or {}),
                        )
                    )
        finally:
            # EOF, malformed/oversized frames and transport implementation
            # errors all invalidate this connection. Always detach it and
            # resolve pending calls through the explicit safety contract.
            await self._connection_lost(transport)

    async def _connection_lost(self, transport: LocalBrokerClient) -> None:
        """Detach one dead transport exactly once and make restart observable."""

        listener = asyncio.current_task()
        async with self._lifecycle_lock:
            if self._transport is not transport:
                return
            self._transport = None
            if self._listener is listener:
                self._listener = None
            self._tool_classifications.clear()
            self._tool_classification_rules.clear()
            self._catalog_transport = None
        try:
            await transport.close()
        except Exception:
            # Closing a broken pipe/socket is best effort; pending calls still
            # need the explicit disconnected/indeterminate result below.
            pass
        for sink in list(self._disconnect_sinks):
            try:
                result = sink()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                continue
        affected = [
            request_id
            for request_id, pending_transport in self._pending_transport.items()
            if pending_transport is transport
        ]
        for request_id in affected:
            future = self._pending.get(request_id)
            if future is None:
                continue
            if not future.done():
                future.set_exception(self._disconnect_error(request_id))

    def _disconnect_error(self, request_id: str) -> HostError:
        if request_id in self._indeterminate_on_disconnect:
            return HostError(
                "CLIENT_RESULT_INDETERMINATE",
                "local broker disconnected after tool dispatch; the effect may have occurred",
                {"local_code": "broker_disconnected"},
            )
        return HostError("broker_disconnected", "local broker disconnected")


def _load_or_create_authkey(paths: HostPaths) -> bytes:
    """Persistent per-user secret authenticating the Windows named pipe."""
    paths.ensure()
    path = paths.broker_authkey
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    except FileExistsError:
        data = path.read_bytes()
        if len(data) < 32:
            raise RuntimeError(f"invalid broker auth key at {path}")
        return data
    data = secrets.token_bytes(32)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    return data


def _unix_socket_identity(path: Path) -> tuple[int, int]:
    metadata = path.lstat()
    if not stat.S_ISSOCK(metadata.st_mode):
        raise RuntimeError(f"refusing to use non-socket broker endpoint at {path}")
    return metadata.st_dev, metadata.st_ino


def _remove_stale_unix_socket(path: Path) -> None:
    """Remove one dead endpoint, preserving anything active or replaced.

    The per-home singleton lock is already held when this runs. The connection
    probe protects an independently managed live endpoint at the same pathname,
    while the inode check prevents deleting a file swapped in after the probe.
    """

    try:
        identity = _unix_socket_identity(path)
    except FileNotFoundError:
        return

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError):
        pass
    except OSError as exc:
        raise BrokerAlreadyRunning(
            f"refusing to replace an unverified local capability socket at {path}"
        ) from exc
    else:
        raise BrokerAlreadyRunning(
            f"local capability socket is already accepting connections at {path}"
        )
    finally:
        probe.close()

    _unlink_owned_unix_socket(path, identity, strict=True)


def _unlink_owned_unix_socket(
    path: Path,
    identity: tuple[int, int] | None,
    *,
    strict: bool = False,
) -> bool:
    if identity is None:
        return False
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    current = (metadata.st_dev, metadata.st_ino)
    if not stat.S_ISSOCK(metadata.st_mode) or current != identity:
        if strict:
            raise RuntimeError(f"broker endpoint changed before stale cleanup: {path}")
        return False
    path.unlink()
    return True


def _unix_socket_path(paths: HostPaths) -> Path:
    digest = hashlib.sha256(str(paths.home).encode()).hexdigest()[:16]
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return Path(tempfile.gettempdir()) / f"openagent-host-tools-{uid}-{digest}.sock"


def _principal_id(value: str | dict[str, Any]) -> str:
    if isinstance(value, str):
        return value.strip()
    allowed = {
        "kind": value.get("kind"),
        "client_instance_id": value.get("client_instance_id"),
        "device_label": value.get("device_label"),
        "account_id": value.get("account_id"),
        "network_id": value.get("network_id"),
        "client_account_id": value.get("client_account_id"),
        "channel_id": value.get("channel_id"),
        "device_id": value.get("device_id"),
        "generation": value.get("generation"),
    }
    return json.dumps(allowed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _wire_classification_rules(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        return {}
    return {
        str(argument): {
            str(option): str(classification)
            for option, classification in options.items()
            if str(classification) in {"read_only", "idempotent", "mutating"}
        }
        for argument, options in value.items()
        if isinstance(options, dict)
    }


def _classification_for_arguments(
    base: str, rules: dict[str, dict[str, str]], arguments: dict[str, Any]
) -> str:
    classification = base if base in {"read_only", "idempotent", "mutating"} else "mutating"
    matches: list[str] = []
    for argument, options in rules.items():
        value = arguments.get(argument)
        if isinstance(value, str):
            matched = options.get(value)
            if matched is not None:
                matches.append(matched)
    if not matches:
        return classification
    risk = {"read_only": 0, "idempotent": 1, "mutating": 2}
    return max(matches, key=risk.__getitem__)
