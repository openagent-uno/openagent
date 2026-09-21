"""Explicit standalone assembly before the shared engine starts.

Library import and Agent construction never seed product capabilities, create
standalone identities, download voice models or replace caller-owned pools.
This module is called only by the standalone server's start operation.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any


async def prepare_agent(agent: Any, config: dict[str, Any]) -> None:
    from openagent_dashboards.migration import ensure_custom_views_storage
    from openagent_core.mcp.pool import MCPPool
    from openagent_server import __version__

    db = agent.memory_db
    if db is None:
        return

    async def dashboard_migration(connection: Any) -> None:
        await ensure_custom_views_storage(connection, app_version=__version__)

    db.add_migration(dashboard_migration)
    await db.connect()
    # The disposable E2E fixture still exercises migrations and authentication,
    # but must not spawn MCPs or initialize a provider runtime.
    if config.get("_local_e2e") is True:
        return
    # Optional OpenAgent modules own their native capabilities. The engine pool
    # contains only the uniform discovery gateway; the MCP module builds and
    # owns protocol connections from the persisted external-server catalog.
    pool = MCPPool.from_config([{"builtin": "tool-search"}], include_defaults=False)
    agent.set_capability_pool(pool)
    await agent.load_model_catalog()


def start_voice_warmups(config: dict[str, Any]) -> set[asyncio.Task]:
    """Return product-owned background tasks so shutdown can drain them."""
    if config.get("_local_e2e") is True:
        return set()
    settings = config.get("voice") or {}
    if settings.get("prefetch", True) is False:
        return set()

    async def whisper() -> None:
        from openagent_core.voice.voice import _load_local_model
        await _load_local_model()

    async def piper() -> None:
        from openagent_core.voice import tts_local
        if tts_local.is_available():
            await tts_local._load_voice(tts_local._resolve_voice_name(None))

    async def guarded(name: str, operation: Any) -> None:
        from openagent_core.core.logging import elog
        try:
            await operation()
            elog(f"{name}.prefetch_done")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            elog(f"{name}.prefetch_error", level="warning", error=type(exc).__name__)

    return {asyncio.create_task(guarded(name, operation), name=f"product-{name}-warmup")
            for name, operation in (("whisper", whisper), ("piper", piper))}


async def start_stream(session: Any, gateway: Any) -> None:
    """Select standalone voice adapters for a multimodal gateway session."""
    from openagent_core.audio_stream import VoiceSTT, VoiceTTS
    from openagent_server.audio_service import service_for_gateway
    voice = service_for_gateway(gateway)
    async def stt(_db): return VoiceSTT(voice)
    async def tts(_db): return VoiceTTS(voice)
    await session.start(stt_factory=stt, tts_factory=tts)


def standalone_spec_resolver(config, *, environment=None):
    """Trusted product composition; persisted row fields cannot replace modules."""
    from openagent_core.mcp.builtins import BUILTIN_MCP_SPECS, resolve_builtin_entry
    product = {"agent-manager": "openagent_product_config.tools.agent_manager.adapters",
               "agent-federation": "openagent_mcp.federation.adapters",
               "messaging": "openagent_server.messaging_tools.adapters"}
    # Dashboard and physical-computer tools belong to an originating App/CLI.
    # The standalone server may separately expose its own workspace filesystem,
    # editor and shell. Those are durable product capabilities with a distinct
    # destination; they never grant access to a connected user's computer.
    client_only = frozenset({"ui-manager", "computer-control", "agent-in-chrome"})
    server_host_tools = frozenset({"filesystem", "editor", "shell"})
    module_native = frozenset({
        "tool-search", "vault", "vault-gate", "attachments", "logs",
        "memory-search", "scheduler", "mcp-manager", "model-manager",
        "workflow-manager", "events-manager", "budget-manager", "skills",
        "skill-data", "delegation", "ptc",
    })

    def server_tool_enabled(name: str) -> bool:
        settings = config.get("server_host_tools", {})
        if settings is False:
            return False
        if settings is None:
            settings = {}
        if not isinstance(settings, dict):
            raise ValueError("server_host_tools must be an object or false")
        if settings.get("enabled", True) is False:
            return False
        selected = settings.get("tools", sorted(server_host_tools))
        if not isinstance(selected, (list, tuple, set, frozenset)):
            raise ValueError("server_host_tools.tools must be a list")
        return name in {str(item).strip() for item in selected}

    def server_tool_environment() -> dict[str, str]:
        """Pass runtime policy and ordinary process settings, never secrets."""
        source = dict(environment or os.environ)
        exact = {
            "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR",
            "USER", "OPENAGENT_MAX_TOOL_RESULT_CHARS",
        }
        prefixes = (
            "LC_", "OPENAGENT_SAFETY_", "OPENAGENT_SANDBOX_",
            "OPENAGENT_TOOL_OFFLOAD_",
        )
        safe = {
            str(key): str(value)
            for key, value in source.items()
            if key in exact or any(str(key).startswith(prefix) for prefix in prefixes)
        }
        safe["PYTHONIOENCODING"] = "utf-8"
        safe["PYTHONUNBUFFERED"] = "1"
        return safe

    def resolve(row, db_path):
        name = row['name']
        if name in server_host_tools:
            if not server_tool_enabled(name):
                return False
            workspace = Path(db_path).resolve().parent if db_path else Path.cwd().resolve()
            return {
                "name": name,
                "command": [
                    sys.executable, "-m", "openagent_host_tools.mcp_server", name,
                ],
                "env": server_tool_environment(),
                "_cwd": str(workspace),
            }
        if name in client_only or name in module_native:
            return False
        if name in product:
            resolved = dict(name=name,in_process=True,adapter_module=product[name],
                            runtime_toolkit_factory="build_runtime_toolkit")
            if name == "messaging":
                resolved["env"] = dict(environment or {})
            return resolved
        if name in BUILTIN_MCP_SPECS:
            # Environment comes from the product's explicit module config,
            # never an arbitrary API-provided PYTHONPATH/argv override.
            env = {**(environment or {}), "OPENAGENT_DB_PATH": str(db_path)}
            configured = (config.get("module_environment") or {}).get(name) or {}
            env.update({str(key):str(value) for key,value in configured.items()})
            return resolve_builtin_entry(name, env=env)
        return None
    return resolve
