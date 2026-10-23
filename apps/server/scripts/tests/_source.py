"""Locate a module's source file after the 1.1 split.

Source-inspection tests used to read ``apps/server/src/<path>.py`` directly.
The 1.1 split moved most of those modules into installed packages
(``openagent_core``, ``openagent_storage_sqlite``…) and the product's own into
``src/openagent_server``. Resolving through the import system finds the file
the running code is actually loaded from, wherever it lives.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path


def module_path(dotted: str) -> Path:
    """The ``.py`` file (or package ``__init__.py``) for *dotted*."""
    spec = importlib.util.find_spec(dotted)
    if spec is None or spec.origin is None:
        raise ModuleNotFoundError(dotted)
    return Path(spec.origin)


_TS_TOOL_NAME = re.compile(r'^\s*name:\s*"([a-z][a-z0-9_]*)"', re.M)
# esbuild keeps each tool definition as ``name: "x", title|description|...``.
_BUNDLED_TOOL_NAME = re.compile(r'name:\s*"([a-z][a-z0-9_]*)"\s*,\s*(?:title|description|inputSchema)')


def vault_tool_names() -> tuple[set[str], str]:
    """Bare tool names the vault MCP registers, and where they were read.

    A source checkout has ``src/createServer.ts`` under Core's builtin MCP
    directory; an installed product ships only the bundle the agent runs,
    ``openagent_module_vault/resources/vault/dist/server.mjs``.
    """
    from openagent_core.mcp.builtins import BUILTIN_MCP_SPECS, BUILTIN_MCPS_DIR

    source = BUILTIN_MCPS_DIR / BUILTIN_MCP_SPECS["vault"]["dir"] / "src/createServer.ts"
    if source.exists():
        return set(_TS_TOOL_NAME.findall(source.read_text())), str(source)
    bundle = module_path("openagent_module_vault").parent / "resources/vault/dist/server.mjs"
    if not bundle.exists():
        raise FileNotFoundError(f"neither {source} nor {bundle} exists")
    return set(_BUNDLED_TOOL_NAME.findall(bundle.read_text(errors="replace"))), str(bundle)


def host_shell_tool_names() -> set[str]:
    """Tool names the server host's shell registers (openagent-tools' openagent_shell)."""
    text = module_path("openagent_shell.server").read_text()
    return set(re.findall(r'^\s*"(shell_[a-z_]+)",\s*$', text, re.M))
