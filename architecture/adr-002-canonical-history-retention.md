# ADR-002: Canonical operational history and retention

- Status: Accepted for beta; implementation present, migration and verification gates pending
- Date: 2026-08-26
- Decision owners: OpenAgent maintainers
- Related plan: [Unified history, storage, and global search beta](../plans/unified-history-storage-search-beta.md)

## Context

OpenAgent currently stores much of a session as a serialized run array. Updating a
turn can therefore require reading, parsing, and rewriting the whole transcript.
The same representation is also used both as durable user history and as model
context, even though those two products have different lifecycle requirements.

This creates four correctness problems:

1. model-context compaction or retention can destroy the user's canonical history;
2. messages, tool invocations, artifacts, and delegated runs do not always have
   stable, independently addressable identities;
3. partial streams and interrupted tool calls do not have a durable state protocol;
4. old or partially compacted records can be presented as complete when they are not.

The vision requires sessions to be durable and full-fidelity while memory remains a
separate, human-readable Markdown vault. Conversation history must therefore have a
canonical representation that is independent from both prompt construction and the
Memory Vault.

## Decision

### 1. Normalized records are the canonical v2 history

Once a session has passed shadow verification and the storage phase permits v2
reads, its canonical operational history consists of stable rows for:

- the session header;
- runs and attempts;
- messages and multimodal content parts;
- tool invocations and their state transitions;
- artifact references and immutable artifact objects;
- parent, child, delegation, workflow, scheduled-task, and event causality links;
- user-visible reasoning and provider metadata retained in versioned raw envelopes;
- context snapshots used only to build future model prompts.

Fields used for identity, authorization, filtering, ordering, joins, or lifecycle are
real columns. Forward-compatible or provider-specific data may remain in a versioned
raw envelope attached to the smallest applicable record; it must not recreate a
single mutable transcript blob.

The legacy `sessions.runs` representation remains a compatibility projection during
the beta rollback window. Its presence does not make it canonical after the storage
phase reaches `v2`.

### 2. History and model context have independent lifecycles

Canonical history is retained until one of these explicit events occurs:

- the user deletes it;
- an administrator applies a configured retention policy visible to the user;
- an artifact-specific retention policy expires an unreferenced object;
- a future, separately approved compliance policy requires deletion.

Prompt construction may summarize, truncate, or compact content into
`context_snapshots`. Those operations affect only what is sent to a model. They never
delete or overwrite canonical messages, tool invocations, visible reasoning, or
artifact references.

The default v2 policy is no destructive transcript TTL. Existing short retention or
"last N runs" behavior must not be carried forward as the silent default.

### 3. A turn follows a crash-durable state protocol

Every client submission has an idempotency key. The server follows this order:

1. validate authorization and resolve or create the session;
2. in one transaction, persist the user message as `complete`, create the run as
   `pending`, append the domain event and search-outbox entries, then acknowledge the
   accepted turn;
3. move the run to `running` before calling the provider;
4. create each assistant message with a stable ID and `streaming` state before
   exposing its first delta;
5. persist tool invocations as `pending`, then transition them through `running` and
   one wire terminal state (`success`, `error`, or `cancelled`); preserve the exact
   runtime state separately and acquire the full raw result before applying
   presentation caps;
6. periodically checkpoint visible assistant content without changing its identity;
7. atomically mark the final assistant message `complete` and its run `success`; on
   non-success, use the respective message and run enums from ADR-001 while retaining
   any visible partial content;
8. retrying the same idempotency key returns or resumes the same logical record and
   never creates a duplicate turn.

No WebSocket delta or client-visible tool state may exist only in memory. A process
crash may lose an unflushed presentation delta, but restart recovery must expose a
durable partial record with an honest terminal or recoverable state.

### 4. Fidelity is explicit and testable

Each migrated session and searchable record carries a `completeness` value:

- `complete`: the v2 writer captured the complete supported record;
- `partial`: known content was omitted by a configured budget or legacy source;
- `legacy_compacted`: the source had already discarded history;
- `malformed_source`: some legacy data could not be parsed;
- `unknown`: completeness has not yet been established.

Migration never invents missing content. UI and APIs surface non-complete coverage
where it affects user expectations. A session cannot switch to v2 reads until its
normalized order, identity, ownership, and content hashes pass shadow verification.

### 5. Large content uses immutable, content-addressed artifacts

Large tool results, attachments, and generated files are stored outside SQLite as
immutable objects addressed by a cryptographic digest. Canonical rows store metadata
and references. Object creation uses write-to-temporary, fsync, atomic rename, and a
transactional reference update.

Reference counts are treated as a derived optimization, not the sole source of
truth. A reconciliation job can recompute liveness from canonical references. An
object can be deleted only after a grace period, with no references, no migration
hold, and no legal/pin hold.

### 6. Deletes and retention are observable domain mutations

Deletion writes a canonical tombstone or domain event and a search-outbox delete in
the same transaction that removes or marks the resource. Derived activity and search
projections must stop serving the content immediately after canonical authorization
recheck, even if asynchronous physical cleanup has not finished.

Hard deletion of sensitive bytes, backup expiry, and artifact garbage collection may
be asynchronous, but their state and failure are observable. Backup retention is a
separate policy and must be disclosed to the operator.

### 7. Delegations remain first-class history

A durable delegated session is canonical and discoverable. It may be displayed nested
under its parent, but it is not erased or replaced by a nested `member_responses`
summary. When both exist, the durable child is authoritative and the nested structure
is a projection or link.

Child sessions created only to execute a workflow step, scheduled run, or event
delivery remain addressable but are grouped under that causal root to avoid duplicate
top-level activity cards.

## Invariants

The implementation and migration test suite must demonstrate that:

- one logical message, run, and tool invocation has one stable ID;
- order is deterministic using ordinal plus stable ID, never timestamp alone;
- a committed user message survives provider failure and process restart;
- content already shown to the user is recoverable as complete or partial history;
- compaction changes context snapshots but not canonical record counts or hashes;
- deleting or revoking a resource prevents it from appearing in new search responses;
- artifact collection cannot remove a still-referenced object;
- dual-write transaction fault injection cannot commit only one of legacy, v2,
  activity, domain event, or search outbox;
- historically installation-wide legacy workflow/scheduled/event definitions and
  runs retain that scope as `installation_shared` with
  `legacy_unattributed` provenance, while every other ambiguous ownerless record
  is quarantined rather than assigned by guesswork.

Wire compatibility is additive. Existing workflow-run and event-delivery detail
fields `started_at` and `finished_at` remain numeric Unix epoch seconds; ISO 8601
renderings are added as `started_at_iso`/`finished_at_iso`, with `occurred_at` serving
as the event delivery's additive ISO equivalent of `started_at`. The new scheduled-run
detail route may use ISO 8601 timestamps as its canonical representation. A wire field
never changes primitive type in place. Workflow trace steps publish only the canonical
attempt-level `id`; an adapter may ingest an old alias internally but the v2 schema
does not emit one.

## Alternatives considered

### Keep the serialized session blob as canonical

Rejected. It preserves compatibility but retains whole-transcript rewrites, weak
addressability, expensive filtering, and destructive coupling between context and
history.

### Store only presentation-ready text

Rejected. It loses structured tool state, provenance, multimodal parts, causality, and
provider data needed for future compatible readers.

### Store only provider-native raw envelopes

Rejected. Raw envelopes preserve bytes but do not provide a stable cross-provider
contract for authorization, ordering, filtering, deep links, or retention.

### Make event logs the canonical history

Deferred. An event-sourced core could reconstruct state, but it would substantially
expand migration and operational complexity. The beta keeps append-friendly domain
events for audit and projections while normalized tables remain the canonical read
model.

## Consequences

Positive consequences:

- history no longer grows the cost of every append linearly with transcript size;
- every search result can resolve to a stable record;
- model-context optimization cannot silently damage user history;
- interrupted work is visible and recoverable instead of disappearing;
- retention becomes an explicit product policy.

Costs and risks:

- writes touch more rows and require a single repository boundary;
- migrations must reconcile malformed and concurrently changing legacy blobs;
- immutable artifacts require garbage collection and backup coordination;
- full-fidelity history consumes more disk unless the user configures retention;
- provider-specific raw envelopes require versioning and privacy review.

## Rollout and rollback

The storage-phase state machine, backup, reconciliation, and binary-downgrade behavior
are defined in ADR-001 and the beta runbook. This ADR does not authorize destructive
legacy removal. `sessions.runs` can be removed only in a later, separately approved
migration after at least one stable release has used v2 successfully.

## Follow-up work

- implement and test the normalized/raw status mapping defined by ADR-001 without
  adding adapter-local wire aliases;
- set artifact inline/streaming thresholds from benchmarks;
- define user-visible retention controls and disk-usage estimates;
- define backup expiry and secure-erasure expectations per platform;
- add crash injection tests at every durable state transition.
