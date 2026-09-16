# Memory & Vault

OpenAgent's long-term memory is a plain **Obsidian-compatible markdown vault** — one `.md` file per note, with YAML frontmatter, `[[wikilinks]]`, and tags. The agent reads and writes those files directly via the `vault` MCP. Open the same folder in Obsidian and graph view, backlinks, and plugins all work, untouched.

The markdown is the source of truth. On top of it sits a code-enforced **quality system** (shipped in v0.14.12): an incremental SQLite + FTS5 index, a quality gate that grades every note, a mechanical doctor, derived artifacts (`llms.txt`, `_showcase/`), link-rewriting move/rename, and a git-backed history. The index is a cache — delete it and it rebuilds from the markdown.

::: tip
For the gate rules, the index, the doctor, git provenance, the `vault-gate` MCP tools, and the `openagent vault` CLI, see **[Vault Quality System](./vault-quality.md)**.
:::

## Configuration

```yaml
memory:
  db_path: "~/.openagent/openagent.db"   # SQLite — operational state (see Architecture §9)
  vault_path: "~/.openagent/memories"    # Obsidian markdown vault (git-backed)

  # Semantic recall (optional) — see the section below. Unset = OFF (FTS only).
  embedding_model: "local:nomic-embed-text"          # <provider>:<model>
  embedding_base_url: "http://100.112.201.76:11434/v1"  # any OpenAI-compatible /embeddings
  # embedding_api_key: "${OPENAI_API_KEY}"           # only for a hosted API
  auto_recall:
    enabled: true
    min_score: 0.6      # cosine floor; a weak match is no match (default 0.75)
    warm_budget: 16     # notes the on-turn hook may top up (default 24)
```

Quality-system options live under `memory.vault.*` and `memory.vault_reminder.*` — see [Vault Quality System → Configuration](./vault-quality.md#configuration).

## Semantic Recall

The FTS index above matches **words**. Semantic recall adds a second, complementary layer that matches **meaning** — "the customer paid twice by mistake" finds a note titled "double charges are refunded within 5 days" even with zero shared keywords. For a support agent asked "has this person complained before?" a hundred different ways, keyword-only recall answers "no record" while the note exists — a confident miss, i.e. a hallucination. This layer closes that gap.

**Keep both.** FTS and semantic are not redundant and do not interfere — they are two rebuildable caches over the *same* vault, queried independently, reconciled by the *same* `(mtime, byte_size)` gate so neither drifts from the markdown. FTS wins on exact literals (ticket IDs, version numbers, error codes — which embeddings blur) and is always on at `$0` with no provider; semantic wins on paraphrase. When no embedder is configured the semantic layer is **inert** and retrieval falls back to FTS, byte-identical to before (vision §17).

### How it works

- `semantic_index.py` is a **rebuildable embedding cache** over the vault notes + session digests — a peer of the FTS caches, keyed to the source DB (`semantic_index_<hash>.db`). Delete it and the next sync rebuilds it; the markdown stays the sole source of truth (§5).
- A **background builder** (`semantic_index_builder.py`) embeds the whole vault **off the turn path**, then re-syncs every 5 min (`OPENAGENT_SEMANTIC_RESYNC_SECONDS`) to pick up changed/added/deleted notes. It is a no-op when no embedder is configured.
- The **auto-recall hook** runs one query embed per turn (time-boxed, default 4 s) and injects the top matches before the model answers. A miss or timeout silently degrades to FTS — it never blocks or fails the turn.
- **Alignment on update:** a note whose `(mtime, byte_size)` changed is re-embedded; a deleted note's vector is dropped (a purged note stops being findable); an added note is embedded on the next sync — so the cache tracks the vault, never a second copy of it.

### Backend: local ollama or a hosted API

The embedder is any OpenAI-compatible `POST {base_url}/embeddings`, selected purely by config (`resolve_embedder`), so the **same three keys switch between a self-hosted model and a cloud API** with zero code change:

```yaml
# (a) Self-hosted ollama on a real machine — $0, private. A Mac (Apple Silicon,
#     Metal GPU) reached over Tailscale is ideal; nomic-embed-text is 768-dim.
memory:
  embedding_model: "local:nomic-embed-text"
  embedding_base_url: "http://<tailscale-ip>:11434/v1"

# (b) Hosted API — reliable, ~$0.02 one-time for a 2000-note vault.
memory:
  embedding_model: "openai:text-embedding-3-small"
  embedding_base_url: "https://api.openai.com/v1"   # the built-in default for the openai provider
  embedding_api_key: "${OPENAI_API_KEY}"
```

Resolution order for `base_url`/`api_key`: explicit `embedding_base_url`/`embedding_api_key` → the matching provider row in your config → a built-in default (`openai` → `https://api.openai.com/v1`). If none resolves, the layer stays inert and logs `semantic.embedder_unresolved` rather than raising on the turn path.

::: warning Do NOT run the embedder as a CPU sidecar on a busy cluster
Embedding is CPU-heavy. On a CPU-saturated Kubernetes node (limits oversubscribed far past the physical cores), a single `nomic-embed-text` embed can take **~31 s** — over the 30 s client timeout — so **every** embed fails and the index never builds (0 vectors, silent fall-back to FTS). Raising the pod's CPU limit can't conjure CPU the node doesn't have. Run the embedder off the busy node: a Mac/box over Tailscale, a GPU pod, or a hosted API. On Apple Silicon the same embed is ~140 ms.
:::

### Config → env, and the deploy gotchas

`_build_agent` maps the yaml onto the environment `resolve_embedder`/`auto_recall` read at runtime:

| yaml (`memory.*`) | env var | default |
|---|---|---|
| `embedding_model` | `OPENAGENT_EMBEDDING_MODEL` | unset → inert |
| `embedding_base_url` | `OPENAGENT_EMBEDDING_BASE_URL` | provider row → `openai` default |
| `embedding_api_key` | `OPENAGENT_EMBEDDING_API_KEY` | `local` (dummy) |
| `auto_recall.enabled` | `OPENAGENT_AUTO_RECALL_ENABLED` | `0` (off) |
| `auto_recall.min_score` | `OPENAGENT_AUTO_RECALL_MIN_SCORE` | `0.75` |
| `auto_recall.top_k` | `OPENAGENT_AUTO_RECALL_TOP_K` | `3` |
| `auto_recall.warm_budget` | `OPENAGENT_AUTO_RECALL_WARM_BUDGET` | `24` |
| `auto_recall.timeout` | `OPENAGENT_AUTO_RECALL_TIMEOUT` | `4.0` s |

::: warning Two deploy gotchas
- A container deployment may **also** set `OPENAGENT_EMBEDDING_*` in supervisord's `[program:openagent] environment=`. That is the exec-time value; if you change it you must `supervisorctl reread && supervisorctl update` — a plain `restart` does **not** reload `environment=`. Keep the yaml and the supervisord line in agreement.
- After a restart, stale orphan `openagent … serve` processes can linger with the old env. A fresh pod (or a clean process cycle) is the reliable way to guarantee the new endpoint everywhere.
:::

See the [deployment kit](./deployment.md#semantic-recall-embedding-kit) for a copy-paste setup (Mac Mini ollama LaunchDaemon + per-agent config).

## How It Works

- The agent writes notes as `.md` files inside `vault_path/`
- The `vault` MCP exposes `list_directory`, `read_note`, `write_note`, `patch_note`, `search_notes`, `manage_tags`, etc.; the `vault-gate` MCP adds `vault_gate`, `vault_doctor`, `vault_rename_note`, `vault_backlinks`, and friends
- The system auto-commits every change to git with provenance trailers, and a full-text index keeps search fast as the vault grows
- Open the same folder in Obsidian desktop for graph view, backlinks, and plugin support

## Note Format

```markdown
---
title: Deploy Wardrobe Service
type: reference
tags: [k8s, wardrobe, ovh]
created: 2026-04-07
---

# Deploy Wardrobe Service

rsync + docker build + k3s import...
See also: [[server-architecture]]
```

`[[wikilinks]]`, tags and YAML frontmatter are standard Obsidian conventions.

## System Prompt

OpenAgent injects a framework-level system prompt that covers:

- How to use the vault (`vault` / `vault-gate` tools, wikilinks, tags)
- Prefer MCP tools over shell scripts
- Act autonomously (tool calls are pre-approved)
- Be concise

Your `system_prompt` in `openagent.yaml` should stay short — just identity and a pointer to the vault. Everything else belongs as `.md` notes.
