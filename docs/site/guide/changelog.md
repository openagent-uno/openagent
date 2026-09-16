# Changelog

Notable changes, newest first.

## v0.14.18

### The write gate now covers the app and CLI too

v0.14.16 made the *agent's* writes pass the quality gate. Now **every** write
does — the REST path (`PUT /api/vault/notes`) that the desktop app and CLI use
runs the same gate:

- Mechanical issues are auto-fixed (frontmatter scaffolded, dates normalized,
  `[[ ]]` spacing, em dashes).
- A structurally-broken note (invalid YAML frontmatter, a brand-new note past
  the atomic size limit) is **rejected with `422`** and a list of errors —
  nothing is written. The app shows the errors inline and keeps your text; the
  CLI prints them and asks you to fix and re-save.

### The agent hears what the gate did

After a write, the vault MCP now tells the agent what it **auto-fixed** and
what **still needs its judgement** (e.g. "missing summary"), so it can improve
the note rather than assume it's done.

### Migration for existing installs

Agents created before v0.14.16 had their vault MCP pinned to the old npx
package and never picked up the validated built-in. A boot migration converts
that row in place (preserving whether it was enabled), so the gate activates on
every existing install — not just fresh ones.

Set `OPENAGENT_VAULT_VALIDATE_WRITES=0` to fall back to the old warn-only
behavior. Scheduled [dream-mode](./vault-quality.md#dream-mode-maintenance)
(config `dream_mode.enabled`) handles the graph-level rules write-time can't.

## v0.14.16

### The agent can no longer write a messy note

The memory vault is now driven by a **vendored, validated fork** of the
markdown-vault MCP (`@bitbonsai/mcpvault` v0.12.1, pinned and shipped in-tree
instead of fetched at runtime). Every write the agent makes — `write_note`,
`patch_note`, `update_frontmatter`, `manage_tags` — runs through the vault
quality gate before it touches disk:

- **Auto-fixed** (silently): missing frontmatter is scaffolded
  (`title`/`tags`/`status`/`created`/`updated`), dates are normalized to
  `YYYY-MM-DD`, spaces inside `[[ wikilinks ]]` are stripped, em dashes are
  replaced. The note lands clean.
- **Blocked** (the agent must fix and retry): frontmatter that isn't valid
  YAML, and a brand-new note past the atomic size limit.

Graph-level rules (broken links, orphans, duplicates) are intentionally left
to the [gate / dream-mode](./vault-quality.md#dream-mode-maintenance) — a note
legitimately links forward to notes that don't exist yet. The behavior is
identical to upstream mcpvault when `OPENAGENT_VAULT_VALIDATE_WRITES` is unset;
OpenAgent enables it automatically.

## v0.14.15

### Vault history: diffs, restore, and reset

The vault's [git history](./vault-quality.md#git-backed-history-and-provenance) is now inspectable and reversible from the app and CLI.

- **Commit diffs** — every commit shows the files it touched and a coloured unified diff. `GET /api/vault/commit?hash=`.
- **Restore a state** (non-destructive) — roll the whole vault back to any past commit as a *new* commit; later history is preserved and the restore is itself undoable. `POST /api/vault/restore {hash}`.
- **Reset to a commit** (destructive) — make a commit the latest state, deleting every commit after it. Ancestor-only, requires an explicit `confirm` flag, and is gated behind a confirmation prompt in the app and CLI. Not exposed as an agent tool. `POST /api/vault/reset {hash, confirm}`.
- **Clients** — the app's Memory history expands each commit inline with its diff and Restore / Reset buttons; the CLI `vault → history` lets you pick a commit to view, restore, or reset.

### Dream mode in the agent (v0.14.14)

The agent now knows what dream mode is and can run it on request: a new `vault_dream` tool runs a full maintenance pass (gate → auto-fix → regenerate derived → commit) and returns the harder issues for the agent to resolve, with a matching system-prompt playbook.

## v0.14.12

### Vault quality system

A code-enforced quality system now wraps the [memory vault](./vault-quality.md). It is pure-Python and runs fully offline.

- **Quality gate** — every note is graded against a fixed rule set: complete frontmatter (`title`, `summary`, `tags`, `status`, `created`/`updated` as `YYYY-MM-DD`), atomic size (≤300 lines), ≥3 real outgoing `[[wikilinks]]`, no broken links, no orphans, a single connected graph, duplicate detection, journal anchoring, absolute dates, and em-dash hygiene. Each violation carries an `error` / `warn` / `info` severity; the gate passes on zero errors.
- **Incremental index** — a SQLite + FTS5 index with `(mtime, size)` invalidation that re-parses only changed files and scales to 100k+ notes. Graph facts (orphans, components, backlinks, broken links) are computed from the index.
- **Doctor** — mechanically fixes what code can do safely (collapse multi-line `related:`, strip spaces in `[[ ]]`, normalize dates, scaffold missing frontmatter, em-dash) and hands the judgement calls (orphans, duplicates, over-long, broken links) to the AI as suggestions.
- **Derived artifacts** — `llms.txt` (a per-folder index AIs read) and `_showcase/showcase.md` are regenerated from the index.
- **Folder taxonomy + canon** — `vault init` scaffolds the 11-folder Company-Brain taxonomy (`self`, `areas`, `projects`, `sources`, `concepts`, `docs`, `entities`, `data`, `code`, `outputs`, `workspace`), the journal tree, and a `workspace/_canon/` workflow (raw `sources/` → canon → atomic notes).
- **Move/rename that rewrites links** — renaming a note or folder rewrites every inbound `[[wikilink]]`, preserving path/stem style, alias, and anchor — no broken links.
- **Git-backed vault** — the vault is a git repo and the *system* auto-commits every change with provenance trailers (`Origin` / `Session` / `Workflow` / `Task` / `Tool`). A background sweep captures external/Obsidian edits; git is bootstrapped at setup if missing and degrades gracefully when absent.
- **Dream-mode maintenance** — an optional periodic pass: sync → gate → auto-fix → regenerate derived → write a dream-log → commit.

New surfaces:

- **Native MCP tools** (`vault-gate` server): `vault_gate`, `vault_doctor`, `vault_validate_note`, `vault_rename_note`, `vault_init`, `vault_stats`, `vault_search`, `vault_backlinks`, `vault_regenerate_derived`.
- **REST**: `GET /api/vault/gate`, `GET /api/vault/stats`, `GET /api/vault/history`, `POST /api/vault/doctor`, `POST /api/vault/derived`, `POST /api/vault/move`, `POST /api/vault/init`, `POST /api/vault/index/sync`; and `PUT /api/vault/notes/{path}` now validates + commits and returns `{ok, path, warnings, commit}`.
- **CLI**: `openagent vault gate|doctor|sync|derive|stats|search|mv|init`, and `openagent doctor --fix` installs git for the vault.

See the full [Vault Quality System](./vault-quality.md) guide.

### Auto-updater hardening

The self-update path is now fail-safe end to end.

- **Fail-closed checksums** — SHA-256 verification is mandatory by default. The updater refuses a download unless it can verify it against the GitHub asset digest or a sibling `.sha256` file.
- **Atomic swaps** — the new binary replaces the running one via a same-directory atomic rename (`current → .old`, `new → current`); Windows swaps a `.pending` binary at next startup.
- **Boot-guard rollback** — an update is provisional until the new binary boots healthy. A journal next to the binary counts boot attempts; after repeated failures it automatically restores the previous `.old` binary and remembers the bad version so the poller won't re-install it. A bad release self-heals with no remote access.

## v0.14.11

- Groundwork for the vault quality system: the incremental index, gate engine, and git-backed vault land here ahead of the full surface in v0.14.12.
- **Save reminder** — on by default: a memory checkpoint ("ALWAYS save relevant things") is injected on the first prompt of a session and then every 3 turns, so the agent reliably persists what matters. Tune it under `memory.vault_reminder.{enabled, every_n_turns}`.
