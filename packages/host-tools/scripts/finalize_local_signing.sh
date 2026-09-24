#!/usr/bin/env bash
# Turn six verified CI candidates into one signed, immutable release set.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <candidate-directory> <empty-output-directory> <source-commit>" >&2
  exit 2
fi

candidate_dir="$(cd "$1" && pwd)"
output_dir="$2"
source_commit="$3"
script_dir="$(cd "$(dirname "$0")" && pwd)"
python_bin="${PYTHON:-python3}"

[[ "$(uname -s)" == Darwin ]] || { echo "local signing requires macOS" >&2; exit 1; }
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "source commit must be a full SHA" >&2; exit 1; }
for name in CSC_NAME APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  [[ -n "${!name:-}" ]] || { echo "missing signing input: $name" >&2; exit 1; }
done
command -v "$python_bin" >/dev/null
[[ ! -e "$output_dir" ]] || { echo "output directory must not exist: $output_dir" >&2; exit 1; }
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

work_root="$(mktemp -d "${TMPDIR:-/tmp}/openagent-local-sign.XXXXXX")"
cleanup() { rm -rf "$work_root"; }
trap cleanup EXIT

for platform in darwin-arm64 darwin-x64; do
  archive="openagent-host-tools-${platform}.tar.gz"
  bundle_root="$work_root/$platform/dist"
  "$python_bin" "$script_dir/verify_bundle_archive.py" \
    "$candidate_dir/$archive" "$bundle_root" --expect-platform "$platform"
  bundle="$bundle_root/$platform"
  "$script_dir/sign_macos_bundle.sh" "$bundle"
  PYTHONPATH="$script_dir${PYTHONPATH:+:$PYTHONPATH}" \
    "$python_bin" -c 'import sys; from pathlib import Path; from build_standalone import write_bundle_manifest; write_bundle_manifest(Path(sys.argv[1]), sys.argv[2])' \
    "$bundle" "$platform"
  "$python_bin" "$script_dir/package_bundle.py" "$bundle"
  codesign --verify --strict "$bundle/openagent-host-tools"
  codesign --verify --strict "$bundle/node"
  codesign --verify --deep --strict "$bundle/openagent-computer-control.app"
  xcrun stapler validate "$bundle/openagent-computer-control.app"
  spctl --assess --type execute "$bundle/openagent-computer-control.app"
  cp "$bundle_root/$archive" "$bundle_root/$archive.sha256" "$output_dir/"
done

for platform in linux-x64 linux-arm64 win32-x64 win32-arm64; do
  archive="openagent-host-tools-${platform}.tar.gz"
  cp "$candidate_dir/$archive" "$candidate_dir/$archive.sha256" "$output_dir/"
done

wheel_count=0
for wheel in "$candidate_dir"/openagent_host_tools-*.whl; do
  [[ -f "$wheel" ]] || { echo "host-tools wheel missing" >&2; exit 1; }
  cp "$wheel" "$output_dir/"
  wheel_count=$((wheel_count + 1))
done
[[ "$wheel_count" -eq 1 ]] || { echo "expected one host-tools wheel" >&2; exit 1; }

"$python_bin" "$script_dir/release_index.py" "$output_dir" \
  --source-commit "$source_commit" \
  --source-repository openagent-uno/openagent
echo "Final signed release set: $output_dir"
