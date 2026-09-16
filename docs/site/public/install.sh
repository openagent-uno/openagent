#!/bin/sh
# OpenAgent one-liner installer for macOS / Linux.
#
# Usage:
#   curl -fsSL https://openagent.uno/install.sh | sh
#   curl -fsSL https://openagent.uno/install.sh | sh -s -- --cli
#   curl -fsSL https://openagent.uno/install.sh | sh -s -- --prefix /opt/bin
#
# Downloads the latest server (or CLI with --cli) release from GitHub,
# verifies the SHA256, drops the binary into $PREFIX (default: the first
# writable path among ~/.local/bin, ~/bin, /usr/local/bin), marks it
# executable, and — on macOS — clears the com.apple.quarantine attribute
# so Gatekeeper doesn't refuse the first launch.
#
# The installer is intentionally POSIX ``sh`` with no bashisms so it runs
# on minimal systems (BusyBox, fresh macOS shells, etc.).

set -eu

PRODUCT="server"   # "server" | "cli"
PREFIX=""

while [ $# -gt 0 ]; do
    case "$1" in
        --cli)         PRODUCT="cli"; shift ;;
        --server)      PRODUCT="server"; shift ;;
        --prefix)      PREFIX="$2"; shift 2 ;;
        --prefix=*)    PREFIX="${1#*=}"; shift ;;
        -h|--help)
            cat <<EOF
OpenAgent installer

Flags:
  --cli          Install the CLI client (default: the server)
  --server       Install the server (default)
  --prefix DIR   Install into DIR (default: first writable of ~/.local/bin,
                 ~/bin, /usr/local/bin)
EOF
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [ "$PRODUCT" = "server" ]; then
    APP="openagent"
    REPO="openagent-uno/openagent-server"
else
    APP="openagent-cli"
    REPO="openagent-uno/openagent-cli"
fi

# ── Platform detection ───────────────────────────────────────────────

UNAME_S=$(uname -s)
UNAME_M=$(uname -m)

case "$UNAME_S" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *)
        echo "Unsupported OS: $UNAME_S. Download manually from https://github.com/$REPO/releases" >&2
        exit 1 ;;
esac

case "$UNAME_M" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        echo "Unsupported arch: $UNAME_M" >&2
        exit 1 ;;
esac

# ── Pick the install prefix ──────────────────────────────────────────

if [ -z "$PREFIX" ]; then
    for candidate in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
        if [ -d "$candidate" ] && [ -w "$candidate" ]; then
            PREFIX="$candidate"
            break
        fi
    done
    # If none exist, create ~/.local/bin — most distros already include it
    # on $PATH, and it's a non-root location.
    if [ -z "$PREFIX" ]; then
        PREFIX="$HOME/.local/bin"
        mkdir -p "$PREFIX"
    fi
fi

# ── Resolve the latest release asset ─────────────────────────────────
#
# macOS is distributed as a signed + notarized + stapled ``.pkg`` (no
# Gatekeeper dialog on Finder double-click). Linux ships as ``.tar.gz``.
# Windows isn't handled here — WSL users fall through to Linux, everyone
# else downloads the .zip from the releases page.

API="https://api.github.com/repos/${REPO}/releases/latest"

echo "→ Resolving latest release for $APP ($OS/$ARCH)..."
TAG=$(curl -fsSL "$API" | grep '"tag_name"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
if [ -z "$TAG" ]; then
    echo "Could not resolve a latest release tag." >&2
    exit 1
fi
VERSION="${TAG#v}"

if [ "$OS" = "macos" ]; then
    ARCHIVE="${APP}-${VERSION}-${OS}-${ARCH}.pkg"
else
    ARCHIVE="${APP}-${VERSION}-${OS}-${ARCH}.tar.gz"
fi
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE}"
SHA_URL="${URL}.sha256"

# ── Download + verify ────────────────────────────────────────────────

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading $ARCHIVE..."
curl -fsSL "$URL" -o "$TMP/$ARCHIVE"

if curl -fsSLI "$SHA_URL" >/dev/null 2>&1; then
    echo "→ Verifying SHA-256..."
    curl -fsSL "$SHA_URL" -o "$TMP/${ARCHIVE}.sha256"
    EXPECTED=$(awk '{print $1}' "$TMP/${ARCHIVE}.sha256")
    if command -v shasum >/dev/null 2>&1; then
        ACTUAL=$(shasum -a 256 "$TMP/$ARCHIVE" | awk '{print $1}')
    else
        ACTUAL=$(sha256sum "$TMP/$ARCHIVE" | awk '{print $1}')
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "Checksum mismatch." >&2
        echo "  expected: $EXPECTED" >&2
        echo "  actual:   $ACTUAL"   >&2
        exit 1
    fi
fi

# ── Extract the binary out of the archive/package ────────────────────

if [ "$OS" = "macos" ]; then
    # ``pkgutil --expand-full`` unpacks the whole .pkg tree (xar archive
    # + Payload) into a directory — no sudo required.
    pkgutil --expand-full "$TMP/$ARCHIVE" "$TMP/pkg-expanded"

    # v0.6.11+ ships the openagent server as a proper ``.app`` bundle
    # so macOS TCC can key permission grants by CFBundleIdentifier
    # rather than cdhash (grants persist across updates). The bundle
    # contains both the onefile Mach-O and the computer-control
    # sidecar under Contents/MacOS/.
    APP_BUNDLE=$(find "$TMP/pkg-expanded" -type d -name "${APP}.app" 2>/dev/null | head -1)
    # Fall back to the legacy bare-binary layout for older packages.
    BINARY=""
    SIDECAR=""
    if [ -z "$APP_BUNDLE" ]; then
        BINARY=$(find "$TMP/pkg-expanded" -type f -name "$APP" -perm +111 2>/dev/null | head -1)
        if [ -z "$BINARY" ]; then
            BINARY=$(find "$TMP/pkg-expanded" -type f -name "$APP" 2>/dev/null | head -1)
        fi
        SIDECAR=$(find "$TMP/pkg-expanded" -type d -name "openagent-computer-control.app" 2>/dev/null | head -1)
        if [ -z "$SIDECAR" ]; then
            SIDECAR=$(find "$TMP/pkg-expanded" -type f -name "openagent-computer-control" 2>/dev/null | head -1)
        fi
    fi
else
    tar xzf "$TMP/$ARCHIVE" -C "$TMP"
    BINARY="$TMP/$APP"
    if [ ! -x "$BINARY" ] && [ -f "$BINARY" ]; then
        chmod +x "$BINARY"
    fi
    # Linux/Windows .tar.gz / .zip ship the sidecar next to the main
    # binary in the archive root.
    APP_BUNDLE=""
    if [ -f "$TMP/openagent-computer-control" ]; then
        SIDECAR="$TMP/openagent-computer-control"
    elif [ -f "$TMP/openagent-computer-control.exe" ]; then
        SIDECAR="$TMP/openagent-computer-control.exe"
    else
        SIDECAR=""
    fi
fi

if [ -z "${APP_BUNDLE:-}" ] && { [ -z "$BINARY" ] || [ ! -f "$BINARY" ]; }; then
    echo "Could not locate the $APP binary or ${APP}.app bundle in the downloaded $ARCHIVE." >&2
    exit 1
fi

# ── Install ──────────────────────────────────────────────────────────

if [ -n "${APP_BUNDLE:-}" ]; then
    # macOS .app layout (v0.6.11+). Drop the bundle into ~/Applications
    # (user-scope, no sudo) and create a symlink at $PREFIX/$APP into
    # the bundle's inner binary so ``openagent serve ...`` from a
    # terminal still works.
    APPS_DIR="$HOME/Applications"
    mkdir -p "$APPS_DIR"
    APP_DEST="$APPS_DIR/${APP}.app"
    echo "→ Installing ${APP}.app to $APP_DEST"
    rm -rf "$APP_DEST"
    cp -R "$APP_BUNDLE" "$APP_DEST"
    if command -v xattr >/dev/null 2>&1; then
        xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
    fi

    # CLI symlink — the path TCC sees when ``openagent`` is invoked is
    # resolved through this to the bundle's inner binary. macOS treats
    # the executed Mach-O as part of openagent.app because of the
    # Contents/MacOS/ layout, so TCC keys grants to
    # ``com.openagent.server``.
    APP_INNER_EXE="$APP_DEST/Contents/MacOS/$APP"
    if [ ! -x "$APP_INNER_EXE" ]; then
        echo "Unexpected layout: $APP_INNER_EXE missing" >&2
        exit 1
    fi
    DEST="$PREFIX/$APP"
    echo "→ Linking $DEST → $APP_INNER_EXE"
    rm -f "$DEST"
    ln -s "$APP_INNER_EXE" "$DEST"
else
    # Legacy bare-binary layout (Linux, Windows, or older macOS pkgs).
    DEST="$PREFIX/$APP"
    echo "→ Installing to $DEST"
    cp "$BINARY" "$DEST"
    chmod +x "$DEST"
    if [ "$OS" = "macos" ] && command -v xattr >/dev/null 2>&1; then
        xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
    fi

    # Install the computer-control sidecar next to the main binary.
    if [ "$PRODUCT" = "server" ] && [ -n "${SIDECAR:-}" ] && [ -e "$SIDECAR" ]; then
        SIDECAR_NAME=$(basename "$SIDECAR")
        SIDECAR_DEST="$PREFIX/$SIDECAR_NAME"
        if [ -d "$SIDECAR" ]; then
            # macOS legacy .app-bundle sidecar.
            echo "→ Installing $SIDECAR_NAME bundle to $SIDECAR_DEST"
            rm -rf "$SIDECAR_DEST"
            cp -R "$SIDECAR" "$SIDECAR_DEST"
            if command -v xattr >/dev/null 2>&1; then
                xattr -dr com.apple.quarantine "$SIDECAR_DEST" 2>/dev/null || true
            fi
        else
            echo "→ Installing sidecar $SIDECAR_NAME to $SIDECAR_DEST"
            cp "$SIDECAR" "$SIDECAR_DEST"
            chmod +x "$SIDECAR_DEST"
            if [ "$OS" = "macos" ] && command -v xattr >/dev/null 2>&1; then
                xattr -dr com.apple.quarantine "$SIDECAR_DEST" 2>/dev/null || true
            fi
        fi
    fi
fi

# ── PATH hint ────────────────────────────────────────────────────────

echo
echo "✓ Installed $APP $VERSION to $DEST"
case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *)
        echo
        echo "⚠  $PREFIX is not on your PATH. Add this to your shell profile:"
        echo "     export PATH=\"$PREFIX:\$PATH\""
        ;;
esac
echo
if [ "$PRODUCT" = "server" ]; then
    echo "Run: $APP serve ./my-agent"
else
    echo "Run: $APP connect localhost:8765"
fi
