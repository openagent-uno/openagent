# Getting Started

OpenAgent is available as the standalone product or as independently versioned
libraries. The sections below discover the latest published version of each
component, including labeled betas. See [downloads](../downloads) for platform
packages and release qualification.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your OS and CPU. Replace an existing App without
uninstalling it or deleting its profile. Selecting a beta build opts into its
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

The server and thin remote CLI are portable Python 3.11+ wheels. The interpreter
must include `venv` and `ensurepip` (for example, `python3-venv` on Debian).
Choose the release above, then use its manifest and installation notes to acquire
the complete dependency set. Keep first-party versions aligned when the server
and CLI share an environment.

A Framework wheel alone is not the complete standalone installation: its qualified
distribution also uses independently versioned Core, modules, native Host Tools and
connector packages. Native capabilities depend on OS and architecture. Follow the
[build and release contract](https://github.com/openagent-uno/openagent/blob/main/docs/build-and-release.md)
and [operator acquisition contract](./connector-operations.md#pinning-the-shared-implementation)
for exact package and native-runner acquisition. Historical version-pinned installer
recipes remain in their original release notes; they do not select this page's
latest downloads.

After installing the matching distribution, make its command directory available
on your `PATH`. Preserve identity and agent directories when upgrading.

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
