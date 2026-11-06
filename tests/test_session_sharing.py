"""Run the real HTTP/SQLite collaboration regressions in installed qualification."""
import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / "apps/server/scripts/tests/test_collaboration.py"
_spec = importlib.util.spec_from_file_location("sharing_contracts", _path)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
CollaborationTests = _module.CollaborationTests
