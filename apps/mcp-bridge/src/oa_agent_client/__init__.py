"""oa_agent_client — the thin Iroh *agent-ALPN* client shared by the
standalone ``openagent-mcp`` server and the embedded openagent-server
builtin. Depends only on ``iroh``, ``aiohttp``, ``cbor2`` and
``cryptography`` — no framework internals.
"""

from __future__ import annotations

from .client import AgentClient
from .identity import Identity, load_or_create_identity
from .iroh_node import DialError, IrohNode, NetworkAlpn
from .ticket import InviteTicket, TicketError, looks_like_ticket

__all__ = [
    "AgentClient",
    "Identity",
    "load_or_create_identity",
    "IrohNode",
    "NetworkAlpn",
    "DialError",
    "InviteTicket",
    "TicketError",
    "looks_like_ticket",
]
