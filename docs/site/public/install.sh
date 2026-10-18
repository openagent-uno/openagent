#!/bin/sh
# Install the current OpenAgent v1.1 beta server or CLI from the four
# canonical, independently versioned GitHub releases.
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
OpenAgent v1.1 beta installer

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
    echo "OpenAgent v1.1 beta requires Python 3.11 or newer." >&2
    exit 1
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openagent-install.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
WHEELHOUSE="$TMP_DIR/wheels"
mkdir -p "$WHEELHOUSE"

"$PYTHON" - "$WHEELHOUSE" <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

destination = Path(sys.argv[1])
releases = (
    ("openagent-uno/openagent", "v1.1.0-beta.45", "manifest.json", "cab1b4dc4555f23fc22e5f9a9b32ba6618cebe1ada8404ebac85257b031eff3c"),
    ("openagent-uno/openagent-core", "v1.1.0-beta.22", "manifest.json", "291be9e298c1035ae88079b849620e9a8a04e03f43dd9180f86ebe6e79f4876d"),
    ("openagent-uno/openagent-tools", "v1.0.0-beta.4", "manifest.json", "20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228"),
    ("openagent-uno/openagent-tools", "connectors-v0.1.8", "manifest.json", "85128fb54ae414269cfa70064bd9b0de724906770db416949e5747be97139916"),
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
for repository, tag, manifest_name, manifest_digest in releases:
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
    if not wheel_assets:
        raise SystemExit(f"{repository} {tag}: no wheels found")

    for name, url in wheel_assets.items():
        digest = expected.get(name)
        if not digest:
            raise SystemExit(f"{repository} {tag}: {name} is absent from the signed manifest")
        payload = fetch(url)
        actual = hashlib.sha256(payload).hexdigest()
        if actual != digest:
            raise SystemExit(f"{repository} {tag}: checksum mismatch for {name}")
        (destination / name).write_bytes(payload)
        verified += 1

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
    DIST="openagent-framework==1.1.0b45"
    COMMAND="openagent"
else
    DIST="openagent-cli==1.1.0b45"
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
EOF

"$VENV/bin/python" -m pip install --disable-pip-version-check --upgrade pip
if [ "$PRODUCT" = "server" ]; then
    # The standalone's NativeProvider needs async ORM support. Require Core's
    # engine extras explicitly, matching the verified normal installed closure.
    "$VENV/bin/python" -m pip install --disable-pip-version-check \
        --pre --constraint "$CONSTRAINTS" --find-links "$WHEELHOUSE" "$DIST" \
        "openagent-core[engine,providers,modules]==1.1.0b22"
else
    "$VENV/bin/python" -m pip install --disable-pip-version-check \
        --pre --constraint "$CONSTRAINTS" --find-links "$WHEELHOUSE" "$DIST"
fi

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

echo "Installed $DIST at $DEST"
case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) echo "Add $PREFIX to PATH to run $COMMAND directly." ;;
esac
