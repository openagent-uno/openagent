# Vault Quality System

The memory vault is still a plain [Obsidian-compatible markdown vault](./memory.md) — but as of **v0.14.12** it is wrapped in a code-enforced **quality system**. The agent writes `.md` files; a pure-Python, fully-offline engine grades, indexes, repairs, version-controls, and derives artifacts from them.

The split is deliberate:

- **Code enforces structure.** The gate, the index, the mechanical fixer, the link rewriter, and git are deterministic. They never call an LLM and produce the same answer every run.
- **The AI does the thinking.** Semantic deduplication, splitting an over-long note, fixing the *meaning* of a broken link, and extracting hard facts into canon are AI-driven. The gate keeps that AI-generated content honest by re-grading it.

Everything below runs without network access and without a running gateway — `openagent vault gate` operates directly on the markdown files.

## The quality gate

The gate walks every note and grades it against a fixed set of rules. Each violation carries a **severity** (`error` / `warn` / `info`); the gate **passes** when there are zero `error`-level issues. It does not reject your writing — markdown is yours — it reports.

| Rule | Severity | Auto-fixable | What it checks |
|---|---|---|---|
| `frontmatter_yaml` | **error** | yes | The `---` block parses as YAML at all |
| `frontmatter` | warn | yes | `title`, `summary`, `tags`, `status`, `created`, `updated` all present |
| `atomicity` | warn | no | One idea per note; stays under the line limit (default 300) |
| `min_links` | info | no | Content notes link out to **≥3** distinct real notes |
| `broken_link` | **error** | no | Every `[[target]]` resolves to a note that exists |
| `orphan` | warn | no | Every note has at least one inbound link (`_index` exempt) |
| `connectivity` | warn | no | The graph is one connected component, not islands |
| `filename` | info | no | Filenames unique across the vault, domain-prefixed |
| `wikilink_format` | warn | yes | No spaces inside `[[ ]]` |
| `date_format` | info | yes | `created` / `updated` are absolute `YYYY-MM-DD` dates |
| `taxonomy` | info | no | `tags[0]` matches the top-level folder |
| `duplicate` | warn | no | No two notes with identical content / title / summary |
| `journal_link` | warn | no | A journal/session/daily note anchors to ≥1 static entity note |
| `em_dash` | info | yes | Prose avoids the em dash (—); use `--` or a comma |

Folders that hold raw material — `sources/`, `workspace/` (except the journal), `_showcase/`, `_templates/`, `templates/`, and any dot-directory (`.obsidian/`, `.trash/`, …) — are excluded from the structural rules. This scope is declared **once**, in `src/memory/vault/taxonomy.py` + the `GateConfig` defaults: the gate and the write path call it directly, and the vendored Node vault MCP reads `scope.generated.ts`, rendered from the same values and pinned against drift by `scripts/tests/test_vault_twins.py`. `strict` mode promotes warnings to errors; `enforce_taxonomy` turns the taxonomy check on.

A passing run looks like this:

```
$ openagent vault gate
OK, 0 errors (5 warnings, 2 info)
  notes=145 links=320 broken=0 orphans=2 islands=0 components=1

[frontmatter] (3)
  warn  entities/client-acme.md: missing frontmatter field(s): summary

[orphan] (2)
  warn  concepts/unused-term.md: orphan — no other note links here
```

The command exits `0` when the gate passes and `1` when there are errors, so it slots straight into CI or a pre-commit hook.

## Incremental index

Behind the gate is an **incremental SQLite index** with an **FTS5** full-text table. It scales to 100k+ notes.

- On each sync it walks the tree, `stat`s every file, and re-parses **only** the files whose `(mtime, size)` changed. A vault that hasn't changed re-syncs in the time it takes to `stat` it.
- It stores parsed note metadata, the wikilink graph (`links`), and an FTS5 virtual table over `title` / `summary` / `body`.
- Graph-derived facts — orphans, connected components, backlinks, broken links — are computed from the index, not by re-reading markdown every time.

The index is a cache: delete it and the next sync rebuilds it from the markdown, which remains the single source of truth.

## Doctor: mechanical auto-fix

The **doctor** repairs everything a script can fix *safely* and *deterministically*, and hands the rest to the AI as suggestions.

It mechanically fixes:

- repair frontmatter that does not parse as YAML back into YAML -- the bare
  `related: [[a]], [[b]]` sequence becomes a block list, and an unquoted scalar
  containing `": "` gets quoted (verified by re-parsing; never written unless
  the repair lands)
- strip whitespace inside `[[ wikilinks ]]`
- normalize `created` / `updated` to `YYYY-MM-DD` when coercible
- scaffold missing mechanical frontmatter fields (`title`, `tags`, `status`, `created`, `updated` — `summary` is left for a human/AI to write)
- replace em dashes (—) with `--` in the body

It does **not** touch the judgement calls — orphans, duplicates, over-long notes, and broken links are listed as **open suggestions** for the AI or [dream mode](#dream-mode-maintenance) to resolve.

```bash
openagent vault doctor          # dry run — show what would change
openagent vault doctor --apply  # write the mechanical fixes
```

## Derived artifacts

Two files are regenerated from the index (never edited by hand — both carry an AUTO-GENERATED banner):

- **`llms.txt`** — a per-folder index that AIs read to orient themselves. Each `## folder` section lists `- [[note]] -- summary`.
- **`_showcase/showcase.md`** — a vault snapshot: note count, wikilink stats, connected-component metrics, orphan count, notes-per-folder table, and the hub summary from each folder's `_index`.

Regenerate them with `openagent vault derive`, the `vault_regenerate_derived` MCP tool, or `POST /api/vault/derived`.

## Folder taxonomy and canon

`openagent vault init` scaffolds an 11-folder **Company-Brain** taxonomy, a journal sub-tree, and the canon workspace. It is idempotent — re-running only fills in what is missing.

```
self/        — the operator and the agent's own identity
areas/       — ongoing responsibilities
projects/    — time-bounded efforts
sources/     — raw, un-gated material (drop zone)
concepts/    — reusable ideas and definitions
docs/        — reference documentation
entities/    — people, companies, accounts
data/        — facts, figures, structured records
code/        — snippets and technical notes
outputs/     — finished deliverables
workspace/   — journal, templates, scratch, canon
```

Each content folder gets an `_index` note (exempt from the orphan rule) that acts as its hub. The journal lives under `workspace/journal/` (`sessions/` and `daily/`), and templates under `workspace/_templates/`.

### The canon workflow

`workspace/_canon/` encodes a three-step flow for turning raw material into trustworthy atomic notes:

1. **Collect** — drop raw docs, exports, and notes into `sources/` (un-gated).
2. **Canon** — the AI extracts the hard facts into a single coherent `canon.md`: invent nothing, reconcile every number.
3. **Atomize** — the AI turns canon into atomic notes across the content folders — one idea per note, dense wikilinks, complete frontmatter.

The factual fidelity of steps 2 and 3 is AI-driven; the gate then re-grades the derived notes so structural problems (orphans, broken links, missing frontmatter, over-long notes) surface immediately.

## Move / rename that rewrites links

Renaming a note or moving a whole folder **rewrites every inbound `[[wikilink]]`** so nothing breaks. The rewriter preserves:

- **reference style** — path-style links stay paths, bare-stem links stay stems
- **aliases** — `[[old|Display Name]]`
- **anchors** — `[[old#heading]]` and `[[old^block-id]]`

```bash
openagent vault mv concepts/old-name.md concepts/new-name.md
```

The same operation is available as the `vault_rename_note` MCP tool and `POST /api/vault/move` with a `{from, to}` body. The response reports how many notes were moved, how many were updated, and how many links were rewritten.

## Git-backed history and provenance

The vault is a **git repository** and the *system* — not the AI — auto-commits **every** change.

- OpenAgent's own writes are committed immediately, with precise provenance.
- External edits (a human in Obsidian, the vault MCP) are picked up by a **background autocommit sweep** (every 25s by default).
- Git is bootstrapped at setup if the vault isn't already a repo (`git init -b main`, a sensible `.gitignore`). If git is unavailable, the vault degrades gracefully and keeps working.

Every commit carries **provenance trailers** so you can see exactly which turn, workflow, task, and tool produced a change:

```
$ git -C ~/.openagent/memories log -1

    vault: update entities/client-acme.md

    Origin: chat
    Session: tg:155490357
    Workflow: weekly-review
    Task: vault-maintenance
    Tool: vault_write_note
    User: geroale
```

Query the log (with parsed trailers) over REST with `GET /api/vault/history?path=&limit=`.

### Inspecting and rolling back

History is not just a record — you can inspect any commit and travel back to it:

- **See the changes** — `GET /api/vault/commit?hash=` returns the files a commit touched and its unified diff. In the app, tapping a commit in the Memory history expands it inline; in the CLI, `vault → history` lets you pick a commit to view.
- **Restore a state** (safe) — `POST /api/vault/restore {hash}` brings the whole vault back to how it was at that commit by adding a **new** commit. Every later commit stays in history, so the restore is itself undoable.
- **Reset to a commit** (destructive) — `POST /api/vault/reset {hash, confirm: true}` makes a commit the latest state, **permanently deleting every commit after it**. It only works on a commit in the current history, requires an explicit `confirm` flag, and is gated behind a confirmation prompt in both the app and the CLI. It is deliberately **not** an agent tool — only a human can trigger it.

Git behaviour is configured under `memory.vault.git.*` — see [Configuration](#configuration).

## Dream-mode maintenance

A periodic maintenance pass keeps the vault healthy without manual intervention. Each run:

1. **sync** — reconcile the index with the notes on disk
2. **gate** — run the quality gate
3. **doctor** — apply every mechanical fix
4. **regenerate derived** — rebuild `llms.txt` and `_showcase/showcase.md`
5. **suggest** — ask a cheap model to propose fixes for the hard issues (orphans, duplicates, over-long notes); best-effort and offline-safe
6. **dream-log** — write an audit note under `workspace/_dream/dream-YYYY-MM-DD-HHMM.md` with before/after metrics, the fixes applied, and the open suggestions
7. **commit** — one provenance-stamped commit for the whole pass

It is disabled by default; enable it under `memory.vault.maintenance.*`. See also [Scheduler & Dream Mode](./scheduler.md).

## Save reminder

To make the agent actually *use* its memory, OpenAgent injects a memory-checkpoint reminder into the turn — on the first prompt of a session and then every **N** turns (default 3). The reminder tells the agent to review the conversation and save anything relevant that isn't already in the vault. It is on by default; tune it under `memory.vault_reminder.*`.

## Native MCP tools

The agent drives the quality system through the in-process **`vault-gate`** MCP server (tool names namespaced `vault_*`):

| Tool | What it does |
|---|---|
| `vault_gate` | Run the quality gate and return a structured report |
| `vault_doctor` | Apply (or preview) the mechanical fixes; list hard issues as suggestions |
| `vault_validate_note` | Validate a note's content **before** writing it |
| `vault_rename_note` | Move/rename a note or folder, rewriting all inbound wikilinks |
| `vault_init` | Scaffold the folder taxonomy, journal tree, canon, and templates |
| `vault_stats` | Vault health at a glance (notes, links, broken, orphans, components) |
| `vault_search` | Full-text (FTS5) search over title / summary / body |
| `vault_backlinks` | List the notes that link **to** a given note |
| `vault_regenerate_derived` | Rebuild `llms.txt` and `_showcase/showcase.md` |

These complement the existing `vault` MCP (read/write notes); see [MCP Tools](./mcp.md).

## CLI

`openagent vault` exposes the whole system from a shell. It works against the markdown directly, so no gateway needs to be running:

```bash
openagent vault gate [--strict] [--json]   # grade every note, print the report
openagent vault doctor [--apply]           # mechanical fixes (dry-run by default)
openagent vault sync [--force]             # reconcile the incremental index
openagent vault derive                     # regenerate llms.txt + showcase.md
openagent vault stats                      # vault health summary
openagent vault search "<query>" [--limit] # full-text search
openagent vault mv <old> <new>             # move/rename + rewrite links
openagent vault init [--no-git]            # scaffold the taxonomy
```

The top-level `openagent doctor --fix` also installs git for the vault when it's missing, so a fresh box gets a version-controlled vault automatically.

## REST endpoints

The gateway exposes the system under `/api/vault/*` (all behind the device-cert middleware):

```
GET  /api/vault/gate?strict=&limit=     → {ok, error_count, warn_count, info_count,
                                            note_count, violations, by_rule, stats}
GET  /api/vault/stats                    → {notes, links, broken_links, orphans,
                                            components, largest_component, notes_per_folder}
GET  /api/vault/history?path=&limit=     → {commits:[{hash, author, message, trailers, …}]}
GET  /api/vault/commit?hash=             → {hash, subject, author, date, provenance,
                                            files:[{status, path}], diff, diff_truncated}
POST /api/vault/restore {hash}           → {ok, commit, restored_from, changed}
POST /api/vault/reset   {hash, confirm}  → {ok, head, deleted}   (destructive)
POST /api/vault/doctor?apply=            → {applied, files_changed, mechanical_fixes,
                                            open_suggestions, errors_before, errors_after}
POST /api/vault/derived                  → regenerate llms.txt + showcase.md
POST /api/vault/move    {from, to}       → {moved, notes_moved, notes_updated,
                                            links_rewritten, commit}
POST /api/vault/init                     → {created:[…], count}
POST /api/vault/index/sync?force=        → {added, updated, deleted, unchanged, total}
PUT  /api/vault/notes/{path}             → validates + commits, returns
                                            {ok, path, warnings, commit}
```

`PUT /api/vault/notes/{path}` validates on write by default (`validate_on_write`) but never rejects the write — it returns the note's quality warnings alongside the resulting commit hash. See the full surface in [Gateway](./gateway.md).

## Configuration

```yaml
memory:
  vault_path: "~/.openagent/memories"   # the git-backed markdown vault
  vault:
    enabled: true
    max_lines: 300            # atomicity ceiling
    min_outlinks: 3           # minimum outgoing links for content notes
    enforce_taxonomy: false   # turn the taxonomy rule on
    strict: false             # promote warnings to errors
    validate_on_write: true   # grade notes on PUT (warns, never rejects)
    git:
      enabled: true
      autocommit_seconds: 25  # background sweep interval for external edits
      author_name: "OpenAgent"
      author_email: "agent@openagent.local"
    maintenance:
      enabled: false          # dream-mode vault pass
      interval_hours: 12
      autofix: true           # apply mechanical fixes each pass
      regenerate_derived: true
  vault_reminder:
    enabled: true
    every_n_turns: 3          # inject the memory checkpoint every N turns
```

Each key also has an `OPENAGENT_VAULT_*` environment-variable override.
