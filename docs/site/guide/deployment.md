# Setup & Deployment

## VPS Quick Setup

### Standalone Executable (recommended)

```bash
# Install the latest server release for your platform
curl -fsSL https://openagent.uno/install.sh | sh

# Start with an agent directory (auto-bootstraps network + prints invite)
openagent serve ./my-agent

# Register as OS service
openagent service install ./my-agent
```

Prefer to grab the archive yourself? Browse releases at
<https://github.com/openagent-uno/openagent-server/releases>.

### pip install

```bash
pip install 'openagent-framework[all]'
openagent serve ./my-agent
```

## Doctor & Setup

```bash
openagent doctor                 # environment report
openagent service install        # register as OS service
```

With an agent directory:
```bash
openagent -d ./my-agent doctor
openagent -d ./my-agent service install
```

## OS Service

OpenAgent registers as a platform-native service. When using agent directories, each agent gets a unique service name derived from the directory name.

### Default (single agent)

- **Linux** — systemd user unit (`~/.config/systemd/user/openagent.service`)
- **macOS** — launchd plist (`~/Library/LaunchAgents/com.openagent.serve.plist`)
- **Windows** — Task Scheduler entry with restart loop

### Per-agent (multi-agent)

- **Linux** — `openagent-<dirname>.service`
- **macOS** — `com.openagent.<dirname>.plist`
- **Windows** — `OpenAgent-<dirname>` task

### Optional systemd limits

On Linux, the generated user unit can include extra raw `[Service]`
directives from `openagent.yaml`. This is the right place to add
resource caps such as `MemoryHigh`, `MemoryMax`, or `MemorySwapMax`.

If you omit the section entirely, OpenAgent writes no memory cap lines at
all. Setting a key to `null` or an empty string also omits it.

```yaml
service:
  systemd:
    MemoryHigh: 2500M
    MemoryMax: 3500M
    MemorySwapMax: 1G
    TasksMax: 4096
```

Re-run `openagent service install` after changing these values so the systemd unit is
rewritten and reloaded. On macOS and Windows this section is ignored.

```bash
# Linux (default agent)
systemctl --user status openagent
journalctl --user -u openagent -f

# Linux (named agent)
systemctl --user status openagent-my-agent
journalctl --user -u openagent-my-agent -f

# macOS
launchctl list com.openagent.serve       # default
launchctl list com.openagent.my-agent    # named

# Uninstall (any platform)
openagent service uninstall
openagent -d ./my-agent service uninstall       # specific agent
```

## Auto-Update

```yaml
auto_update:
  enabled: true
  mode: auto                    # auto | notify | manual
  check_interval: "17 */6 * * *"
```

- `auto` — upgrade + exit 75 (OS service restarts with new code)
- `notify` — upgrade + notify, no restart
- `manual` — upgrade only

The update mechanism adapts to the installation type:
- **Standalone executable**: downloads the latest release from GitHub, verifies checksum, and swaps the binary in place
- **pip install**: runs `pip install --upgrade openagent-framework`

Manual: `openagent update`

## Data Paths

### With agent directory (recommended)

When using `openagent serve ./my-agent`, all data lives inside the agent directory:

```
my-agent/
├── openagent.yaml    # configuration
├── openagent.db      # SQLite database
├── memories/         # memory vault
└── logs/             # log files
```

### Without agent directory (legacy)

OpenAgent stores files in platform-standard directories:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/OpenAgent/` |
| Linux | `~/.config/openagent/` (config), `~/.local/share/openagent/` (data) |
| Windows | `%APPDATA%\OpenAgent\` |

Override with `-c /path/to/openagent.yaml` or set paths in config.

## Testing

The repository ships with an end-to-end test suite that exercises the full gateway, agent, MCP, and model stack against real API keys. Each test lives in its own module under `scripts/tests/`:

```bash
# Full suite (reads API keys from ~/my-agent/openagent.yaml)
bash scripts/test_openagent.sh

# Run a specific category only
bash scripts/test_openagent.sh --only files,rest,channels

# List all registered tests (category/name) and exit
bash scripts/test_openagent.sh --list
```

Categories:

| Category | What it covers |
|---|---|
| `imports`, `catalog` | Module compile + catalog/pricing helpers |
| `channels`, `formatting` | Pure-unit string utilities (attachment markers, split, Telegram/WhatsApp rendering) |
| `pool`, `mcp` | MCP pool lifecycle + per-server tool round-trips |
| `runtime`, `router`, `budget` | Live LLM calls + entry-model resolution + budget-aware fallback + `usage_log` rows |
| `gateway`, `sessions` | HTTP server boot + WebSocket message round-trip + session isolation |
| `upload`, `voice`, `files` | File/audio upload + voice transcription path + full agent-reads-uploaded-file pipeline through filesystem MCP + `[IMAGE:/…]` response markers → WS `attachments` field |
| `config`, `logs`, `usage`, `models`, `pricing`, `providers`, `vault_rest` | REST surface |
| `cron`, `dream`, `updater` | Scheduler roundtrip, dream-mode prompt, updater smoke |
| `bridges` | Telegram/Discord/WhatsApp module imports + `BaseBridge` contract |

The suite builds a throwaway agent dir under `/tmp/openagent-test-<uuid>/` so it never touches your real `my-agent` config or database.

### Migrating to agent directory

```bash
openagent migrate --to ./my-agent
```

This copies your existing config, database, and memories from platform-standard paths to the new agent directory.

## Semantic Recall (embedding) kit

A copy-paste setup for [semantic recall](./memory.md#semantic-recall) across one or many agents. The pattern: run **one** embedding endpoint off the busy cluster (a Mac over Tailscale, or a hosted API) and point every agent at it via config. Embedding is CPU-heavy — never run it as a sidecar on a CPU-saturated node (a single embed can exceed the 30 s client timeout, and the index never builds).

### 1. The embedding endpoint (Mac / Apple Silicon over Tailscale)

Install ollama, pull the model, and expose it on the tailnet as a boot-persistent daemon:

```bash
brew install ollama
# LaunchDaemon (runs at boot, no login needed) bound to all interfaces:
sudo tee /Library/LaunchDaemons/com.esound.ollama.plist >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.esound.ollama</string>
  <key>UserName</key><string>development</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/opt/ollama/bin/ollama</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>OLLAMA_HOST</key><string>0.0.0.0:11434</string>
    <key>OLLAMA_KEEP_ALIVE</key><string>-1</string>
    <key>HOME</key><string>/Users/development</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLIST
sudo launchctl bootstrap system /Library/LaunchDaemons/com.esound.ollama.plist
ollama pull nomic-embed-text
# verify from another tailnet host:
curl http://<tailscale-ip>:11434/api/tags
```

Apple Silicon serves `nomic-embed-text` on the Metal GPU (~140 ms/embed); a 2000-note vault cold-builds in a few minutes. `OLLAMA_KEEP_ALIVE=-1` keeps the model resident. One endpoint serves every agent.

> Alternative: skip the Mac entirely and point agents at a hosted API — set `embedding_model: openai:text-embedding-3-small`, `embedding_base_url: https://api.openai.com/v1`, `embedding_api_key`. Same config surface.

### 2. Per-agent config

Each agent needs the `memory` block in its `openagent.yaml` (mapped to env by `_build_agent` at boot):

```yaml
memory:
  embedding_model: local:nomic-embed-text
  embedding_base_url: http://<tailscale-ip>:11434/v1
  auto_recall:
    enabled: true
    min_score: 0.6
    warm_budget: 16
```

If the deployment also sets `OPENAGENT_EMBEDDING_*` in supervisord's `[program:openagent] environment=`, change it there too and run `supervisorctl reread && supervisorctl update` (a plain `restart` won't reload `environment=`). Keep the two in agreement. Agents must be on a build with the background index builder (≥ v0.18.4) so the index builds without waiting for live traffic.

### 3. Apply to a running pod

```bash
# point the agent at the endpoint (both the yaml and, if present, supervisord.conf)
kubectl exec <pod> -c agent -- sed -i \
  's#embedding_base_url:.*#embedding_base_url: http://<tailscale-ip>:11434/v1#' \
  /data/agent/openagent.yaml
# then a clean process cycle — a fresh pod avoids stale orphan serve procs:
kubectl delete pod <pod>          # Recreate strategy; the built index persists on the PVC
```

Verify the build: `semantic.index_built` in `events.jsonl`, growing `vault_vectors` in `semantic_index_*.db`, and zero `semantic.embed_error` naming the endpoint.

> A ready-to-adapt copy of the LaunchDaemon script lives at `~/k8s-manifests/mini-ollama-setup.sh` (not auto-committed — treat `~/k8s-manifests` as out-of-repo, per the signing-incident rule).
