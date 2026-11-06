#!/usr/bin/env python3
"""Publish qualified product delivery artifacts without rebuilding native code."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1 << 20):
            result.update(block)
    return result.hexdigest()


def receipt(path):
    return {'sha256': digest(path), 'bytes': path.stat().st_size}


def main():
    root, source = map(lambda p: Path(p).resolve(), sys.argv[1:])
    repository = os.environ['GITHUB_REPOSITORY']
    version = os.environ['HOST_VERSION']
    revision = os.environ['BUILD_SOURCE']
    tag = 'v' + version
    index_path = root / 'release-index.json'
    original_index = index_path.read_bytes()
    index = json.loads(original_index)
    assert index['source_commit'] == revision
    assert index['source_repository'] == repository
    assert index['version'] == version and index['source_ref'] == tag
    subprocess.run([sys.executable, str(source / 'packages/host-tools/scripts/release_index.py'),
                    str(root), '--source-commit', revision, '--source-repository', repository], check=True)
    assert index_path.read_bytes() == original_index
    helper = root / 'acquire-host-tools.py'
    helper.write_bytes((source / 'apps/server/scripts/acquire-host-tools.py').read_bytes())
    wheel = root / index['python_wheel']['asset']
    assert digest(wheel) == index['python_wheel']['sha256']
    manifest = {
        'format': 1, 'repository_commit': revision, 'dirty_snapshot': False,
        'qualification': 'six native targets passed host tests and real native launch; macOS signed/notarized/stapled; no Windows Authenticode or physical remote acceptance claim',
        'build_run_id': int(os.environ['BUILD_RUN']),
        'wheels': [{'file': wheel.name, **receipt(wheel)}],
        'installation_files': {
            helper.name: receipt(helper),
            'host-tools.lock.json': {'asset': index_path.name, **receipt(index_path)},
        },
        'native_archives': [{'file': v['asset'], **receipt(root / v['asset'])}
                            for v in index['platforms'].values()],
    }
    manifest_path = root / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    assert digest(manifest_path) == os.environ['MANIFEST_SHA256'], 'Installation cohort manifest differs'
    files = sorted(root.glob('*.tar.gz')) + sorted(root.glob('*.sha256')) + [wheel, index_path, manifest_path, helper]
    expected = {p.name: p for p in files}
    info = json.loads(gh('release', 'view', tag, '--repo', repository,
                         '--json', 'apiUrl,isDraft,targetCommitish'))
    assert info['targetCommitish'] == revision
    draft = info['isDraft']
    release = json.loads(gh('api', info['apiUrl']))
    assert all(a['name'] in expected for a in release['assets']), 'Unrecognized draft assets'
    existing = {a['name']: a for a in release['assets']}
    for name, path in expected.items():
        if name in existing:
            asset = existing[name]
            if asset['state'] != 'uploaded':
                assert draft, 'Published asset is incomplete'
                # Resume an interrupted upload belonging to this exact private
                # draft. Uploaded or published bytes are never overwritten.
                gh('api', '--method', 'DELETE', 'repos/' + repository + '/releases/assets/' + str(asset['id']))
            else:
                assert asset['digest'] == 'sha256:' + digest(path) and asset['size'] == path.stat().st_size, name
                continue
        assert draft, 'A published asset is missing'
        gh('release', 'upload', tag, '--repo', repository, str(path))
    release = json.loads(gh('api', info['apiUrl']))
    assets = {a['name']: a for a in release['assets']}
    assert assets.keys() == expected.keys()
    for name, path in expected.items():
        assert assets[name]['digest'] == 'sha256:' + digest(path) and assets[name]['size'] == path.stat().st_size, name
    if draft:
        gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false')
    published = json.loads(gh('api', info['apiUrl']))
    assert not published['draft']

    def verify_public(asset):
        result = hashlib.sha256()
        total = 0
        request = urllib.request.Request(asset['browser_download_url'], headers={'User-Agent': 'openagent-public-qualification'})
        with urllib.request.urlopen(request, timeout=120) as response:
            while block := response.read(1 << 20):
                result.update(block)
                total += len(block)
                assert total <= asset['size']
        assert total == asset['size'] and 'sha256:' + result.hexdigest() == asset['digest'], asset['name']
        return {'file': asset['name'], 'bytes': total, 'sha256': result.hexdigest()}

    with ThreadPoolExecutor(max_workers=4) as workers:
        public = list(workers.map(verify_public, published['assets']))
    (root / 'public-verification.json').write_text(json.dumps({'tag': tag, 'source_commit': revision, 'anonymous_https': public}, indent=2) + '\n')
    print('Published and anonymously verified ' + str(len(public)) + ' immutable Host Tools assets')


if __name__ == '__main__':
    main()
