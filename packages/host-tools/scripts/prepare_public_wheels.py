#!/usr/bin/env python3
"""Download the reviewed public dependency closure; build no source or binaries."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

RELEASES = (
    ('core', 'https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.21/',
     '28695103622403e02f06692d869f48b14bb0bbd1e32df4bb38d99e7600d60bd5',
     'cedd0607c5ea3a3df2c95e9d169f4621cac0b3ae'),
    ('tools', 'https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.4/',
     '20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228', None),
)

def fetch(base, filename, digest, destination, size=None):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', filename) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid immutable artifact locator')
    with urllib.request.urlopen(base + filename, timeout=60) as response:
        data = response.read((64 << 20) + 1)
    if len(data) > 64 << 20 or hashlib.sha256(data).hexdigest() != digest or (size is not None and len(data) != size):
        raise ValueError('Public artifact differs from its reviewed digest/size')
    destination.write_bytes(data)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 1, 'artifacts': []}
    names = set()
    for label, base, digest, source in RELEASES:
        manifest = json.loads(fetch(base, 'manifest.json', digest, root/(label+'-manifest.json')))
        if manifest.get('dirty_snapshot') is not False or (source and manifest.get('repository_commit', manifest.get('source_commit')) != source):
            raise ValueError('Public dependency provenance differs from the reviewed source')
        specs = manifest.get('wheels')
        if specs is None:
            specs = [{'file':name, **value} for name,value in manifest['files'].items() if name.endswith('.whl')]
        for spec in specs:
            name = spec['file']
            if name in names or not name.endswith('.whl'):
                raise ValueError('Duplicate or non-wheel dependency')
            names.add(name)
            size = spec.get('bytes', spec.get('size_bytes'))
            data = fetch(base, name, spec['sha256'], root/name, size)
            receipt['artifacts'].append({'file':name, 'sha256':spec['sha256'], 'bytes':len(data), 'release':base})
    if not names:
        raise ValueError('No verified dependency wheels')
    (root/'dependency-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')

if __name__ == '__main__':
    main()
