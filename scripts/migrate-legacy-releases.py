#!/usr/bin/env python3
"""Resume verified historical distribution imports; never delete sources.

Keep detailed inventories private: authenticated source releases include drafts.
Only aggregate progress is emitted to the public Actions log.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import time

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
    source = 'openagent-uno/openagent-' + args.component
    destination = 'openagent-uno/openagent'
    result = subprocess.run(['gh', 'api', '--paginate', '--slurp', f'repos/{source}/releases?per_page=100'],
                            capture_output=True, text=True, check=True)
    releases = [r for page in json.loads(result.stdout) for r in page]
    (args.state_dir / 'source-releases.json').write_text(json.dumps(releases))
    client = migration.GitHub(source, destination)
    total_assets = total_bytes = 0
    for ordinal, release in enumerate(releases, 1):
        for attempt in range(6):
            try:
                receipt = migration.copy_release(client, release, args.component + '-' + release['tag_name'],
                    args.target_commit, args.state_dir / 'cache')
                (args.state_dir / f'receipt-{ordinal:04d}.json').write_text(json.dumps(receipt))
                total_assets += receipt['assets']
                total_bytes += receipt['bytes']
                print(f'Verified release {ordinal}/{len(releases)}; cumulative assets={total_assets}, bytes={total_bytes}', flush=True)
                break
            except Exception as error:
                # Do not leak private draft titles, filenames or API responses.
                print(f'Release {ordinal}: retry {attempt + 1}/6 ({type(error).__name__})', flush=True)
                if attempt == 5:
                    raise SystemExit('Import incomplete; all sources are preserved') from None
                time.sleep(min(60 * (attempt + 1), 300))
                client.loaded_index = False
    print(f'COMPLETE: {len(releases)} releases, {total_assets} assets, {total_bytes} bytes verified; no source deleted.', flush=True)


if __name__ == '__main__':
    main()
