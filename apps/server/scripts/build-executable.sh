#!/usr/bin/env bash
# Build from the already installed product wheels and prebuilt native bundle.
# Provision the isolated build environment from the release's hash-locked
# wheelhouse first; this command never installs or downloads dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

python - <<'CHECK'
from importlib.metadata import version
from pathlib import Path
import os
import PyInstaller
from openagent_modules import module_assets
for distribution in (
    "openagent-framework", "openagent-core", "openagent-storage-sqlite",
    "openagent-modules", "openagent-identity", "openagent-dashboards",
    "openagent-product-config", "openagent-client-transport", "openagent-mcp",
    "openagent-host-tools", "openagent-device-tools",
):
    if version(distribution) != "1.0.0b1":
        raise SystemExit(f"Unexpected installed version for {distribution}")
module_assets("vault")
bundle = os.environ.get("OPENAGENT_HOST_TOOLS_BUNDLE", "")
if not bundle or not Path(bundle).is_dir():
    raise SystemExit("OPENAGENT_HOST_TOOLS_BUNDLE must name the verified prebuilt device bundle")
CHECK

python -m PyInstaller openagent.spec --clean --noconfirm
python - <<'PACKAGE'
from importlib.metadata import version
from pathlib import Path
import hashlib
import platform
import tarfile
import os
import shutil
os_name = {"Darwin": "macos", "Linux": "linux"}.get(platform.system(), platform.system().lower())
arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
output = Path("dist")
name = f"openagent-{version('openagent-framework')}-{os_name}-{arch}.tar.gz"
# macOS uses the stable .app wrapper for microphone usage declarations.
product = output / ("openagent.app" if (output / "openagent.app").exists() else "openagent")
if not product.exists():
    raise SystemExit("PyInstaller did not produce the expected product artifact")
# TCC-addressable native children remain outside the one-file archive.
# Copy their producer signatures intact; release signing seals the outer App.
if product.suffix == ".app":
    bundle = Path(os.environ["OPENAGENT_HOST_TOOLS_BUNDLE"])
    shutil.copy2(bundle / "node", product / "Contents/MacOS/node")
    helpers = product / "Contents/Helpers"
    helpers.mkdir(exist_ok=True)
    shutil.copytree(bundle / "openagent-computer-control.app",
        helpers / "openagent-computer-control.app", dirs_exist_ok=True)
archive = output / name
with tarfile.open(archive, "w:gz") as stream:
    stream.add(product, arcname=product.name)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n")
print(f"Built {archive}; signing and updater qualification remain separate release gates.")
PACKAGE
