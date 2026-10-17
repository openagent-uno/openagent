# Getting Started

OpenAgent can be used as the complete standalone product or embedded as a
library. The current assembly is **server/CLI v1.1.0-beta.43**, Core beta 22,
connector SDK/runner 0.1.6, Host Tools 1.0.0b6 and desktop **App v1.1.0-beta.20**.
See [downloads](../downloads) and [qualification status](./connector-status.md)
for the independently recorded installation, provider, packaging and GUI boundaries.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your operating system and CPU, launch OpenAgent, and
connect it to an existing standalone server. App 20 has six qualified native
targets; both macOS builds are signed and notarized. Its
[Linux x64 App 20/server 43 marketplace trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app20-server43-marketplace-2026-10-17.json)
loaded 19 official connectors and 30 registry results in one grid and exercised
five keyless connections without provider calls. Hosted Electron used
`--no-sandbox`; this does not establish sandbox security or Mac/Windows marketplace GUI.
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
[fresh public-installer receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
records successful combined installation and dependency checks with default
HOME/TMPDIR and without a source overlay. This does not claim
native App GUI acceptance or Windows/macOS server execution.

| Pinned release manifest | SHA-256 |
| --- | --- |
| [Product beta 43](https://github.com/openagent-uno/openagent/releases/download/v1.1.0-beta.43/manifest.json) | `0458e049e3bfeafafff7c677670bdc30eeeb7a70ec8e93eac1742f6e45ba5e63` |
| [Core beta 22](https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.22/manifest.json) | `291be9e298c1035ae88079b849620e9a8a04e03f43dd9180f86ebe6e79f4876d` |
| [Tools beta 4](https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.4/manifest.json) | `20b583195ac624c8f46a3c484eb596a5545dc514d60cbe7ed12e7b6f4da48228` |
| [Connector SDK 0.1.6](https://github.com/openagent-uno/openagent-tools/releases/download/connectors-v0.1.6/manifest.json) | `a1e87b9469cadfc1c8184e4ad704d0b7ed26ee7233f6145bf15baddfe19789f5` |

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
