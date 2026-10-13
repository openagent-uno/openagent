"""Qualify the installed generic support wheel; external host business is separate."""
from __future__ import annotations
import importlib.metadata
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    import openagent_support
    installed = Path(openagent_support.__file__).resolve()
    if 'site-packages' not in installed.parts:
        raise RuntimeError('Install the support wheel before qualification')
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern='test_support_configuration.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    receipt = {
        'package_version': importlib.metadata.version('openagent-support-integration'),
        'package_file': str(installed), 'qualification': 'generic-host-admission-and-receipts',
        'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
        'external_business_plugin_qualified': False,
    }
    output = ROOT / 'artifacts/support-regression-verification.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2) + '\n')
    return int(not result.wasSuccessful())


if __name__ == '__main__':
    raise SystemExit(main())
