/**
 * Canonical TypeScript wire types for the unified-history/search beta API.
 *
 * Field names intentionally use snake_case to match JSON on the wire. Keep this
 * file in lockstep with `unified-history-search.openapi.yaml`; app-specific view
 * models may adapt these types but must not redefine SearchTarget.
 *
 * The first beta covers operational history only. Memory/vault search is a
 * separate capability and is intentionally absent from SearchScope.
 */

export type OpaqueId = string;
export type OpaqueCursor = string;
export type Revision = string;
export type Sequence = number;
export type IsoDateTime = string;
export type NonEmptyArray<T> = [T, ...T[]];

export const ACTIVITY_KINDS = [
  "chat",
  "delegated_session",
  "workflow_run",
  "scheduled_run",
  "event_delivery",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_PARENT_KINDS = [
  "session",
  "workflow",
  "scheduled_task",
  "event",
] as const;
export type ActivityParentKind = (typeof ACTIVITY_PARENT_KINDS)[number];

export const SEARCH_SCOPES = [
  "chats",
  "tools",
  "workflows",
  "scheduled",
  "events",
] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_SORTS = ["relevance", "recent"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_GROUPINGS = ["root", "match"] as const;
export type SearchGrouping = (typeof SEARCH_GROUPINGS)[number];

export const SEARCH_QUERY_MODES = ["keyword"] as const;
export type SearchQueryMode = (typeof SEARCH_QUERY_MODES)[number];

export const SEARCH_STATES = [
  "unavailable",
  "warming",
  "ready",
  "degraded",
] as const;
export type SearchState = (typeof SEARCH_STATES)[number];

export const STORAGE_PHASES = [
  "legacy",
  "shadow",
  "prefer_v2",
  "v2",
] as const;
export type StoragePhase = (typeof STORAGE_PHASES)[number];

export const RUN_STATUSES = [
  "pending",
  "queued",
  "received",
  "running",
  "success",
  "failed",
  "cancelled",
  "rejected",
  "interrupted",
  "skipped",
  "timed_out",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const COMPLETENESS_VALUES = [
  "complete",
  "partial",
  "legacy_compacted",
  "malformed_source",
  "unknown",
] as const;
export type Completeness = (typeof COMPLETENESS_VALUES)[number];

export const MESSAGE_STATUSES = [
  "streaming",
  "complete",
  "interrupted",
  "cancelled",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const SENSITIVITY_VALUES = ["safe", "redacted"] as const;
export type Sensitivity = (typeof SENSITIVITY_VALUES)[number];

export const SEARCH_TARGET_KINDS = [
  "chat",
  "chat_message",
  "chat_tool",
  "workflow_definition",
  "workflow_run",
  "scheduled_definition",
  "scheduled_run",
  "event_definition",
  "event_delivery",
] as const;
export type SearchTargetKind = (typeof SEARCH_TARGET_KINDS)[number];

export const SEARCH_ROOT_KINDS = [
  "chat",
  "delegated_session",
  "workflow_definition",
  "workflow_run",
  "scheduled_definition",
  "scheduled_run",
  "event_definition",
  "event_delivery",
] as const;
export type SearchRootKind = (typeof SEARCH_ROOT_KINDS)[number];

export const SEARCH_MATCH_KINDS = [
  "title",
  "description",
  "prompt",
  "message",
  "tool_name",
  "tool_args",
  "tool_result",
  "error",
  "workflow_step",
] as const;
export type SearchMatchKind = (typeof SEARCH_MATCH_KINDS)[number];

export const MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
  "compaction",
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const AUTHOR_KINDS = ["user", "agent", "system"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const TOOL_INVOCATION_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
] as const;
export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATUSES)[number];

export const CURSOR_STALE_REASONS = [
  "expired",
  "generation_changed",
  "acl_changed",
  "filter_mismatch",
  "invalid_signature",
  "snapshot_missing",
] as const;
export type CursorStaleReason = (typeof CURSOR_STALE_REASONS)[number];

export const API_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "target_not_found",
  "cursor_stale",
  "unsupported",
  "warming",
  "degraded",
  "conflict",
  "request_too_large",
  "unprocessable_query",
  "rate_limited",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetails {
  reason?: CursorStaleReason;
  retry_after_ms?: number;
  [key: string]: unknown;
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  request_id?: string | null;
  details?: ApiErrorDetails;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface HistoryFeature {
  version: 2;
  kinds: ActivityKind[];
  snapshot_pagination: true;
  max_page_size: number;
  /** Optional; subscribe only when the authenticated server advertises it. */
  realtime_event?: "history_changed";
}

export interface GlobalSearchFeature {
  version: 1;
  /** Exact global-search v1 scope contract: all five entries, once each. */
  scopes: typeof SEARCH_SCOPES;
  sorts: SearchSort[];
  query_modes: SearchQueryMode[];
  tool_content: "redacted";
  /** Exact global-search v1 target contract: all nine entries, once each. */
  targets: typeof SEARCH_TARGET_KINDS;
  snapshot_pagination: true;
  max_page_size: number;
  /** Optional; subscribe only when the authenticated server advertises it. */
  realtime_event?: "search_index_changed";
}

export interface SessionMessagesFeature {
  version: 1;
  around: true;
  bidirectional: true;
  max_page_size: number;
}

export interface DetailResolversFeature {
  version: 1;
  tool_invocation: boolean;
  workflow_run: boolean;
  scheduled_run: boolean;
  event_delivery: boolean;
  /** False in beta: automation search guarantees root/run resolution only. */
  definition_field_anchors: boolean;
}

export interface CapabilityFeatures {
  /** Entries appear only after their complete versioned contract is ready. */
  history?: HistoryFeature;
  global_search?: GlobalSearchFeature;
  session_messages?: SessionMessagesFeature;
  detail_resolvers?: DetailResolversFeature;
}

export interface StorageCapability {
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
}

export interface CapabilitiesResponse {
  api_revision: 2;
  /** May be empty during bootstrap; retry according to storage state. */
  features: CapabilityFeatures;
  storage: StorageCapability;
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

export interface HistorySnapshot {
  snapshot_id: OpaqueId;
  revision: Revision;
  expires_at: IsoDateTime;
}

export interface HistoryPage {
  items: ActivityItem[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  revision: Revision;
  snapshot: HistorySnapshot;
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
  /** At least one explicit operational scope is required. */
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

export interface SearchAuthor {
  kind: AuthorKind;
  principal_id?: OpaqueId | null;
  handle?: string | null;
  display?: string | null;
}

export interface EventCause {
  kind: "event_delivery";
  event_id: OpaqueId;
  delivery_id: OpaqueId;
  title: string;
}

export interface ChatTarget {
  kind: "chat";
  session_id: OpaqueId;
}

export interface ChatMessageTarget {
  kind: "chat_message";
  session_id: OpaqueId;
  message_id: OpaqueId;
}

export interface ChatToolTarget {
  kind: "chat_tool";
  session_id: OpaqueId;
  message_id: OpaqueId;
  tool_invocation_id: OpaqueId;
}

export interface WorkflowDefinitionTarget {
  kind: "workflow_definition";
  workflow_id: OpaqueId;
  /** Future match-specific fields; not guaranteed while definition_field_anchors=false. */
  node_id?: OpaqueId;
  field?: string;
}

export interface WorkflowRunTarget {
  kind: "workflow_run";
  run_id: OpaqueId;
  workflow_id: OpaqueId;
  /** Future match-specific anchors; beta guarantees the exact run root. */
  trace_step_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}

export type ScheduledDefinitionField = "name" | "prompt" | "schedule";

export interface ScheduledDefinitionTarget {
  kind: "scheduled_definition";
  task_id: OpaqueId;
  /** Future match-specific anchor; beta guarantees the task root. */
  field?: ScheduledDefinitionField;
}

export interface ScheduledRunTarget {
  kind: "scheduled_run";
  run_id: OpaqueId;
  task_id: OpaqueId;
  /** Future nested match anchors; beta guarantees the exact run root. */
  session_id?: OpaqueId;
  message_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}

export interface EventDefinitionTarget {
  kind: "event_definition";
  event_id: OpaqueId;
  /** Future match-specific anchor; beta guarantees the event root. */
  field?: string;
}

export interface EventDeliveryTarget {
  kind: "event_delivery";
  delivery_id: OpaqueId;
  event_id: OpaqueId;
  /** Future nested match anchors; beta guarantees the exact delivery root. */
  session_id?: OpaqueId;
  message_id?: OpaqueId;
  tool_invocation_id?: OpaqueId;
}

/**
 * Stable, serializable navigation contract returned by operational search.
 * Switches over `kind` must be exhaustive; never infer a route from root kind.
 */
export type SearchTarget =
  | ChatTarget
  | ChatMessageTarget
  | ChatToolTarget
  | WorkflowDefinitionTarget
  | WorkflowRunTarget
  | ScheduledDefinitionTarget
  | ScheduledRunTarget
  | EventDefinitionTarget
  | EventDeliveryTarget;

export type SearchTargetFor<K extends SearchTargetKind> = Extract<
  SearchTarget,
  { kind: K }
>;

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
  author?: SearchAuthor | null;
  occurred_at: IsoDateTime;
  fragments: NonEmptyArray<HighlightFragment>;
  sensitivity: Sensitivity;
  completeness: Completeness;
  target: SearchTarget;
}

export type SearchMatchPreview = [SearchMatch] | [SearchMatch, SearchMatch];

export interface SearchResult {
  result_id: OpaqueId;
  root: SearchRoot;
  /** One or two passages; the first target is the default target. */
  matches: SearchMatchPreview;
  match_count: number;
  target: SearchTarget;
  caused_by?: EventCause | null;
}

export interface SearchSnapshot {
  search_session_id: OpaqueId;
  index_generation: Revision;
  indexed_seq: Sequence;
  expires_at: IsoDateTime;
}

export interface CorpusCoverage {
  complete: boolean;
  indexed_documents: number;
  estimated_total: number;
  pending: number;
  lag_ms: number;
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
  per_corpus: Partial<Record<SearchScope, CorpusCoverage>>;
}

export interface SearchPage {
  items: SearchResult[];
  next_cursor: OpaqueCursor | null;
  has_more: boolean;
  snapshot: SearchSnapshot;
  index_generation: Revision;
  indexed_seq: Sequence;
  coverage: SearchCoverage;
  query_mode: SearchQueryMode;
}

export type MessagePageDirection = "before" | "after";

export type SessionMessagesQuery =
  | {
      around: OpaqueId;
      before?: number;
      after?: number;
      cursor?: never;
      direction?: never;
      limit?: never;
    }
  | {
      cursor: OpaqueCursor;
      direction: MessagePageDirection;
      limit?: number;
      around?: never;
      before?: never;
      after?: never;
    }
  | {
      limit?: number;
      around?: never;
      before?: never;
      after?: never;
      cursor?: never;
      direction?: never;
    };

export interface MessageAuthor {
  kind: AuthorKind;
  principal_id?: OpaqueId | null;
  handle?: string | null;
  display?: string | null;
}

export type MessageAttachmentKind = "image" | "file" | "voice" | "video";

export interface MessageAttachment {
  artifact_id: OpaqueId;
  kind: MessageAttachmentKind;
  filename: string;
  mime: string;
  size_bytes?: number;
}

export interface SessionMessage {
  id: OpaqueId;
  session_id: OpaqueId;
  run_id?: OpaqueId | null;
  ordinal: number;
  role: MessageRole;
  status: MessageStatus;
  author: MessageAuthor;
  text: string;
  visible_reasoning?: string | null;
  tool_invocation_id?: OpaqueId | null;
  attachments?: MessageAttachment[];
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

export interface ArtifactMetadata {
  id: OpaqueId;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
}

export type ToolInvocationRootKind =
  | "chat"
  | "delegated_session"
  | "workflow_run"
  | "scheduled_run"
  | "event_delivery";

export interface ToolInvocationDetail {
  id: OpaqueId;
  tool_call_id?: OpaqueId | null;
  root_kind: ToolInvocationRootKind;
  root_id: OpaqueId;
  session_id?: OpaqueId | null;
  message_id?: OpaqueId | null;
  workflow_run_id?: OpaqueId | null;
  trace_step_id?: OpaqueId | null;
  scheduled_run_id?: OpaqueId | null;
  event_delivery_id?: OpaqueId | null;
  tool_server?: string | null;
  tool_name: string;
  status: ToolInvocationStatus;
  args_safe: SafeJsonValue;
  result_safe: SafeJsonValue;
  error_safe: string | null;
  child_session_id?: OpaqueId | null;
  sensitivity: Sensitivity;
  completeness: Completeness;
  artifacts: ArtifactMetadata[];
  created_at: IsoDateTime;
  finished_at?: IsoDateTime | null;
}

export interface WorkflowTraceStep {
  /** Stable attempt-level anchor; do not substitute node_id. */
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
}

export interface WorkflowRunDetail {
  id: OpaqueId;
  workflow_id: OpaqueId;
  title: string;
  status: RunStatus;
  trigger?: string | null;
  trace_steps: WorkflowTraceStep[];
  /** Legacy-compatible Unix epoch seconds; do not change its primitive type. */
  started_at: number;
  finished_at?: number | null;
  /** Additive ISO 8601 rendering of started_at. */
  started_at_iso: IsoDateTime;
  /** Additive ISO 8601 rendering of finished_at. */
  finished_at_iso?: IsoDateTime | null;
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
  /** Legacy-compatible Unix epoch seconds; do not change its primitive type. */
  started_at: number;
  /** Additive ISO 8601 rendering of started_at. */
  occurred_at: IsoDateTime;
  finished_at?: number | null;
  /** Additive ISO 8601 rendering of finished_at. */
  finished_at_iso?: IsoDateTime | null;
  completeness: Completeness;
}

interface HistoryChangedEventBase {
  type: "history_changed";
  revision: Revision;
  /** Stable ActivityItem.id used as the client-store key. */
  activity_id: OpaqueId;
  kind: ActivityKind;
  resource_id: OpaqueId;
}

export type HistoryChangedEvent =
  | (HistoryChangedEventBase & { action: "upsert"; item: ActivityItem })
  | (HistoryChangedEventBase & { action: "delete"; item?: null });

export interface SearchIndexChangedEvent {
  type: "search_index_changed";
  index_generation: Revision;
  indexed_seq: Sequence;
}

export type OperationalRealtimeEvent =
  | HistoryChangedEvent
  | SearchIndexChangedEvent;
