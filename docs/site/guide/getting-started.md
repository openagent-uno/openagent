# Getting Started

OpenAgent is available as the standalone product or as independently versioned
libraries. The current manual-upgrade server/CLI cohort is
[1.1.8](https://github.com/openagent-uno/openagent/releases/tag/v1.1.8), with
Core beta43 and Device Tools B10. App beta24 carries the canonical desktop
updater. See [downloads](../downloads) for publication and verification scope.

## Desktop app

<ReleaseDownloads target="desktop" />

Choose the installer for your OS and CPU. Replace an existing App without
uninstalling it or deleting its profile. Manually selecting beta24 opts into its
beta update channel. New builds use the canonical feed; reinstalling an older
build may preserve an obsolete feed. Native artifact checks and provider
acceptance remain separate; see [downloads](../downloads).
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
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --server

# CLI
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --cli

# Download and verify every first-party wheel without installing
curl -fsSL https://github.com/openagent-uno/openagent/releases/download/v1.1.8/install.sh | sh -s -- --check
```

The installer checks first-party wheels against the six pinned manifests
below, creates its isolated virtual environment and refuses to overwrite an
unrelated command. Server installation also acquires and verifies the SDK-pinned
native connector runner; users do not need a Go compiler. `--check` verifies the
wheelhouse without installing dependencies or acquiring the native runner.
The default installer root is shared. If both commands are already installed
there, run both installers when upgrading so their exact-version dependencies
stay aligned. The CLI remains a remote client and does
not need the server engine, model runtime or local connector runner.
The current product manifest and immutable installer contain the exact six
release pins and SHA-256 values. The public installer has completed in an owned
temporary macOS prefix, including the verified native connector runner. Clean
wheel dependency resolution, CLI startup and 31 installed updater contracts and live two-page GitHub feed verification also
passed. This does not establish production or provider acceptance.

The Python host-tools B8 facade inherits Device Tools B10. Native App bundles
remain the unchanged signed B7 artifacts; native helper versions still pinned by
other clients remain available at canonical compatibility tags. Earlier full
runtime/profile receipts are dated evidence for their original cohorts, not
qualification of new source.

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
