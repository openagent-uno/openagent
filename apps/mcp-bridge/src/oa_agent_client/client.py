"""AgentClient — dial an OpenAgent agent over the agent-ALPN and POST /api/chat.

Single source of truth for the agent-to-agent wire call. The client either
OWNS an ``IrohNode`` (standalone: it builds one from a persisted identity)
or BORROWS one (embedded: the host's already-running node is passed in).
The *only* difference between the two consumers is which node the
constructor receives — everything below is identical, which is exactly
what makes "embedded == standalone" provable.

The flow mirrors the proven spike and ``peers.handle_peer_chat`` minus the
DB/gateway state: open one bi-stream to the target on ALPN
``openagent/agent/1`` (no cert — the QUIC handshake proves node_id
ownership), tunnel an HTTP/1.1 ``POST /api/chat`` over it, return the reply.
"""

from __future__ import annotations

import aiohttp

from .identity import load_or_create_identity
from .iroh_node import IrohNode
from .session import AgentDialer, LoopbackProxy


class AgentClient:
    """Reach OpenAgent agents over Iroh agent-ALPN.

    Construct with exactly one of:
      - ``identity_path``  → the client owns its node (standalone).
      - ``node``           → the client borrows a running node (embedded).
    """

    def __init__(
        self,
        *,
        node: IrohNode | None = None,
        identity_path: str | None = None,
    ) -> None:
        if node is None and identity_path is None:
            raise ValueError(
                "AgentClient needs either a running IrohNode (embedded) "
                "or an identity_path to own one (standalone)"
            )
        self._node = node
        self._owns_node = node is None
        self._identity_path = identity_path

    async def start(self) -> None:
        """Build + start the owned node (no-op when a node was borrowed)."""
        if self._owns_node and self._node is None:
            identity = load_or_create_identity(self._identity_path)
            self._node = IrohNode(identity)
            await self._node.start()

    async def stop(self) -> None:
        """Stop the owned node (no-op when a node was borrowed)."""
        if self._owns_node and self._node is not None:
            await self._node.stop()
            self._node = None

    async def node_id(self) -> str:
        """This client's stable Iroh node_id (its identity on every target)."""
        if self._node is None:
            raise RuntimeError("AgentClient.start() not awaited")
        return await self._node.node_id()

    async def chat(
        self,
        *,
        node_id: str,
        message: str,
        session_id: str | None = None,
        relay_url: str | None = None,
        addresses: list[str] | None = None,
        timeout: float = 120.0,
    ) -> dict:
        """POST one message to the target agent's ``/api/chat`` and return its JSON.

        ``relay_url`` / ``addresses`` are first-contact hints (from an
        invite ticket / descriptor); omit them to rely on iroh discovery.
        ``session_id`` is sent only when provided — a ``None`` lets the
        target mint (and, once patched, echo) a fresh peer session id.

        Returns the target's raw reply: at minimum ``{response, model,
        errored}``, plus ``{session_id, created}`` once the target runs the
        peer-session patch. Agent-level problems surface as ``errored=True``;
        only transport failures (``DialError``, timeout) propagate.
        """
        if self._node is None:
            raise RuntimeError("AgentClient.start() not awaited")
        dialer = AgentDialer(
            node=self._node,
            target_node_id=node_id,
            relay_url=relay_url,
            addresses=addresses,
        )
        proxy = LoopbackProxy(stream_factory=dialer.open_agent_stream)
        await proxy.start()
        payload: dict = {"message": message}
        if session_id is not None:
            payload["session_id"] = session_id
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    f"{proxy.base_url}/api/chat",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as resp:
                    if resp.content_type == "application/json":
                        return await resp.json()
                    text = await resp.text()
                    return {"errored": True, "error": text, "status": resp.status}
        finally:
            await proxy.stop()
            await dialer.close()
