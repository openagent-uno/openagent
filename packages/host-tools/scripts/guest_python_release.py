"""Compose an independently installable, hash-locked Python guest from a clean checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from project_metadata import PROJECT_VERSION

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]


def build(output: Path) -> None:
    tag = "host-tools-python-v" + PROJECT_VERSION
    subprocess.run([sys.executable, ROOT / "scripts/build_wheels.py", "--components",
                    "host-tools", "--out", output], check=True)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    if manifest["dirty_snapshot"]:
        raise ValueError("Publish a guest composition from a clean checkout")
    wheel, = manifest["wheels"]
    if wheel["name"] != "openagent-host-tools" or wheel["version"] != PROJECT_VERSION:
        raise ValueError("The built guest wheel differs from the selected product")
    requirements = output / "guest-requirements.txt"
    exported = subprocess.check_output(
        ["uv", "export", "--project", str(PACKAGE), "--locked", "--no-emit-project",
         "--no-dev", "--no-header", "--no-annotate"], text=True)
    origin = f"https://github.com/openagent-uno/openagent/releases/download/{tag}"
    requirements.write_text(exported + f"{wheel['name']} @ {origin}/{wheel['file']}"
                            + f" --hash=sha256:{wheel['sha256']}\n", encoding="utf-8")
    manifest["qualification"] = "Python guest composition"
    manifest["tag"] = tag
    manifest["installation_files"] = {requirements.name: {
        "sha256": hashlib.sha256(requirements.read_bytes()).hexdigest(),
        "bytes": requirements.stat().st_size,
    }}
    manifest["upstream_releases"] = json.loads((PACKAGE / "public-dependencies.lock.json").read_bytes())["releases"]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output.resolve())
