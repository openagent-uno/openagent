"""Explicit standalone assembly before the shared engine starts.

Library import and Agent construction never seed product capabilities, create
standalone identities, download voice models or replace caller-owned pools.
This module is called only by the standalone server's start operation.
"""
from __future__ import annotations

import asyncio
from typing import Any


async def prepare_agent(agent: Any, config: dict[str, Any]) -> None:
    from openagent_dashboards.migration import ensure_custom_views_storage
    from openagent_core.memory.bootstrap import ensure_builtin_mcps
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
    await ensure_builtin_mcps(db, config=config)
    for name in ("agent-manager", "agent-federation"):
        if await db.get_mcp(name) is None:
            await db.upsert_mcp(name,kind="builtin",builtin_name=name,source="standalone-product")
    pool = await MCPPool.from_db(db, db_path=db.db_path,
                                host_spec_resolver=standalone_spec_resolver(config,environment=getattr(agent,"product_environment",{})))
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
               "agent-federation": "openagent_mcp.federation.adapters"}
    # These old globally registered tools belong to an originating App/CLI.
    contextual = frozenset({"ui-manager", "filesystem", "editor", "shell", "computer-control", "agent-in-chrome"})
    def resolve(row, db_path):
        name = row['name']
        if name in contextual:
            return False
        if name in product:
            return dict(name=name,in_process=True,adapter_module=product[name],
                        runtime_toolkit_factory="build_runtime_toolkit")
        if name in BUILTIN_MCP_SPECS:
            # Environment comes from the product's explicit module config,
            # never an arbitrary API-provided PYTHONPATH/argv override.
            env = {**(environment or {}), "OPENAGENT_DB_PATH": str(db_path)}
            configured = (config.get("module_environment") or {}).get(name) or {}
            env.update({str(key):str(value) for key,value in configured.items()})
            return resolve_builtin_entry(name, env=env)
        return None
    return resolve
