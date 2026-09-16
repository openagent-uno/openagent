"""FastMCP stdio server — registers the two shared tools over a Backend.

Concrete, explicitly-typed tool wrappers (NOT ``lambda **kw``) so the MCP
schema exposes ``target`` / ``message`` / ``session_id`` / ``timeout_secs``.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import tools as _tools
from .backends.base import Backend


def build_server(backend: Backend, *, name: str = "openagent-mcp") -> FastMCP:
    mcp = FastMCP(name)

    @mcp.tool()
    async def list_agents() -> dict:
        """List the OpenAgent agents you can reach with ask_agent.

        Returns each agent's short ``name`` (use it as the ``target``
        argument to ask_agent) and a description of what it is for.
        """
        return await _tools.list_agents(backend)

    @mcp.tool()
    async def ask_agent(
        target: str,
        message: str,
        session_id: str | None = None,
        timeout_secs: int | None = None,
    ) -> dict:
        """Send a message to another OpenAgent agent and get its reply.

        Use this to retrieve context/information from, or delegate a task to,
        one of the configured agents (call list_agents for the names).

        Args:
            target: the agent's short name from list_agents.
            message: what to ask or tell it, in natural language.
            session_id: omit / null to START A NEW conversation — the
                returned ``session_id`` is the handle to continue it, so pass
                it back on the next call to resume the same thread. Provide a
                prior ``session_id`` to continue that conversation.
            timeout_secs: optional per-call timeout (clamped to the configured
                default).

        The conversation is a first-class session on the TARGET agent: it can
        itself use its tools, spawn sub-agents, and schedule tasks. Returns
        ``{target, session_id, response, model, errored, error, created}``.
        """
        return await _tools.ask_agent(
            backend,
            target=target,
            message=message,
            session_id=session_id,
            timeout_secs=timeout_secs,
        )

    return mcp
