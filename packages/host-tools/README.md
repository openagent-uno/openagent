# Standalone host-tools composition

This package preserves the published `openagent-host-tools` command, Python API,
identity/configuration locations, durable consent and broker protocol. It composes
`openagent-capability-host` with the independent filesystem/editor/shell/device
packages. Their implementations and native source files have one owner in
`openagent-tools`; the generic host is in `openagent-core`.

Individual MCP commands are owned by the corresponding tool package. The legacy
`openagent_host_tools.mcp_server` module remains a forwarding dispatcher. Product
packaging obtains native sources through `openagent_device_tools.sidecar_source`
and keeps the existing signing identifiers. Sidecar integrity verification uses
the explicit product bundle version, independent of the device package version.

Validated during extraction: existing suite 87 passed, 2 skipped; clean wheel
installation outside repositories 35 passed, 1 Windows-only skip. These checks do
not qualify signed installers, updater transitions or real OS interaction.

Host composition can explicitly select its built-ins with
`CapabilityHost(builtin_names=("filesystem", "editor", "shell"), paths=..., cwd=...,
process_environment=...)`. Omitting `builtin_names` preserves the complete
standalone bundle. A selection without device sidecars performs no sidecar
discovery; explicit process environments also apply to shell calls. This is a
host configuration API, not a routing argument accepted from a model or client.
The selected-bundle tests verify these boundaries using a real shell process.

The usage reference below documents the preserved product behavior.

The `1.0.0b3` source candidate composes device-tools `1.0.0b2`. Its local
computer-control source additionally lists desktop windows and captures one
window by the returned window/process pair. The desktop app's checked-in
resource manifest still points to the previously signed bundle; a new signed
multi-platform bundle and installer lock are required before installed app
users receive these tools.

# OpenAgent Host Tools

`openagent-host-tools` is the local capability host shared by OpenAgent's
Desktop and interactive CLI clients. It exposes filesystem, editor, shell and
configured local MCP servers from the computer on which the client is running.

The package can be imported as a Python API or launched as an NDJSON stdio
sidecar:

```console
openagent-host-tools
```

The protocol version is `openagent-host-tools/1`. Requests are one JSON object
per line and use the following `type` values: `initialize`, `catalog`, `call`,
`cancel`, `status`, `set_consent`, and `shutdown`.

Local access is fail-closed. A user enables it once per device with the Desktop
client or:

```console
openagent-cli local-tools enable
```

That consent is persistent and unrestricted: after enabling, there are no
per-call prompts or artificial filesystem roots. Only built-ins and MCP plugins
explicitly present in `client-mcps.toml` are loaded.

Desktop and CLI share `~/.openagent/user/client-mcps.toml` and
`~/.openagent/user/client-tools-consent.json`. Set
`OPENAGENT_HOST_TOOLS_HOME` to override that user directory. Internal lease,
idempotency and audit databases live in its `host-tools/` child directory.

The release bundles obtain computer-control and Agent-in-Chrome sources from
the installed `openagent-device-tools` package, maintained in `openagent-tools`. Each native bundle contains a
`bundle-manifest.json` with the version, size and SHA-256 of every runtime file;
frozen hosts verify it before starting a sidecar. Tag `v0.1.0` publishes the
universal Python wheel and native macOS, Linux and Windows x64/arm64 archives
with detached checksums.

The Python built-ins also have official MCP stdio entrypoints:
`openagent-filesystem-mcp`, `openagent-editor-mcp`, and `openagent-shell-mcp`.
The shell advertises the experimental capability
`openagent/shell-completion` version `1`. Background completion is delivered as
a standard `notifications/message` logging notification from logger
`openagent.shell`; its `data` object is the same `shell_completed` event emitted
by the embedded capability host. MCP consumers should register a logging
callback and route that logger's data into the agent event/autoloop path rather
than treating it as diagnostic text.
