"""Standalone config — a TOML file listing target agents.

Config is a FILE (``OPENAGENT_MCP_CONFIG`` → path), never an env blob:
invite tickets are bearer credentials and env vars leak via
``/proc/<pid>/environ``, ``ps -E``, crash dumps and child processes. The
file's perms are checked (0600) unless ``strict_config_perms = false``.

Each target is addressed by an opaque ``name`` (the only token the model
ever sees) and carries either a self-contained invite ``ticket`` or an
explicit ``node_id`` (+ optional ``relay_url`` / ``addresses``).
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from oa_agent_client import InviteTicket

from .backends.base import Target
from .errors import ConfigError


@dataclass(frozen=True)
class Config:
    identity_path: str | None
    default_timeout_secs: int
    strict_config_perms: bool
    targets: list[Target] = field(default_factory=list)


def load_config(path: str) -> Config:
    p = Path(path).expanduser()
    if not p.exists():
        raise ConfigError(f"config file not found: {p}")

    try:
        data = tomllib.loads(p.read_bytes().decode("utf-8"))
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
        raise ConfigError(f"{p} is not valid TOML: {e}") from e

    client = data.get("client", {}) or {}
    strict = bool(client.get("strict_config_perms", True))
    if strict and os.name == "posix":
        mode = p.stat().st_mode & 0o777
        if mode & 0o077:
            raise ConfigError(
                f"{p} is group/world-accessible ({oct(mode)}); tickets are "
                "bearer credentials — run `chmod 600` on it, or set "
                "strict_config_perms = false to override."
            )

    identity_path = client.get("identity_path")
    default_timeout = int(client.get("default_timeout_secs", 900))

    targets: list[Target] = []
    seen: set[str] = set()
    raw_targets = data.get("targets", []) or []
    for i, t in enumerate(raw_targets):
        name = (t.get("name") or "").strip()
        if not name:
            raise ConfigError(f"targets[{i}] is missing 'name'")
        if name in seen:
            raise ConfigError(f"duplicate target name: {name!r}")
        seen.add(name)
        description = (t.get("description") or "").strip()

        ticket = t.get("ticket")
        if ticket:
            try:
                tk = InviteTicket.decode(ticket)
            except Exception as e:
                raise ConfigError(f"target {name!r}: invalid ticket: {e}") from e
            node_id = tk.coordinator_node_id
            relay_url = tk.relay_url
            addresses = tuple(tk.addresses) if tk.addresses else None
        else:
            node_id = (t.get("node_id") or "").strip()
            if not node_id:
                raise ConfigError(
                    f"target {name!r}: needs either 'ticket' or 'node_id'"
                )
            relay_url = t.get("relay_url") or None
            addrs = t.get("addresses") or []
            addresses = tuple(a for a in addrs if a) or None

        targets.append(Target(
            name=name, node_id=node_id, description=description,
            relay_url=relay_url, addresses=addresses,
        ))

    if not targets:
        raise ConfigError(f"{p} configures no [[targets]]")

    return Config(
        identity_path=identity_path,
        default_timeout_secs=default_timeout,
        strict_config_perms=strict,
        targets=targets,
    )
