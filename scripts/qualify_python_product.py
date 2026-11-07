"""Qualify a clean product wheel cohort against its pinned public Core cohort."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib
from urllib.request import urlopen
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def pinned_external_wheels(config: dict) -> list[tuple[str, str, str]]:
    """Include optional module pins, not only the four coupled Core wheels."""
    dependencies = config['tool']['uv']['constraint-dependencies']
    result, names = [], set()
    for dependency in dependencies:
        if not dependency.startswith('openagent-') or ' @ ' not in dependency:
            continue
        name, url = dependency.split(' @ ', 1)
        location, separator, fragment = url.partition('#sha256=')
        parsed = urlsplit(location)
        if (not separator or not re.fullmatch('[a-f0-9]{64}', fragment)
                or parsed.scheme != 'https' or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or not parsed.path.endswith('.whl') or name in names):
            raise ValueError('Every external package needs one exact HTTPS wheel and SHA256')
        names.add(name)
        result.append((name, location, fragment))
    if not {'openagent-core', 'openagent-storage-sqlite', 'openagent-gateway', 'openagent-sdk'} <= names:
        raise ValueError('The coupled public Core cohort is incomplete')
    return result


def qualify(wheels: Path) -> None:
    manifest = json.loads((wheels/'manifest.json').read_text())
    sha = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    assert manifest['repository_commit'] == sha and not manifest['dirty_snapshot']
    version = json.loads((ROOT/'packaging/workspace.json').read_text())['product_version']
    expected = {name: version for name in ('openagent-framework', 'openagent-cli', 'openagent-mcp',
        'openagent-identity', 'openagent-dashboards', 'openagent-support-integration', 'openagent-client-transport')}
    config_version = tomllib.loads((ROOT/'packages/product-config/pyproject.toml').read_text())['project']['version']
    expected['openagent-product-config'] = config_version
    assert len(manifest['wheels']) == len(expected)
    assert {row['name']: row['version'] for row in manifest['wheels']} == expected
    for row in manifest['wheels']:
        filename = row['file']
        assert Path(filename).name == filename and filename.endswith('.whl')
        path = wheels/filename
        assert not path.is_symlink() and path.is_file()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
    config = tomllib.loads((ROOT/'apps/server/pyproject.toml').read_text())
    # The source manifest is pinned by the maintained installer/pyproject cohort.
    # Direct URL wheel hashes are checked before installing any candidate.
    with tempfile.TemporaryDirectory(prefix='core-cohort-') as temporary:
        core = Path(temporary)
        paths = []
        for name, location, digest in pinned_external_wheels(config):
            with urlopen(location,timeout=120) as response:
                payload = response.read((64 << 20) + 1)
            assert len(payload) <= 64 << 20 and hashlib.sha256(payload).hexdigest() == digest, name
            target = core/urlsplit(location).path.rsplit('/',1)[-1]
            target.write_bytes(payload)
            paths.append(str(target))
        paths.extend(str(wheels/row['file']) for row in manifest['wheels'])
        subprocess.run([sys.executable,'-m','pip','install','--upgrade',*paths],check=True)
    subprocess.run([sys.executable,'-m','pip','check'],check=True)
    import importlib
    import importlib.metadata
    for module in ['openagent_server', 'openagent_cli', 'openagent_mcp', 'openagent_client_transport']:
        assert importlib.import_module(module).__version__ == version, module
    assert importlib.metadata.version('openagent-product-config') == config_version
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
