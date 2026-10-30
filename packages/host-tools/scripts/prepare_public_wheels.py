#!/usr/bin/env python3
"""Download the reviewed public dependency closure; build no source or binaries."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

def release_inputs():
    lock = json.loads((Path(__file__).resolve().parents[1] / "public-dependencies.lock.json").read_text())
    if lock.get("schema") != 1 or set(lock.get("releases", {})) != {"core", "tools"}:
        raise ValueError("Expected the sealed Core and Tools public dependency lock")
    result = []
    for label, spec in lock["releases"].items():
        if not isinstance(spec, dict):
            raise ValueError("Unsealed public dependency release: " + label)
        base = spec["base"]
        if not base.startswith("https://github.com/openagent-uno/openagent-") or not base.endswith("/"):
            raise ValueError("Unexpected dependency release origin")
        source = spec["source_commit"]
        if not re.fullmatch(r"[a-f0-9]{40}", source):
            raise ValueError("Expected exact dependency source commit")
        result.append((label, base, spec["manifest_sha256"], source))
    return result

def fetch(base, filename, digest, destination, size=None):
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', filename) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid immutable artifact locator')
    with urllib.request.urlopen(base + filename + '?download=1', timeout=60) as response:
        data = response.read((64 << 20) + 1)
    if len(data) > 64 << 20 or hashlib.sha256(data).hexdigest() != digest or (size is not None and len(data) != size):
        raise ValueError('Public artifact differs from its reviewed digest/size')
    destination.write_bytes(data)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    releases = release_inputs()
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 1, 'artifacts': []}
    names = set()
    for label, base, digest, source in releases:
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
