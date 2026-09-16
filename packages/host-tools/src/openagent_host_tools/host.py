"""Standalone product composition of independent capabilities."""
from __future__ import annotations
import asyncio
import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any
from openagent_capability_host import CapabilityHost as BaseCapabilityHost
from openagent_tool_protocol.context import current_principal
from openagent_tool_protocol.types import CapabilityServer, HostError, ServerManifest, ToolResult
from openagent_filesystem import FilesystemServer
from openagent_editor import EditorServer
from openagent_shell import ShellServer
from .chrome_pool import PerPrincipalMCPPool
from .config import PluginSpec
from .paths import HostPaths
from .sidecars import AGENT_IN_CHROME_MANIFEST, COMPUTER_CONTROL_MANIFEST, discover_sidecars

class CapabilityHost(BaseCapabilityHost):
    def __init__(self, *, paths=None, cwd=None, builtin_names=None, **kwargs):
        paths = paths or HostPaths.discover()
        cwd = Path(cwd or Path.cwd()).expanduser().resolve()
        all_names = ("filesystem", "editor", "shell", "computer-control", "agent-in-chrome")
        selected = tuple(all_names if builtin_names is None else builtin_names)
        if len(selected) != len(set(selected)) or any(name not in all_names for name in selected):
            raise ValueError("builtin_names must contain distinct supported local capabilities")
        kwargs.setdefault("process_environment", dict(os.environ))
        factories = {"filesystem": lambda: FilesystemServer(cwd), "editor": lambda: EditorServer(cwd),
                     "shell": lambda: ShellServer(cwd, event_sink=self._emit_event, environment=kwargs["process_environment"])}
        servers = tuple(factories[name]() for name in selected if name in factories)
        platforms = ("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64")
        for server in servers:
            server.manifest = replace(server.manifest, platforms=platforms, os_requirements=("Runs with the signed-in user's OS permissions",), data_directory=str(paths.internal / server.manifest.name))
        self._selected_sidecars = frozenset(name for name in selected if name not in factories)
        inventory = tuple(replace(manifest, data_directory=str(paths.internal / manifest.name))
                          for manifest in (COMPUTER_CONTROL_MANIFEST, AGENT_IN_CHROME_MANIFEST)
                          if manifest.name in self._selected_sidecars)
        super().__init__(paths=paths, cwd=cwd, servers=servers, inventory=inventory, allow_plugins=True, **kwargs)

    def _normalize_principal(self, value):
        return _principal_id(value)

    def _mark_result(self, result):
        _mark_client_local(result)

    async def _validate_provider(self, provider, server, tool, args, principal, call_id):
        if server == "agent-in-chrome":
            try:
                _require_browser_network_context(principal)
            except HostError as exc:
                await self._audit_denial(call_id, principal, server, tool, args, exc.code)
                raise
            principal_health = getattr(
                provider, "availability_for_principal", None
            )
            if principal_health is not None:
                available, reason = principal_health(principal)
                if not available:
                    await self._audit_denial(
                        call_id,
                        principal,
                        server,
                        tool,
                        args,
                        "plugin_unavailable",
                    )
                    raise HostError(
                        "plugin_unavailable",
                        reason
                        or "agent-in-chrome is restarting for this account",
                    )
        if server == "computer-control" and args.get("action") in {
            "start_screen_recording",
            "stop_screen_recording",
        }:
            owner = self._resource_owners.get((server, "screen-recording"))
            if owner is not None and owner != principal:
                await self._audit_denial(
                    call_id,
                    principal,
                    server,
                    tool,
                    args,
                    "resource_owner_mismatch",
                )
                raise HostError(
                    "resource_owner_mismatch",
                    "screen recording belongs to a different local client account",
                )


    async def _release_owned_resources(self, principal_id):
        recording_key = ("computer-control", "screen-recording")
        if self._resource_owners.get(recording_key) == principal_id:
            provider = self._servers.get("computer-control")
            if provider is not None:
                token = current_principal.set(principal_id)
                try:
                    await provider.call("computer", {"action": "stop_screen_recording"})
                except Exception:
                    pass
                finally:
                    current_principal.reset(token)

    def _update_resource_ownership(
        self,
        server: str,
        args: dict[str, Any],
        principal: str,
        result: ToolResult,
    ) -> None:
        if server != "computer-control" or result.is_error:
            return
        action = args.get("action")
        key = (server, "screen-recording")
        if action == "start_screen_recording":
            self._resource_owners[key] = principal
        elif action == "stop_screen_recording":
            self._resource_owners.pop(key, None)

    async def _start_external_locked(self) -> None:
        if self._external_started:
            return
        self._external_started = True
        try:
            configured = {spec.name: spec for spec in self.plugin_store.load() if spec.enabled}
        except Exception as exc:  # malformed config is visible but core built-ins remain usable
            self._health["client-mcps.toml"] = {
                "available": False,
                "reason": str(exc),
                "source": "config",
            }
            configured = {}

        reserved = {"filesystem", "editor", "shell"}
        for name in sorted(set(configured) & reserved):
            self._health[name] = {
                "available": True,
                "reason": f"configured plugin {name!r} ignored because the built-in owns that name",
                "source": "builtin",
            }
            configured.pop(name, None)

        # Explicit config wins for optional sidecars; otherwise use packaged/PATH discovery.
        for candidate in (discover_sidecars() if self._selected_sidecars else ()):
            if candidate.name not in self._selected_sidecars:
                continue
            placeholder = self._inventory.get(candidate.name, candidate.placeholder)
            spec = configured.pop(candidate.name, None)
            if spec is None and candidate.command is not None:
                spec = PluginSpec(candidate.name, candidate.command)
            if spec is None:
                self._inventory[candidate.name] = replace(
                    placeholder,
                    available=False,
                    unavailable_reason=candidate.reason,
                )
                self._health[candidate.name] = {
                    "available": False,
                    "reason": candidate.reason,
                    "source": "sidecar",
                }
                continue
            if candidate.name == "agent-in-chrome":
                await self._start_chrome_pool(spec, placeholder=placeholder)
            else:
                await self._start_mcp(spec, placeholder=placeholder, source="sidecar")

        for spec in configured.values():
            await self._start_mcp(spec, placeholder=None, source="plugin")

    async def _start_chrome_pool(self, spec: PluginSpec, *, placeholder: ServerManifest) -> None:
        adapter = PerPrincipalMCPPool(
            spec,
            placeholder=placeholder,
            data_root=self.paths.internal / "agent-in-chrome",
            on_state_change=self._on_external_state_change,
            restart_limit=self.external_restart_limit,
            restart_initial_delay=self.external_restart_initial_delay,
            restart_max_delay=self.external_restart_max_delay,
        )
        self._servers[spec.name] = adapter
        self._external_names.add(spec.name)
        self._inventory[spec.name] = replace(
            placeholder,
            available=False,
            unavailable_reason=f"MCP {spec.name!r} is starting",
        )
        self._health[spec.name] = {
            "available": False,
            "reason": f"MCP {spec.name!r} is starting",
            "source": "sidecar-per-network-account",
        }
        try:
            await adapter.start()
        except Exception as exc:
            adapter.manifest = replace(
                adapter.manifest, available=False, unavailable_reason=str(exc)
            )
            self._inventory[spec.name] = adapter.manifest
            self._health[spec.name] = {
                "available": False,
                "reason": str(exc),
                "source": "sidecar-per-network-account",
            }
            adapter.supervise_initial_failure(exc)
            return
        self._inventory[spec.name] = adapter.manifest
        self._health[spec.name] = {
            "available": True,
            "reason": None,
            "source": "sidecar-per-network-account",
        }


def _principal_id(value: str | dict[str, Any]) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
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
        if not allowed["client_instance_id"]:
            raise HostError("invalid_principal", "principal.client_instance_id is required")
        return json.dumps(allowed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    raise HostError("invalid_principal", "principal must be a string or object")


def _require_browser_network_context(principal: str) -> None:
    try:
        value = json.loads(principal)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HostError(
            "network_context_required",
            "agent-in-chrome requires a certified network id",
        ) from exc
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("network_id"), (str, int))
        or not str(value.get("network_id")).strip()
    ):
        raise HostError(
            "network_context_required",
            "agent-in-chrome requires a certified network id",
        )


def _mark_client_local(result: ToolResult) -> None:
    result.meta = {
        **result.meta,
        "openagent/location": "client",
        "openagent/pathSemantics": "client-local",
    }
