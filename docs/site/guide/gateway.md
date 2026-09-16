# Gateway

The Gateway is OpenAgent's public interface — a WebSocket + REST server that lives **inside the AgentServer process**. Every client (desktop app, CLI, Telegram/Discord/WhatsApp bridges) talks to the agent through it.

Unlike a traditional HTTP server listening on a TCP port, the Gateway is served over **Iroh QUIC** (a P2P transport). Clients don't connect to `localhost:8765` — they connect to the agent's Iroh NodeId, authenticated by a coordinator-signed device certificate.

```
 ┌────────────────────────────────────────────────────────┐
 │  Agent Directory (./my-agent)                          │
 │  ┌─────────────────────────┐                           │
 │  │   Agent Core            │  openagent.yaml           │
 │  │   Agent + MCPs          │  openagent.db             │
 │  └──────────┬──────────────┘  memories/                │
 │             │                  logs/                   │
 │  ┌──────────▼──────────────┐                           │
 │  │      Gateway             │                          │
 │  │  WS + REST (aiohttp)    │                           │
 │  │  over Iroh QUIC          │                           │
 │  │  Device cert auth        │                           │
 │  └──────────┬──────────────┘                           │
 └─────────────┼──────────────────────────────────────────┘
               │ Iroh QUIC (P2P)
  ┌────────────┼────────────────┐
  │            │                 │
┌─▼──────┐ ┌──▼─────────┐ ┌────▼───┐
│Bridges │ │ Desktop App│ │  CLI   │
│TG/DC/WA│ │ (Electron) │ │(term.) │
│(certs) │ │ (certs)    │ │(certs) │
└────────┘ └────────────┘ └────────┘
```

## Authentication

The Gateway uses **device certificate authentication**, not bearer tokens or shared secrets. Every inbound connection carries a coordinator-signed certificate that binds a user handle to a device public key.

The `NetworkAuthState` middleware runs on every request:
1. Extract the cert wire bytes from the Iroh stream
2. Verify the Ed25519 signature against the pinned coordinator public key
3. Prove the cert device key is the Iroh peer key for this connection
4. Check the cert hasn't expired (30-day TTL)
5. Check the cert is for this network (`network_id` match)
6. Check live device membership/revocation
7. Annotate the request with `device_cert`, `client_id`, and `user_handle`

Failed auth returns `401 unauthorized`. Unlike the legacy shared-token model, each device has its own credential — revoking one device doesn't affect others for the same user.

See [Invitation System & Networking](./invitation-system.md) for the full cert lifecycle and coordinator architecture.

## WebSocket protocol

All traffic on `/ws` is JSON. The protocol uses typed messages for both directions.

Desktop and CLI may additionally open `/ws/capabilities` for the versioned,
turn-scoped local computer tool plane. It uses the same device certificate but
rejects token, bridge and agent-peer identities. See
[Client Computer Capabilities](./client-capabilities.md).

### Client → Server

| Type | Payload | Purpose |
|---|---|---|
| `auth` | `{token, client_id}` | Handshake (legacy: now cert-based, but still present for bridges) |
| `session_open` | `{session_id}` | Open or resume a conversation session |
| `text_final` | `{text, session_id, attachments?}` | Send a user turn to the agent |
| `audio_chunk_in` | `{session_id, data: base64, seq, is_end}` | Voice mode audio input |
| `attachment` | `{session_id, path, filename, type}` | Attach a file to the current turn |
| `interrupt` | `{session_id}` | Interrupt the current agent run |
| `command` | `{name: stop\|clear\|new\|reset\|…, session_id}` | Slash-command equivalents |
| `ping` | `{}` | Keep-alive |

### Server → Client

| Type | Payload | Purpose |
|---|---|---|
| `auth_ok` | `{agent_name, version}` | Handshake accepted |
| `auth_error` | `{reason}` | Handshake rejected |
| `delta` | `{text, session_id}` | Streaming token during generation |
| `status` | `{text, session_id}` | Tool-use progress (e.g. the agent's `ToolExecution` JSON) — **data**, not a UI string |
| `reasoning` | `{active, session_id}` | Boolean "the agent is thinking" flag. The server never ships a `"Thinking…"` UI string — each client renders its own affordance (native typing indicator, CLI spinner, app animation). `active=true` while thinking, `false` once output starts or the turn ends |
| `response` | `{text, session_id, model, attachments}` | Final agent reply for a turn |
| `turn_complete` | `{session_id, usage}` | Turn finished, includes cost/token info |
| `queued` | `{position}` | Message accepted, waiting in FIFO queue |
| `pong` | `{}` | Keep-alive ack |
| `audio_start` / `audio_chunk` / `audio_end` | `{session_id, …}` | TTS audio streaming |
| `resource_event` | `{resource, action, id}` | Broadcast on MCP/vault/task/config mutations |
| `system_snapshot` | `{cpu_percent, ram_percent, disk_percent}` | System health broadcast |
| `error` | `{text}` | Recoverable error |
| `command_result` | `{text}` | Response to a slash command |

### Attachments

Attachments use markers in reply text (`[IMAGE:/path]`, `[FILE:/path]`, `[VOICE:/path]`, `[VIDEO:/path]`) which the gateway strips and moves into the structured `attachments` array with `{type, path, filename}` entries.

## Session management

The Gateway owns a `SessionManager` that enforces **one active run per client** (`client_id` = device pubkey hex) with a FIFO queue. Messages arriving while a turn is in flight get an immediate `queued` acknowledgement with position, then stream `status` events until `response` arrives. An `interrupt` command cancels the active run.

Sessions are isolated — each `session_id` maps to its own conversation history. Bridges use platform-specific session IDs (e.g. `tg:155490357` for Telegram), while the desktop app and CLI use arbitrary strings. Session bindings (which model served this session) persist in SQLite across restarts.

## REST API

All endpoints live under `/api/` on the same aiohttp application. Every request is authenticated via device cert middleware (except `/api/health` which may bypass for liveness checks).

```
# Health + identity
GET    /api/health                → agent status
GET    /api/agent-info            → agent name, dir, port, version

# Config (hot-reloads on write)
GET    /api/config                → read full config
PUT    /api/config                → replace full config
PATCH  /api/config/{section}      → update one section

# Vault (Obsidian-compatible markdown notes)
GET    /api/vault/notes           → list notes
GET    /api/vault/notes/{path}    → read note content + frontmatter + links
PUT    /api/vault/notes/{path}    → write/update note (validates + commits → {ok,path,warnings,commit})
DELETE /api/vault/notes/{path}    → delete note
GET    /api/vault/graph           → {nodes, edges} wikilink graph
GET    /api/vault/search?q=…      → full-text search (FTS5)

# Vault quality system (see vault-quality.md)
GET    /api/vault/gate?strict=&limit=   → run the quality gate → report
GET    /api/vault/stats                 → {notes, links, broken_links, orphans, components}
GET    /api/vault/history?path=&limit=  → git log + parsed provenance trailers
POST   /api/vault/doctor?apply=         → mechanical auto-fix (dry-run unless apply)
POST   /api/vault/derived               → regenerate llms.txt + _showcase/showcase.md
POST   /api/vault/move    {from,to}     → move/rename + rewrite inbound wikilinks
POST   /api/vault/init                  → scaffold the folder taxonomy
POST   /api/vault/index/sync?force=     → reconcile the incremental index

# Usage / pricing
GET    /api/usage                 → monthly spend summary
GET    /api/usage/daily           → day-by-day breakdown

# Models & providers
GET    /api/models                → list models from DB
GET    /api/models/catalog        → enabled models with pricing
GET    /api/models/available      → discoverable models from provider APIs
POST   /api/models                → add model
PUT    /api/models/{id}           → update model
DELETE /api/models/{id}           → remove model
POST   /api/models/{id}/enable    → enable model
POST   /api/models/{id}/disable   → disable model
GET    /api/providers             → list configured providers
POST   /api/providers             → add provider
PUT    /api/providers/{id}        → update provider
DELETE /api/providers/{id}        → remove provider

# MCPs
GET    /api/mcps                  → list configured MCP servers
POST   /api/mcps                  → add a custom MCP
PUT    /api/mcps/{name}           → update a custom MCP
DELETE /api/mcps/{name}           → remove a custom MCP
POST   /api/mcps/{name}/enable    → enable (triggers hot reload)
POST   /api/mcps/{name}/disable   → disable (triggers hot reload)

# Scheduled tasks
GET    /api/scheduled-tasks       → list cron tasks
POST   /api/scheduled-tasks       → create task
PUT    /api/scheduled-tasks/{id}  → update task
DELETE /api/scheduled-tasks/{id}  → delete task

# Workflows
GET    /api/workflows             → list workflows
POST   /api/workflows             → create workflow
PUT    /api/workflows/{id}        → update workflow
DELETE /api/workflows/{id}        → delete workflow
POST   /api/workflows/{id}/run    → execute workflow
GET    /api/workflow-runs/{id}    → run history

# Events (webhook channel) — management surface (device-cert auth)
GET    /api/events                    → list events (secret hidden)
POST   /api/events                    → create event (+ one-time secret; optional session_binding_*)
GET    /api/events/{id}               → read event
PATCH  /api/events/{id}               → update event, including session_binding_*
DELETE /api/events/{id}               → delete event
POST   /api/events/{id}/rotate-secret → new secret (one-time)
POST   /api/events/{id}/trigger       → fire now (peer/manual, authenticated)
GET    /api/events/{id}/deliveries    → delivery history
GET    /api/event-deliveries/{id}     → one delivery
GET    /api/event-types               → provider presets for the picker

# Sessions
GET    /api/sessions              → list active sessions
POST   /api/sessions/{id}/pin     → pin session to a model
POST   /api/sessions/{id}/clear   → clear session history

# File uploads
POST   /api/upload                → save uploaded file, returns {path, filename}

# TTS / STT
POST   /api/tts/synthesize        → text-to-speech
POST   /api/stt/transcribe        → speech-to-text

# Logs
GET    /api/logs                  → recent events

# Lifecycle
POST   /api/restart               → restart agent (with exit code for auto-update swap)
```

Event create/update bodies for prompt events may set
`session_binding_enabled` plus `session_binding_path` (`id`, `ticket.id`,
`payload.thread.id`, etc.) so deliveries with the same payload value reuse the
same internal OpenAgent event run session. With the flag off, every delivery
creates a new run session.

## Bridges

Bridges (Telegram, Discord, WhatsApp) are internal WebSocket clients that connect to the gateway over Iroh within the same process. They translate platform SDK events into the unified WS protocol. Each bridge is configured with platform-specific tokens and allowed-user lists in `openagent.yaml`.

The `BaseBridge` class (~150 lines) handles connection lifecycle, retry, and session mapping. Adding a new platform means subclassing `BaseBridge` — the core agent code never changes. See [Channels](./channels.md) for per-platform configuration.

## Webhook listener

The [webhook channel](./channels.md#webhook-inbound) is served by a **separate**
`aiohttp` application on its own TCP port — not the gateway app. It carries only
`POST /hooks/{slug}` (plus a bodyless `/hooks/health` probe). The `/api/*` routes
and `/ws` are **not registered** on it, so the management surface is structurally
unreachable from that port, and the device-cert middleware is deliberately not in
its chain (an external SaaS can't present a cert). Auth is per-event instead — a
secret plus an optional provider HMAC, checked inside the handler. See
[Events](./events.md) for the auth model, and note the listener is **off by
default**: no socket opens until `channels.webhook.enabled` is set.

## Loopback proxy

The desktop app and CLI client don't speak Iroh directly in all cases. Instead, a **loopback proxy** bridges localhost TCP to the agent's gateway over Iroh QUIC:

```
App/CLI ←→ localhost:PORT ←→ LoopbackProxy ←→ Iroh QUIC ←→ Agent Gateway
```

The proxy presents the device cert on every Iroh stream and translates between plain HTTP/WS on the local side and authenticated Iroh streams on the remote side. This lets standard HTTP clients (fetch, curl, WebSocket browser APIs) work without Iroh integration.
