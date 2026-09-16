/**
 * Canonical client wire types for the unified history/search beta.
 *
 * Keep this module in lockstep with openagent-docs/api/search-target.ts.
 * JSON field names intentionally remain snake_case; route/view adapters are
 * the only places allowed to convert them to client-facing camelCase names.
 */

export type OpaqueId = string;
export type OpaqueCursor = string;
export type Revision = string;
export type Sequence = number;
export type IsoDateTime = string;
export type NonEmptyArray<T> = [T, ...T[]];

export const ACTIVITY_KINDS = [
  'chat',
  'delegated_session',
  'workflow_run',
  'scheduled_run',
  'event_delivery',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const SEARCH_SCOPES = [
  'chats',
  'tools',
  'workflows',
  'scheduled',
  'events',
  'views',
] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export type ActivityParentKind = 'session' | 'workflow' | 'scheduled_task' | 'event';
export type SearchSort = 'relevance' | 'recent';
export type SearchGrouping = 'root' | 'match';
export type SearchQueryMode = 'keyword';
export type SearchState = 'unavailable' | 'warming' | 'ready' | 'degraded';
export type StoragePhase = 'legacy' | 'shadow' | 'prefer_v2' | 'v2';
export type RunStatus =
  | 'pending'
  | 'queued'
  | 'received'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'interrupted'
  | 'skipped'
  | 'timed_out';
export type Completeness =
  | 'complete'
  | 'partial'
  | 'legacy_compacted'
  | 'malformed_source'
  | 'unknown';
export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'cancelled' | 'failed';
export type Sensitivity = 'safe' | 'redacted';
export type AuthorKind = 'user' | 'agent' | 'system';

export const SEARCH_TARGET_KINDS = [
  'chat',
  'chat_message',
  'chat_tool',
  'workflow_definition',
  'workflow_run',
  'scheduled_definition',
  'scheduled_run',
  'event_definition',
  'event_delivery',
  'ui_view',
] as const;
export type SearchTargetKind = (typeof SEARCH_TARGET_KINDS)[number];

export type SearchRootKind =
  | 'chat'
  | 'delegated_session'
  | 'workflow_definition'
  | 'workflow_run'
  | 'scheduled_definition'
  | 'scheduled_run'
  | 'event_definition'
  | 'event_delivery'
  | 'ui_view';

export type SearchMatchKind =
  | 'title'
  | 'description'
  | 'prompt'
  | 'message'
  | 'tool_name'
  | 'tool_args'
  | 'tool_result'
  | 'error'
  | 'workflow_step'
  | 'static_text';

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'target_not_found'
  | 'cursor_stale'
  | 'unsupported'
  | 'warming'
  | 'degraded'
  | 'conflict'
  | 'request_too_large'
  | 'unprocessable_query'
  | 'rate_limited'
  | 'internal_error';

export interface ApiErrorDetails {
  reason?: 'expired' | 'generation_changed' | 'acl_changed' | 'filter_mismatch' | 'invalid_signature' | 'snapshot_missing';
  retry_after_ms?: number;
  [key: string]: unknown;
}

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  request_id?: string | null;
  details?: ApiErrorDetails;
}

export interface HistoryFeature {
  version: 2;
  kinds: ActivityKind[];
  snapshot_pagination: true;
  max_page_size: number;
  /** Present only when the gateway actually emits incremental history events. */
  realtime_event?: 'history_changed';
}

export interface GlobalSearchFeature {
  version: 1;
  scopes: SearchScope[];
  sorts: SearchSort[];
  query_modes: SearchQueryMode[];
  tool_content: 'redacted';
  targets: SearchTargetKind[];
  snapshot_pagination: true;
  max_page_size: number;
  /** Present only when the gateway actually emits search-index invalidations. */
  realtime_event?: 'search_index_changed';
}

export interface SessionMessagesFeature {
  version: 1;
  around: true;
  bidirectional: true;
  max_page_size: number;
}

export interface SessionRelatedRunsFeature {
  version: 1 | 2;
  kinds: SessionRelatedRunKind[];
  include_descendants?: boolean;
  snapshot_pagination: true;
  max_page_size: number;
}

export interface SessionDescendantsFeature {
  version: 1;
  max_depth: number;
  snapshot_pagination: true;
  max_page_size: number;
}

export interface DetailResolversFeature {
  version: 1;
  tool_invocation: boolean;
  workflow_run: boolean;
  scheduled_run: boolean;
  event_delivery: boolean;
  definition_field_anchors: boolean;
}

export interface CapabilitiesResponse {
  api_revision: number;
  features: {
    /** Operational features are omitted until their backing projection is ready. */
    history?: HistoryFeature;
    global_search?: GlobalSearchFeature;
    session_messages?: SessionMessagesFeature;
    session_related_runs?: SessionRelatedRunsFeature;
    session_descendants?: SessionDescendantsFeature;
    detail_resolvers?: DetailResolversFeature;
  };
  storage: {
    phase: StoragePhase;
    schema_version: number;
    /** False while canonical history v2 is still bootstrapping. */
    history_ready: boolean;
    /** Legacy session or automation changes still awaiting projection. */
    history_pending: number;
    search_state: SearchState;
    search_ready: boolean;
    index_generation: Revision;
    indexed_seq: Sequence;
  };
}

export interface ActivityParent {
  kind: ActivityParentKind;
  id: OpaqueId;
  title: string;
}

export interface ActivityItem {
  id: OpaqueId;
  kind: ActivityKind;
  resource_id: OpaqueId;
  title: string;
  status?: RunStatus | null;
  origin?: string | null;
  occurred_at: IsoDateTime;
  updated_at: IsoDateTime;
  parent?: ActivityParent | null;
  session_id?: OpaqueId | null;
  downstream?: {
    session_id?: OpaqueId | null;
    workflow_run_id?: OpaqueId | null;
    scheduled_run_id?: OpaqueId | null;
  } | null;
  live: boolean;
  completeness: Completeness;
}

export interface HistoryQuery {
  kinds?: ActivityKind[];
  status?: RunStatus[];
  origin?: string;
  parent_type?: ActivityParentKind;
  parent_id?: OpaqueId;
  from?: IsoDateTime;
  to?: IsoDateTime;
  include_children?: boolean;
  limit?: number;
  cursor?: OpaqueCursor;
}

export interface HistoryPage {
  items: ActivityItem[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  revision: Revision;
  snapshot: {
    snapshot_id: OpaqueId;
    revision: Revision;
    expires_at: IsoDateTime;
  };
}

export type SessionRelatedRunKind = 'workflow_run' | 'scheduled_run' | 'event_delivery';

/** Compact causal run edge resolved from normalized tool invocations. The
 * server may add downstream ids for event deliveries; clients intentionally
 * ignore unknown additive fields. */
export interface SessionRelatedRunItem {
  id: OpaqueId;
  kind: SessionRelatedRunKind;
  resource_id: OpaqueId;
  title: string;
  status?: RunStatus | null;
  origin?: string | null;
  started_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
  updated_at: IsoDateTime;
  parent?: ActivityParent | null;
  session_id?: OpaqueId | null;
  live: boolean;
  caused_by: {
    tool_invocation_id: OpaqueId;
    session_id?: OpaqueId;
    session_depth?: number;
    tool_call_id?: OpaqueId | null;
    tool_server?: string | null;
    tool_name: string;
    status: string;
    created_at: IsoDateTime;
    count: number;
  };
}

export interface SessionRelatedRunsPage {
  session_id: OpaqueId;
  include_descendants?: boolean;
  items: SessionRelatedRunItem[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  revision: Revision;
  snapshot: {
    snapshot_id: OpaqueId;
    revision: Revision;
    expires_at: IsoDateTime;
  };
}

export interface SessionDescendantItem {
  session_id: OpaqueId;
  parent_session_id?: OpaqueId | null;
  lineage_redacted: boolean;
  depth: number;
  title?: string | null;
  session_type: string;
  kind: string;
  origin?: string | null;
  model?: string | null;
  framework?: string | null;
  status: string;
  completeness: Completeness;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  last_active_at: IsoDateTime;
}

export interface SessionDescendantsPage {
  session_id: OpaqueId;
  items: SessionDescendantItem[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  revision: Revision;
  snapshot: {
    snapshot_id: OpaqueId;
    revision: Revision;
    expires_at: IsoDateTime;
  };
}

export interface SearchRootRef {
  kind: SearchRootKind;
  id: OpaqueId;
}

export interface SearchFilters {
  status?: RunStatus[];
  from?: IsoDateTime | null;
  to?: IsoDateTime | null;
  parent_type?: ActivityParentKind | null;
  parent_id?: OpaqueId | null;
  origin?: string | null;
  root?: SearchRootRef | null;
}

export interface SearchRequest {
  query: string;
  scopes: NonEmptyArray<SearchScope>;
  filters: SearchFilters;
  sort: SearchSort;
  grouping: SearchGrouping;
  limit: number;
  cursor: OpaqueCursor | null;
}

export interface SearchRoot {
  kind: SearchRootKind;
  id: OpaqueId;
  title: string;
  status?: RunStatus | null;
  occurred_at: IsoDateTime;
  session_id?: OpaqueId | null;
  parent?: ActivityParent | null;
  completeness: Completeness;
}

export interface HighlightFragment {
  text: string;
  highlight: boolean;
}

export interface EventCause {
  kind: 'event_delivery';
  event_id: OpaqueId;
  delivery_id: OpaqueId;
  title: string;
}

export interface ChatTarget {
  kind: 'chat';
  session_id: OpaqueId;
}
export interface ChatMessageTarget {
  kind: 'chat_message';
  session_id: OpaqueId;
  message_id: OpaqueId;
}
export interface ChatToolTarget {
  kind: 'chat_tool';
  session_id: OpaqueId;
  message_id: OpaqueId;
  tool_invocation_id: OpaqueId;
}
export interface WorkflowDefinitionTarget {
  kind: 'workflow_definition';
  workflow_id: OpaqueId;
  node_id?: OpaqueId;
  field?: string;
}
export interface WorkflowRunTarget {
  kind: 'workflow_run';
  run_id: OpaqueId;
  workflow_id: OpaqueId;
  trace_step_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}
export interface ScheduledDefinitionTarget {
  kind: 'scheduled_definition';
  task_id: OpaqueId;
  field?: 'name' | 'prompt' | 'schedule';
}
export interface ScheduledRunTarget {
  kind: 'scheduled_run';
  run_id: OpaqueId;
  task_id: OpaqueId;
  session_id?: OpaqueId;
  message_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}
export interface EventDefinitionTarget {
  kind: 'event_definition';
  event_id: OpaqueId;
  field?: string;
}
export interface EventDeliveryTarget {
  kind: 'event_delivery';
  delivery_id: OpaqueId;
  event_id: OpaqueId;
  session_id?: OpaqueId;
  message_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}
export interface UIViewTarget {
  kind: 'ui_view';
  view_id: OpaqueId;
}

export type SearchTarget =
  | ChatTarget
  | ChatMessageTarget
  | ChatToolTarget
  | WorkflowDefinitionTarget
  | WorkflowRunTarget
  | ScheduledDefinitionTarget
  | ScheduledRunTarget
  | EventDefinitionTarget
  | EventDeliveryTarget
  | UIViewTarget;

export type EventDownstreamTarget =
  | ChatTarget
  | ChatMessageTarget
  | ChatToolTarget
  | WorkflowRunTarget
  | ScheduledRunTarget;

export interface SearchMatch {
  kind: SearchMatchKind;
  id: OpaqueId;
  field: string;
  author?: {
    kind: AuthorKind;
    principal_id?: OpaqueId | null;
    handle?: string | null;
    display?: string | null;
  } | null;
  occurred_at: IsoDateTime;
  fragments: NonEmptyArray<HighlightFragment>;
  sensitivity: Sensitivity;
  completeness: Completeness;
  target: SearchTarget;
}

export interface SearchResult {
  result_id: OpaqueId;
  root: SearchRoot;
  matches: [SearchMatch] | [SearchMatch, SearchMatch];
  match_count: number;
  target: SearchTarget;
  caused_by?: EventCause | null;
}

export interface SearchCoverage {
  state: SearchState;
  complete: boolean;
  indexed_documents: number;
  estimated_total: number;
  pending: number;
  indexed_through: IsoDateTime | null;
  lag_ms: number;
  last_error: string | null;
  per_corpus: Partial<Record<SearchScope, {
    complete: boolean;
    indexed_documents: number;
    estimated_total: number;
    pending: number;
    lag_ms: number;
  }>>;
}

export interface SearchPage {
  items: SearchResult[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  snapshot: {
    search_session_id: OpaqueId;
    index_generation: Revision;
    indexed_seq: Sequence;
    expires_at: IsoDateTime;
  };
  index_generation: Revision;
  indexed_seq: Sequence;
  coverage: SearchCoverage;
  query_mode: SearchQueryMode;
}

export type SessionMessagesQuery =
  | { around: OpaqueId; before?: number; after?: number }
  | { cursor: OpaqueCursor; direction: 'before' | 'after'; limit?: number }
  | { limit?: number };

/** Compact invocation metadata embedded in a normalized transcript page.
 * Arguments and results intentionally remain behind the authorized detail
 * resolver so opening a chat never duplicates or renders a large tool blob. */
export interface ToolInvocationSummary {
  id: OpaqueId;
  tool_call_id?: OpaqueId | null;
  tool_server?: string | null;
  tool_name: string;
  /** Safe inner identity when ``tool_name`` is the deferred dispatcher.
   * Invocation arguments/results remain on the authorized detail endpoint. */
  effective_tool_server?: string | null;
  effective_tool_name?: string | null;
  status:
    | 'pending'
    | 'running'
    | 'success'
    | 'completed'
    | 'error'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'timed_out';
  child_run_id?: OpaqueId | null;
  child_session_id?: OpaqueId | null;
  /** ACL-checked canonical run link for historical launcher cards. This is
   * deliberately identifier-only: tool arguments/results remain private. */
  run_target?: {
    kind: 'task' | 'workflow' | 'event';
    run_id: OpaqueId;
    parent_id?: OpaqueId | null;
  } | null;
  completeness?: Completeness;
}

export interface SessionMessage {
  id: OpaqueId;
  session_id: OpaqueId;
  run_id?: OpaqueId | null;
  ordinal: number;
  role: 'user' | 'assistant' | 'tool' | 'compaction';
  status: MessageStatus;
  author: {
    kind: AuthorKind;
    principal_id?: OpaqueId | null;
    handle?: string | null;
    display?: string | null;
  };
  text: string;
  visible_reasoning?: string | null;
  tool_invocation_id?: OpaqueId | null;
  tool_summary?: ToolInvocationSummary | null;
  attachments?: {
    artifact_id: OpaqueId;
    artifact_link_id?: OpaqueId;
    kind: 'image' | 'file' | 'voice' | 'video';
    filename: string;
    mime?: string;
    mime_type?: string;
    size_bytes?: number;
    sha256?: string;
    url?: string;
  }[];
  /** Additive ordered response parts. Beta gateways may use either the final
   * kind/snake_case envelope or the early type/camelCase alias. */
  parts?: unknown[];
  artifacts?: unknown[];
  created_at: IsoDateTime;
  completeness: Completeness;
}

export interface SessionMessagePage {
  session_id: OpaqueId;
  messages: SessionMessage[];
  anchor_found: boolean | null;
  anchor_message_id?: OpaqueId | null;
  before_cursor: OpaqueCursor | null;
  after_cursor: OpaqueCursor | null;
  has_more_before: boolean;
  has_more_after: boolean;
  revision: Revision;
}

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | SafeJsonValue[]
  | { [key: string]: SafeJsonValue };

export interface ToolInvocationDetail {
  id: OpaqueId;
  tool_call_id?: OpaqueId | null;
  root_kind: 'chat' | 'delegated_session' | 'workflow_run' | 'scheduled_run' | 'event_delivery';
  root_id: OpaqueId;
  session_id?: OpaqueId | null;
  message_id?: OpaqueId | null;
  workflow_run_id?: OpaqueId | null;
  trace_step_id?: OpaqueId | null;
  scheduled_run_id?: OpaqueId | null;
  event_delivery_id?: OpaqueId | null;
  tool_server?: string | null;
  tool_name: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  args_safe: SafeJsonValue;
  result_safe: SafeJsonValue;
  error_safe: string | null;
  child_session_id?: OpaqueId | null;
  sensitivity: Sensitivity;
  completeness: Completeness;
  artifacts: { id: OpaqueId; kind: string; filename: string; mime: string; size_bytes: number }[];
  created_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
}

export interface WorkflowRunDetail {
  id: OpaqueId;
  workflow_id: OpaqueId;
  title: string;
  status: RunStatus;
  trigger?: string | null;
  trace_steps: {
    id: OpaqueId;
    node_id: OpaqueId;
    attempt: number;
    type: string;
    status: RunStatus;
    child_session_id?: OpaqueId | null;
    error_safe?: string | null;
    started_at: IsoDateTime;
    finished_at?: IsoDateTime | null;
    tool_invocation_ids: OpaqueId[];
  }[];
  started_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
  completeness: Completeness;
}

export interface ScheduledRunDetail {
  id: OpaqueId;
  task_id: OpaqueId;
  title: string;
  status: RunStatus;
  trigger?: string | null;
  session_id?: OpaqueId | null;
  output_summary_safe?: string | null;
  error_safe?: string | null;
  caused_by?: EventCause | null;
  started_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
  completeness: Completeness;
}

export interface EventDeliveryDetail {
  id: OpaqueId;
  event_id: OpaqueId;
  title: string;
  status: RunStatus;
  source: string;
  session_id?: OpaqueId | null;
  downstream_target?: EventDownstreamTarget | null;
  error_safe?: string | null;
  occurred_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
  completeness: Completeness;
}

interface HistoryChangedEventBase {
  type: 'history_changed';
  revision: Revision;
  activity_id: OpaqueId;
  kind: ActivityKind;
  resource_id: OpaqueId;
}

export type HistoryChangedEvent =
  | (HistoryChangedEventBase & { action: 'upsert'; item: ActivityItem })
  | (HistoryChangedEventBase & { action: 'delete'; item?: null });

export interface SearchIndexChangedEvent {
  type: 'search_index_changed';
  index_generation: Revision;
  indexed_seq: Sequence;
}

export type OperationalRealtimeEvent = HistoryChangedEvent | SearchIndexChangedEvent;
