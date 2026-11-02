# Download OpenAgent

The current canonical server and CLI manual-upgrade release is
**[OpenAgent 1.1.8](https://github.com/openagent-uno/openagent/releases/tag/v1.1.8)**.
It contains the canonical server updater and a complete pinned installer.
Desktop **[App 1.1.0-beta.24](https://github.com/openagent-uno/openagent/releases/tag/app-v1.1.0-beta.24)**
is published with all six native targets verified and 36 asset checksums checked.
Both macOS targets are signed and notarized. Windows Authenticode and live
provider acceptance are separate from these native installation checks.

## Desktop app

<ReleaseDownloads target="desktop" />

Download the installer for your OS and CPU from the canonical App release.
For an existing installation, replace the app at the same location. Keep its
profile and agent directories; do not uninstall first or erase data. The App ID,
`openagent` protocol, identity paths and signed native bundles remain unchanged.
Choosing beta 24 manually opts into the beta channel. Its subsequent updates use
the canonical `app-update-feed`; stable/beta separation and no-downgrade checks
remain in force. Older installers may still contain a retired updater URL.

## Standalone server and CLI

<ReleaseDownloads target="server" />

<ReleaseDownloads target="cli" />

Use Python 3.11+ with `venv` and `ensurepip` (Debian: `python3-venv`). The installer
verifies six pinned release manifests, then installs the complete first-party
wheel set. Server installation also verifies the native connector runner.

```bash
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --server
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --cli
# Verify every first-party wheel without installing:
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --check
```

Rerun the installer for the existing installation root. If server and CLI share
that root, run both commands to keep their exact-version dependencies aligned. It preserves identity
and agent data; `OPENAGENT_INSTALL_ROOT` selects the command environment, not an
identity reset. See [Getting Started](./guide/getting-started) for commands.

## Current component dependencies

Product 1.1.8 uses Core/SQLite/Gateway/SDK beta43, modules beta37, capability-host
B3, the Python Host Tools B8 facade and Device Tools B10. Other Tools beta6
packages, product-config B20 and channel-bridges B16 retain their published
bytes. The native connector runner remains 0.1.14. App beta24 uses MCP Apps 0.1.3
and the unchanged signed Host Tools B7 six-platform bundles.

[Core](https://github.com/openagent-uno/openagent-core/releases),
[Tools](https://github.com/openagent-uno/openagent-tools/releases) and the
[product manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.8/manifest.json)
record independent versions and exact SHA-256 values. Older component versions
still pinned by active clients are retained as useful dependencies.

## Qualification and retirement

The new server/CLI wheels passed clean dependency resolution, installed CLI
startup and 31 installed updater contracts and live two-page GitHub feed verification. The anonymous public server and CLI
installer also completed in an isolated macOS environment. These checks do not
claim production deployment or provider acceptance. Desktop native build,
signing and publication evidence are recorded separately.

The owner explicitly chose to retire old repository updater URLs and discard
unused historical release assets on 2 November 2026. Old installations require a
manual upgrade to a new canonical-updater build. Dated receipts retain their
original versions, source commits and hashes; historical download URLs may no
longer resolve. See the
[repository transition](https://github.com/openagent-uno/openagent/blob/main/docs/repository-transition.md)
and [migration procedure](https://github.com/openagent-uno/openagent/blob/main/docs/release-consolidation.md).
