# Getting Started

SDK 1.1.5 is public and has passed installed package, full runtime and actual CLI startup/shutdown checks. Production rollout and signed desktop GUI acceptance are still pending; see the qualification receipt for the exact scope.

OpenAgent can be used as the complete standalone product or embedded as a
library. The qualified public server/CLI cohort is **[v1.1.5](https://github.com/openagent-uno/openagent/releases/tag/v1.1.5)**,
with Core/SQLite beta41, unchanged modules from beta37, Tools beta6, Host Tools
B7, capability-host B3, Python connectors 0.1.15 and native Go connector
SDK/runner 0.1.14. The App host library is MCP Apps 0.1.1. Desktop **App
v1.1.0-beta.22** remains the published download; beta23 is not public.
See [downloads](../downloads) for package, installation, production and GUI
qualification boundaries. These page updates still await site deployment.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your operating system and CPU, launch OpenAgent, and
connect it to an existing standalone server. [App22](https://github.com/openagent-uno/openagent-app/releases/tag/v1.1.0-beta.22)
has six qualified native targets and 36 verified assets; both macOS builds are
signed and notarized. Its [Linux x64 App22/server45 marketplace trial](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/app22-server45-marketplace-2026-10-18.json)
loaded 114 official connectors and 30 registry results in one grid, verified
45 shared SVGs and 12 bundled marks, and captured ten reviewed screenshots.
Postman token setup stayed blank and was cancelled; one Exa local control cycle
completed. No provider call, model turn or new OAuth grant occurred. Google and
Microsoft common enrollment remained off. Historical App21/server44 receipts
and images retain their original versions. Hosted Electron used `--no-sandbox`;
this does not establish sandbox security or Mac/Windows marketplace GUI.
The app registers dashboard and local-computer capabilities only for its
authenticated device turns; Telegram, scheduled work and other clients do not inherit them.

## Standalone server and CLI

<ReleaseDownloads target="server" />

<ReleaseDownloads target="cli" />

The server and thin remote CLI are Python 3.11+ wheels. The interpreter must include
`venv` and `ensurepip`; some Linux distributions package these separately
(for example `python3-venv` on Debian). The public installation was qualified
with separate server and CLI prefixes from the anonymous release assets. Use
the version-pinned public installer rather than assembling a partial wheel set:

```bash
# Standalone server
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.5/install.sh | sh -s -- --server

# CLI
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.5/install.sh | sh -s -- --cli

# Download and verify every first-party wheel without installing
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.5/install.sh | sh -s -- --check
```

The installer checks first-party wheels against the four pinned manifests
below, creates its isolated virtual environment and refuses to overwrite an
unrelated command. Server installation also acquires and verifies the SDK-pinned
native connector runner; users do not need a Go compiler. `--check` verifies the
wheelhouse without installing dependencies or acquiring the native runner.
The default installer root is shared; the CLI remains a remote client and does
not need the server engine, model runtime or local connector runner.
The [current qualification receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product-stable-1.1.5-source.json)
records 469 tests and 168 subtests on installed wheels, successful anonymous
server/CLI installation with pip checks, CLI/server help and native catalog/ORM
probes. The full profile in the public-installer prefix started 14 modules and
exposed 210 catalog tools, read budgets and closed eight tracked SQLite
connections with zero remaining workers or child processes. That profile used
controlled certificate/worker dependencies and made no model/provider calls;
it does not establish authenticated production transport health, App GUI,
GlassPalace or ICS end-to-end acceptance. Production health remains pending.

| Pinned release manifest | SHA-256 |
| --- | --- |
| [Product 1.1.5](https://github.com/openagent-uno/openagent/releases/download/v1.1.5/manifest.json) | `1384e2f3381facba4faa9f3eea0d0b76c0d63d82ca043793499f6c8f2d8dbe45` |
| [Core beta41](https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.41/manifest.json) | `5d8c24acd692a41e7921c1c7ddf5be011732ecc0f3f3a8c97ed8fe756f610e46` |
| [Unchanged modules, beta37](https://github.com/openagent-uno/openagent-core/releases/download/v1.1.0-beta.37/manifest.json) | `bbdc069507368b9b7c04ae5af780fcede035f01ed429ccfb8fd49f2ecdf15ead` |
| [Tools beta6](https://github.com/openagent-uno/openagent-tools/releases/download/v1.0.0-beta.6/manifest.json) | `f7d4dbb5c2a17687266ad3c74a8d796c9e2787d8bf5a2617dadcdce1f0fc46bd` |

The [immutable installer](https://github.com/openagent-uno/openagent/releases/download/v1.1.5/install.sh)
has SHA256 `ddd1ca58fb0de5dd7e6241179ef985eb34a4ba30a4e280ce47a55194052d4957`.
The product manifest also binds the unchanged Host B7 wheel. The six-platform
[Host B7 index](https://github.com/openagent-uno/openagent/releases/download/v1.0.0b7/release-index.json)
has SHA256 `661c7f87cbcefddf66c619ccd63e44ef4f2b3c0f98981bfc45a52b8923e0e824`;
capability-host B3 retains its original Core40 provenance and exact wheel bytes.
The separately versioned Go runner 0.1.14 comes from the server wheel's verified
connector lock. The older [beta51 installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product51-public-installer-2026-10-19.json)
and [beta43 installer](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/product43-public-installer-2026-10-17.json)
receipts retain their original versions and scope.

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
