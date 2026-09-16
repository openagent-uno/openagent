# Getting Started

OpenAgent has two installable client pieces plus an optional CLI. You only need the **Agent Server** — the CLI and Desktop App are optional clients.

## Agent Server

The runtime. Install this on the machine where your agent should live.

<ReleaseDownloads target="server" />

**macOS** — double-click the `.pkg`. **Linux / Windows** — extract the archive. Or from a terminal:

```bash
curl -fsSL https://openagent.uno/install.sh | sh
```

Start it from any folder:

```bash
openagent serve ./my-agent
```

The folder becomes your agent — config, memory, and database live inside `./my-agent/`.

**First run:** `openagent serve` automatically bootstraps a personal network. It prints an invite ticket (`oa1...`) — paste this into the desktop app or CLI client to connect. No separate setup step needed. See [Invitation System & Networking](./invitation-system.md) for details on how the network works.

```bash
openagent serve --no-auto-init   # Skip network bootstrap (standalone mode)
```

## Desktop App

A native chat window for your agent.

<ReleaseDownloads target="desktop" />

Launch the installer, then paste the invite ticket printed by `openagent serve` to connect. The desktop app handles the Iroh P2P transport and device certificate automatically — no manual config needed.

## CLI Client

A terminal client for talking to a running server.

<ReleaseDownloads target="cli" />

Extract the archive and connect using the invite ticket:

```bash
# First-time join (paste the oa1... ticket from the server)
openagent-cli connect oa1abc123...

# Returning user (saved credentials)
openagent-cli connect alice@homelab
```

## Multi-agent

Run multiple independent agents in parallel, each with its own data directory:

```bash
openagent serve ./agent-work
openagent serve ./agent-home
```

Each directory contains its own `openagent.yaml`, database, memories, and logs. Each gets its own Iroh identity and network configuration.

## Service installation

Install OpenAgent as a system service that auto-starts on boot:

```bash
openagent service install          # Default service
openagent service install ./my-agent   # Per-agent service
openagent service status
openagent service uninstall
```

Supports systemd (Linux), launchd (macOS), and Task Scheduler (Windows).

## Next steps

- [Invitation System & Networking](./invitation-system.md) — how clients connect
- [Configure your agent](./config-reference.md)
- [Pick a model](./models.md)
- [Add MCP tools](./mcp.md)
- [Connect a channel](./channels.md)
