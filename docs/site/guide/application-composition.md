# Composable applications

**Architecture requirement, recorded 16 October 2026.** OpenAgent must support
composing persistent, interactive applications from independently supplied
tools, data sources and UI components. Multiple accounts of one provider and
multiple providers must be usable in the same application. This document
defines the extension boundaries and acceptance criteria; it does not announce
a shipped application framework or implement the reference applications.

The reference cases are a calendar over several accounts, a task tracking
system, and document management over several filesystems with editing. They
test the architecture's generality. Their provider tools and domain behavior
remain independent integrations; none is required by Core or added by this
decision.

## Composition and ownership

An application assembles a versioned definition, data bindings, actions, views
and lifecycle policy. It can be created by a developer or an authorized agent.
Its ordinary interactions must execute deterministically without requiring a
model turn for every click, keystroke, refresh or synchronization step. Agent
reasoning remains available when the interaction calls for it.

| Layer | Responsibility | Boundary |
| --- | --- | --- |
| Core | Verified execution context, authorization, capability discovery and dispatch, durable runs and optional modules | Public contracts; no dependency on a particular UI, provider or standalone identity |
| Tools and connectors | Provider/file operations, schemas, feature discovery and source-specific change semantics | Same adapters for every consuming host; no application layout or product accounts |
| Application services | Definitions, bindings, domain state, projections, action records and synchronization lifecycle | Host-owned storage and authorization; independently testable, optional services |
| Presentation | Component registry, navigation, responsive layout, forms, selections, editor buffers and accessibility | Typed data/action bridge; no provider tokens or direct privileged execution |
| Host | Authenticated identities, grants, secrets, storage, worker limits and installed component versions | Explicit construction and shutdown; no central OpenAgent account dependency |

This architecture places application services alongside the standalone's existing dashboards.
Embedding hosts can supply their own services and renderers using the same
public capability boundaries. Reusable services can be extracted into versioned
packages when their contracts are qualified. This decision adds no required
kernel module, source overlay, new central service or adopter-specific code.

```mermaid
flowchart LR
    Definition[Versioned application definition] --> Services[Host application services]
    UI[Responsive typed components] --> Services
    Services --> State[Host state and projections]
    Services --> Dispatch[Public capability dispatch]
    Dispatch --> A[Authorized source instance A]
    Dispatch --> B[Authorized source instance B]
    Changes[Source changes or bounded polling] --> Services
    Services --> UI
```

## Contracts to preserve

The following names describe architectural roles. They are not new configuration
keys, callable endpoints or a published wire schema.

### Application definition and component registry

A definition identifies its schema version, immutable revision, component
dependencies, required capabilities, named source slots, views, actions and
state migrations. It stores references to grants rather than credentials.
Importing a definition never imports another person's access. The receiving
host resolves each source slot with its own authorized configuration.

Components declare typed properties, outputs, interaction events and supported
renderer versions. Layout and data adapters are independent: changing a source
does not require rewriting a view, and changing a view does not change an
operation's permissions. Collections, relations, selection, navigation,
validation, drag operations and text editing must be expressible through
composable contracts rather than a fixed set of provider-specific screens.

The renderer registry must admit versioned extensions with explicit host
installation and compatibility checks. A portable subset must have defined
fallbacks when a renderer is unavailable. Responsive layouts retain access to
data and actions on narrow screens; keyboard operation, focus, loading, empty,
partial, stale and error states are part of the component contract. CLI and
non-graphical hosts use the same application services without pretending to
render a graphical editor.

Application definitions bind to renderer components and existing capabilities.
The desktop renderer can display a versioned interactive dashboard document in
a separate sandbox. The document receives only the dashboard data and declared
assets available to the viewer. New privileges still require the host's normal
authorization and confirmation policies. See [Interactive dashboards](#interactive-dashboards).

### Interactive dashboards

Add an `interactive` node to an existing OA-UI view and publish the HTML as
an immutable bundle asset. A document can contain HTML, CSS and JavaScript,
including locally bundled React/TypeScript, Three.js, WebGL, Canvas, SVG or a
charting library. Bundle dependencies at authoring time. Use HTML scripts or
declare additional bundle assets and load them through the document bridge.

```xml
<interactive src="asset:dashboard.html" title="Observatory" height="640"
  assets='["asset:scene.glb"]' />
```

```html
<canvas id="scene" width="640" height="320"></canvas>
<output id="total"></output>
<script>
  const gl = document.querySelector('#scene').getContext('webgl2')
  if (gl) {
    gl.clearColor(0.15, 0.32, 0.55, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  OpenAgent.onData(data => {
    document.querySelector('#total').textContent = data.total ?? 'Loading'
  })
</script>
```

Publish through `ui_create_view` with `assets_base64`, or the regular Custom
Views REST API. Live view data arrives through `OpenAgent.onData(listener)`
and updates the existing frame. `OpenAgent.asset(ref)` returns a Blob URL for
a declared asset and `OpenAgent.assetBytes(ref)` returns its bytes and MIME
type. `OpenAgent.import(ref)` loads a declared, self-contained JavaScript
module. Use `OpenAgent.onVisibility(listener)` to pause animations when the
screen loses focus. `OpenAgent.run(actionId, input)` requests a named view action and opens
the app's confirmation. Inline previews can display data and use local controls.

Each view supports up to four documents, with up to 2 MiB of HTML and up to
32 declared asset references per document. The desktop app isolates the frame
from renderer APIs, credentials and external network navigation. Browser and
mobile clients render the declarative components of the view and display a
desktop fallback for an interactive document.

### Source bindings and resources

A provider name is not a connection identity. Each binding resolves to a
specific installation, tenant, principal/grant, connection, executor and
resource scope. Two accounts of the same provider are distinct sources, as are
two computers exposing the same filesystem tool. Source slots and display
names never let an action substitute another account or device.

A resource reference preserves its source identity, provider-native identifier,
type and available version token. File references also preserve filesystem/root
identity; paths are interpreted only by their bound executor. Names and paths
alone are insufficient global identifiers. Copies across sources receive new
identities and explicit provenance rather than silently becoming one object.

Bindings declare schemas for reads, mutations, relationships, pagination,
changes and errors, and advertise which features are actually supported. The
application can compose typed projections while retaining source attribution
and domain semantics, such as time zones, ordering, text encoding or binary
content. It must not flatten every provider into a lossy universal record.
Unsupported features have explicit capability results and UI states.

Collection queries need typed filtering, sorting, pagination and bounded
incremental delivery, with their actual source limitations exposed. Large
collections and file contents must be loaded on demand rather than copied
wholesale into the model context or renderer. Query parameters cannot alter
the binding's identity or resource grant.

Combining sources does not combine their permissions. Reads, joins, search,
counts, exports and subscriptions must authorize both input resources and the
result audience. One authorized source cannot reveal another's contents or
metadata. Partial results identify unavailable sources only to an audience
already permitted to know those bindings.

### Actions and durable state

Every action binds its target source, validated input/output schemas, required
permissions, execution location, expected resource version and applicable
idempotency policy. The host resolves current capabilities at execution time;
persisted definitions never retain an expired opaque ToolRef or client lease.
UI, CLI and agent invocation converge on the same service and authorization
path. A read-only view does not imply permission to mutate its backing source.
Shared services do not automatically advertise App-only tools to other channels
or background runs; the host still selects and authorizes each surface.

State has separate lifecycles:

| State | Authority and persistence |
| --- | --- |
| Definition and view revision | Immutable, checksummed configuration with explicit migrations |
| Application-owned records | Durable host data with ACLs, versions, backup and recovery |
| Source projection/cache | Derived data with provenance, cursor, freshness and rebuild procedure |
| Pending mutation and outcome | Durable intent and reconciliation record; never a cache |
| UI state | Selection, navigation and drafts scoped to the user/device; durability declared explicitly |

Saving a view or publishing a new layout must not reset records, drafts or
synchronization checkpoints. Rebuilding a cache must not discard unsent edits.
A locally persisted projection is not evidence of a successful provider write.
Attachments use authorized content references rather than exposed host paths.

Actions that span providers are not a distributed atomic transaction. Each step
records its outcome; partial completion is visible and recovery or compensation
is explicit. Writes with an ambiguous outcome are reconciled before another
attempt. Provider-supported idempotency and conditional updates are used where
available; application code must not promise exactly-once external effects.

### Synchronization and background work

Synchronization is a lifecycle owned by the host application service, not by an
open chat transcript or a visible component. Each source/resource partition
has independent checkpoints, ordering/version semantics and health. Webhooks,
change streams and bounded polling are interchangeable only where the source's
declared contract permits it. One failed account does not block healthy ones.

The synchronization contract must specify initial pagination, incremental
updates, deletion/tombstones, duplicate and out-of-order delivery, cursor expiry,
full rescan, rate limits and restart recovery. Checkpoint advancement and local
projection changes commit consistently. Durable jobs deduplicate delivery and
bound retries, concurrency, memory, disk and retention. Idle sources must not
create a polling storm; subscriptions can share work only within compatible
authorization and resource boundaries.

Edits carry their observed revision or ETag. Concurrent changes produce a
documented source-specific merge, a conflict to resolve, or an explicit lack of
conditional-write support. There is no universal last-writer-wins policy and no
assumption that all sources support collaborative text editing. Offline drafts
and queued writes require declared support, reauthorization before execution
and reconciliation after reconnect.

An interactive device capability remains temporary. A background job cannot
reuse the last online computer or a saved client connection. Device-only work
waits for a new authorized interaction, or uses a separately configured durable
executor with its own grant. See [Client Computer Tools](./client-capabilities.md).

Revoking a connection stops new reads, writes and subscriptions for that grant.
Outstanding work and cached data follow explicit cancellation, retention and
privacy policy. A shared view cannot retain a revoked participant's access.
Operational logs record identities, versions, progress and outcomes without
copying credential values or document bodies.

## Existing foundations and remaining work

These observations describe the source inspected for this decision, not new
installed-product acceptance.

| Foundation in the current source | Architectural work still required |
| --- | --- |
| Public Core capability catalog, verified principals, exact executor binding and optional durable modules | Qualify application bindings and action dispatch against those public contracts |
| Product Custom Views: validated OA-UI v1, typed built-in components, immutable bundles and revisions, ACLs, source state and subscriptions | Versioned component extension and application-definition contracts; richer interactive renderer support |
| Static/push/file-watch/command data drivers; bounded commands and action schemas | Typed provider-source driver contract with per-account cursors and feature negotiation |
| View revision checks, expected-version data updates, data replace/merge/append and action-run idempotency records | Separate durable application records, draft policy and provider mutation reconciliation/conflict handling |
| Shared connector adapters and product-owned connection credentials | Multi-source application binding policy and explicit authorization of combined results |
| Authenticated artifact routes and immutable view references | Qualified editing/save lifecycle; artifact download alone does not provide document editing |

Existing `mcp_tool` dashboard actions name a server/tool and use the configured
MCP bridge; command actions use explicitly configured subprocesses. Neither is
evidence that a generic application action contract, provider synchronization
or versioned renderer plugin API is complete. Extending this path must converge
on public capability dispatch while preserving existing views, saved IDs,
permissions and the temporary App-origin boundary. Unknown definitions or
unsupported versions fail explicitly instead of silently changing behavior.

The current OA-UI `code` and `markdown` components display content. Their
existence does not establish an editor, save protocol or multi-filesystem
synchronization. Similarly, data-source updates and view subscriptions are not
proof of a durable bidirectional synchronization engine.

## Acceptance and implementation sequence

Future implementation proceeds through bounded contracts: source bindings and
action dispatch, durable state and reconciliation, renderer registration and
compatibility, then source-specific synchronization. Each can be delivered
independently without adding one of the reference applications to Core.

Qualification uses neutral fake sources and synthetic records before real
provider acceptance. It must establish:

- Two accounts of one adapter and a second adapter can supply one view without
  identifier collisions or accidental cross-account writes.
- Two views use the same service/state and independent UI selections; schema
  upgrades preserve data and reject unsupported component versions.
- Permissions and result audiences are checked for each binding, including
  derived data, offline drafts, revocation and resumed background work.
- Repeated/out-of-order changes, pagination, cursor expiry, missed events and
  a restart recover without lost records or duplicate external effects.
- A concurrent edit and an ambiguous write have observable conflict/recovery
  outcomes; a source outage leaves healthy sources usable with honest freshness.
- Different filesystem executors with identical paths remain distinct; editor
  drafts preserve encoding/version and never overwrite a changed file silently.
- Narrow and wide layouts, keyboard interaction and unavailable component/source
  states remain usable without requiring a model call per UI interaction.
- Disabling an optional module/source removes its execution surface, preserves
  host-owned data under policy and never falls back to another executor.

These are architecture acceptance gates. They do not assert that a calendar,
task tracking system or document editor has been implemented or qualified.


### Custom View revision integrity

Definition updates persist the immutable revision, sources and actions before
publishing its head in the same SQL transaction. The additive
`custom-views-revision-head-v1` ledger entry installs a database guard rejecting
head changes to absent revision rows, including writes outside the repository.
The original `custom-views-v1` migration checksum stays unchanged.

Reads always verify the exact selected revision and its bundle checksum. Missing
or damaged definitions return `ui_revision_unavailable` (REST 503, or the same
WebSocket error code), with a diagnostic-free recovery message. They never
silently display an older definition or execute its actions. ACL checks still
precede revision reads. This additive guard does not automatically change
historical data or prevent unrelated chat from starting. A host repairing old
heads must first back up affected rows, verify the replacement bundle and
preserve live data, ownership, grants and revision history.

A revision bundle is written before the transaction that records it. If that
transaction never commits, the next publish at the same revision number checks,
holding the database write lock, that no revision row references the leftover
bundle. It then replaces the leftover. A referenced bundle is never replaced:
the publish reports a revision conflict instead. Lock contention when opening
the write transaction returns `busy` to `ui-manager` tools and `ui_view_busy`
to REST (503). Both are retryable unchanged, and nothing was saved.
Every `ui-manager` failure carries `retryable`. Unexpected failures name only
their exception class, never the caller's data.

`ui_get_schema` returns `componentSchema`. For each component it lists
accepted properties, whether it is a container, whether it accepts text
content and the data shape the renderer reads. Pass `component` to get one
entry. Collection components accept `data` as an alias of their primary array,
as the renderer already does. OA-UI has no loop node: to show one panel per
record, author one card per record, bind a list or table to a source array,
or mount an `interactive` asset.
