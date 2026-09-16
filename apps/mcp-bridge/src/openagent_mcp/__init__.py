"""openagent_mcp — the MCP tool layer.

Backend-agnostic: the same ``ask_agent`` / ``list_agents`` implementations
(``openagent_mcp.tools``) are registered by the standalone stdio server
(``openagent_mcp.server`` over a ``StandaloneBackend``) and by the embedded
openagent-server builtin (over a ``PeerNetworksBackend`` that lives in the
server). Same functions ⇒ identical tool surface in both hosts.
"""

from __future__ import annotations

from . import tools
from .backends.base import Backend, Target

__all__ = ["Backend", "Target", "tools"]
