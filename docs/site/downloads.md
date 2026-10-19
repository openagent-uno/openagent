# Download OpenAgent

The current server and CLI build is **v1.1.0-beta.49**, using Core beta 22,
connector SDK/runner 0.1.11 and Host Tools 1.0.0b6. The current desktop App remains
**v1.1.0-beta.22**, published for macOS, Windows and Linux on ARM64 and x64.
[App22/server45 Linux x64 marketplace](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-server45-marketplace-2026-10-18.json)
passed with 114 official cards, 30 registry results and ten reviewed screenshots.
It made zero provider/model calls and is not an App22/server49 GUI qualification.
Historical App21/server44 and App20/server43 evidence retain their actual scope.
Hosted `--no-sandbox` does not qualify sandbox security or Mac/Windows marketplace GUI.
Beta49's [installed qualification](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.49/qualification.json)
passed 215 tests and fifteen React source groups. The [normal public-source installer49](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product49-public-installer-2026-10-19.json) passed separate server/CLI installation, dependency/import/catalog and seven-provider-default checks. Live website byte equality is recorded separately in that receipt. The dated
[installer48 receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product48-public-installer-2026-10-19.json)
retains beta48 attribution. Provider acceptance remains separate; see
[Connector release status](./guide/connector-status.md).

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

The beta server is distributed as a Python 3.11+ wheel. The interpreter must
include `venv` and `ensurepip` (Debian packages this separately as `python3-venv`).
Use the verified public installer described in
[Getting Started](./guide/getting-started), which pins the product, Core, Tools
and connector SDK releases and acquires the verified local connector runner.

```bash
curl -fsSL https://openagent.uno/install.sh | sh -s -- --server
```

The server installer selects `openagent-core[engine,providers,modules]==1.1.0b22`,
including SQLAlchemy async support. When assembling directly from release wheels,
install those extras too: the bare Framework wheel is not the qualified
`NativeProvider` dependency closure. The CLI remains a thin remote client.
The [normal public beta 43 installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
passed server-plus-CLI installation and dependency checks on Linux x64/CPython
3.11.14 with default HOME/TMPDIR. This does not qualify Windows/macOS server
execution. The earlier [beta 42 cross-filesystem repair](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
retains its distinct-mount probe and original scope.

## CLI

<ReleaseDownloads target="cli" />

The beta CLI is distributed as a Python 3.11+ wheel and uses the same verified
wheelhouse as the server.

```bash
curl -fsSL https://openagent.uno/install.sh | sh -s -- --cli
```

## Libraries

- [OpenAgent Core v1.1.0-beta.22](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.22)
  — kernel, SDK, storage and optional module wheels.
- [OpenAgent Tools v1.0.0-beta.4](https://github.com/openagent-uno/openagent-tools/releases/tag/v1.0.0-beta.4)
  — filesystem, editor, shell, web search, device capabilities and the optional
  Meta Ads MCP package with video upload support.
- [OpenAgent host-tools v1.0.0b6](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b6)
  — six qualified platform bundles and the exact Python wheel reused by server/CLI beta49.
  The desktop App retains its own release lock.
- [Shared connector module/runner 0.1.11](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.11)
  — 114 official entries plus Custom MCP, including 90 limited manual-token profiles; Python/MCP transport, platform manifests and checksums.
- [Connector auth service 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.6)
  — historical operator release; the current deployed broker checkpoint and
  provider-specific enrollment boundaries are recorded in [connector status](./guide/connector-status.md).
- [Product release manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.49/manifest.json)
  — component versions, source commits and SHA-256 digests.

Existing 0.x installations continue to use their historical updater endpoints
during the transition. Retained historical release assets and updater endpoints remain available.
The historical App repository still executes the reviewed canonical-source
signing and updater bridge. The installed-version →
transition → canonical-release chain remains separately qualified from provider
consent. Desktop beta clients retain their beta channel and manual update behavior;
archival preserves the published downloads and updater feed.
