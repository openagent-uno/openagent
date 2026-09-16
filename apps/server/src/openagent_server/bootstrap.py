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
    pool = await MCPPool.from_db(db, db_path=db.db_path)
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


async def start_stream(session: Any) -> None:
    """Select standalone voice adapters for a multimodal gateway session."""
    from openagent_core.voice.stt_base import resolve_stt
    from openagent_core.voice.tts_base import resolve_tts
    await session.start(stt_factory=resolve_stt, tts_factory=resolve_tts)
