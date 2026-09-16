"""Minimal MCP stdio client used for configured plugins and optional sidecars."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import socket
from dataclasses import replace
from pathlib import Path
from typing import Any, Awaitable, Callable

from openagent_capability_host._version import __version__
from openagent_capability_host.config import PluginSpec
from openagent_tool_protocol.context import current_principal
from openagent_tool_protocol.types import (
    HostError,
    ServerManifest,
    ToolClassification,
    ToolManifest,
    ToolResult,
)

_MCP_PROTOCOL_VERSION = "2024-11-05"
# MCP stdio uses one JSON-RPC message per line. A single supported 64 MiB raw
# artifact expands to roughly 86 MiB when base64 encoded, so asyncio's 64 KiB
# StreamReader default is far too small for screenshots and other media. Keep a
# finite ceiling above the capability protocol's largest supported artifact to
# avoid turning an untrusted plugin response into an unbounded buffer.
_MAX_MCP_STDIO_LINE_BYTES = 128 * 1024 * 1024


from openagent_capability_host.mcp_stdio import MCPStdioServer

class PerPrincipalMCPPool:
    """Lazy MCP stdio pool isolated by certified network and account.

    Agent-in-Chrome must never share a browser profile, extensions directory,
    or CDP port between networks, even when an account identifier is reused.
    Release closes only that network/account's sidecar while retaining its
    profile for the next connection.
    """

    def __init__(
        self,
        spec: PluginSpec,
        *,
        placeholder: ServerManifest,
        data_root: str | Path,
        on_state_change: (
            Callable[["PerPrincipalMCPPool"], Awaitable[None] | None] | None
        ) = None,
        restart_limit: int = 5,
        restart_initial_delay: float = 0.25,
        restart_max_delay: float = 5.0,
    ):
        self.spec = spec
        self.placeholder = placeholder
        self.data_root = Path(data_root).expanduser().resolve()
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.on_state_change = on_state_change
        self.restart_limit = restart_limit
        self.restart_initial_delay = restart_initial_delay
        self.restart_max_delay = restart_max_delay
        self.manifest = replace(
            placeholder,
            available=True,
            unavailable_reason=None,
            data_directory=str(self.data_root),
        )
        self._instances: dict[str, MCPStdioServer] = {}
        self._ports: dict[str, _PortLease] = {}
        self._principal_accounts: dict[str, str] = {}
        self._account_principals: dict[str, set[str]] = {}
        self._instance_health: dict[str, bool] = {}
        self._instance_reasons: dict[str, str | None] = {}
        self._guard = asyncio.Lock()
        self._probe_lock = asyncio.Lock()
        self._probe_ready = False
        self._probe_restart_attempts = 0
        self._probe_restart_task: asyncio.Task[None] | None = None
        self._closing = False

    async def start(self) -> None:
        """Probe the real MCP handshake/catalog in an isolated throwaway slot."""
        async with self._probe_lock:
            if self._probe_ready:
                return
            probe_key = "catalog-probe"
            adapter, lease = self._build(probe_key, supervise=False)
            try:
                await adapter.start()
                self.manifest = replace(
                    adapter.manifest,
                    platforms=self.placeholder.platforms,
                    os_requirements=self.placeholder.os_requirements,
                    data_directory=str(self.data_root),
                    available=True,
                    unavailable_reason=None,
                )
                self._probe_ready = True
            finally:
                await adapter.close()
                lease.close()

    def supervise_initial_failure(self, error: BaseException) -> None:
        """Retry a transient failure of the pool's catalog probe."""

        if self._closing:
            return
        self.manifest = replace(
            self.manifest,
            available=False,
            unavailable_reason=str(error),
        )
        if (
            self._probe_restart_attempts < self.restart_limit
            and (
                self._probe_restart_task is None
                or self._probe_restart_task.done()
            )
        ):
            self._probe_restart_task = asyncio.create_task(
                self._probe_restart_loop(),
                name=f"mcp-probe-restart-{self.spec.name}",
            )

    async def _probe_restart_loop(self) -> None:
        try:
            while self._probe_restart_attempts < self.restart_limit:
                attempt = self._probe_restart_attempts + 1
                delay = min(
                    self.restart_max_delay,
                    self.restart_initial_delay * (2 ** (attempt - 1)),
                )
                if delay:
                    await asyncio.sleep(delay)
                if self._closing:
                    return
                self._probe_restart_attempts = attempt
                try:
                    await self.start()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self.manifest = replace(
                        self.manifest,
                        available=False,
                        unavailable_reason=(
                            f"MCP {self.spec.name!r} catalog restart {attempt}/"
                            f"{self.restart_limit} failed: {exc}"
                        ),
                    )
                    await self._notify_state_change()
                    continue
                await self._notify_state_change()
                return
        finally:
            if self._probe_restart_task is asyncio.current_task():
                self._probe_restart_task = None

    async def call(self, tool: str, args: dict[str, Any]) -> ToolResult:
        principal = current_principal.get()
        key = _chrome_principal_key(principal)
        assert principal is not None
        async with self._guard:
            self._principal_accounts[principal] = key
            self._account_principals.setdefault(key, set()).add(principal)
            adapter = self._instances.get(key)
            if adapter is None:
                adapter, lease = self._build(key)
                try:
                    await adapter.start()
                except Exception as exc:
                    # Retain the failed generation so its bounded supervisor
                    # can recover without requiring another tool call.  The
                    # instance is scoped to this exact network/account and
                    # must not affect healthy instances in the pool.
                    self._instances[key] = adapter
                    self._ports[key] = lease
                    self._instance_health[key] = False
                    self._instance_reasons[key] = str(exc)
                    adapter.supervise_initial_failure(exc)
                    raise
                self._instances[key] = adapter
                self._ports[key] = lease
                self._instance_health[key] = True
                self._instance_reasons[key] = None
        return await adapter.call(tool, args)

    def availability_for_principal(self, principal: str) -> tuple[bool, str | None]:
        """Return health for one certified network/account only.

        A per-principal Chrome process can be restarting while another account
        on the same computer remains completely healthy.  The pool's public
        manifest therefore describes whether the module is installed, while
        dispatch consults this narrower health view.
        """

        key = _chrome_principal_key(principal)
        if key not in self._instances:
            return True, None
        return (
            self._instance_health.get(key, False),
            self._instance_reasons.get(key),
        )

    async def release_principal(self, principal: str) -> None:
        async with self._guard:
            key = self._principal_accounts.pop(principal, None)
            if key is None:
                return
            principals = self._account_principals.get(key)
            if principals is not None:
                principals.discard(principal)
                if principals:
                    return
                self._account_principals.pop(key, None)
            adapter = self._instances.pop(key, None)
            lease = self._ports.pop(key, None)
            self._instance_health.pop(key, None)
            self._instance_reasons.pop(key, None)
        if adapter is not None:
            await adapter.close()
        if lease is not None:
            await _wait_until_port_free(lease.port)
            lease.close()

    async def close(self) -> None:
        self._closing = True
        probe_restart = self._probe_restart_task
        if probe_restart is not None and probe_restart is not asyncio.current_task():
            probe_restart.cancel()
            await asyncio.gather(probe_restart, return_exceptions=True)
        self._probe_restart_task = None
        async with self._guard:
            instances = list(self._instances.values())
            leases = list(self._ports.values())
            self._instances.clear()
            self._ports.clear()
            self._principal_accounts.clear()
            self._account_principals.clear()
            self._instance_health.clear()
            self._instance_reasons.clear()
        await asyncio.gather(*(adapter.close() for adapter in instances), return_exceptions=True)
        for lease in leases:
            await _wait_until_port_free(lease.port)
            lease.close()

    def _build(
        self, key: str, *, supervise: bool = True
    ) -> tuple[MCPStdioServer, "_PortLease"]:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        principal_root = self.data_root / "principals" / digest[:24]
        profile = principal_root / "profile"
        extensions = principal_root / "extensions"
        profile.mkdir(parents=True, exist_ok=True)
        extensions.mkdir(parents=True, exist_ok=True)
        lease = _PortLease.acquire(self.data_root / "ports", key)
        env = {
            **self.spec.env,
            "OPENAGENT_CHROME_PROFILE_DIR": str(profile),
            "OPENAGENT_CHROME_EXTENSIONS_DIR": str(extensions),
            "OPENAGENT_CHROME_CDP_PORT": str(lease.port),
        }
        isolated = replace(self.spec, env=env)

        async def state_change(adapter: MCPStdioServer) -> None:
            await self._instance_state_changed(key, adapter)

        return (
            MCPStdioServer(
                isolated,
                placeholder=self.placeholder,
                on_state_change=state_change if supervise else None,
                restart_limit=self.restart_limit if supervise else 0,
                restart_initial_delay=self.restart_initial_delay,
                restart_max_delay=self.restart_max_delay,
            ),
            lease,
        )

    async def _instance_state_changed(
        self, key: str, adapter: MCPStdioServer
    ) -> None:
        if self._closing:
            return
        async with self._guard:
            if self._instances.get(key) is not adapter:
                return
            self._instance_health[key] = adapter.manifest.available
            self._instance_reasons[key] = adapter.manifest.unavailable_reason

    async def _notify_state_change(self) -> None:
        if self.on_state_change is None:
            return
        try:
            result = self.on_state_change(self)
            if inspect.isawaitable(result):
                await result
        except Exception:
            return


def _chrome_principal_key(principal: str | None) -> str:
    if not principal:
        raise HostError(
            "account_context_required",
            "agent-in-chrome requires a certified local account principal",
        )
    try:
        value = json.loads(principal)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HostError(
            "account_context_required",
            "agent-in-chrome cannot run without an isolated account id",
        ) from exc
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("account_id"), (str, int))
        or not str(value.get("account_id")).strip()
    ):
        raise HostError(
            "account_context_required",
            "agent-in-chrome cannot run without an isolated account id",
        )
    if (
        not isinstance(value.get("network_id"), (str, int))
        or not str(value.get("network_id")).strip()
    ):
        raise HostError(
            "network_context_required",
            "agent-in-chrome cannot run without a certified network id",
        )
    return json.dumps(
        {
            "account_id": str(value["account_id"]).strip(),
            "network_id": str(value["network_id"]).strip(),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


class _PortLease:
    def __init__(self, port: int, handle):
        self.port = port
        self._handle = handle

    @classmethod
    def acquire(cls, directory: Path, key: str) -> "_PortLease":
        directory.mkdir(parents=True, exist_ok=True)
        start = 28000 + int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 18000
        for offset in range(512):
            port = 28000 + ((start - 28000 + offset) % 18000)
            if not _port_is_free(port):
                continue
            handle = open(directory / f"{port}.lock", "a+b")
            try:
                if os.name == "nt":  # pragma: no cover - Windows CI
                    import msvcrt

                    handle.seek(0)
                    if handle.read(1) == b"":
                        handle.write(b"0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                handle.close()
                continue
            return cls(port, handle)
        raise HostError("chrome_port_unavailable", "no isolated Chrome CDP port is available")

    def close(self) -> None:
        if self._handle is None:
            return
        try:
            if os.name == "nt":  # pragma: no cover - Windows CI
                import msvcrt

                self._handle.seek(0)
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


async def _wait_until_port_free(port: int, timeout: float = 3.0) -> bool:
    """Keep the cross-process port lease until Chromium has really exited."""

    deadline = asyncio.get_running_loop().time() + max(0.0, timeout)
    while not _port_is_free(port):
        if asyncio.get_running_loop().time() >= deadline:
            return False
        await asyncio.sleep(0.05)
    return True
