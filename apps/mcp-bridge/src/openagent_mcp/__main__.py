"""Standalone entrypoint: `openagent-mcp` (console script) / `python -m openagent_mcp`.

Reads OPENAGENT_MCP_CONFIG (a TOML file), builds a StandaloneBackend, and
serves the two tools over stdio.
"""

from __future__ import annotations

import os
import sys

from . import log
from .backends.standalone import StandaloneBackend
from .config import load_config
from .errors import ConfigError
from .identity import resolve_identity_path
from .server import build_server


def main() -> None:
    log.setup(os.environ.get("OPENAGENT_MCP_LOGLEVEL", "INFO"))

    cfg_path = os.environ.get("OPENAGENT_MCP_CONFIG")
    if not cfg_path:
        sys.stderr.write(
            "openagent-mcp: set OPENAGENT_MCP_CONFIG to the path of your "
            "targets TOML file (see examples/targets.example.toml)\n"
        )
        raise SystemExit(2)

    try:
        cfg = load_config(cfg_path)
    except ConfigError as e:
        sys.stderr.write(f"openagent-mcp: config error: {e}\n")
        raise SystemExit(2)

    identity_path = resolve_identity_path(cfg.identity_path)
    backend = StandaloneBackend(
        cfg.targets,
        identity_path=identity_path,
        default_timeout=cfg.default_timeout_secs,
    )
    build_server(backend).run()


if __name__ == "__main__":
    main()
