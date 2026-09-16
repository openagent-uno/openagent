"""StandaloneBackend — owns an Iroh node; targets come from config.

Used by the standalone stdio server (Claude Code, any MCP host). The node
is started lazily on the first dial so ``IrohNode.start`` binds to the MCP
server's running event loop.
"""

from __future__ import annotations

import asyncio

from oa_agent_client import AgentClient

from .base import Target


class StandaloneBackend:
    def __init__(
        self,
        targets: list[Target],
        *,
        identity_path: str,
        default_timeout: float = 900.0,
    ) -> None:
        self._targets = list(targets)
        self._client = AgentClient(identity_path=identity_path)
        # Generous by default so long jobs run to completion synchronously;
        # anything longer persists to the session and is resumable.
        self.default_timeout = float(default_timeout)
        self._started = False
        self._lock = asyncio.Lock()

    async def _ensure_started(self) -> None:
        if self._started:
            return
        async with self._lock:
            if not self._started:
                await self._client.start()
                self._started = True

    async def node_id(self) -> str:
        await self._ensure_started()
        return await self._client.node_id()

    async def list_targets(self) -> list[Target]:
        return list(self._targets)

    async def dial(
        self,
        target: Target,
        message: str,
        session_id: str | None,
        timeout: float,
    ) -> dict:
        await self._ensure_started()
        return await self._client.chat(
            node_id=target.node_id,
            message=message,
            session_id=session_id,
            relay_url=target.relay_url,
            addresses=list(target.addresses) if target.addresses else None,
            timeout=timeout,
        )

    async def aclose(self) -> None:
        if self._started:
            await self._client.stop()
            self._started = False
