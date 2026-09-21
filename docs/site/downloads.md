# Download OpenAgent

The current public build is **v1.1.0-beta.2**. It is a beta of the new modular
architecture and its release manifest is marked `development-unqualified`:
the published artifacts are tested, but this release does not claim a complete
cross-platform updater chain.

All new product downloads come from the canonical
[`openagent`](https://github.com/openagent-uno/openagent) repository. Core and
Tools remain independently versioned libraries.

## Desktop app

<ReleaseDownloads target="desktop" />

The current desktop beta is signed, notarized and stapled for **macOS on Apple
Silicon**. Windows, Linux and Intel macOS installers will appear here only after
those exact artifacts have completed their release gates.

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

- [OpenAgent Core v1.1.0-beta.1](https://github.com/openagent-uno/openagent-core/releases/tag/v1.1.0-beta.1)
  — kernel, SDK, storage and optional module wheels.
- [OpenAgent Tools v1.0.0-beta.1](https://github.com/openagent-uno/openagent-tools/releases/tag/v1.0.0-beta.1)
  — filesystem, editor, shell, web search and device capability packages.
- [Product release manifest](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.2/product-release-manifest.json)
  — component versions, source commits and SHA-256 digests.

Existing 0.x installations continue to use their historical updater endpoints
during the transition. Those repositories retain their immutable tags and
release assets until the installed-version → transition → canonical-release
chain has been verified.
