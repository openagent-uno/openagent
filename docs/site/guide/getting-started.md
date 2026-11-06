# Getting Started

OpenAgent is available as the standalone product or as independently versioned
libraries. The current manual-upgrade server/CLI cohort is
[1.1.9 beta 10](https://github.com/openagent-uno/openagent/releases/tag/v1.1.9-beta.10), with
Core beta48 and Device Tools B18. App beta26 carries the canonical desktop
updater. See [downloads](../downloads) for publication and verification scope.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your OS and CPU. Replace an existing App without
uninstalling it or deleting its profile. Manually selecting beta26 opts into its
beta update channel. New builds use the canonical feed; reinstalling an older
build may preserve an obsolete feed. Native artifact checks and provider
acceptance remain separate; see [downloads](../downloads).
Private human sessions can use all connected, consenting devices belonging to
their authenticated owner. Devices lists connected and offline computers; session
details contain participants, used devices and a direct desktop view. Channel,
scheduled and agent ingress does not acquire client authority implicitly. The
embedded Core supports other topologies through host-supplied optional grants.

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
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --server

# CLI
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --cli

# Download and verify every first-party wheel without installing
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.9-beta.10/install.sh | sh -s -- --check
```

The installer verifies 39 first-party wheels against nine pinned manifests,
creates an isolated virtual environment and refuses to overwrite unrelated
commands. It binds each first-party dependency to the verified local bytes and
acquires the complete native Host Tools B15 bundle. Server installation also
acquires the pinned native connector runner; no local native compiler is needed.
`--check` verifies the wheelhouse and installation metadata without installing
or acquiring the native archives.

The default installer root is shared. If server and CLI are both installed there,
upgrade both so their exact-version dependencies stay aligned. The CLI remains a
remote client and does not install the server engine or connector runner.
Device Tools B18 owns reusable native/browser behavior; the product composes it
through the Host Tools B15 facade. Core remains independent of clients, users
and the native distribution. See the [release receipt](https://github.com/openagent-uno/openagent/blob/main/docs/qualification/device-release-2026-11-06.json)
for qualification and limits.

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
