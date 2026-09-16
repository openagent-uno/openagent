"""Client identity path resolution.

The standalone client keeps a PERSISTENT Ed25519 key so its Iroh node_id is
stable across runs — which is what makes it enrollment/allowlist-ready and
gives each target a consistent, attributable peer identity. The key bytes
themselves are created + perm-checked (0600) by
``oa_agent_client.load_or_create_identity``; here we only resolve the path
and ensure the parent dir exists with tight perms.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_IDENTITY_PATH = "~/.openagent-mcp/identity.key"


def resolve_identity_path(path: str | None) -> str:
    p = Path(path or DEFAULT_IDENTITY_PATH).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            os.chmod(p.parent, 0o700)
        except OSError:
            pass
    return str(p)
