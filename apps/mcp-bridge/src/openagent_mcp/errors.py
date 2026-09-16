"""Typed errors + redaction.

Invite tickets, node ids, relay urls and direct addresses are sensitive
(a ticket + a reachable node ⇒ agent access under the current no-allowlist
reality). ``redact`` scrubs them from any string that could reach a log or
a model-visible tool result.
"""

from __future__ import annotations

import re


class OpenAgentMcpError(Exception):
    """Base for openagent-mcp errors."""


class ConfigError(OpenAgentMcpError):
    """Malformed or unsafe configuration."""


class UnknownTarget(OpenAgentMcpError):
    """ask_agent called with a target that isn't configured."""


_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"oa1[a-z2-7]{12,}"), "oa1<ticket>"),          # invite tickets
    (re.compile(r"\b[0-9a-fA-F]{64}\b"), "<node_id>"),          # iroh node ids
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b"), "<addr>"),  # ipv4:port
    (re.compile(r"\[[0-9a-fA-F:]+\]:\d+"), "<addr6>"),           # [ipv6]:port
    (re.compile(r"https?://[^\s'\"]*(?:relay|iroh\.network)[^\s'\"]*"), "<relay>"),
]


def redact(text: str) -> str:
    """Strip tickets / node ids / addresses / relay urls from *text*."""
    if not text:
        return text
    for pattern, repl in _REDACTIONS:
        text = pattern.sub(repl, text)
    return text
