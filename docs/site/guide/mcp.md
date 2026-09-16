# MCP Tools

All MCP tools are available to every model — model-agnostic by design. OpenAgent ships **24 built-in MCPs** (`BUILTIN_MCP_SPECS`) and the LLM can enumerate them at runtime via the built-in `list_mcp_servers` tool.

## Built-in MCPs

| Name | What it does | Requires | On by default |
|---|---|---|---|
| `vault` | Read/write Obsidian-compatible markdown notes; every write is validated against the quality gate | Node.js | ✅ |
| `vault-gate` | Quality gate, doctor, index, link-rewriting rename, derived artifacts over the markdown vault | Python (in-process) | ✅ |
| `filesystem` | Read, write, search and manage files through the shared OpenAgent host-tools core | Python (in-process) | ✅ |
| `editor` | Structured file editing — read, write, patch, search — through the shared OpenAgent host-tools core | Python (in-process) | ✅ |
| `web-search` | Web search + page fetch, no API key | Node.js + Playwright | ✅ |
| `shell` | Cross-platform shell execution with multi-session concurrency, background jobs, and autoloop integration | Python (in-process) | ✅ |
| `computer-control` | Screenshot, mouse, keyboard (macOS/Linux/Windows) | native binary | ✅ |
| `agent-in-chrome` | Drive a Chrome session — navigate, click, type, screenshot, read the DOM | Node.js + Chrome | ✅ |
| `attachments` | Read/write files attached to the current turn — screenshots, images, pasted text, uploads | Python (in-process) | ✅ |
| `logs` | Query and summarize the agent's unified event log | Python (in-process) | ✅ |
| `skills` | Discover and manage file-backed SKILL.md playbooks | Python (in-process) | when `skills.enabled` |
| `ptc` | Programmatic tool calling through the live MCP pool | Python (in-process) | when `ptc.enabled` |
| `messaging` | Send via Telegram/Discord/WhatsApp + AI-driven phone calls / SMS via Twilio (see [phone-mcp.md](phone-mcp.md)) | Channel tokens / Twilio + OpenAI | ✅ |
| `scheduler` | Manage cron tasks from within conversations | Python | ✅ |
| `mcp-manager` | Let the agent add/remove/toggle MCP servers at runtime | Python | ✅ |
| `model-manager` | Let the agent manage its LLM catalog at runtime | Python | ✅ |
| `workflow-manager` | Workflow CRUD and execution | Python | ✅ |
| `events-manager` | CRUD webhook events and fire one on demand | Python | ✅ |
| `budget-manager` | Inspect and manage model/provider/global spend caps | Python | ✅ |
| `tool-search` | Cross-MCP fuzzy tool index for capability discovery | Python | ✅ |
| `delegation` | Hand a sub-task to another registered model and get its answer back | Python (in-process) | ✅ |
| `agent-federation` | Talk to a federated peer OpenAgent over native Iroh — `list_agents`, `ask_agent` | Python (in-process) | ✅ |
| `media-gen` | Generate images or video via configured providers | Python | — |
| `memory-search` | Full-text search across past conversations (vault is your notes; this is everything you've said) | Python | ✅ |

::: tip Built-in ≠ on by default
The two sets are not the same. `BUILTIN_MCP_SPECS` is the 24 servers OpenAgent knows how to run; `DEFAULT_MCPS` contains the 21 entries seeded enabled on a fresh boot. **`media-gen` is built-in but opt-in**, while `skills` and `ptc` are seeded only when their corresponding configuration flags are enabled. Enable an optional MCP via its configuration gate or with `mcp-manager`, `POST /api/mcps/{name}/enable`, or the MCPs tab.

`filesystem` and `editor` are built-ins backed by the exact versioned core also shipped in `openagent-host-tools`. This removes the old `npx`/Node runtime dependency while keeping their server-side names and configuration compatible.
:::

Tool names are namespaced `<server>_<tool>`, so `filesystem_read_text_file`, `vault_write_note`, `scheduler_create_scheduled_task`, etc. — no collisions between servers.

Machine-bound MCPs can also be advertised by the Desktop or CLI computer that
sent the current interactive turn. Tool Search exposes those as
`client:<mcp>` and exposes the agent host as `server:<mcp>`; legacy unprefixed
names remain server-only. See [Client Computer Capabilities](./client-capabilities.md).

::: tip Native `vault-gate` tools
The `vault-gate` MCP is a native, in-process Python server that exposes the [memory-vault quality system](./vault-quality.md): `vault_gate`, `vault_doctor`, `vault_validate_note`, `vault_rename_note` (rewrites inbound wikilinks), `vault_init`, `vault_stats`, `vault_search` (FTS5), `vault_backlinks`, `vault_dream`, and `vault_regenerate_derived`. It complements the file-level `vault` MCP — the latter reads and writes note content, the former grades, repairs, indexes, and version-controls the vault.
:::

## Source of truth: the `mcps` table

Since v0.9.0 the MCP list lives in the `mcps` SQLite table, not in yaml. Two equivalent ways to edit it:

- **From the agent itself** — ask the LLM to call one of the `mcp-manager` tools (`list_mcps`, `add_custom_mcp`, `update_mcp`, `enable_mcp`, `disable_mcp`, `remove_mcp`). Changes take effect on the next message via the gateway's hot-reload loop.
- **REST**: `GET/POST/PUT/DELETE /api/mcps[/...]`, plus `POST /api/mcps/{name}/enable` and `/disable`.
- **UI**: the MCPs screen in the desktop app — hits the same REST endpoints.

The `mcps` SQLite table is the sole source of truth. Every boot, `ensure_builtin_mcps` backfills any `BUILTIN_MCP_SPECS` entry whose row is missing (forward compat + safety net against manual DB tampering); existing rows — including disabled ones — are left untouched.

## Built-in vs custom

- **Built-ins** (`kind='default'` or `kind='builtin'` in the `mcps` row): defined in `openagent.mcp.builtins.BUILTIN_MCP_SPECS`. They are **auto-seeded** on every boot — if a row is missing (manual DB tampering, new builtin shipped in a later release), it gets reinstated with `enabled=1`. Built-ins **cannot be removed**; only disabled via `disable_mcp` / `/api/mcps/{name}/disable`. `add_builtin_mcp` is not exposed because there is nothing to add — the row already exists.
- **Custom MCPs** (`kind='custom'`): anything the user adds via `add_custom_mcp`, `POST /api/mcps`, or the "Custom" tab in the app. Fully CRUD: add, update, toggle, remove.

## Adding a custom MCP

```text
> use mcp-manager to add a custom MCP called github with command
> "github-mcp-server stdio" and env GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_TOKEN
```

Or via REST (through the loopback proxy or Iroh gateway):

```bash
curl -X POST http://localhost:8765/api/mcps -H 'Content-Type: application/json' -d '{
  "name": "github",
  "command": ["github-mcp-server", "stdio"],
  "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…"},
  "enabled": true
}'
```

Remote MCPs use `url` instead of `command`:

```bash
curl -X POST http://localhost:8765/api/mcps -H 'Content-Type: application/json' -d '{
  "name": "service",
  "url": "https://mcp.example.com/sse",
  "oauth": true
}'
```

## How the Pool Works

At startup, OpenAgent builds a single `MCPPool` that connects every enabled row in the `mcps` table. The native runtime reads from this one pool:

- **API-based providers** (OpenAI, Anthropic API, Z.ai GLM, any OpenAI-compatible endpoint) get the live `MCPTools` toolkits registered directly on OpenAgent's in-process LLM runtime — tool routing, call loops, and retries are handled by the runtime.

Sharing one pool means we don't pay N times for the same MCP when the smart router dispatches between models, and there's no in-process tool registry for OpenAgent to keep in sync — the runtime owns it.

When the `mcps` table changes (manager MCP writes a row, REST endpoint flips `enabled`), the gateway sees the bumped `updated_at` on the next incoming message and rebuilds the pool atomically: new subprocesses come up first, the in-process runtime's toolkit list is swapped in place, old subprocesses are torn down last. In-flight turns see no gap.
