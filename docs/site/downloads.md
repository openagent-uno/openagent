# Download OpenAgent

The current server and CLI build is **v1.1.0-beta.42**. The latest desktop App
is **v1.1.0-beta.19**, published for macOS, Windows and Linux on ARM64 and x64.
These are betas of the modular architecture. Provider activation and product
qualification are recorded separately in [Connector release status](./guide/connector-status.md).
App beta 19 is published with six qualified native targets. Its
[Linux x64 marketplace trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-server42-marketplace-2026-10-17.json)
with server beta 42 passed: 16 official entries and 30 registry results share
one grid; Exa/Firecrawl local connection controls passed without provider calls.
Hosted Electron used `--no-sandbox`; sandbox security and Mac/Windows marketplace
GUI or provider acceptance are not established.

Product source and server/CLI releases come from the canonical
[`openagent`](https://github.com/openagent-uno/openagent) repository. Desktop
assets use the preserved historical App updater repository during the signed
transition; their manifests identify the exact canonical payload commit.
Core, Tools, connector runner and auth service are independently versioned.

## Desktop app

<ReleaseDownloads target="desktop" />

The current desktop beta is signed and notarized for **macOS on Apple Silicon
and Intel**. Windows and Linux installers are published for both architectures.
The [App beta 19 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.19)
includes installer checksums, six platform provenance manifests and verified
update metadata. Native packaged launches passed on all six targets; Intel
macOS ZIP and DMG launches also passed. The [native release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app19-native-release-2026-10-17.json)
retains the original failed ARM stapling run and its successful recovery.
The historical, separately recorded [Linux x64 marketplace trial](./guide/connector-status.md#what-the-tests-establish)
uses App beta 18 with server beta 40 and the published 0.1.4 catalog; this is
not Mac or Windows marketplace/provider acceptance. App beta 17 remains
available as a [historical release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.17).

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
The [fresh beta 42 installer check](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product42-public-installer-2026-10-17.json)
passed normal server-plus-CLI installation on Linux x64/CPython 3.11.14 with
temporary and installation directories on different mounts. This is an
installation boundary, not Windows/macOS server execution or native GUI proof.

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
  — six qualified platform bundles and the exact Python wheel reused by server/CLI beta 42.
  The desktop App retains its own release lock.
- [Shared connector module/runner 0.1.5](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.5)
  — sixteen official adapters plus Custom MCP, including Exa/Firecrawl keyless
  reads; Python/MCP transport, platform manifests and checksums.
- [Connector auth service 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.6)
  — separate operator release; ClickUp, GitHub and Notion enrollment is deployed
  as a limited public beta. Other provider gates remain independent.
- [Product release manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.42/manifest.json)
  — component versions, source commits and SHA-256 digests.

Existing 0.x installations continue to use their historical updater endpoints
during the transition. Retained historical release assets and updater endpoints remain available.
The historical App repository still executes the reviewed canonical-source
signing and updater bridge. The installed-version →
transition → canonical-release chain remains separately qualified from provider
consent. Desktop beta clients retain their beta channel and manual update behavior;
archival preserves the published downloads and updater feed.
