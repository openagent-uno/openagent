# ADR-003: Separate operational full-text search index

- Status: Accepted for beta; implementation present, security and performance gates pending
- Date: 2026-08-26
- Decision owners: OpenAgent maintainers
- Related plan: [Unified history, storage, and global search beta](../plans/unified-history-storage-search-beta.md)

## Context

OpenAgent needs one global search surface for chats, tool invocations, workflows,
scheduled tasks, and events, including text found inside messages, execution traces,
tool arguments, tool results, and errors. The current client can search only already
loaded chat summaries, while existing transcript and Memory Vault indexes have
different ownership, freshness, and lifecycle rules.

Putting all raw operational data directly into one FTS table would make search easy
to implement but unsafe: tool calls and event payloads routinely contain secrets,
headers, signed URLs, private paths, or high-entropy values. Reusing the Memory Vault
index would also confuse curated, Git-backed knowledge with chronological operational
history and violate their different canonical-source rules.

## Decision

### 1. Use a separate, derived SQLite FTS5 database

The first beta uses `operational_search_<source-fingerprint>.db` as the default local
search backend. It is:

- derived from normalized canonical records;
- safe to delete and rebuild;
- separate from `openagent.db` so index rebuilds do not hold long write locks on the
  canonical store;
- separate from `vault_index_*.db` and any semantic/vector cache;
- owned by one index worker per canonical database;
- protected with the same local file permissions as canonical state.

The reference schema is `architecture/operational-search-v1.sql`. It keeps
`trusted_schema=OFF`. Searchable safe text is stored in a normal contentful FTS5
table; bounded chunk metadata lives in a relational table with the same rowids. The
index owner mutates both explicitly in one transaction. This avoids invoking a
virtual table from a trigger, which supported hardened SQLite builds reject when the
schema is untrusted. A generation can become ready only after the verifier proves
that the FTS and metadata rowid sets are identical.

SQLite FTS5 preserves the offline, self-hosted, zero-configuration baseline. The
service checks FTS5 availability at startup and reports an explicit unsupported or
degraded capability; it must not silently fall back to an unbounded in-memory scan.

### 2. Keep operational and Memory Vault search as separate services

`OperationalSearchService` searches chronological operational history.
`VaultSearchService` searches Markdown notes whose canonical source is the vault and
Git history. They may share tokenization, ACL, health, and query primitives, but they
do not share a database, outbox, lifecycle, completeness flag, or result semantics.

The initial global-search capability exposes only these scopes:

- `chats`;
- `tools`;
- `workflows`;
- `scheduled`;
- `events`.

Memory is not included in `All` in the first beta. A future Memory scope requires an
explicit product decision and a cross-corpus ranking/pagination contract. Semantic
search is likewise deferred and must never be a hidden dependency for keyword search.

### 3. Feed the index through a transactional outbox

The canonical writer appends a `search_outbox` mutation in the same SQLite
transaction that changes history, ownership, ACL, or deletion state. The index worker
claims rows in sequence, extracts safe documents, writes the search database, and
then records the applied sequence idempotently.

The system tracks two independent values:

- `index_generation`: changes only when schema, tokenizer, extractor, ACL projection,
  or redaction semantics require a rebuild;
- `indexed_seq`: advances when an outbox mutation becomes searchable.

When the optional realtime capability is implemented and advertised,
`history_changed` is emitted after the canonical commit and `search_index_changed`
only after the corresponding outbox sequence has been applied. The beta remains
correct through bounded REST refreshes when these events are absent. A live update
does not invalidate an existing paginated search snapshot merely because
`indexed_seq` advanced.

Delete and ACL-revoke mutations have priority over ordinary upserts. Until the index
applies them, every candidate is reauthorized against the canonical database before
serialization, so stale derived data cannot be returned.

### 4. Index only a safe projection

Canonical content and indexed content have different schemas. Search documents keep
stable resource IDs, tenant/principal metadata, safe display metadata, completeness,
extractor/redaction versions, and one or more safe text chunks. They do not become a
backup or reconstruction source for canonical history.

Default searchable content includes:

- user-visible titles, descriptions, prompts, messages, and errors;
- tool name, server, status, and public identifiers;
- tool argument/result values only when a built-in extractor or explicit schema
  annotation marks the field searchable;
- workflow node labels and user-visible trace content;
- scheduled-task definitions and run transcripts;
- event definitions and downstream transcripts;
- event payload fields only when individually allowlisted.

Never-index content includes credentials, authorization headers, cookies, secrets,
private keys, provider-hidden reasoning, raw framework state, raw stack traces, raw
webhook bodies, binary/base64 content, and signed URLs.

Unknown tools are fail-closed. Their name, server, status, key names, public IDs,
types, and sizes may be indexed. Scalar values are excluded unless an approved schema,
annotation, or extractor identifies them as searchable. Denylists and entropy
detectors are defense in depth, not permission to index an otherwise unknown value.

Every safe document carries `extractor_version`, `redaction_version`, `source_version`,
`content_hash`, `sensitivity`, and `completeness`. A redaction or ACL-policy change that
could expose old content forces a new generation and rebuild, including destruction
of superseded raw transcript or semantic caches.

### 5. Authorize before limiting, counting, or serializing

The search database contains a derived tenant and ACL projection so unauthorized
candidates are excluded before ranking and `LIMIT`. The server then batch-loads the
canonical resources and rechecks each candidate with the shared `AccessResolver`
before returning snippets, counts, or targets.

The ACL projection has a composite `(document_rowid, tenant_id)` foreign key, so a
cross-tenant grant cannot be represented even in the derived cache.

Identity uses stable immutable principal IDs. Handles and names are safe display
snapshots only. The authenticated principal and on-behalf-of context are injected by
the server and cannot be selected in the query body.

Grouped `match_count`, coverage estimates, and corpus statistics returned to a caller
refer only to the authorized corpus. Timing side channels are minimized and tested,
but the product does not claim absolute elimination of all timing inference.

### 6. Use literal keyword search with stable query snapshots

The user query is treated as literal text by default. The API constructs the FTS
expression itself; it never passes raw user syntax directly to `MATCH`. Quoted phrases
may be supported through a small parser, while arbitrary FTS operators remain
unexposed.

Ranking prioritizes exact IDs/names, title prefixes and phrases, tool or workflow
labels, then BM25 body relevance with a bounded recency boost. One large category
must not monopolize the first page, but any category-balancing rule must be
deterministic and frozen in the query snapshot.

The first page materializes a short-lived query snapshot scoped to server, tenant,
principal, ACL version, normalized query, filters, sort, and `index_generation`.
Cursors point into that immutable ordered ID set. This guarantees stable pagination
while new outbox rows advance `indexed_seq`. Snapshot IDs and cursors are opaque,
authenticated, bounded in size, and deleted on TTL or logout.

A revoke or delete can remove a hit from an existing snapshot after canonical
reauthorization. The API may therefore return fewer items than the requested page
size; it continues scanning authorized snapshot candidates to fill the page where
possible and never leaks that a hidden candidate existed.

### 7. Require a resolvable typed target; capability-gate detailed anchors

Every indexed document kind has a typed `SearchTarget` and an endpoint/client resolver
that opens the exact authorized canonical destination represented by its required IDs.
For chat-message and chat-tool targets, that includes the matching message or tool
invocation. For the first beta, workflow, scheduled, and event targets guarantee the
correct definition root or concrete run/delivery, but do not claim that the matching
node, definition field, trace step, or nested tool is known. All nine target kinds stay
enabled under that root/run contract.

`detail_resolvers.definition_field_anchors` is therefore `false` in the beta contract.
The optional node/field/step members remain forward-compatible wire fields, not a beta
navigation promise. Exact automation sub-target anchors require separately projected
match provenance plus resolver, stale-target, authorization, and end-to-end evidence
before that capability can become `true`; they do not gate root/run search.

Search returns snippets as structured text/highlight fragments, not trusted HTML.
The client renders them as text, supports Unicode grapheme boundaries, and does not
reparse Markdown or tool output as executable markup.

## Invariants

The implementation must demonstrate that:

- deleting the search database and replaying canonical state produces equivalent
  authorized results for the same extractor/redaction versions;
- no forbidden test secret is present anywhere in search database bytes, WAL, or
  superseded cache files;
- unauthorized documents cannot influence returned snippets, counts, or page limits;
- an outbox row is applied at least once but produces one final document version;
- relational chunk and FTS rowid sets are identical at every promoted generation;
- query pagination has no duplicates or gaps within a live snapshot;
- advancing `indexed_seq` does not cause routine `cursor_stale` errors;
- a generation change invalidates incompatible snapshots explicitly;
- every returned target opens the exact authorized canonical record;
- index warm-up and partial coverage never masquerade as a complete empty result.

## Alternatives considered

### Query normalized tables with `LIKE`

Rejected as the primary search path. It avoids an index database but cannot provide
acceptable ranked search and snippets across large heterogeneous transcripts.

### Put FTS virtual tables inside `openagent.db`

Deferred. This is simpler transactionally, but rebuild and optimization operations can
increase lock contention and canonical database size. The outbox gives the separate
index an explicit consistency contract.

### Reuse the Memory Vault FTS database

Rejected. Vault notes and operational history have different canonical sources,
authorization, lifecycle, freshness, evidence, and deletion semantics.

### Make MongoDB or a hosted search service mandatory

Rejected. Either would break the zero-configuration local baseline without first
showing that normalized SQLite plus FTS5 fails measured SLOs. The repository and API
boundaries leave room for an optional client/server backend later.

### Add semantic/vector search in the first beta

Rejected for the initial capability. It expands privacy, tenancy, egress, ranking,
model lifecycle, and pagination requirements before reliable keyword search exists.

## Consequences

Positive consequences:

- fast local full-text search without a required external service;
- clear separation between canonical bytes and redacted searchable text;
- independent rebuild, tokenizer, and schema evolution;
- one API contract for UI, CLI, and agent-side operational recall;
- Memory Vault semantics remain intact.

Costs and risks:

- search is asynchronously consistent with canonical history;
- every searchable kind needs a maintained extractor and target resolver;
- a second SQLite database consumes disk and requires lifecycle coordination;
- query snapshots require bounded server-side state;
- safe extraction of arbitrary tool output remains intentionally incomplete.

## Criteria for revisiting the backend

An optional PostgreSQL or dedicated search backend should be evaluated only after
benchmarks show the SQLite design misses agreed SLOs on representative hardware and
corpora despite normalization, WAL tuning, bounded transactions, chunking, and index
maintenance. Relevant triggers include sustained write contention, unacceptable
rebuild time, corpus size beyond local disk expectations, or a real multi-process /
multi-node deployment requirement.

MongoDB is not the default next step: the decision must compare measured workload
needs against PostgreSQL full-text/search extensions and dedicated search systems,
including operational cost, backup, portability, and offline behavior.

## Follow-up work

- validate the reference operational-search DDL and tokenizer/prefix options through
  the benchmark harness;
- freeze the OpenAPI schema and TypeScript target union;
- complete the search threat model and redaction fixture corpus;
- define snapshot TTL, maximum candidate count, and per-principal quotas;
- benchmark keyword latency, rebuild time, disk amplification, and writer contention;
- specify the future Memory integration as a separate ADR if it is pursued.
