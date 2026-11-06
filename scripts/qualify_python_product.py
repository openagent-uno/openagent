"""Qualify a clean product wheel cohort against its pinned public Core cohort."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def qualify(wheels: Path) -> None:
    manifest = json.loads((wheels/'manifest.json').read_text())
    sha = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    assert manifest['repository_commit'] == sha and not manifest['dirty_snapshot']
    version = json.loads((ROOT/'packaging/workspace.json').read_text())['product_version']
    assert len(manifest['wheels']) == 8
    config_version = tomllib.loads((ROOT/'packages/product-config/pyproject.toml').read_text())['project']['version']
    assert all(row['version'] == (config_version if row['name'] == 'openagent-product-config' else version)
               for row in manifest['wheels'])
    config = tomllib.loads((ROOT/'apps/server/pyproject.toml').read_text())
    # The source manifest is pinned by the maintained installer/pyproject cohort.
    # Direct URL wheel hashes are checked before installing any candidate.
    with tempfile.TemporaryDirectory(prefix='core-cohort-') as temporary:
        core = Path(temporary)
        deps = config['tool']['uv']['constraint-dependencies']
        selected = [dep for dep in deps if dep.startswith(('openagent-core @ ', 'openagent-storage-sqlite @ ', 'openagent-gateway @ ', 'openagent-sdk @ '))]
        assert len(selected) == 4
        paths = []
        for dep in selected:
            url = dep.split(' @ ',1)[1]
            location, digest = url.split('#sha256=',1)
            with urlopen(location,timeout=120) as response:
                payload = response.read(64 << 20)
            assert hashlib.sha256(payload).hexdigest() == digest
            target = core/location.split('/')[-1].split('?')[0]
            target.write_bytes(payload)
            paths.append(str(target))
        paths.extend(str(wheels/row['file']) for row in manifest['wheels'])
        subprocess.run([sys.executable,'-m','pip','install','--upgrade',*paths],check=True)
    subprocess.run([sys.executable,'-m','pip','check'],check=True)
    import importlib
    import importlib.metadata
    for module in ['openagent_server', 'openagent_cli', 'openagent_mcp', 'openagent_client_transport']:
        assert importlib.import_module(module).__version__ == version, module
    subprocess.run([sys.executable,'-m','pytest','tests','-q'],cwd=ROOT,check=True)
    # The existing deterministic Custom Views protocol suite uses its own
    # registry rather than pytest. It needs no live account/configuration.
    import asyncio
    import importlib
    sys.path.insert(0, str(ROOT/'apps/server'))
    importlib.import_module('scripts.tests.test_custom_views')
    from scripts.tests._framework import TESTS
    async def custom_views():
        checks = [(name, fn) for category, name, fn in TESTS if category == 'custom_views']
        assert len(checks) >= 20
        for name, fn in checks:
            await fn(None)
            print('Custom Views: ' + name, flush=True)
    asyncio.run(custom_views())
    # Installed packages, rather than source PYTHONPATH, own the public imports.
    import openagent_dashboards.repository as repository
    assert str(ROOT) not in str(Path(repository.__file__).resolve())
    manifest['qualification'] = 'remote-installed-product-tests-passed'
    (wheels/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheels',type=Path,required=True)
    qualify(parser.parse_args().wheels.resolve())
