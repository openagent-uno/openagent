#!/bin/sh
# Install the current OpenAgent v1.1 beta server or CLI from the three
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
from urllib.request import Request, urlopen

destination = Path(sys.argv[1])
releases = (
    ("openagent-uno/openagent", "v1.1.0-beta.2", "product-release-manifest.json"),
    ("openagent-uno/openagent-core", "v1.1.0-beta.1", "manifest.json"),
    ("openagent-uno/openagent-tools", "v1.0.0-beta.1", "manifest.json"),
)
headers = {"Accept": "application/vnd.github+json", "User-Agent": "openagent-site-installer"}


def fetch(url: str) -> bytes:
    with urlopen(Request(url, headers=headers), timeout=60) as response:
        return response.read()


verified = 0
for repository, tag, manifest_name in releases:
    api = f"https://api.github.com/repos/{repository}/releases/tags/{tag}"
    release = json.loads(fetch(api))
    assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
    if manifest_name not in assets:
        raise SystemExit(f"{repository} {tag}: missing {manifest_name}")

    manifest = json.loads(fetch(assets[manifest_name]))
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
    DIST="openagent-framework==1.1.0b2"
    COMMAND="openagent"
else
    DIST="openagent-cli==1.1.0b2"
    COMMAND="openagent-cli"
fi

"$VENV/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$VENV/bin/python" -m pip install --disable-pip-version-check \
    --pre --find-links "$WHEELHOUSE" "$DIST"

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
