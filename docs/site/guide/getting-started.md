# Getting Started

OpenAgent can be used as the complete standalone product or embedded as a
library. Current Python releases are **server/CLI v1.1.0-beta.45**, Core beta22,
connector SDK/runner 0.1.8 and Host Tools 1.0.0b6: 114 official connectors plus
Custom MCP, including 90 token profiles with two reads each. Desktop **App
v1.1.0-beta.21** remains public; App22 publication and actual GUI checks are pending.
See [downloads](../downloads) and [qualification status](./connector-status.md)
for the independently recorded installation, provider, packaging and GUI boundaries.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your operating system and CPU, launch OpenAgent, and
connect it to an existing standalone server. [App21](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.21)
has six qualified native targets and 36 verified assets; both macOS builds are
signed and notarized. Its [Linux x64 App21/server44 marketplace trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app21-server44-marketplace-2026-10-17.json)
loaded 22 official connectors and 30 registry results in one grid, with five
local keyless control cycles and no provider calls. These screenshots and
receipts retain their original version scope, rather than qualifying the new
114-entry App22/server45 GUI. Hosted Electron used `--no-sandbox`; this does not
establish sandbox security or Mac/Windows marketplace GUI.
The app registers dashboard and local-computer capabilities only for its
authenticated device turns; Telegram, scheduled work and other clients do not inherit them.

## Standalone server and CLI

<ReleaseDownloads target="server" />

<ReleaseDownloads target="cli" />

The beta server and CLI are Python 3.11+ wheels. The interpreter must include
`venv` and `ensurepip`; some Linux distributions package these separately
(for example `python3-venv` on Debian). The public installation was qualified
on CPython 3.11.14/Linux x64. Use the normal public installer rather than
assembling a partial wheel set:

```bash
# Standalone server
curl -fsSL https://openagent.uno/install.sh | sh -s -- --server

# CLI
curl -fsSL https://openagent.uno/install.sh | sh -s -- --cli

# Download and verify every first-party wheel without installing
curl -fsSL https://openagent.uno/install.sh | sh -s -- --check
```

The installer checks first-party wheels against the four pinned manifests
below, creates its isolated virtual environment and refuses to overwrite an
unrelated command. Server installation also acquires and verifies the SDK-pinned
native connector runner; users do not need a Go compiler. `--check` verifies the
wheelhouse without installing dependencies or acquiring the native runner.
Installing server and CLI uses the same default installation root. The
[historical beta43 public-installer receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
records its successful combined installation and dependency checks with default
HOME/TMPDIR and without a source overlay. The current installer pins beta45/SDK18;
its fresh public-install trial is recorded separately in [release status](./connector-status.md).
Installed beta45 qualification passed 210 tests and 15 React source scenarios.
Neither boundary claims native App GUI acceptance or Windows/macOS server execution.

| Pinned release manifest | SHA-256 |
| --- | --- |
| [Product beta45](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.45/manifest.json) | `cab1b4dc4555f23fc22e5f9a9b32ba6618cebe1ada8404ebac85257b031eff3c` |
| [Core beta 22](https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.22/manifest.json) | `291be9e298c1035ae88079b849620e9a8a04e03f43dd9180f86ebe6e79f4876d` |
| [Tools beta 4](https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.4/manifest.json) | `20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228` |
| [Connector SDK 0.1.8](https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.8/manifest.json) | `85128fb54ae414269cfa70064bd9b0de724906770db416949e5747be97139916` |

The product manifest also binds the unchanged Host Tools B6 wheel/bundles.
Embedding products or custom packagers should follow the
[operator acquisition contract](./connector-operations.md#pinning-the-shared-implementation),
including native runner acquisition, instead of treating a bare Framework
`pip install` as equivalent to the standalone installer.

Commands are linked into `~/.local/bin` by default; make that directory
available on your `PATH`. Use installer `--prefix /your/bin` for another command
directory and add that directory to `PATH`. `OPENAGENT_INSTALL_ROOT` can select
an owned installation root; it does not change your home or identity profile.

Start a standalone agent from any folder:

```bash
openagent init ./my-agent
openagent serve ./my-agent
```

The folder contains the product configuration, SQLite state, vault and logs.
On first run the standalone identity package bootstraps the configured network
and prints an invite ticket. Connect the CLI with that verified ticket:

```bash
openagent-cli connect oa1abc123...
```

## Embed Core in another product

Products install only the Core packages and modules they select. The host owns
authentication, authorization, credentials, infrastructure and deployment:

```python
profile = RuntimeProfile(modules={
    "sessions": ModuleConfig(surfaces={"service", "agent_tools", "host_api"}),
    "vault": ModuleConfig(surfaces={"service", "agent_tools"}),
    "mcp": ModuleConfig(
        surfaces={"service", "host_api"},
        options={"catalog_mode": "managed"},
    ),
})

runtime = Runtime(settings=settings, services=services, profile=profile)
await runtime.start()
```

An embedding host can follow this model: it builds its own worker image from pinned
packages and owns its pods, sandbox, volumes and identity adapters. It does not
download or patch the standalone OpenAgent repository at runtime.

## Next steps

- [Understand the modular architecture](./architecture)
- [Configure the standalone product](./config-reference)
- [Choose models](./models)
- [Configure MCP mode](./mcp)
- [Connect a channel](./channels)
