#!/bin/bash
set -euo pipefail

# ── OpenAgent App Release ──
# Bumps version in desktop/package.json + universal/package.json, tags,
# pushes. CI (.github/workflows/release.yml) builds the Electron desktop
# app for macOS / Linux / Windows and publishes to GitHub Releases.
#
# Usage:
#   ./release.sh patch    # 0.13.8 → 0.13.9
#   ./release.sh minor    # 0.13.8 → 0.14.0
#   ./release.sh major    # 0.13.8 → 1.0.0
#   ./release.sh 0.14.0   # explicit version

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Ensure node is in PATH ──
if ! command -v node &>/dev/null; then
  for d in "$HOME/.nvm/versions/node/v"*/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/node" ] 2>/dev/null; then
      export PATH="$d:$PATH"
      break
    fi
  done
fi
command -v node &>/dev/null || { echo "ERROR: node is required but not found in PATH" >&2; exit 1; }

BUMP="${1:-patch}"

CURRENT=$(node -e "console.log(require('./desktop/package.json').version)")
echo "Current version: $CURRENT"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW="$((MAJOR + 1)).0.0" ;;
  *)     NEW="$BUMP" ;;
esac

if [ "$CURRENT" = "$NEW" ]; then
  echo "Version unchanged ($CURRENT). Nothing to do."
  exit 0
fi

echo "New version: $NEW"

# ── Check clean working tree ──
if ! git diff-index --quiet HEAD --; then
  echo "ERROR: working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

read -p "Continue? [y/N] " -n 1 -r
echo
[[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# ── Bump version ──
echo "📦 Bumping $CURRENT → $NEW"

for pkg in "$ROOT/desktop/package.json" "$ROOT/universal/package.json"; do
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$pkg','utf8'));
    p.version = '$NEW';
    fs.writeFileSync('$pkg', JSON.stringify(p,null,2)+'\n');
  "
  echo "  $(basename $(dirname "$pkg"))/package.json → $NEW"
done

# ── Commit + tag + push ──
echo ""
echo "📤 Committing and tagging v$NEW..."

git add desktop/package.json universal/package.json
git commit -m "release: v$NEW"
git tag "v$NEW" -m "v$NEW"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "$BRANCH" "v$NEW"

echo ""
echo "=== Released v$NEW ==="
echo ""
echo "GitHub Actions will now build & publish to GitHub Releases:"
echo "  https://github.com/openagent-uno/openagent-app/releases"
echo ""
echo "Track: https://github.com/openagent-uno/openagent-app/actions"
