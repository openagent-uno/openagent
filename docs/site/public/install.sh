#!/bin/sh
# Install the current OpenAgent 1.1 stable server or CLI from four
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
OpenAgent 1.1 stable installer

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
    ('openagent-uno/openagent', 'v1.1.3', 'manifest.json', '51808bb18a9e3a420783c006e39b6533cc08e85099926b9e7c07b641a1fdb8f3', 'all'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.40', 'manifest.json', '6da7326924459cebe3f73aea3797fdafb10c02b8c211193a332cc399b80f80e3', 'all'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.37', 'manifest.json', 'bbdc069507368b9b7c04ae5af780fcede035f01ed429ccfb8fd49f2ecdf15ead', 'modules'),
    ('openagent-uno/openagent-tools', 'v1.0.0-beta.6', 'manifest.json', 'f7d4dbb5c2a17687266ad3c74a8d796c9e2787d8bf5a2617dadcdce1f0fc46bd', 'all'),
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
    if "artifacts" in manifest:
        expected = {item["path"]: item["sha256"] for item in manifest["artifacts"]}
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
    elif selection != "all":
        raise SystemExit(f"Unsupported first-party artifact selection: {selection}")
    if not wheel_assets:
        raise SystemExit(f"{repository} {tag}: no selected wheels found")

    for name, url in wheel_assets.items():
        digest = expected.get(name)
        if not digest:
            raise SystemExit(f"{repository} {tag}: {name} is absent from the signed manifest")
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
product = sys.argv[2]
if product == "server":
    requirements = [
        "openagent-framework[discord,slack,whatsapp]==" + versions["openagent-framework"],
        "openagent-core[engine,providers,modules]==" + versions["openagent-core"],
    ]
else:
    requirements = ["openagent-cli==" + versions["openagent-cli"]]
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
    --constraint "$CONSTRAINTS" --find-links "$WHEELHOUSE" \
    --requirement "$WHEELHOUSE/install-requirements.txt"

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
