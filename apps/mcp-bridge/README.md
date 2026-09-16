# openagent-mcp

Talk to [OpenAgent](https://github.com/openagent-uno) agents from **any MCP host** —
Claude Code, or another agent — over OpenAgent's native **Iroh** transport.
Peer-to-peer and NAT/tailnet-traversing: no shared network, no port-forwarding,
no reverse proxy. It's the CLI/desktop client's sibling, but shaped for an agent.

One server, **two tools**, any number of target agents:

- `list_agents()` — the agents you've configured (name + description only).
- `ask_agent(target, message, session_id?)` — send a message to one of them and
  get its reply. Omit `session_id` to start a new conversation (the returned id
  is the handle to continue it); pass it back to resume.

Each `ask_agent` lands as a **first-class conversation on the target agent** —
persisted, and (once the target runs the peer-session patch) visible in its app
sidebar with full capabilities (it can use its own tools, spawn sub-agents,
schedule tasks). Just like a human talking to that agent.

## How it works

A configured target is a connection descriptor `(node_id, relay_url, addresses)` —
carried by an OpenAgent **invite ticket** (`oa1…`) or given explicitly.
`openagent-mcp` runs its own Iroh node and dials the target on the agent-to-agent
ALPN (`openagent/agent/1`); the QUIC handshake proves node_id ownership, and the
message is POSTed to the target's `/api/chat` over that stream.

The wire client is the small, dependency-light `oa_agent_client` package
(only `iroh`, `aiohttp`, `cbor2`, `cryptography`). The same core + tool layer is
also **embedded inside openagent-server** as a builtin, so an OpenAgent agent
reaches its federated peers with the identical tool surface — add a peer to the
Iroh network and it's reachable, no extra configuration.

## Install (standalone)

```bash
pip install "openagent-mcp[stdio]"
```

Create a targets file (keep it `chmod 600` — tickets are bearer credentials):

```toml
# ~/.openagent-mcp/targets.toml
[client]
identity_path        = "~/.openagent-mcp/identity.key"   # persistent → stable node_id
default_timeout_secs = 900
strict_config_perms  = true

[[targets]]
name        = "research"
description = "A research agent."
ticket      = "oa1…"        # a self-contained invite ticket (preferred)

[[targets]]
name        = "ops"
description = "An ops agent (iroh-only)."
node_id     = "…"            # …or an explicit descriptor: the peer's 64-hex Iroh node id
relay_url   = "https://euw1-1.relay.iroh.network./"
```

Register with your MCP host (see `examples/claude_code_mcp.json`):

```bash
claude mcp add openagent-agents \
  -e OPENAGENT_MCP_CONFIG=$HOME/.openagent-mcp/targets.toml \
  -- openagent-mcp
```

## Security

- **Persistent identity.** The client keeps a stable Ed25519 key (`0600`), so its
  node_id is consistent and allowlist-ready.
- **Alias-only addressing.** The model only ever sees the opaque target `name`;
  node ids, relays and addresses never enter its context, and are redacted from
  logs and errors.
- **Tickets are secrets.** Config is a file (perms-checked), never an env blob.
- Today an OpenAgent agent accepts any node that can dial its agent-ALPN endpoint.
  Enrollment + an opt-in allowlist (so only invited peers are accepted) are on the
  roadmap; the invite ticket is what will gate access.

## License

MIT
