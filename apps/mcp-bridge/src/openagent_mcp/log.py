"""Logging setup — everything to STDERR.

On a stdio MCP server, STDOUT is the JSON-RPC channel; a stray write there
corrupts the protocol. We route our logger (and the root, so iroh/aiohttp
noise doesn't leak) to stderr.
"""

from __future__ import annotations

import logging
import sys


def setup(level: str = "INFO") -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("openagent_mcp").setLevel(
        getattr(logging, str(level).upper(), logging.INFO)
    )
