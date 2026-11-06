# Download OpenAgent

The current canonical server and CLI manual-upgrade release is
**[OpenAgent 1.1.9 beta 10](https://github.com/openagent-uno/openagent/releases/tag/v1.1.9-beta.10)**.
It contains the canonical server updater and a complete pinned installer.
Desktop **[App 1.1.0-beta.26](https://github.com/openagent-uno/openagent/releases/tag/app-v1.1.0-beta.26)**
is published with all six native targets verified and 36 asset checksums checked.
Both macOS targets are signed and notarized. Windows Authenticode and live
provider acceptance are separate from these native installation checks.

## Desktop app

<ReleaseDownloads target="desktop" />

Download the installer for your OS and CPU from the canonical App release.
For an existing installation, replace the app at the same location. Keep its
profile and agent directories; do not uninstall first or erase data. The App ID,
`openagent` protocol, and identity paths remain unchanged.
Choosing beta 26 manually opts into the beta channel. Its subsequent updates use
the canonical `app-update-feed`; stable/beta separation and no-downgrade checks
remain in force. Older installers may still contain a retired updater URL.

## Standalone server and CLI

<ReleaseDownloads target="server" />

<ReleaseDownloads target="cli" />

Use Python 3.11+ with `venv` and `ensurepip` (Debian: `python3-venv`). The installer
verifies nine pinned release manifests, then binds installed first-party dependencies to the verified wheels. Both
products acquire the complete native Host Tools bundle, including the browser
runtime. Server installation also verifies the native connector runner.

```bash
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --server
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --cli
# Verify every first-party wheel without installing:
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --check
```

Rerun the installer for the existing installation root. If server and CLI share
that root, run both commands to keep their exact-version dependencies aligned. It preserves identity
and agent data; `OPENAGENT_INSTALL_ROOT` selects the command environment, not an
identity reset. See [Getting Started](./guide/getting-started) for commands.

## Current component dependencies

Product 1.1.9 beta 10 uses Core/SQLite/Gateway/SDK beta48, modules beta37,
capability-host B3, Host Tools B15 and Device Tools B18. Other Tools beta6
packages and product-config B20 retain their published bytes; channel bridges
are B19. The native connector runner remains 0.1.14. App beta26 consumes the
public Desktop Tools SDK 0.1.0, MCP Apps 0.1.3 and six qualified Host Tools B15
bundles. Native desktop behavior is owned by Tools and keeps its signed macOS
application identity.

[Core](https://github.com/openagent-uno/openagent-core/releases),
[Tools](https://github.com/openagent-uno/openagent-tools/releases) and the
[product manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/manifest.json)
record independent versions and exact SHA-256 values. Older component versions
still pinned by active clients are retained as useful dependencies.

## Qualification and retirement

Qualification includes 461 standalone tests, 168 CLI and packaging contracts,
13 installed public-wheel device/transport contracts, four desktop UI scenarios and all six
native App targets. The public installer verified 39 first-party wheels from
nine immutable manifests. Host Tools publication independently verified all 16
assets by anonymous HTTPS. Native package checks do not establish acceptance
on two physical desktop clients or arbitrary messaging/provider integrations.
Separate live acceptance verified an installed macOS App with a remote Linux
host: chat/model response, desktop video, direct pointer/text input and a
constant-output shell command executed by the agent on the authorized client. See the
[release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/device-release-2026-11-06.json)
for source revisions, build/publication runs and verification limits.

The owner explicitly chose to retire old repository updater URLs and discard
unused historical release assets on 2 November 2026. Old installations require a
manual upgrade to a new canonical-updater build. Dated receipts retain their
original versions, source commits and hashes; historical download URLs may no
longer resolve. See the
[repository transition](https://github.com/openagent-uno/openagent/blob/main/docs/repository-transition.md)
and [migration procedure](https://github.com/openagent-uno/openagent/blob/main/docs/release-consolidation.md).
