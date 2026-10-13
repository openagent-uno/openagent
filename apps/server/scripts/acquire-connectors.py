#!/usr/bin/env python3
"""Build entrypoint for the same acquisition code shipped in the server wheel."""
import importlib.util
from pathlib import Path
import runpy

MODULE = Path(__file__).resolve().parents[1] / "src/openagent_server/connector_acquisition.py"
SPEC = importlib.util.spec_from_file_location("openagent_connector_acquisition", MODULE)
_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(_module)
acquire = _module.acquire
digest = _module.digest
verify_bundle = _module.verify_bundle
PLATFORMS = _module.PLATFORMS
MAX_BYTES = _module.MAX_BYTES

if __name__ == "__main__":
    runpy.run_path(str(MODULE), run_name="__main__")
