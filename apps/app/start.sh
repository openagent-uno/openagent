#!/usr/bin/env bash
set -euo pipefail

# ── OpenAgent App — Start ──
# Launch the dev server for a given platform.
#
# Usage:
#   ./start.sh              Start web dev server (default)
#   ./start.sh web          Same — Expo web on localhost:8081
#   ./start.sh macos        Start Electron on macOS (loads web dev server)
#   ./start.sh windows      Start Electron on Windows
#   ./start.sh linux        Start Electron on Linux
#   ./start.sh ios          Start iOS simulator (React Native)
#   ./start.sh android      Start Android emulator (React Native)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM="${1:-web}"

echo "🚀 OpenAgent App — Start ($PLATFORM)"
echo ""

start_desktop() {
    # Start web dev server in background, then launch Electron
    cd "$SCRIPT_DIR/universal"
    BROWSER=none npx expo start --web &
    WEB_PID=$!
    trap 'kill $WEB_PID 2>/dev/null || true' EXIT
    echo "⏳ Waiting for web dev server..."
    sleep 5

    cd "$SCRIPT_DIR/desktop"
    npm run dev

    kill $WEB_PID 2>/dev/null || true
}

case "$PLATFORM" in
    web)
        cd "$SCRIPT_DIR/universal"
        npx expo start --web
        ;;
    macos|windows|linux)
        start_desktop
        ;;
    ios)
        cd "$SCRIPT_DIR/universal"
        npx expo start --ios
        ;;
    android)
        cd "$SCRIPT_DIR/universal"
        npx expo start --android
        ;;
    *)
        echo "❌ Unknown platform: $PLATFORM"
        echo "Usage: ./start.sh [web|macos|windows|linux|ios|android]"
        exit 1
        ;;
esac
