#!/usr/bin/env python3
"""Preserve available legacy Actions bytes in private canonical draft releases."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location('release_migration', Path(__file__).with_name('migrate-release-assets.py'))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', choices=['app', 'cli', 'server', 'host-tools'], required=True)
    parser.add_argument('--target-commit', required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    args.state_dir.chmod(0o700)
    repo = 'openagent-uno/openagent-' + args.component
    result = subprocess.run(['gh', 'api', '--paginate', '--slurp', f'repos/{repo}/actions/artifacts?per_page=100'],
                            capture_output=True, text=True, check=True)
    artifacts = [a for page in json.loads(result.stdout) for a in page['artifacts']]
    (args.state_dir / 'source-artifacts.json').write_text(json.dumps(artifacts))
    live = [a for a in artifacts if not a['expired']]
    source = {'id': 0, 'tag_name': 'available-actions', 'name': 'Private historical Actions archive: ' + args.component,
        'body': 'Private archive of available historical Actions artifacts. Metadata is backed up separately. Do not publish.',
        'draft': True, 'prerelease': False,
        'assets': [{'name': f'actions-artifact-{a["id"]}.zip', 'size': a['size_in_bytes'], 'digest': a.get('digest'),
            'url': f'https://api.github.com/repos/{repo}/actions/artifacts/{a["id"]}/zip'} for a in live]}
    # A missing upstream digest must be investigated, never silently accepted.
    migration.inventory(source)
    client = migration.GitHub(repo, 'openagent-uno/openagent')
    receipt = migration.copy_release(client, source, 'archive-actions-' + args.component + '-2026-11-02',
                                     args.target_commit, args.state_dir / 'cache')
    (args.state_dir / 'receipt.json').write_text(json.dumps(receipt))
    print(f'Verified {receipt["assets"]} Actions artifacts, {receipt["bytes"]} bytes; archive remains private.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('Archive incomplete (' + type(error).__name__ + '); source remains intact') from None
