#!/usr/bin/env bash
set -euo pipefail

# ── OpenAgent App — Test ──
# Run linting, type checks, and tests.
#
# Usage:
#   ./test.sh               Run all checks
#   ./test.sh lint          ESLint only
#   ./test.sh types         TypeScript type check only
#   ./test.sh unit          Common + Electron unit/contract tests
#   ./test.sh e2e           Two real Electron/host-tools E2E passes
#   ./test.sh e2e-real-iroh Two opt-in Electron + real server/Iroh passes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"
FAILURES=0

run_lint() {
    echo "🔍 ESLint..."
    cd "$SCRIPT_DIR/universal"
    # Il gate esiste davvero: eslint + typescript-eslint sono dipendenze del
    # repo e la configurazione e' in eslint.config.mjs. Regole scelte per
    # cogliere difetti, non gusti — niente formattazione, niente stile: se
    # fallisce, qualcosa e' rotto. (In ESLint 9 la selezione dei file sta nella
    # config, non piu' in --ext.)
    if ls eslint.config.* >/dev/null 2>&1; then
        npx eslint . || FAILURES=$((FAILURES + 1))
    else
        echo "   saltato: manca eslint.config.* — la configurazione e' stata rimossa?"
    fi
    echo ""
}

run_types() {
    echo "📐 TypeScript..."
    cd "$SCRIPT_DIR/universal"
    npx tsc --noEmit || FAILURES=$((FAILURES + 1))

    cd "$SCRIPT_DIR/desktop"
    npx tsc --noEmit || FAILURES=$((FAILURES + 1))
    echo ""
}

run_unit() {
    echo "🧪 Electron main/network/capability tests..."
    local desktop_dist="$SCRIPT_DIR/desktop/dist"
    cleanup_unit_artifacts() {
        rm -rf -- "$desktop_dist"
    }
    # Desktop tests exercise the same bundled main-process code shipped by
    # Electron. Keep generated dist/ state scoped to this gate.
    trap cleanup_unit_artifacts RETURN
    cd "$SCRIPT_DIR/desktop"
    npm test || FAILURES=$((FAILURES + 1))

    echo "🧪 Common model-contract tests..."
    cd "$SCRIPT_DIR"
    node --experimental-strip-types --test common/__tests__/*.test.mjs \
        || FAILURES=$((FAILURES + 1))
    echo ""
}

run_e2e() {
    echo "🧪 Electron + real local host-tools E2E (two passes)..."
    cd "$SCRIPT_DIR/desktop"
    npm run test:e2e:twice || FAILURES=$((FAILURES + 1))
    echo ""
}

run_real_iroh_e2e() {
    echo "🧪 Electron + coordinator/Gateway/Iroh + client tools E2E (two passes)..."
    cd "$SCRIPT_DIR/desktop"
    # CI can point at independently checked-out server/Python paths through
    # OPENAGENT_REAL_DESKTOP_SERVER_ROOT / OPENAGENT_REAL_DESKTOP_PYTHON.
    # Locally the spec discovers the sibling openagent-server checkout.
    if ! npm run build:e2e; then
        FAILURES=$((FAILURES + 1))
    elif ! OPENAGENT_REAL_DESKTOP_IROH_E2E=1 npx playwright test \
        --config=playwright.config.mjs \
        e2e/desktop-real-iroh.spec.mjs \
        --repeat-each=2 \
        --workers=1; then
        FAILURES=$((FAILURES + 1))
    fi
    echo ""
}

case "$TARGET" in
    all)
        run_lint
        run_types
        run_unit
        ;;
    lint)   run_lint ;;
    types)  run_types ;;
    unit)   run_unit ;;
    e2e)    run_e2e ;;
    e2e-real-iroh) run_real_iroh_e2e ;;
    *)
        echo "❌ Unknown target: $TARGET"
        echo "Usage: ./test.sh [all|lint|types|unit|e2e|e2e-real-iroh]"
        exit 1
        ;;
esac

if [ "$FAILURES" -gt 0 ]; then
    echo "❌ $FAILURES check(s) failed"
    exit 1
else
    echo "✅ All checks passed"
fi
