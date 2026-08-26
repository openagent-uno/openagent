# Unified history and search verification plan

- Status: Active beta verification contract; required end-to-end evidence is pending
- Date: 2026-08-26
- Release effect: blocking for the authorized beta; this document does not authorize stable
- Related plan: [Unified history, storage, and global search beta](../plans/unified-history-storage-search-beta.md)
- API: [Unified history and search OpenAPI](../api/unified-history-search.openapi.yaml)
- Storage decisions: [ADR-001](../architecture/adr-001-operational-storage-sqlite-first.md), [ADR-002](../architecture/adr-002-canonical-history-retention.md), [ADR-003](../architecture/adr-003-operational-search-index.md)
- Security: [Operational search threat model](../security/operational-search-threat-model.md)
- Release process: [Beta unified-history runbook](../release/beta-unified-history-runbook.md)

::: danger The external authorization does not waive verification
The user authorized this beta train on 2026-08-26. Nothing in this verification
document authorizes a stable release, a `latest` mutation, a reused tag, or a release
that skips these gates. Candidate packages and production-like data migration remain
subject to the backup, rollback, isolation, and evidence rules in the beta runbook.
:::

## 1. Purpose

This plan defines the evidence required before an OpenAgent unified-history build can
be offered in the opt-in beta channel. It covers server, app, CLI, migration, search,
security, performance, compatibility, and final packaged artifacts.

Passing a unit suite is not sufficient. The gate requires:

- deterministic fixtures that exercise every supported resource and target kind;
- fault injection around every canonical transaction boundary;
- migration and binary downgrade/re-upgrade with sanitized copies that preserve
  real legacy schemas and data shapes;
- API contract and authorization tests against a running gateway;
- UI flows that open the exact matched content;
- performance measurements on declared hardware and filesystem;
- two consecutive complete end-to-end passes from clean state;
- smoke tests of the exact immutable packages intended for the authorized beta
  prerelease.

A zero exit code from an existing repository suite is baseline evidence, not
evidence that this plan passed. Required feature tests may not be skipped, and a
runner that exits zero while required tests are skipped does not satisfy the
gate. Two consecutive passes mean the same immutable SHA/artifact set, fresh
fixtures, no required skip, and separately recorded evidence identifiers.

## 2. Test topology

Every gate-specific run that counts as evidence uses an isolated temporary
agent directory and never reads or mutates the developer's real OpenAgent data.
The existing regression runner described in §2.1 is an explicitly documented
baseline exception and does not count as the destructive/security harness.

The integration topology contains:

- one gateway/server process;
- one migration/index owner;
- scheduler, workflow, event, and MCP workers enabled where relevant;
- two tenants or networks;
- at least three users with distinct ACLs in the primary tenant;
- one agent principal and one delegated child agent;
- two app accounts connected to different principals;
- one CLI client;
- a deterministic fake model/provider and deterministic tool servers;
- a controllable clock and seeded random generator;
- a local filesystem artifact store;
- no Internet requirement.

Tests that validate process concurrency start real independent processes. In-process
tasks are not accepted as proof of file-lock, downgrade, WAL, or crash behavior.

This is the target topology. The repositories do not currently provide one
command that creates it end to end.

### 2.1 Current commands and what they prove

#### Server

The current registered test runner is:

```bash
uv venv
uv pip install -e .
bash scripts/test_openagent.sh --list
bash scripts/test_openagent.sh
```

It supports category selection. The unified-history beta registers the focused
storage/API/updater gate:

```bash
bash scripts/test_openagent.sh --only operational_storage,operational_api,updater
```

This runner creates `/tmp/openagent-test-<uuid>/` for writes, but it is not
hermetic by default: `--config` defaults to `~/my-agent/openagent.yaml`, the
setup reads its sibling `openagent.db` read-only to borrow live provider keys,
and the generated filesystem MCP roots include the user's home directory. Live
tests may skip when keys are unavailable, and `npx -y` may require network.
Therefore this command remains an existing regression gate, but it is not
approved for destructive migration, retention, restore, full-disk, or hostile
path fixtures.

Feature tests may register additional categories in the same framework, but the
exact category names and command must be taken from `--list` after they exist.
This document does not invent a command for tests that have not been added.

#### App

With dependencies installed, the current repository gate is:

```bash
npm ci --prefix universal
npm ci --prefix desktop
bash test.sh
```

The supported focused forms are `bash test.sh lint`, `bash test.sh types`, and
`bash test.sh unit`. The beta worktree wires this gate into both CI and the tag
release workflow and includes common search-navigation/workflow-trace plus
desktop updater-channel policy tests. The release matrix separately extracts or
installs and launches the generated installers, verifies the ASAR/web payload
and update metadata, and launches both macOS architectures. This describes
configured coverage, not a recorded pass. It still does not provide a committed
Playwright/Electron real-gateway flow, iOS/Android automation,
visual-regression, or accessibility automation.

#### CLI

The CLI beta worktree has a standard-library `unittest` suite and a CI matrix
for Python 3.11 and 3.12. The exact source-checkout command is:

```bash
python -m pip install -e .
python -m unittest discover -s tests -v
```

The release workflow runs the same suite on Python 3.12, then runs the `full`
isolated distribution check before its platform matrix. Each platform job also
launches the exact frozen binary it just built (after signing where applicable)
with `--version`, `--help`, and `server-info --help`; it then verifies the final
package checksum, extracts the package, and repeats the exact version/help
probes before upload. This configuration is not evidence that a run passed.
The beta worktree defines both distribution checks explicitly:

```bash
OPENAGENT_PACKAGING_PYTHON=3.11 bash scripts/test-packaging.sh wheel-only
OPENAGENT_PACKAGING_PYTHON=3.12 bash scripts/test-packaging.sh full
```

They build a wheel from a staged source copy, install it into a clean virtual
environment, reject leaked legacy top-level modules, and—in `full` mode—build and
launch a PyInstaller executable outside the checkout. They still do not replace
a live gateway integration or the cross-version/Friday matrix below. The
per-platform release jobs separately smoke each final signed/frozen package
before upload; the release job then downloads the platform artifacts and
verifies the exact merged union and checksums before opening a hidden draft.

#### Docs

The current documentation gate is:

```bash
npm ci
npm run docs:build
```

It must run from `openagent-docs` and fail on malformed Markdown/Vue or broken
internal links.

### 2.2 Safety contract for destructive fixtures

Migration, downgrade, retention, restore, corrupt-file, read-only, power-loss,
and full-disk tests use a dedicated process-level harness, not the current
default server runner.

The harness must:

- create one unique root with `mktemp -d` under the CI runner or an ephemeral
  VM/container and place a fixture manifest containing its UUID and resolved
  root inside it;
- use generated credentials, fake providers, and sanitized fixture databases;
  it must not read a developer config, database, keychain, vault, backup, or
  provider key;
- copy every legacy input into the fixture root before opening it and keep the
  source fixture immutable;
- resolve every database, artifact, backup, index, binary, and restore target
  before mutation and verify it is a non-symlink descendant of that exact
  marked root;
- reject `/`, a home directory, a workspace/repository root, platform default
  OpenAgent data directories, the temp directory itself, unresolved variables,
  globs, and paths without the fixture marker;
- launch and kill only child PIDs it created; broad `pkill`, service-manager
  names, and host-wide process matching are forbidden;
- simulate disk exhaustion with a bounded filesystem image, quota, or injected
  write failure inside the fixture root, never by filling the host volume;
- run storage `--plan` first and permit `--apply` only while the fixture server
  is offline and the resolved target plus fixture manifest match;
- keep all backup/restore/artifact copies under the marked root and verify the
  developer's normal data paths were never opened for write;
- clean only explicitly enumerated children of the recorded fixture root. A
  kept failure fixture is moved to a CI artifact area with restrictive
  permissions rather than deleted by a broad recursive command.

For maximum assurance, destructive lanes run as a fresh OS account without
access to real OpenAgent directories. A test-only confirmation token may bypass
interactive prompts, but it must be bound to the resolved fixture manifest and
must not be accepted by a production binary against an unmarked path.

## 3. Fixture corpus

### 3.1 Required records

The generator creates stable IDs and expected normalized/search projections for:

- ordinary and titled chats;
- a long chat never opened by the test client;
- delegated sessions nested two levels deep;
- workflow definitions with prompts, duplicate node labels, loop and retry attempts;
- workflow runs with distinct trace-step IDs for the same node ID;
- scheduled definitions and a run older than the legacy latest-50 window;
- event definitions and deliveries that start a chat, scheduled run, and workflow;
- event delivery with no downstream target;
- messages from two users, an agent, and a system record;
- visible reasoning plus provider-hidden reasoning;
- tool success, error, cancellation, child session, large result, and artifact result;
- two invocations sharing a provider `tool_call_id` but having different canonical
  `tool_invocation_id` values;
- image, voice, video, text-file, and generated artifact links;
- deleted, revoked, private, shared, and quarantined resources;
- ownerless `installation_shared` legacy workflow/scheduled/event definitions
  and runs with `legacy_unattributed` provenance, alongside ownerless legacy
  chat/session rows that must remain quarantined;
- partial stream and interrupted run;
- malformed, double-encoded, compacted, and truncated legacy sessions;
- non-Latin scripts, Italian, English, emoji, combining marks, right-to-left text,
  punctuation, phrase and prefix candidates;
- hostile Markdown/HTML strings rendered only as text in snippets.

### 3.2 Secret canaries

Plant unique, non-production canaries in every risky location:

- API key and bearer header;
- cookie and JWT-like token;
- PEM-like private key;
- signed URL query string;
- high-entropy unknown-tool scalar;
- nested event payload;
- environment variable and MCP header;
- provider-private metadata and hidden reasoning;
- stack trace and local private path;
- binary/base64 block crossing chunk boundaries.

The suite scans:

- search database main file, WAL and SHM;
- old index generations;
- API and WebSocket bodies;
- persisted app/CLI state and post-logout/post-account-switch state produced by
  tests; live request memory is not treated as a persistence sink;
- server logs, traces, metrics labels, crash reports, and diagnostic bundles;
- semantic/embedding fakes, which must receive no request in the first beta;
- migration logs, manifests, and backup metadata.

No secret canary may appear outside the specifically authorized canonical test
source or the deliberately full-fidelity test-backup payload. A backup may
contain canonical secret values by design; its metadata, manifest, logs, file
name, and diagnostics must not. The test backup remains inside the marked
fixture with restrictive permissions whether or not backup encryption is later
adopted. Searching a secret canary returns zero authorized hits.

### 3.3 Dataset sizes

Generate these reproducible profiles:

| Profile | Sessions | Message/tool documents | Purpose |
|---|---:|---:|---|
| tiny | 20 | 500 | unit/integration and visual flows |
| medium | 10,000 | 100,000 | migration, concurrency, ordinary performance |
| large | 100,000 | 1,000,000 | search/history SLO and index rebuild |
| pathological | targeted | targeted | 4 MiB blob, large tool output, deep JSON, loops, corruption |

Each generated corpus writes a manifest with generator version, seed, byte sizes,
expected counts/hashes, distribution, and source schema version.

## 4. Static and contract gates

Before starting runtime tests:

1. apply the proposed canonical DDL to a new SQLite database;
   apply each version-gated legacy trigger bridge only to a matching sanitized
   legacy fixture after validating its required table/columns;
2. apply the operational-search DDL with `trusted_schema=OFF`, insert/update/delete
   an FTS row transactionally with its chunk row, run the FTS integrity command, and
   prove that the two rowid sets are identical;
3. run `PRAGMA foreign_key_check` and `PRAGMA integrity_check` on both schemas;
4. apply every migration/schema script twice to prove idempotent orchestration or
   explicit refusal;
5. validate the OpenAPI document and resolve every local `$ref`;
6. compile the canonical TypeScript search-target types in strict mode;
7. for every closed wire enum, assert that the server accepts/emits only documented
   values and that generated client types regenerate without a diff;
8. for richer runtime or legacy status enums, assert a total table-driven mapping to
   the applicable wire enum, exact `status_raw`/raw-envelope round-trip, and
   fail-closed handling of an unmapped value; storage enum equality is not required
   when the concepts differ;
9. verify `api_revision=2`, `history=2`, `global_search=1`,
   `session_messages=1`, and `detail_resolvers=1`; the complete beta candidate
   advertises exactly five search scopes and nine target kinds, and every target
   maps to one implemented authorization-aware resolver;
   during bootstrap, `features` and individual feature entries may be absent and
   long-lived clients must show warming/retry and the one-shot CLI must return a
   retryable warming/degraded error rather than empty results or legacy fallback;
   a canonical v2 fresh install with an FTS file not yet created may report
   `search_state=unavailable`, which is tested as transient warming rather than
   unsupported;
10. verify workflow-run and event-delivery detail preserve numeric epoch values in
    the legacy `started_at`/`finished_at` keys and add their ISO renderings, while the
    new scheduled-run detail route uses its documented canonical ISO values; verify
    every workflow trace step emits only its canonical `id`, never a new-schema alias;
11. verify no initial capability contains Memory/Vault or semantic search;
12. verify `realtime_event` is optional and that clients subscribe only when it is
    advertised; if advertised, execute the corresponding event ordering and ACL
    gates below;
13. run repository lint, formatting, type, import, and existing test gates;
14. build the documentation site with no broken internal links.

The OpenAPI file is the wire source of truth, not a demand that unrelated
internal/UI enums be identical. `ActivityKind`, `SearchScope`,
`SearchTargetKind`, `SearchRootKind`, and `SearchMatchKind` intentionally model
different sets. Contract tests compare each implementation to the applicable
wire schema and discriminator mapping. The beta `global_search=1` capability is
advertised only with the complete five-scope and nine-target sets; it must be omitted
rather than advertising a partial contract. Other capability arrays must conform to
their wire schema and to behavior actually enabled for that principal.

If types are generated, CI checks that regeneration produces no diff.
Hand-written adapters may normalize internal values but cannot redefine wire
values, discard the exact raw value, or silently coerce an unmapped state to
success/failure. Clients must handle a future unknown response value
safely—generic/unsupported UI or a
bounded skip with diagnostics—without broadening access, silently choosing a
different target, or crashing the whole search surface. Invalid request enum
values receive the documented validation error.

## 5. Server unit and repository gates

The existing command in [§2.1](#21-current-commands-and-what-they-prove) remains
the regression baseline. New in-process tests may use its registered-test
framework. Crash, lock, old-binary, restore, and disk-pressure cases use the
separate destructive harness from §2.2. Until those modules/harness commands
exist and appear in CI, the corresponding items below are **not run**, not
implicitly passed.

### 5.1 Canonical writes

- append a message without rewriting prior canonical message rows;
- stable IDs and ordinals under retry;
- duplicate idempotency key returns the same turn;
- unique provider tool-call IDs are scoped correctly;
- artifact object created, linked, reconciled, and collected safely;
- child/delegation/causation links preserve lineage;
- author principal and display snapshot remain distinct;
- unknown raw-envelope fields round-trip byte-equivalently where promised;
- context compaction changes only context snapshots;
- delete writes tombstone/domain event/search outbox atomically.

### 5.2 Crash durability

Inject process termination before and after:

- accepted user-message commit;
- run transition to running;
- first assistant stream checkpoint;
- tool pending and running transitions;
- raw tool result acquisition and artifact link;
- assistant terminal message commit;
- activity/domain-event/outbox commit;
- index application and applied-sequence checkpoint.

After each restart, assert one logical turn, honest terminal/partial state, no visible
content without a canonical record, no duplicate invocation, and replayable outbox.

### 5.3 Search extraction

- known extractor allowlist and versioning;
- unknown tool values excluded by default;
- redaction occurs before chunking;
- query text is escaped and never passed as raw FTS syntax;
- phrase, prefix, punctuation, Unicode and empty/recent modes;
- deterministic ranking tie-breaker;
- ACL filter before limit/count and canonical recheck;
- revoke/delete prioritization;
- crash between chunk/FTS statements rolls back both because they share one
  transaction;
- a manually injected chunk/FTS rowid mismatch makes the generation invalid rather
  than searchable;
- a cross-tenant ACL projection insert fails its composite foreign key;
- corrupt index rebuild and atomic generation swap;
- warming/degraded/partial coverage is truthful;
- cancellation and deadline interrupt the SQLite query and extraction work.

## 6. Migration matrix

Use sanitized fixture databases produced by every supported pre-beta server schema,
not only synthetic rows created by the new writer. A “real legacy database” in
this plan means a sanitized, immutable fixture copied under the marked test
root; it never means an operator's live database or backup. Every step follows
the destructive-fixture contract in §2.2.

For each source version test:

1. preflight disk space and permissions;
2. acquire the cross-process migration lock;
3. create a SQLite-consistent backup and artifact manifest;
4. open the backup, run integrity checks, and restore it to a temporary directory;
5. stop after each DDL/backfill checkpoint and resume;
6. mutate legacy sessions concurrently while backfill is extracting them;
7. verify source-version/hash CAS requeues stale work;
8. compare order, authors, messages, tools, artifacts, status, lineage, timestamps and
   visible reasoning for every complete record;
9. count and label malformed/partial/legacy-compacted records without invention;
10. enter `prefer_v2` only for individually verified sessions;
11. run real traffic during bounded backfill and record lock/latency regression;
12. complete `v2`, then return to legacy read mode without restoring a snapshot;
13. downgrade to a pre-v2 binary, create/update/delete data, and run retention;
14. re-upgrade, force `shadow`, consume `legacy_session_changes`, and reconcile;
15. prove deleted data is not resurrected in history or search;
16. exercise offline restore plan and apply in a disposable directory.

The matrix covers clean exit, power-loss simulation, WAL present, full disk, read-only
artifact directory, corrupt source row, corrupt index, and insufficient backup space.
Power loss terminates only the recorded fixture child PID. Full disk and
read-only behavior are simulated within the bounded fixture filesystem; they
must not alter host-volume free space or permissions outside that root.

## 7. API and authorization integration gates

Against a running authenticated gateway:

- capabilities embedded in `auth_ok` equal `GET /api/capabilities`;
- history returns one authorized summary snapshot and paginates without gap/duplicate;
- search returns authorized structured snippets and typed targets;
- message-around includes the anchor and independent before/after cursors;
- scheduled run resolves directly by ID beyond the legacy list window;
- workflow resolver distinguishes two attempts of the same node;
- tool resolver distinguishes invocation ID from provider tool-call ID;
- event delivery returns the real downstream target and causal breadcrumb;
- malformed cursor, expired snapshot, filter mismatch and generation change return the
  documented error without falling back to page one;
- 401, timeout, and 5xx do not trigger legacy fallback;
- unsupported/404 capability does trigger the explicitly limited session switcher;
- count, coverage and `N more` include only authorized matches;
- direct-object requests cannot enumerate another tenant;
- when `history.realtime_event` is advertised, `history_changed` follows canonical
  commit and contains only an authorized summary;
- when `global_search.realtime_event` is advertised, `search_index_changed` follows
  index application and contains no text; when either event is absent, clients do
  not subscribe or infer it and bounded REST refresh remains correct;
- rate, query-length, snapshot-count and response-size limits match the contract.

Repeat the relevant requests as owner, shared member, ungranted member, different
tenant, agent on behalf of each user, and revoked user.

## 8. Client and deep-link gates

Run on Chromium/Electron, one iOS simulator, and one Android emulator/device where the
platform supports the feature.

These are target gates, not capabilities of the current `test.sh`. The app
repository must first add committed search-store/API tests and named
Chromium/Electron/device E2E runner commands. A manual exploratory pass may
provide supplementary evidence, but it cannot be silently represented as an
automated gate. Each required platform flow runs twice from clean app state
against the same candidate server/package set.

### 8.1 Search behavior

- open from every primary authenticated route and the sidebar/drawer;
- query-empty All with no filters reuses only the account-scoped first history page;
- a specific scope or any filter uses `POST /api/search` with an empty query,
  `sort: recent`, and `grouping: match`; Tools always follows this path and labels
  the state `Recent tools`;
- rapid typing, filter change and account switch allow only the latest request to win;
- close/reopen retains in-memory query, filters, scroll, and selection for the same
  account;
- logout and account/server switch hard-clear state;
- pagination beyond 100 results has no duplicate visual keys or missing snapshot rows;
- live updates show `Results updated` without moving the active row;
- offline, warming, degraded, empty, no-match, initial-error and page-error states;
- keyboard, IME, focus trap, Home/End/Page keys and focus restoration;
- screen-reader label/order and touch targets;
- snippets with hostile markup, emoji, combining characters and bidirectional text.

### 8.2 Target resolution and beta anchors

Exercise all nine `SearchTarget` variants and assert that every required opaque ID
opens the authorized canonical destination. The first-beta gate is deliberately split:

- chat root opens the correct session;
- chat message and chat tool open, focus, and highlight the exact matching message or
  invocation;
- workflow definition opens the correct workflow root, without requiring a matching
  node or field;
- workflow run opens the exact run, without requiring a match-specific trace-step or
  nested-tool anchor;
- scheduled definition opens the correct task root;
- an old scheduled run opens by its exact run ID rather than a latest-runs lookup;
- event definition opens the correct event root;
- event delivery opens the exact delivery; its separately authorized downstream link
  still resolves to the real workflow/scheduled/chat destination.

The advertised beta value is `detail_resolvers.definition_field_anchors=false`.
Fixtures must not require optional workflow/scheduled/event node, field, trace-step,
message, or tool members to be present in search results. When a later capability sets
that field to `true`, add match-specific tests for each projected definition field and
attempt-level trace step before treating those anchors as a release gate.

While positioned on an old chat message, append live messages. The viewport must
remain at the anchor and expose a `New messages` action. Delete or revoke the target
between response and click and verify the explicit stale-result state.

### 8.3 Visual regression

Use the matrix in the [visual specification](../design/global-search-visual-refresh-spec.md).
Capture fixed before/after screenshots in dark/light themes and at 390, 768, 1024, and
1440 px where applicable. Confirm no remote font request, no palette/blur-token diff,
and no unintended layout change.

## 9. CLI gates

The source-level `unittest`/CI gate described in §2.1 now exists. None of the
remaining bullets can be checked off merely because that suite or a PyInstaller
build exits zero. The verification record names the exact command, Python
version, non-zero test count, live fixture/candidate identity where applicable,
and packaged-artifact evidence separately.

### 9.1 Remote `openagent-cli`

- history/search output parity with the same server principal;
- `--json` schema validated against fixed fixtures;
- cursor/limit/all behavior with the declared TTL, per-principal snapshot quota,
  and candidate ceiling; `--all` exhausts an accepted snapshot but cannot bypass
  those limits, and an oversized request fails explicitly without silent truncation;
- exit codes for success, no match, invalid request, authentication, unsupported,
  warming/degraded, network failure and internal server failure;
- query never appears in process logs, update logs, shell-generated URL, or telemetry;
- capability cache scoped to server and account;
- fallback only on explicit unsupported/404;
- packaged `openagent-cli --version`, `--help`, connect, history, search,
  pagination, JSON,
  cancellation, and fallback smoke from outside the source checkout;
- if CLI self-update ships: beta opt-in, signature/checksum, atomic swap,
  self-check and bad-version guard;
- if self-update is deferred as allowed by the beta runbook: manual package
  installation is tested and the CLI advertises no unsupported updater command
  or capability.

### 9.2 Server-host `openagent storage`

The following are server-binary tests, not remote CLI-repository tests:

- storage status, verify, backup, migration plan/apply, index rebuild and
  offline restore refuse unsafe online or ambiguous operations;
- destructive restore requires explicit apply and confirmation, validates the
  fixture marker, and never runs against a broad, symlinked, default, or
  unresolved path;
- packaged `openagent --version` and
  `openagent selfcheck --quiet --expect <package-version>` run successfully
  before any fixture storage command;
- every storage mutation follows §2.2 and operates only on an offline fixture
  agent directory.

## 10. Performance and scale gates

Record CPU, RAM, filesystem, free space, OS, SQLite version/options, Python/Node
versions, WAL settings, corpus manifest, cold/warm definition, sample count, p50/p95/
p99, errors, payload bytes and lock/retry counters.

Initial release gates:

| Measurement | Dataset | Gate |
|---|---|---|
| History first page, warm | 100k activity items, 50 returned | p95 ≤ 200 ms |
| History first page, cold | same | p95 ≤ 500 ms |
| Keyword search, warm | 1M message/tool docs | p95 ≤ 300 ms |
| Keyword search, cold | same | p95 ≤ 1 s |
| Perceived first result | local network, including debounce | p95 ≤ 600 ms |
| Search freshness | steady-state outbox | p95 ≤ 2 s |
| Sidebar visible | authenticated local network | ≤ 1 s, one history fetch |
| First-page payload | worst supported row mix | ≤ 256 KiB |
| Long-session append | turn 10,000 vs turn 10, equal payload | ≤ 2× latency |
| Migration batch lock | medium/large corpus | commit p99 ≤ 100 ms |
| Foreground regression during backfill | medium/large corpus | ≤ 20% p95 latency |

There must be zero lost/duplicate writes and zero exhausted `database locked` errors
surfaced to clients. Temporary internal retries are recorded. A test does not pass by
raising timeouts until the error disappears.

## 11. Cross-version compatibility

Exercise these pairs with real binaries or packages:

- old app and CLI to new server;
- new app and CLI to old server;
- new clients to new server in `legacy`, `shadow`, `prefer_v2`, and `v2`;
- old stable server after beta binary downgrade, followed by beta re-upgrade;
- beta client/server to a semantically newer stable;
- stable updater selection in the presence of synthetic beta GitHub API/feed
  fixtures;
- packaged/frozen server beta updater opt-in through
  `OPENAGENT_UPDATE_CHANNEL=beta` (and config-channel precedence), with
  beta.1 → beta.2 and beta → newer stable; an unknown channel must fail
  safe to stable, while the environment alone must not enable `auto_update`;
- a `0.19.x` server must not auto-select `0.20.0-beta.2`: seed Friday manually
  from the exact Linux x64 package after sibling-checksum and GitHub asset-digest
  verification, then prove later compatible `0.20.0-beta.N` selection;
- missing, corrupt, interrupted, wrong-platform, wrong-architecture, unsigned and
  checksum-mismatched packages.

Independent server/app/CLI version numbers are expected. Capability/API revision, not
matching package version, controls behavior.

Before the authorized beta tag is pushed, updater matrices use a local HTTP
stub or recorded/synthetic GitHub API and feed metadata with test-only
artifacts. They must not create a public tag, draft, prerelease, `latest`
mutation, or updater feed merely to exercise discovery. Real old/stable
binaries run only against the marked fixture agent directory. Published-
metadata verification is a separate post-publication check and never mutates
`latest`.

## 12. Evidence bundle and exit criteria

### 12.1 Exact packaged-artifact evidence

Source-checkout tests and packaged-artifact tests are separate gates. The beta
tag workflows validate exact beta versions, run repository tests, build, and
smoke the final package on its native platform before uploading the workflow
artifact. The release job downloads those platform artifacts, verifies the exact
merged set, creates only an unpublished draft, and compares every uploaded name,
size, and GitHub `sha256:` digest before exposing a prerelease. Package or draft
failure therefore leaves no partially visible prerelease. A later
non-publishing candidate plus manual promotion can strengthen the process but
is not to be fabricated in the evidence record.

For every OS/architecture artifact:

1. freeze the manifest's exact 40-character source SHA and push one unused,
   immutable `vX.Y.Z-beta.N` tag only after all pre-tag gates pass;
2. let the tag workflow verify versions, run source tests, and build each
   platform artifact exactly once before any release job;
3. record workflow run/artifact IDs, external release version,
   normalized package version, filename, size, SHA-256, signature/notarization
   or provenance reference, and build-tool versions;
4. test the final package on its native build runner without editable packages,
   source-tree imports, `PYTHONPATH`, developer config, or access to real user
   data, then upload those exact bytes as the platform workflow artifact;
5. download all platform artifacts into the release job, reject any duplicate,
   missing, or unexpected filename, and recompute every checksum;
6. upload only that set to a hidden GitHub draft with overwrite disabled and
   verify the remote asset-name union, size, and `sha256:` digest while
   `draft=true`;
7. patch the verified draft to `draft=false`, `prerelease=true`,
   `make_latest=false`, then re-read its state and assets;
8. install or unpack the exact published server/CLI Linux package on Friday
   without editable packages, source-tree imports, `PYTHONPATH`, or unscoped
   developer credentials, and only after the verified backup/restore rehearsal;
9. run the component-specific live smoke against the marked Friday principal
   and backed-up agent root;
10. collect the smoke result and environment identity, then recompute/archive
   the immutable artifact digest;

A local or CI rebuild from the same SHA is a different candidate and invalidates
prior technical evidence. If a hidden draft fails verification, keep it unpublished and
advance to a new tag/version; never overwrite it.

Minimum package probes:

- server: `openagent --version`,
  `openagent selfcheck --quiet --expect <package-version>`, isolated boot,
  gateway health, one canonical turn, history/search, shutdown, and restart;
- app: signature/notarization validation where supported, clean install and
  launch, connect to the fixture gateway, search/deep-link flow, clean relaunch,
  updater disabled or pointed only at the local test feed, and recovery with the
  published stable `v0.16.0` installer after verifying its available digest and
  platform-signature evidence;
- CLI: exact source/package/frozen `openagent-cli --version`, final-package
  checksum verification and extraction, `openagent-cli --help`, connect to the
  fixture gateway, history/search/JSON/pagination, and clean execution from
  outside the checkout.

No package or Friday smoke step may invoke `release.sh`, push another tag, or
mutate a real updater feed. The separately permissioned release job is the only
publisher and runs only after native package smoke succeeds; its draft is not
public until remote digest verification passes.

### 12.2 Bundle contents

For each candidate SHA set, store a local or CI evidence bundle containing:

- exact repository SHAs and dirty-state check;
- fixture manifests and expected hash report;
- migration parity and quarantine report;
- schema integrity and OpenAPI/type validation;
- security-canary scan report;
- test logs and two consecutive full-pass identifiers;
- performance raw data and summary;
- visual screenshots/diffs and accessibility checklist;
- package filenames, sizes, signatures and SHA-256 digests;
- candidate workflow/artifact IDs and smoke-test results from those exact
  package bytes on every required platform;
- hidden-draft and published GitHub API snapshots proving the exact remote asset
  union, sizes, `sha256:` digests, prerelease flag and non-latest state;
- known limitations and explicit waivers, if any.

The beta is blocked by any:

- committed data loss or duplicate logical turn;
- cross-principal disclosure or secret canary outside canonical authorized storage;
- history/search completeness falsely reported;
- migration or backup that cannot be resumed/restored;
- deep link opening the wrong record;
- stable updater observing a prerelease;
- package digest mismatch or rebuild between candidate freeze and publication;
- unbounded lock, query, snapshot, memory, disk, or response behavior;
- failed required platform or accessibility flow.

The beta train is already authorized, but execution remains gated. All pre-tag
items must pass before the immutable beta tag is pushed; the tag workflow must
hold GitHub Release creation until its exact-artifact smoke passes. Until those
conditions are recorded there is no GitHub prerelease, updater publication, or
user-data migration outside the explicitly backed-up Friday dogfood procedure.
Nothing here authorizes stable.
