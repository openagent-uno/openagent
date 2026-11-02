#!/usr/bin/env python3
"""Copy one reviewed release without changing bytes or exposing drafts.

Git history/ref preservation is a separate prerequisite. A release is kept draft
until every source asset has been verified at the destination. Never clobber an
existing artifact, publish a source draft, or mark a historical import latest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import quote


class GitHub:
    def __init__(self, source: str, destination: str):
        self.source, self.destination = source, destination
        self.release_ids = {}
        self.loaded_index = False

    def api(self, path, method='GET', payload=None):
        args = ['gh', 'api', '--method', method, path]
        if payload is not None:
            args += ['--input', '-']
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def source_release(self, tag):
        return self.api(f'repos/{self.source}/releases/tags/{quote(tag, safe="")}')

    def destination_release(self, tag):
        if tag in self.release_ids:
            return self.api(f'repos/{self.destination}/releases/{self.release_ids[tag]}')
        if self.loaded_index:
            return None
        # Drafts are not returned by the published release-by-tag endpoint.
        result = subprocess.run(['gh', 'api', '--paginate', '--slurp',
                                 f'repos/{self.destination}/releases?per_page=100'],
                                text=True, capture_output=True, check=True)
        for page in json.loads(result.stdout):
            for release in page:
                self.release_ids[release['tag_name']] = release['id']
        self.loaded_index = True
        if tag in self.release_ids:
            return self.api(f'repos/{self.destination}/releases/{self.release_ids[tag]}')
        return None

    def create(self, tag, commit, source):
        release = self.api(f'repos/{self.destination}/releases', 'POST', {
            'tag_name': tag, 'target_commitish': commit, 'name': source['name'] or tag,
            'body': (source.get('body') or '') + '\n\nDistribution mirror of ' + source.get('html_url', self.source) + '. Binary bytes are unchanged; the tag targets the canonical importer, not a rebuild.', 'draft': True,
            'prerelease': source['prerelease'], 'make_latest': 'false'})
        self.release_ids[tag] = release['id']
        return release

    def download(self, asset, destination):
        import time
        for attempt in range(5):
            partial = destination.with_name(destination.name + '.migration-part')
            try:
                with partial.open('wb') as stream:
                    # Actions archive endpoints require the JSON Accept header
                    # before redirecting to their ZIP; release assets require
                    # octet-stream to return bytes instead of asset metadata.
                    headers = [] if '/actions/artifacts/' in asset['url'] else ['-H', 'Accept: application/octet-stream']
                    subprocess.run(['gh', 'api', *headers,
                                    asset['url'] + '?migration=' + str(time.time_ns())],
                                   stdout=stream, stderr=subprocess.PIPE, check=True)
                if (partial.stat().st_size, digest_file(partial)) != (asset['size'], asset['digest']):
                    raise ValueError('Downloaded asset failed its source digest')
                partial.replace(destination)
                return
            except (subprocess.CalledProcessError, ValueError):
                partial.unlink(missing_ok=True)
                if attempt == 4:
                    raise RuntimeError('Asset download failed after bounded retries') from None
                time.sleep(2 ** attempt)

    def upload(self, release, path):
        import http.client
        import os
        import time
        token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
        if not token:
            raise ValueError('GitHub upload authorization is required')
        endpoint = f'/repos/{self.destination}/releases/{release["id"]}/assets?name={quote(path.name, safe="")}'
        for attempt in range(8):
            connection = http.client.HTTPSConnection('uploads.github.com', timeout=300)
            try:
                connection.putrequest('POST', endpoint)
                for key, value in {'Authorization': 'Bearer '+token,
                        'User-Agent': 'openagent-release-consolidation',
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': str(path.stat().st_size)}.items():
                    connection.putheader(key, value)
                connection.endheaders()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1 << 20), b''):
                        connection.send(chunk)
                response = connection.getresponse()
                body = response.read()
                if response.status == 201:
                    # Bound writes across the parallel migration jobs.
                    time.sleep(1.6)
                    return json.loads(body)
                if response.status == 422:
                    existing = self.destination_release(release['tag_name'])
                    asset = next((a for a in existing['assets'] if a['name'] == path.name), None)
                    if asset and (asset['size'], asset.get('digest')) == (path.stat().st_size, digest_file(path)):
                        return asset
                    raise ValueError('Conflicting uploaded asset')
                if response.status not in (403, 429, 500, 502, 503, 504):
                    raise RuntimeError('GitHub upload rejected with HTTP '+str(response.status))
                delay = int(response.getheader('Retry-After') or min(60 * (attempt + 1), 300))
            except (OSError, http.client.HTTPException):
                delay = min(30 * (attempt + 1), 180)
            finally:
                connection.close()
            time.sleep(delay)
        raise RuntimeError('GitHub upload retry limit reached')

    def finish(self, release, source):
        return self.api(f'repos/{self.destination}/releases/{release["id"]}', 'PATCH', {
            'draft': source['draft'], 'prerelease': source['prerelease'], 'make_latest': 'false'})


def digest_file(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1 << 20), b''):
            sha.update(data)
    return 'sha256:' + sha.hexdigest()


def inventory(release):
    result = {}
    for asset in release['assets']:
        name = asset['name']
        if not name or Path(name).name != name or '\\' in name or name in {'.', '..'}:
            raise ValueError('Asset filename is not a safe basename')
        if name in result or not str(asset.get('digest', '')).startswith('sha256:'):
            raise ValueError('Duplicate asset or missing source SHA-256')
        result[name] = (asset['size'], asset['digest'])
    return result


def copy_release(client, source, tag, commit, cache):
    expected = inventory(source)
    cache.mkdir(parents=True, exist_ok=True)
    destination = client.destination_release(tag)
    if destination is None:
        destination = client.create(tag, commit, source)
    actual = inventory(destination)
    if set(actual) - set(expected) or any(expected[name] != value for name, value in actual.items()):
        raise ValueError('Destination contains conflicting or unexpected assets')
    if source['draft'] and not destination['draft']:
        raise ValueError('Refusing a public destination for a private source draft')
    if not destination['draft'] and actual != expected:
        raise ValueError('A partial import must remain draft until verified')
    for asset in source['assets']:
        name = asset['name']
        if name in actual:
            continue
        path = cache / name
        if path.is_symlink():
            raise ValueError('Asset cache cannot follow symbolic links')
        if path.exists() and (path.stat().st_size, digest_file(path)) != expected[name]:
            raise ValueError('Existing cached asset differs from the source')
        if not path.exists():
            client.download(asset, path)
        if (path.stat().st_size, digest_file(path)) != expected[name]:
            raise ValueError('Downloaded asset differs from the source digest/size')
        uploaded = client.upload(destination, path)
        if uploaded is None:
            destination = client.destination_release(tag)
            actual = inventory(destination)
        else:
            actual[name] = (uploaded['size'], uploaded.get('digest'))
        if actual.get(name) != expected[name]:
            raise ValueError('Uploaded asset differs from the verified source')
        # Bound disk use by one asset; the verified source and destination both remain.
        path.unlink()
    destination = client.destination_release(tag)
    if inventory(destination) != expected:
        raise ValueError('Destination release is incomplete')
    destination = client.finish(destination, source)
    if destination['draft'] != source['draft'] or destination['prerelease'] != source['prerelease']:
        raise ValueError('Destination visibility differs from source')
    return {'source_release_id': source['id'], 'source_tag': source['tag_name'],
            'destination_release_id': destination['id'], 'destination_tag': tag,
            'assets': len(expected), 'bytes': sum(size for size, _ in expected.values()),
            'asset_inventory': expected, 'draft': source['draft'], 'verified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='owner/repository')
    parser.add_argument('--destination', default='openagent-uno/openagent')
    parser.add_argument('--source-tag', required=True)
    parser.add_argument('--destination-tag', required=True)
    parser.add_argument('--target-commit', required=True)
    parser.add_argument('--state-dir', required=True, type=Path)
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    args.state_dir.chmod(0o700)
    client = GitHub(args.source, args.destination)
    source = client.source_release(args.source_tag)
    receipt = copy_release(client, source, args.destination_tag, args.target_commit,
                           args.state_dir / 'cache')
    receipt['source_repository'] = args.source
    receipt['destination_repository'] = args.destination
    (args.state_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Verified {receipt["assets"]} assets; source remains intact')


if __name__ == '__main__':
    main()
