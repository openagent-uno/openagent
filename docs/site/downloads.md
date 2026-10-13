# Download OpenAgent

The current server and CLI build is **v1.1.0-beta.38**. The latest desktop App
is **v1.1.0-beta.16**, published for macOS, Windows and Linux on ARM64 and x64.
These are betas of the modular architecture. Provider activation and product
qualification are recorded separately in [Connector release status](./guide/connector-status.md).

Product source and server/CLI releases come from the canonical
[`openagent`](https://github.com/openagent-uno/openagent) repository. Desktop
assets use the preserved historical App updater repository during the signed
transition; their manifests identify the exact canonical payload commit.
Core, Tools, connector runner and auth service are independently versioned.

## Desktop app

<ReleaseDownloads target="desktop" />

The current desktop beta is signed and notarized for **macOS on Apple Silicon
and Intel**. Windows and Linux installers are published for both architectures.
The [App beta 16 release](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.16)
includes installer checksums, six platform provenance manifests and verified
update metadata. Native packaged launches passed on all six targets.

## Standalone server

<ReleaseDownloads target="server" />

The beta server is distributed as a Python 3.11+ wheel. Use the complete
wheelhouse procedure in [Getting Started](./guide/getting-started), because the
standalone product pins independently released Core and Tools packages.

```bash
curl -fsSL https://openagent.uno/install.sh | sh
```

## CLI

<ReleaseDownloads target="cli" />

The beta CLI is distributed as a Python 3.11+ wheel and uses the same verified
wheelhouse as the server.

```bash
curl -fsSL https://openagent.uno/install.sh | sh -s -- --cli
```

## Libraries

- [OpenAgent Core v1.1.0-beta.21](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.21)
  — kernel, SDK, storage and optional module wheels.
- [OpenAgent Tools v1.0.0-beta.4](https://github.com/openagent-uno/openagent-tools/releases/tag/v1.0.0-beta.4)
  — filesystem, editor, shell, web search, device capabilities and the optional
  Meta Ads MCP package with video upload support.
- [OpenAgent host-tools v1.0.0b4](https://github.com/openagent-uno/openagent/releases/tag/v1.0.0b4)
  — six platform bundles pinned by the App release lock. Standalone beta 38
  also publishes the host-tools `1.0.0b5` wheel for local runner acquisition.
- [Shared connector module/runner 0.1.2](https://github.com/openagent-uno/openagent-tools/releases/tag/connectors-v0.1.2)
  — shared provider adapters, Python/MCP transport, platform manifests and checksums.
- [Connector auth service 0.1.3](https://github.com/openagent-uno/openagent-tools/releases/tag/connector-auth-v0.1.3)
  — separate operator deployment release; public provider enrollment remains disabled.
- [Product release manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.38/manifest.json)
  — component versions, source commits and SHA-256 digests.

Existing 0.x installations continue to use their historical updater endpoints
during the transition. The historical repositories are archived read-only and
retain their immutable tags and release assets. The installed-version →
transition → canonical-release chain remains separately qualified from provider
consent. Desktop beta clients retain their beta channel and manual update behavior;
archival preserves the published downloads and updater feed.
