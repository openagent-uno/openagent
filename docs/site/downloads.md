# Download OpenAgent

Package and isolated runtime checks for 1.1.4 passed, but production startup qualification found a database connection failure while preparing invitation tickets after gateway startup. SDK 1.1.5 is being qualified to fix that CLI lifecycle; it is not yet published.

The qualified public server and CLI cohort is **[v1.1.4](https://github.com/openagent-uno/openagent/releases/tag/v1.1.4)**:
Core/SQLite beta41, unchanged modules from beta37, Tools beta6, Host Tools B7,
capability-host B3, Python connectors 0.1.15, native Go connector SDK/runner 0.1.14
and MCP Apps 0.1.1. The [qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product-stable-1.1.4-source.json)
records 452 tests and 156 subtests on installed wheels, anonymous public
server/CLI installer checks, and a full 14-module catalog with 210 tools.
The public-installer profile closed all eight tracked SQLite connections and
left zero workers or owned child processes. It used controlled certificate and
worker dependencies; authenticated production health is still pending.

The current desktop App remains **v1.1.0-beta.22**, published for macOS, Windows
and Linux on ARM64 and x64. App beta23 is not published. Server/CLI package and
installer qualification does not announce App, GlassPalace or ICS end-to-end
acceptance. The [App22/server45 Linux x64 marketplace receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-server45-marketplace-2026-10-18.json)
retains its 114 official cards, 30 registry results and ten reviewed screenshots,
with zero provider/model calls. It is historical evidence for those versions.

Earlier [stable 1.1.2 qualification](https://github.com/openagent-uno/openagent/releases/download/v1.1.2/qualification.json),
[stable 1.1.0 installation](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product-stable-1.1.0-2026-10-26.json)
and [beta49 public installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product49-public-installer-2026-10-19.json)
receipts retain their original scope. Provider-specific acceptance remains
separate; see [connector release status](./guide/connector-status.md).

Historical qualification: [beta49 installed checks](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.49/qualification.json)
passed 215 tests and 15 React source groups. Its [public-source installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product49-public-installer-2026-10-19.json)
passed separate server/CLI installations, dependency/import/catalog checks and
seven provider defaults; website byte equality is recorded separately. The
[installer48 receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product48-public-installer-2026-10-19.json)
retains beta48 attribution. [App21/server44](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json)
and [App20/server43](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
retain their actual versions and trial scope. Hosted `--no-sandbox` does not
qualify sandbox security or macOS/Windows marketplace GUI. These historical
receipts do not qualify the current server/App combination.

Product source and server/CLI releases come from the canonical
[`openagent`](https://github.com/openagent-uno/openagent) repository. Desktop
assets use the preserved historical App updater repository during the signed
transition; their manifests identify the exact canonical payload commit.
Core, Tools, connector runner and auth service are independently versioned.

## Desktop app

<ReleaseDownloads target="desktop" />

The current desktop beta is signed and notarized for **macOS on Apple Silicon
and Intel**. Windows and Linux installers are published for both architectures.
The [App beta22 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.22)
includes 36 verified assets, six provenance manifests and updater metadata.
Native packaged checks passed on all six targets; Intel macOS ZIP and DMG
launches also passed. The earlier [App20 native release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-native-release-2026-10-17.json)
retains its original scope; App22 publication is separate from marketplace GUI and provider acceptance. Earlier
[App 19/server 42](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json) and
[App 18/server 40](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app18-server40-marketplace-2026-10-16.json)
trials retain their original versions, screenshots and failure evidence.

## Standalone server

<ReleaseDownloads target="server" />

The stable server is distributed as a Python 3.11+ wheel. The interpreter must
include `venv` and `ensurepip` (Debian packages this separately as `python3-venv`).
Use the verified public installer described in
[Getting Started](./guide/getting-started), which pins the product, Core, Tools
and connector SDK releases and acquires the verified local connector runner.

```bash
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.4/install.sh | sh -s -- --server
```

The server installer selects `openagent-core[engine,providers,modules]==1.1.0b41`,
including SQLAlchemy async support. When assembling directly from release wheels,
install those extras too: the bare Framework wheel is not the qualified
`NativeProvider` dependency closure. The installer source also requests the
Framework's `discord`, `slack` and `whatsapp` extras with pinned SDK versions,
because those bridges import their SDK only when a configured channel starts;
a server without the SDK now reports one startup error and skips that channel.
Release-asset installers up to beta52 install the bare Framework wheel. The CLI
remains a thin remote client.
The [normal public beta 43 installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
passed server-plus-CLI installation and dependency checks on Linux x64/CPython
3.11.14 with default HOME/TMPDIR. This does not qualify Windows/macOS server
execution. The earlier [beta 42 cross-filesystem repair](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
retains its distinct-mount probe and original scope.

## CLI

<ReleaseDownloads target="cli" />

The CLI is a thin Python 3.11+ remote client. Its installation verifies the same
first-party manifests but does not install the server engine or start an agent.

```bash
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.4/install.sh | sh -s -- --cli
```

## Libraries

- [OpenAgent Core beta41](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.41)
  — Core, storage, gateway and Python SDK; [module wheels remain beta37](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.37).
- [OpenAgent Tools beta6](https://github.com/openagent-uno/openagent-tools/releases/tag/v1.0.0-beta.6)
  — Device Tools B8, protocol B2, filesystem/editor/shell/execution B3 and Python connectors 0.1.15.
- [Host Tools B7](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b7)
  — six verified platform bundles and the public Python wheel. Its
  [release index](https://github.com/openagent-uno/openagent/releases/download/v1.0.0b7/release-index.json)
  remains unchanged; capability-host B3 reuses the exact public Core40 wheel.
- [Native Go connector SDK/runner 0.1.14](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.14)
  — separately pinned native runner, acquired and verified by the server installer.
- [MCP Apps 0.1.1](https://github.com/openagent-uno/openagent/releases/tag/mcp-apps-v0.1.1)
  — the public interactive-app host library.
- [Connector auth service 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.6)
  — historical operator release; deployed broker and enrollment boundaries are
  recorded in [connector status](./guide/connector-status.md).
- [Product 1.1.4 manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.4/manifest.json)
  — exact component versions, source commits and SHA256 digests.

These documentation updates still await site deployment. The commands above
use the immutable, qualified 1.1.4 release installer; they do not assume that
the website convenience endpoint has already changed.

Existing 0.x installations continue to use their historical updater endpoints
during the transition. Retained historical release assets and updater endpoints remain available.
The historical App repository still executes the reviewed canonical-source
signing and updater bridge. The installed-version →
transition → canonical-release chain remains separately qualified from provider
consent. Desktop beta clients retain their beta channel and manual update behavior;
archival preserves the published downloads and updater feed.
