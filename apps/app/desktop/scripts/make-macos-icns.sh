#!/usr/bin/env bash
# Rebuild the macOS .icns from the padded transparent squircle master.
# macOS 15 does not apply Tahoe's icon mask to legacy .icns assets, so an
# opaque full-bleed master renders as a giant square. The verifier below keeps
# the cross-version source geometry fail-closed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../buildResources/icon.png}"
OUT="${2:-$HERE/../buildResources/icon.icns}"

[ -f "$SRC" ] || { echo "missing master: $SRC" >&2; exit 1; }
node "$HERE/verify-macos-icon.mjs" "$SRC"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
SET="$WORK/icon.iconset"; mkdir -p "$SET"

for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done

iconutil -c icns "$SET" -o "$OUT"
VERIFY_SET="$WORK/verify.iconset"
iconutil -c iconset "$OUT" -o "$VERIFY_SET"
node "$HERE/verify-macos-icon.mjs" "$VERIFY_SET/icon_512x512@2x.png"
echo "✅ $OUT"
