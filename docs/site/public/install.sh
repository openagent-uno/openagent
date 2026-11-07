#!/bin/sh
# Install the qualified OpenAgent 1.1 server or CLI from pinned
# canonical, independently versioned GitHub release manifests.
set -eu

PRODUCT="server"
PREFIX=""
CHECK_ONLY="0"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --cli) PRODUCT="cli"; shift ;;
        --server) PRODUCT="server"; shift ;;
        --prefix) PREFIX="$2"; shift 2 ;;
        --prefix=*) PREFIX="${1#*=}"; shift ;;
        --check) CHECK_ONLY="1"; shift ;;
        -h|--help)
            cat <<'EOF'
OpenAgent 1.1 installer

Flags:
  --server       Install the standalone server (default)
  --cli          Install the CLI
  --prefix DIR   Directory for the command symlink (default: ~/.local/bin)
  --check        Download and verify the complete wheelhouse without installing
EOF
            exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' 2>/dev/null; then
        PYTHON="$candidate"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "OpenAgent 1.1 requires Python 3.11 or newer." >&2
    exit 1
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openagent-install.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
WHEELHOUSE="$TMP_DIR/wheels"
mkdir -p "$WHEELHOUSE"

"$PYTHON" - "$WHEELHOUSE" "$PRODUCT" <<'PY'
from __future__ import annotations

from email.parser import BytesParser
import hashlib
import json
from pathlib import Path
import sys
import time
import zipfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

destination = Path(sys.argv[1])
releases = (
    ('openagent-uno/openagent', 'v1.1.9-beta.17', 'manifest.json', 'aa57768d15a00faa7d2c6138144e3f1b485017954cc83e43d8b2ae80009beb87', 'all'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.53', 'manifest.json', '6f2c22fd7de22943e0df2c93068aa057f110122f3919585047a99770ae87a23b', 'kernel'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.53', 'manifest.json', '6f2c22fd7de22943e0df2c93068aa057f110122f3919585047a99770ae87a23b', 'modules'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.40', 'manifest.json', '6da7326924459cebe3f73aea3797fdafb10c02b8c211193a332cc399b80f80e3', 'capability-host'),
    ('openagent-uno/openagent-tools', 'v1.0.0-beta.6', 'manifest.json', 'f7d4dbb5c2a17687266ad3c74a8d796c9e2787d8bf5a2617dadcdce1f0fc46bd', 'tools-base'),
    ('openagent-uno/openagent-tools', 'device-tools-v1.0.0-beta.18', 'manifest.json', '34a56c6adaaf4c84ad5da82b5bedb034e7a5facdb22fc098c3b8c3db55f6b7ea', 'all'),
    ('openagent-uno/openagent', 'channel-bridges-v0.1.0-beta.19', 'manifest.json', '698da2f1986bacb796c80f7a8575c2b431bb8143cc0c9640ce5aabd3ef7032c4', 'all'),
    ('openagent-uno/openagent', 'v1.0.0b15', 'manifest.json', '3f2706789a52cc08b42dff5177d54936205ba3843da1af7c65d51434e97580fe', 'all'),
)
headers = {"Accept": "application/vnd.github+json", "User-Agent": "openagent-site-installer"}


def fetch(url: str, *, max_bytes: int = 64 << 20) -> bytes:
    attempts = 5
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=headers), timeout=60) as response:
                payload = response.read(max_bytes + 1)
                if len(payload) > max_bytes:
                    raise RuntimeError(f"Download exceeds the size limit: {url}")
                return payload
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise RuntimeError(f"Could not download {url}: HTTP {error.code}") from error
        except (URLError, TimeoutError) as error:
            if attempt == attempts - 1:
                raise RuntimeError(f"Could not download {url}: {error}") from error
        time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


verified = 0
for repository, tag, manifest_name, manifest_digest, selection in releases:
    api = f"https://api.github.com/repos/{repository}/releases/tags/{tag}"
    release = json.loads(fetch(api, max_bytes=1 << 20))
    assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
    if manifest_name not in assets:
        raise SystemExit(f"{repository} {tag}: missing {manifest_name}")

    manifest_bytes = fetch(assets[manifest_name], max_bytes=1 << 20)
    if hashlib.sha256(manifest_bytes).hexdigest() != manifest_digest:
        raise SystemExit(f"{repository} {tag}: pinned manifest checksum mismatch")
    manifest = json.loads(manifest_bytes)
    for local_name, receipt in manifest.get("installation_files", {}).items():
        if local_name not in {"acquire-host-tools.py", "host-tools.lock.json"}:
            raise SystemExit("Unsupported installation helper")
        asset = receipt.get("asset", local_name)
        if asset not in assets:
            raise SystemExit(f"Missing installation helper: {asset}")
        payload = fetch(assets[asset], max_bytes=1 << 20)
        if hashlib.sha256(payload).hexdigest() != receipt["sha256"]:
            raise SystemExit(f"Installation helper checksum mismatch: {asset}")
        (destination / local_name).write_bytes(payload)
    if "artifacts" in manifest:
        expected = {item.get("path", item.get("file")): item["sha256"] for item in manifest["artifacts"]}
    elif "wheels" in manifest:
        expected = {item["file"]: item["sha256"] for item in manifest["wheels"]}
    else:
        expected = {
            name: receipt["sha256"]
            for name, receipt in manifest.get("files", {}).items()
            if name.endswith(".whl")
        }

    wheel_assets = {name: url for name, url in assets.items() if name.endswith(".whl")}
    if selection == "modules":
        wheel_assets = {name: url for name, url in wheel_assets.items()
                        if name.startswith(("openagent_module_", "openagent_modules-", "openagent_modules_full-"))}
    elif selection == "capability-host":
        wheel_assets = {name: url for name, url in wheel_assets.items() if name.startswith("openagent_capability_host-")}
    elif selection == "tools-base":
        wheel_assets = {name: url for name, url in wheel_assets.items() if not name.startswith("openagent_device_tools-")}
    elif selection == "kernel":
        wheel_assets = {name: url for name, url in wheel_assets.items()
                        if name.startswith(("openagent_core-", "openagent_storage_sqlite-", "openagent_gateway-", "openagent_sdk-"))}
    elif selection == "config":
        wheel_assets = {name: url for name, url in wheel_assets.items() if name.startswith("openagent_product_config-")}
    elif selection != "all":
        raise SystemExit(f"Unsupported first-party artifact selection: {selection}")
    if not wheel_assets:
        raise SystemExit(f"{repository} {tag}: no selected wheels found")

    for name, url in wheel_assets.items():
        digest = expected.get(name)
        if not digest:
            raise SystemExit(f"{repository} {tag}: {name} is absent from the pinned manifest")
        payload = fetch(url)
        actual = hashlib.sha256(payload).hexdigest()
        if actual != digest:
            raise SystemExit(f"{repository} {tag}: checksum mismatch for {name}")
        target = destination / name
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise SystemExit(f"Conflicting immutable artifact across releases: {name}")
        target.write_bytes(payload)
        verified += 1

# Resolve installation requirements from the exact wheel bytes just verified.
# A separately maintained version literal can silently select an older release
# or a package from an index instead of the manifest-qualified wheelhouse.
versions = {}
first_party = []
for wheel in destination.glob("*.whl"):
    with zipfile.ZipFile(wheel) as archive:
        entries = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(entries) != 1:
            raise SystemExit(f"Ambiguous wheel metadata: {wheel.name}")
        metadata = BytesParser().parsebytes(archive.read(entries[0]))
    name, version = metadata["Name"], metadata["Version"]
    if not name or not version or name in versions:
        raise SystemExit(f"Missing or duplicate distribution metadata: {wheel.name}")
    versions[name] = version
    first_party.append(name + " @ " + wheel.resolve().as_uri())
product = sys.argv[2]
if product == "server":
    requirements = [
        "openagent-framework[discord,slack,whatsapp]==" + versions["openagent-framework"],
        "openagent-core[engine,providers,modules]==" + versions["openagent-core"],
    ]
else:
    requirements = ["openagent-cli==" + versions["openagent-cli"]]
# Direct constraints bind each selected first-party distribution to verified
# local bytes without installing unrelated products from the wheelhouse.
(destination / "first-party-constraints.txt").write_text("\n".join(sorted(first_party)) + "\n")
(destination / "install-requirements.txt").write_text("\n".join(requirements) + "\n")
print(f"Verified {verified} first-party wheels from the canonical releases.")
PY

if [ "$CHECK_ONLY" = "1" ]; then
    echo "OpenAgent release wheelhouse verification passed."
    exit 0
fi

INSTALL_ROOT="${OPENAGENT_INSTALL_ROOT:-$HOME/.local/share/openagent/v1.1-beta}"
VENV="$INSTALL_ROOT/venv"
mkdir -p "$INSTALL_ROOT"
if [ ! -x "$VENV/bin/python" ]; then
    "$PYTHON" -m venv "$VENV"
fi

if [ "$PRODUCT" = "server" ]; then
    # The Discord, Slack and WhatsApp bridges import their SDKs only when a
    # configured channel starts, so a bare Framework wheel cannot run them.
    # Telegram is already a base dependency of the Framework wheel.
    COMMAND="openagent"
else
    COMMAND="openagent-cli"
fi

# The installer must not let ``--pre`` upgrade unrelated transitive packages
# to release candidates merely because the first-party product is a beta.
# These are the versions qualified by the product wheel test environment.
CONSTRAINTS="$TMP_DIR/constraints.txt"
cat >"$CONSTRAINTS" <<'EOF'
hf-xet==1.7.0
litellm==1.105.0
pydantic==2.14.1
pydantic-core==2.50.1
SQLAlchemy==2.1.4
PyJWT==2.14.0
urllib3==2.8.0
discord.py==2.7.1
slack-bolt==1.30.0
slack-sdk==3.45.0
# Newer WhatsApp clients require aiogram, which caps pydantic below the
# qualified 2.14 line. 0.0.49 has the same Green API surface over requests.
whatsapp-api-client-python==0.0.49
EOF

"$VENV/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$VENV/bin/python" -m pip install --disable-pip-version-check \
    --constraint "$CONSTRAINTS" --constraint "$WHEELHOUSE/first-party-constraints.txt" --find-links "$WHEELHOUSE" \
    --requirement "$WHEELHOUSE/install-requirements.txt"

# The public Python facade needs the complete native distribution for browser
# tools (including its Node runtime and dependencies), even in a wheel install.
"$VENV/bin/python" - "$INSTALL_ROOT" "$WHEELHOUSE" <<'PY'
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import openagent_device_tools

root = Path(sys.argv[1]).resolve()
wheels = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("verified_host_acquisition", wheels / "acquire-host-tools.py")
acquisition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acquisition)
lock_path = wheels / "host-tools.lock.json"
lock = json.loads(lock_path.read_text())
machine = platform.machine().lower()
architecture = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
target = f"{sys.platform}-{architecture}"
parent = root / "native-host-tools"
output = parent / lock["version"]
bundle = output / target
if bundle.exists():
    acquisition.verify_bundle(bundle, lock["platforms"][target]["bundle_manifest_sha256"], lock["version"])
else:
    bundle = acquisition.acquire(lock_path=lock_path, platform_key=target, output=output)
link = Path(openagent_device_tools.__file__).parent / "bin"
if link.exists() or link.is_symlink():
    if not link.is_symlink() or parent not in link.resolve().parents:
        raise SystemExit("Refusing to replace an independently managed tool directory")
temporary = link.with_name("bin.installing")
if temporary.exists() or temporary.is_symlink():
    raise SystemExit("An unfinished native tool link already exists")
temporary.symlink_to(bundle, target_is_directory=True)
os.replace(temporary, link)
print(f"Installed verified Host Tools {lock['version']} ({target}).")
PY

if [ "$PRODUCT" = "server" ]; then
    # Reuse the same manifest/archive verifier used by frozen server builds.
    # The wheel owns this lock and helper; no source checkout or local Go build.
    "$VENV/bin/python" - "$INSTALL_ROOT" "$WHEELHOUSE" <<'PY'
import json
import os
from pathlib import Path
import platform
import sys
import openagent_server.connector_acquisition as acquisition

lock_path = Path(acquisition.__file__).with_name("connectors.lock.json")
lock = json.loads(lock_path.read_text())
machine = platform.machine().lower()
architecture = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
target = f"{sys.platform}-{architecture}"
if target not in acquisition.PLATFORMS:
    raise SystemExit(f"No qualified connector runner for {target}")
bundle = Path(sys.argv[1]).resolve() / "connectors" / lock["version"] / target
if bundle.exists():
    acquisition.verify_bundle(lock, target, bundle)
else:
    acquisition.acquire(lock_path, target, bundle, Path(sys.argv[2]))
name = "openagent-connector-runner.exe" if sys.platform == "win32" else "openagent-connector-runner"
destination = Path(sys.executable).parent / name
if destination.exists() and not destination.is_symlink():
    raise SystemExit("Refusing to replace an existing non-symlink connector executable")
temporary = destination.with_name(destination.name + ".new")
if temporary.exists() or temporary.is_symlink():
    raise SystemExit("An unfinished connector executable link already exists")
temporary.symlink_to(bundle / "bin" / name)
os.replace(temporary, destination)
print(f"Installed verified connector runner {lock['version']} ({target}).")
PY
fi

if [ -z "$PREFIX" ]; then
    PREFIX="$HOME/.local/bin"
fi
mkdir -p "$PREFIX"
DEST="$PREFIX/$COMMAND"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "Refusing to replace the existing non-symlink command at $DEST." >&2
    echo "Choose another --prefix or move that file explicitly." >&2
    exit 1
fi
ln -sfn "$VENV/bin/$COMMAND" "$DEST"

echo "Installed verified OpenAgent $PRODUCT at $DEST"
case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) echo "Add $PREFIX to PATH to run $COMMAND directly." ;;
esac
