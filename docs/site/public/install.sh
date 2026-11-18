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
    ('openagent-uno/openagent', 'v1.1.9-beta.89', 'manifest.json', '140a5f037ae49f522e3e970df9c3e2c52db1fa749cbff316b5179c30ac0446cd', 'all'),
    ('openagent-uno/openagent', 'channel-bridges-v0.1.0-beta.27', 'manifest.json', 'c5461d91a4763e3b1c4602621ad81a464bfb4cce8b19715d077f2b44977719c7', 'only:openagent_channel_bridges'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.37', 'manifest.json', 'bbdc069507368b9b7c04ae5af780fcede035f01ed429ccfb8fd49f2ecdf15ead', 'only:openagent_module_attachments,openagent_module_budget,openagent_module_delegation,openagent_module_logs,openagent_module_models,openagent_module_ptc,openagent_module_skills'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.100', 'manifest.json', '710f9457677480645e9fdd9af06fb1996b3123e5aa84ce421872ce68893d9066', 'only:openagent_module_events,openagent_module_mcp,openagent_module_scheduler,openagent_module_search,openagent_module_sessions,openagent_module_vault,openagent_module_workflows'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.110', 'manifest.json', '9d446b59f48147d38d649b6300383f50091ee77c0fd9e024d846bc1da220101d', 'only:openagent_module_tool_discovery,openagent_modules,openagent_modules_full'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.87', 'manifest.json', 'cdbc39faa10794df26d9d6fb0cbb4ff32e6ad0e3f662b19a3e99a93b2537978d', 'only:openagent_capability_host'),
    ('openagent-uno/openagent-core', 'v1.1.0-beta.140', 'manifest.json', '204b1d1bc9bf89a561156c1045dfaea0e6682d713b528d572903035d6ff33653', 'only:openagent_core,openagent_gateway,openagent_sdk,openagent_storage_sqlite'),
    ('openagent-uno/openagent-tools', 'device-tools-v1.0.0-beta.18', 'manifest.json', '34a56c6adaaf4c84ad5da82b5bedb034e7a5facdb22fc098c3b8c3db55f6b7ea', 'only:openagent_device_tools'),
    ('openagent-uno/openagent-tools', 'v1.0.0-beta.7', 'manifest.json', 'c8ce5b9b7b8fafbd232cc802d82bcd0e601c2041df697432de832526afd43315', 'only:openagent_editor,openagent_execution,openagent_filesystem,openagent_shell,openagent_tool_protocol'),
    ('openagent-uno/openagent', 'v1.0.0b18', 'manifest.json', 'b7fba7619d41ff6a522e36ca08c12438b1a5a94d45a7ba086c5ff0c3481d369b', 'only:openagent_host_tools'),
)
headers = {"Accept": "application/vnd.github+json", "User-Agent": "openagent-site-installer"}


def fetch(url: str, *, max_bytes: int = 64 << 20) -> bytes:
    attempts = 5
    for attempt in range(attempts):
        try:
            request_headers = dict(headers)
            # Explicit installer token, scoped only to GitHub's API host.
            token = __import__("os").environ.get("OPENAGENT_INSTALL_GITHUB_TOKEN")
            if token and url.startswith("https://api.github.com/"):
                request_headers["Authorization"] = "Bearer " + token
            with urlopen(Request(url, headers=request_headers), timeout=60) as response:
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
    if selection.startswith("only:"):
        prefixes = tuple(name + "-" for name in selection[5:].split(","))
        wheel_assets = {name: url for name, url in wheel_assets.items() if name.startswith(prefixes)}
    elif selection == "modules":
        wheel_assets = {name: url for name, url in wheel_assets.items()
                        if name.startswith(("openagent_module_", "openagent_modules-", "openagent_modules_full-"))}
    elif selection == "capability-host":
        wheel_assets = {name: url for name, url in wheel_assets.items() if name.startswith("openagent_capability_host-")}
    elif selection == "tools-base":
        wheel_assets = {name: url for name, url in wheel_assets.items() if not name.startswith(("openagent_device_tools-", "openagent_connectors-"))}
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

# The connector SDK and the native runner must come from the same release.
# The standalone server wheel carries their exact source and artifact lock.
framework, = destination.glob("openagent_framework-*.whl")
with zipfile.ZipFile(framework) as archive:
    connector = json.loads(archive.read("openagent_server/connectors.lock.json"))
repo, tag = connector["source_repository"], connector["source_ref"]
release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/tags/{tag}", max_bytes=1 << 20))
assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
manifest_bytes = fetch(assets["manifest.json"], max_bytes=1 << 20)
if hashlib.sha256(manifest_bytes).hexdigest() != connector["manifest_sha256"]:
    raise SystemExit("Connector release manifest checksum mismatch")
manifest = json.loads(manifest_bytes)
if (manifest.get("version") != connector["version"]
        or manifest.get("source_commit") != connector["source_commit"]
        or manifest.get("dirty_snapshot") is not False):
    raise SystemExit("Connector release does not match the server's pinned source")
name = f"openagent_connectors-{connector['version']}-py3-none-any.whl"
receipt = connector["assets"][name]
if manifest["files"].get(name) != receipt:
    raise SystemExit("Connector SDK wheel does not match the server's lock")
payload = fetch(assets[name], max_bytes=receipt["bytes"])
if len(payload) != receipt["bytes"] or hashlib.sha256(payload).hexdigest() != receipt["sha256"]:
    raise SystemExit("Connector SDK wheel checksum mismatch")
(destination / name).write_bytes(payload)
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
        "openagent-core[engine,providers,subscriptions]==" + versions["openagent-core"],
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
