"""Locate a module's source file after the 1.1 split.

Source-inspection tests used to read ``apps/server/src/<path>.py`` directly.
The 1.1 split moved most of those modules into installed packages
(``openagent_core``, ``openagent_storage_sqlite``…) and the product's own into
``src/openagent_server``. Resolving through the import system finds the file
the running code is actually loaded from, wherever it lives.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path


def module_path(dotted: str) -> Path:
    """The ``.py`` file (or package ``__init__.py``) for *dotted*."""
    spec = importlib.util.find_spec(dotted)
    if spec is None or spec.origin is None:
        raise ModuleNotFoundError(dotted)
    return Path(spec.origin)
