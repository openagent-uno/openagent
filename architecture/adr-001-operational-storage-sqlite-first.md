# ADR-001: SQLite-first normalized operational storage

- Status: Accepted for beta; implementation present, migration and verification gates pending
- Date: 2026-08-26
- Scope: `openagent-server`, with contracts consumed by the app and CLI
- Related plan: [Piano beta: storage normalizzato, history unificata e ricerca globale](../plans/unified-history-storage-search-beta.md)
- Normative source: [vision.md](../vision.md)
- Reference DDL: `architecture/operational-storage-v2.sql`
- Version-gated legacy bridges: `architecture/legacy-session-change-triggers.sql`, `architecture/legacy-automation-change-triggers.sql`

## Context

OpenAgent is server-shaped, self-hosted, and must remain fully usable offline. The server owns sessions, automations, operational history, identity, and capabilities; the app, CLI, and integrations are clients of the same gateway.

The current store represents a session primarily as a JSON array in `sessions.runs`. This has three structural limitations:

1. appending or updating a turn requires reading, serializing, and rewriting a blob that grows with the conversation;
2. messages, authors, tool invocations, attachments, and lineage lack uniform relational identities and efficient cursors;
3. history, authorization, retention, and search must repeatedly parse heterogeneous shapes and cannot be updated atomically per durable unit.

The problem is not SQLite itself. It is the monolithic data model built on SQLite and the existence of multiple writers that update the same history through different connections and abstractions.

The vision also requires:

- durable, full-fidelity sessions;
- stable identity and authorship for messages, files, tool calls, delegations, outputs, and visible reasoning;
- first-class, navigable, resumable child sessions;
- model-context compaction that never destroys canonical history;
- one structured event stream for all operational events;
- a human-readable Markdown memory vault with only rebuildable indexes;
- an agent that remains operational when any cloud provider or external service is removed.

The first beta must retain compatibility with the legacy blob for shadow verification and rollback without making an external database service a prerequisite.

## Decision drivers

In priority order:

1. **Correctness and full fidelity.** A write visible to a user must not exist only in a stream or cache.
2. **Local atomicity.** Canonical history, the compatibility blob, activity, domain events, and the search outbox must advance together.
3. **Zero-configuration self-hosting.** A single installation must start offline without a separately administered database.
4. **Fail-closed ownership and ACL.** Identities are stable and migrations do not infer permissive ownership.
5. **Incremental reads.** Cursors and queries read targeted rows rather than deserialize whole sessions.
6. **Provable migration and rollback.** Backup, resumable backfill, downgrade, and re-upgrade are tested protocols.
7. **Replaceable backend.** Domain code does not scatter SQLite primitives through the runtime.
8. **Proportionate operations.** Backup, recovery, and observability remain understandable for a self-hosted operator.

## Decision

### 1. Normalized SQLite remains the default canonical backend

`openagent.db` remains the local operational database. Operational history moves to additive normalized tables for:

- session headers;
- runs;
- messages;
- tool invocations;
- artifacts and artifact links;
- context snapshots;
- ACL grants;
- domain events;
- the activity projection;
- the search outbox.

Every unit with its own identity or lifecycle receives its own row. Fields used for joins, filtering, ordering, authorization, or retention are columns rather than JSON keys.

JSON remains valid for two purposes:

- structured payloads that do not need relational queries;
- bounded, versioned, per-record raw envelopes that preserve provider or framework fields not yet normalized.

The v2 tables must not recreate a canonical per-session blob.

### 2. One repository owns operational-history writes

A domain `SessionRepository` is the only boundary authorized to mutate operational history. The runtime, `MemoryDB`, scheduler, workflow executor, and subprocesses do not update the same resources through independent transactions.

Each durable transition writes the following in one SQLite transaction:

1. canonical v2 rows;
2. `sessions.runs` during the compatibility window;
3. `activity_items` when history changes;
4. redacted `domain_events`;
5. `search_outbox` rows without sensitive bodies;
6. the revisions and source versions required by cursors and consumers.

Search indexing, JSONL rendering, and realtime broadcasts run after commit. These consumers may lag; they may not make the canonical commit partial.

### 3. Full-fidelity history is separate from model context

Canonical history preserves everything a user could see or reopen: multimodal content, authorship, tool requests and results, files, delegations, and visible reasoning.

Every run, message, and tool invocation has a bounded, versioned raw envelope. Large tool output is captured before display/model capping and stored in the artifact store. Its canonical record retains hash, size, state, and links. Model-facing and display-facing text are explicit projections, not replacements for the authorized raw value.

Compaction creates `context_snapshots` with exact boundaries, a source revision, and a checksum. It never updates or deletes messages, tool invocations, or artifacts.

#### Canonical enum and wire mapping

The OpenAPI document is the source of truth for public wire enums. Columns that
represent the same concept use those values directly. Internal source values are
preserved in `status_raw` or the versioned raw envelope; adapters do not add a
second public vocabulary.

These similarly named values are intentionally different:

- a finished successful **run** has `RunStatus = success`;
- a finalized **message** has `MessageStatus = complete`;
- a successful **tool invocation** has `ToolInvocationStatus = success`;
- a failed tool invocation has `ToolInvocationStatus = error`;
- `complete` in `Completeness` means fidelity is known to be complete, not that
  execution has terminated;
- `complete`/`failed` in `schema_migrations` and words such as `ddl_completed`
  in event names belong to migration/event domains, not `RunStatus`.

`session_runs.status` uses the public `RunStatus` values. The repository stores
the exact incoming spelling and state in `status_raw` and applies this total
mapping for currently supported sources:

| Runtime or legacy source state | Normalized `RunStatus` |
|---|---|
| `PENDING` | `pending` |
| `PAUSED` while awaiting approval/input | `pending` |
| `QUEUED` | `queued` |
| `RECEIVED` | `received` |
| `RUNNING`, `CANCELLING` | `running` |
| `COMPLETED`, `COMPLETE`, `SUCCESS`, `SUCCEEDED` | `success` |
| `ERROR`, `FAILED` | `failed` |
| `CANCELLED`, `CANCELED` | `cancelled` |
| `REJECTED`, `BLOCKED`, `DENIED` | `rejected` |
| `INTERRUPTED` | `interrupted` |
| `SKIPPED` | `skipped` |
| `TIMEOUT`, `TIMED_OUT` | `timed_out` |

`activity_items.status`, when present, uses the same normalized values. A query
can therefore filter session, workflow, scheduled, and event activity without
knowing each legacy subsystem's spelling. `status_raw` remains on the canonical
source row rather than the summary projection.

`tool_invocations.status` uses the smaller public tool vocabulary:

| Runtime or stored tool state | Normalized `ToolInvocationStatus` |
|---|---|
| `requested`, `pending` | `pending` |
| `started`, `running`, or no result yet | `running` |
| `completed`, `succeeded`, `success` with no error | `success` |
| `failed`, `error`, `denied`, or `tool_call_error=true` | `error` |
| `cancelled`, `canceled`, `interrupted` | `cancelled` |

The exact tool state remains in `status_raw` and the raw envelope. This retains
the difference between, for example, a provider error and an approval denial
without leaking an adapter-specific enum to clients.

Messages use the wire values without aliases:

- `MessageStatus`: `streaming`, `complete`, `interrupted`, `cancelled`, `failed`;
- `MessageRole`: `user`, `assistant`, `tool`, `compaction`;
- `AuthorKind`: `user`, `agent`, `system`.

A self-seeded prompt may have role `user` and author kind `agent`; the two fields
describe different facts. Tool and compaction rows use author kind `system`.
Framework `system`/`developer` messages and provider-private messages do not
become public `SessionMessage` rows by default. They remain in the raw envelope
with internal/provider-private visibility. A deliberately user-visible framework
notice is normalized to role `assistant`, author kind `system`, while its source
role remains in the envelope.

Completeness uses exactly `complete`, `partial`, `legacy_compacted`,
`malformed_source`, or `unknown` on sessions and searchable canonical records.
Authorship inference remains a separate `legacy_inferred` flag. The former draft
values map as follows: `pending` to `unknown`, `corrupt` to `malformed_source`,
and an already compacted legacy blob to `legacy_compacted`; quarantine is an ACL
visibility state, not a fidelity value. Inferred or omitted content is `partial`
unless independent verification establishes full fidelity.

An unrecognized source status is never guessed into a success or failure. The
normalization attempt is marked `malformed_source`, the original record remains in
the legacy source and migration journal for remediation, and no normalized row is
promoted as canonical. That session cannot switch to v2 reads until the mapping
registry understands and verifies it.

### 4. Artifact bytes live outside SQLite; references live inside it

Attachment and large-output bytes live in a content-addressed store on the same host. SQLite stores metadata, ACL information, hashes, state, and polymorphic links.

The write protocol is:

1. write a temporary file on the same filesystem as the object store;
2. close and sync it, then verify hash and size;
3. atomically rename it to its content-addressed key;
4. insert the artifact and links in the canonical database transaction;
5. leave a recoverable orphan if the file rename succeeds but the transaction fails.

Migration is copy-only throughout the beta. Garbage collection removes only objects with no links or old orphans after a safety window and a transactional recheck. Backup and restore include the database, artifact manifest, and required objects.

### 5. Structured logging is one logical stream

`domain_events` is the append-only journal that participates in the canonical commit. It carries redacted structured metadata, correlation, and causation, not the full-fidelity payload already stored in domain tables.

`logs/events.jsonl` is the local, human-inspectable materialization of that same stream. Its exporter resumes from the database sequence after a crash. It is not a second taxonomy or an independent producer.

`activity_items` is not the log; it is a summary-only history projection. `search_outbox` is not the log; it is a technical queue for a rebuildable index.

### 6. Search indexes remain separate and rebuildable

The canonical DDL does not create FTS5 tables. The operational index lives in `operational_search_<source-fingerprint>.db` and is rebuilt from canonical tables and the outbox. The vault keeps a separate index and lifecycle; Markdown remains the vault's only source of truth.

The operational index contains only redacted projections. Raw arguments, results, payloads, and artifacts do not enter FTS. Search results rehydrate canonical detail and recheck authorization before serialization.

Any future semantic index remains opt-in, operates only on already-redacted text, and does not change this storage decision.

### 7. Identity and ACL are canonical data

Owners and authors use immutable, tenant-scoped principal IDs. Handles and display names are presentation snapshots. New records derive ownership only from the authenticated certificate/request context injected by the server; owner or tenant fields supplied by a client never establish authority.

Legacy migration has one narrow compatibility policy. Workflow, scheduled-task,
and event definitions and runs that the versioned legacy schema made
installation-wide are migrated as `installation_shared`, with no invented human
owner, provenance `legacy_unattributed`, and an explicit legacy visibility-policy
marker. Their completeness remains independently classified rather than inferred
from visibility. Ownerless or ambiguous sessions/chats, and any record whose
historical installation-wide semantics cannot be proved, are `quarantined` and
unsearchable until explicit remediation. `owner_principal_id` may therefore be
NULL only for `installation_shared` or `quarantined`; private, shared, and public
records require an attributable owner.

Child sessions inherit ACL from their root as a domain rule. Delegations remain first-class history entries. Only child sessions caused by workflow, scheduled, or event runs are grouped beneath their operational root to avoid duplicate top-level activity.

### 8. Migration is additive and has four phases

The state machine is:

```text
legacy -> shadow -> prefer_v2 -> v2
```

Before the first DDL statement, the migration leader acquires an OS file lock, prevents secondary writers from starting, and creates a backup through the SQLite Backup API or `VACUUM INTO`. The backup is verified with `integrity_check` and a restore rehearsal.

Migrations have checksums and a ledger. Backfill uses a `(updated_at, session_id)` keyset plus source hash/version and conditional upsert. A session that changes during extraction is requeued.

Additive triggers on legacy `sessions` populate `legacy_session_changes`. They are a detection net for downgrade to a pre-v2 binary, not a replacement for application dual-write. After re-upgrade, the server returns to `shadow` and reconciles inserts, updates, and deletes before enabling `prefer_v2` again.

### 9. SQLite connection policy is explicit

Connection setup, rather than schema DDL, applies and verifies:

- `PRAGMA foreign_keys = ON` on every connection;
- WAL for the operational database;
- one bounded `busy_timeout` policy;
- one logical write queue for operational history;
- `synchronous = FULL` for canonical storage unless a later benchmark-backed decision explicitly accepts weaker power-loss durability;
- observable WAL checkpoints, never a raw copy of only the live `.db` file.

Rebuildable indexes may use a less expensive sync policy. Migration, backup, and phase changes additionally use the OS lock and `BEGIN IMMEDIATE`.

The proposed DDL baseline is SQLite 3.38 or newer with JSON functions enabled. FTS5 is required only by the search database, not to open canonical storage.

### 10. The repository is portable without becoming a lowest-common-denominator abstraction

The repository exposes domain operations and transactions, not generic SQL or ORM objects shared with clients. The initial implementation may use SQLite-specific features where useful.

A future PostgreSQL adapter must pass the same contract tests for atomicity, idempotency, ACL, full fidelity, and outbox behavior. Portability does not justify giving up foreign keys, partial indexes, WAL, or native SQLite backup support now.

## Alternatives considered

### Keep `sessions.runs` as the canonical blob

Advantages:

- no structural migration;
- immediate compatibility with the current runtime;
- flexible shape.

Disadvantages:

- append cost grows with transcript length;
- pagination and search require whole-session parsing;
- identity, ACL, retention, and deduplication remain implicit;
- compaction and capping may destroy the only historical copy;
- one malformed record affects the entire session.

Outcome: rejected as the future canonical source. It remains temporarily as a compatibility projection.

### Make MongoDB mandatory

Advantages:

- flexible documents map naturally to provider-specific shapes;
- mature document indexing primitives;
- horizontal scaling is available for large deployments.

Disadvantages:

- adds a separate service and lifecycle to every installation;
- weakens the zero-configuration laptop and offline baseline;
- a nested session document would preserve the same monolithic-growth problem;
- ACL, lineage, links, deduplication, and outbox still need stable identities and cross-entity transactions;
- backup, upgrade, and recovery become more complex than the current baseline.

Outcome: rejected as a mandatory dependency. Changing engines would not solve the problem while keeping the blob model.

### Make PostgreSQL the default

Advantages:

- stronger multi-writer concurrency and MVCC;
- mature constraints, JSONB, FTS, and operational tooling;
- replication, high availability, and multi-host deployments are more natural.

Disadvantages:

- requires provisioning, credentials, a separate process, and its own upgrade strategy;
- raises the barrier for personal and fully offline installations;
- makes packaging, backup, and cross-platform support more expensive before measurements require it;
- does not remove the need to normalize the domain and centralize writes.

Outcome: not selected as the default. PostgreSQL is the preferred candidate for a future optional adapter after the repository and contract tests exist.

### Use JSONL or one file per session as canonical storage

Advantages:

- easy to inspect;
- inexpensive append;
- straightforward backup when files are quiescent.

Disadvantages:

- atomic transactions across history, ACL, activity, and outbox become a custom protocol;
- update, deletion, deduplication, and referential integrity require additional indexes and recovery logic;
- many files and concurrent writers complicate portability and consistency.

Outcome: rejected for operational state. JSONL remains the presentation of the transactional structured log.

### Split canonical subsystems across SQLite databases

Advantages:

- more isolated files and locks;
- independent backup or pruning.

Disadvantages:

- robust crash-atomic commits across files are not available in every relevant SQLite mode and failure condition;
- dual-write, activity, logging, and outbox could diverge;
- ACL and causal deletion would require a local distributed-transaction protocol.

Outcome: rejected for canonical sources. Only rebuildable indexes live in separate databases.

## Consequences

### Positive consequences

- Appending a turn no longer scales with the whole transcript.
- Sessions and history become keyset-pageable through B-tree indexes.
- Messages, tools, files, and child sessions gain stable identities and deep links.
- Context compaction and retention no longer delete canonical history.
- ACL, domain events, and search outbox can commit atomically with the source.
- The server remains a single offline-capable installation with no external database.
- Search indexes can be deleted and rebuilt without data loss.
- The repository creates a concrete seam for a future PostgreSQL adapter.

### Negative consequences and costs

- The beta writes both legacy and v2 models, temporarily increasing write amplification.
- SQLite still has one physical writer; slow transactions can create contention.
- Relational rows and raw envelopes require strict versioning and contract tests.
- The artifact store, orphan collection, and coordinated backup add a new lifecycle.
- Backfill cannot recover data already removed by legacy compaction or retention.
- Legacy triggers detect drift but do not make an old binary aware of v2.
- `synchronous = FULL` may increase commit latency and must be measured on target datasets.

### Risks and required mitigations

| Risk | Required mitigation |
|---|---|
| A writer bypasses the repository | Instrument direct writes and fail tests; use one logical write queue |
| Backfill overwrites newer data | Source hash/version, conditional upsert, and requeue |
| Downgrade creates v2 drift | Legacy triggers, writer epoch, boot audit, and shadow reconciliation |
| Legacy ownership is ambiguous | Apply `installation_shared` only to versioned installation-wide automation definitions/runs with `legacy_unattributed` provenance; quarantine every other ambiguous record |
| A raw envelope contains secrets | Protect canonical detail with ACL; redact only indexes and logs |
| Artifact metadata and bytes diverge | Rename-before-link, storage state, hash verification, and safety-window orphan GC |
| The outbox grows without bound | Durable consumer checkpoints; prune below the minimum checkpoint; rebuild from canonical data |
| WAL or migration locking stalls startup | Bounded timeouts, metrics, leader recovery, and fail-fast before secondary writers |

## Acceptance criteria

This decision is ready for implementation only when the project has:

- repository contract tests for append, retry, reconnect, cancellation, and crash recovery;
- fault injection between every logical write boundary;
- shadow parity for complete records and explicit reports for inferred or partial records;
- downgrade/re-upgrade tests that create, update, and delete legacy sessions;
- cross-tenant ACL and revocation tests before ranking and snippet generation;
- backup, `integrity_check`, artifact verification, and restore rehearsal;
- recorded benchmarks for write scaling, history, lock wait, and backfill;
- recovery tests for the outbox, JSONL exporter, and index rebuild.

## Review criteria

Review this decision, without automatically changing the default, when at least one of these conditions holds:

1. agreed write or history SLOs remain unmet after normalization, indexing, and batching;
2. supported workloads exhaust lock retries or exceed the commit-latency budget;
3. active writers on multiple hosts or local-leader-free high availability becomes a supported requirement;
4. backup or checkpoint duration no longer fits the accepted operational window;
5. a real deployment requires replication, failover, or tenant isolation that a single-host SQLite design cannot provide;
6. measured operational cost is dominated by SQLite-specific workarounds;
7. a PostgreSQL adapter passes the same contract, migration, rollback, and SLO tests without weakening the self-hosted baseline.

Row count alone is not a sufficient trigger. Review uses recorded datasets, hardware, profiles, and failure rates rather than an abstract preference for another engine.

Review MongoDB only if a concrete document-storage requirement cannot be met by normalized rows plus raw envelopes and can preserve transactions, ACL, and self-hosting.

## Out of scope

- the operational FTS schema;
- merging vault and transcript search;
- semantic search;
- final history/search APIs and UX;
- an implemented PostgreSQL backend;
- removal of `sessions.runs`;
- final retention for raw event payloads;
- any beta tag or release.

## Assumptions and open gaps

- Validate the versioned mapping that recognizes historically installation-wide
  automation definitions/runs; every non-matching ownerless legacy record must
  remain quarantined.
- Inventory every runtime/provider shape and version the raw-envelope contract.
- Define inline-size limits and encryption-at-rest policy for sensitive artifacts.
- Define retention and legal hold for `domain_events`, JSONL, and artifacts.
- Confirm the minimum SQLite version shipped on every supported platform.
- Design query snapshots and the operational-search DDL as a separate artifact.
- Prove that `synchronous = FULL` meets the write budget. Any weaker durability policy requires an explicit ADR amendment.
