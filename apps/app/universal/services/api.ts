/**
 * REST API client for OpenAgent vault operations.
 */

import type {
  VaultNote, InFileSearchResult,
  GraphData, AgentConfig, AgentIdentity, ProviderConfig, ModelsResponse,
  UsageData, ModelCatalogEntry, DailyUsageEntry, ScheduledTask,
  CreateScheduledTaskInput, UpdateScheduledTaskInput, TaskRun, MCPEntry,
  ModelEntry, ModelFramework, AvailableModel,
  WorkflowTask, CreateWorkflowInput, UpdateWorkflowInput, WorkflowRun,
  WorkflowStats, BlockTypeSpec, MCPToolkitDescriptor,
  SystemSnapshot,
  VaultWriteResult, VaultHistory, VaultGateReport,
  VaultCommitDetail, VaultRestoreResult, VaultResetResult,
  ChatMessage, Attachment, ToolInfo, MessageAuthor, CompactionInfo,
  SessionContext, SessionModelPin,
  BudgetRule, BudgetUsage, CreateBudgetInput, UpdateBudgetInput,
  LogEntry, QualityReport, GatewayCommandSpec,
  SkillSummary, SkillDetail, SkillWriteResult, CreateSkillInput,
  ProviderAccounts, AgentEvent, CreateEventInput, UpdateEventInput, EventDelivery, EventTypeSpec,
} from '../../common/types';
import type {
  ActivityItem,
  ApiErrorPayload,
  CapabilitiesResponse,
  EventDeliveryDetail,
  HistoryPage,
  HistoryQuery,
  ScheduledRunDetail,
  SearchPage,
  SearchRequest,
  SessionMessagePage,
  SessionMessagesQuery,
  SessionDescendantsPage,
  SessionRelatedRunsPage,
  ToolInvocationDetail,
  WorkflowRunDetail,
} from '../../common/unified-history';
import {
  mergeCanonicalWorkflowTrace,
  type WorkflowRunWithCanonicalTrace,
} from '../../common/workflow-trace';
import type { UIJson } from '../../common/ui-views';
import { normalizeAttachmentRefs, normalizeMessageContent } from '../../common/ui-views';
import { attachmentContentRef } from '../../common/attachments';

let baseUrl = '';

export function setBaseUrl(host: string, port: number) {
  baseUrl = `http://${host}:${port}`;
}

/** Current REST origin, used only for gateway-owned media links. Keeping it
 * behind a helper prevents custom view specs from choosing arbitrary local
 * file URLs. */
export function apiUrl(path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

// Hard ceiling so a hung loopback stream (Iroh stalls, server crashes
// mid-response, etc.) can never lock a UI control "in flight" forever.
// 30s is generous for normal calls — anything longer is a real failure
// the user should see as an error rather than a permanently-disabled
// button.
const REQUEST_TIMEOUT_MS = 30_000;

/** An API failure that still knows its HTTP status.
 *
 *  The status is what lets a caller tell "this agent is older than this
 *  feature" (404/405 — the route does not exist) apart from a real fault.
 *  A released app talks to gateways of several vintages, and rendering a
 *  bare "API 405" at someone whose only problem is an un-upgraded server
 *  is a support ticket we wrote ourselves. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: ApiErrorPayload['code'];
  readonly retryable?: boolean;
  readonly details?: ApiErrorPayload['details'];
  constructor(status: number, message: string, payload?: ApiErrorPayload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.code;
    this.retryable = payload?.retryable;
    this.details = payload?.details;
  }
}

/** True when the gateway simply has no such route — i.e. the agent predates
 *  the feature. aiohttp answers an unknown path 404 and a known path with
 *  the wrong method 405; both mean "this server can't do that yet". */
export function isUnsupportedByAgent(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 405);
}

/** A v2 endpoint exists but this server intentionally disabled the feature. */
export function isExplicitlyUnsupported(e: unknown): boolean {
  return e instanceof ApiError && e.status === 501 && e.code === 'unsupported';
}

/** True when the request never reached the agent at all: the loopback tunnel
 *  is down, the sidecar port is stale, the agent is offline.
 *
 *  An `ApiError` means the opposite — the agent answered, it just said no —
 *  so it is never a transport failure. Everything else arrives as a bare
 *  `TypeError: Failed to fetch` (browser/Electron), `Network request failed`
 *  (React Native), or our own 30 s abort, which on a loopback call means the
 *  same thing. Telling the two apart is what lets a screen say "your agent is
 *  offline" instead of quoting a transport error at someone who cannot act on
 *  it. */
export function isAgentUnreachable(e: unknown): boolean {
  if (e instanceof ApiError) return false;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /failed to fetch|network request failed|networkerror|load failed|aborterror|timed out|econnrefused|econnreset/i
    .test(msg);
}

function withTimeout(init: RequestInit, label: string): RequestInit {
  if (typeof AbortController === 'undefined') return init;
  const ctrl = new AbortController();
  const upstream = init.signal;
  const onUpstreamAbort = () => ctrl.abort(upstream?.reason);
  if (upstream?.aborted) onUpstreamAbort();
  else upstream?.addEventListener('abort', onUpstreamAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${label}`), REQUEST_TIMEOUT_MS);
  const timed = { ...init, signal: ctrl.signal };
  // Sentinels are removed in `clearTimer`; they never reach fetch's
  // observable request surface.
  (timed as any).__timer = timer;
  (timed as any).__cleanupAbort = () => upstream?.removeEventListener('abort', onUpstreamAbort);
  return timed;
}

function clearTimer(init: RequestInit): void {
  const t = (init as any).__timer;
  if (t) clearTimeout(t);
  (init as any).__cleanupAbort?.();
}

async function responseError(res: Response): Promise<ApiError> {
  const text = await res.text();
  let payload: ApiErrorPayload | undefined;
  let message: string | undefined;
  try {
    const decoded = JSON.parse(text) as { error?: ApiErrorPayload | string };
    if (typeof decoded?.error === 'string') message = decoded.error;
    else if (decoded?.error?.code && decoded.error.message) payload = decoded.error;
  } catch {
    // Older gateways return plain text. Preserve it below.
  }
  return new ApiError(
    res.status,
    payload?.message || message || `API ${res.status}${text ? `: ${text}` : ''}`,
    payload,
  );
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const init = withTimeout({ signal }, `GET ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await responseError(res);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

async function put<T>(path: string, body: object): Promise<T> {
  const init = withTimeout({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, `PUT ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

async function post<T>(path: string, body: object = {}, signal?: AbortSignal): Promise<T> {
  const init = withTimeout({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }, `POST ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await responseError(res);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

async function del(path: string): Promise<void> {
  const init = withTimeout({ method: 'DELETE' }, `DELETE ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  } finally {
    clearTimer(init);
  }
}

async function patch<T>(path: string, body: object): Promise<T> {
  const init = withTimeout({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, `PATCH ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw await responseError(res);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

// ── OA-UI custom views ──────────────────────────────────────────────

export async function getUICapabilities(): Promise<unknown> {
  return get('/api/ui/capabilities');
}

export async function listUIViews(options: {
  surface?: 'sidebar' | 'inline';
  sessionId?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<unknown> {
  const params = new URLSearchParams();
  if (options.surface) params.set('surface', options.surface);
  if (options.sessionId) params.set('sessionId', options.sessionId);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return get(`/api/ui/views${query ? `?${query}` : ''}`);
}

export async function getUIView(viewId: string, revision?: number): Promise<unknown> {
  const query = revision != null ? `?revision=${encodeURIComponent(String(revision))}` : '';
  return get(`/api/ui/views/${encodeURIComponent(viewId)}${query}`);
}

export async function invokeUIViewAction(
  viewId: string,
  actionId: string,
  input: unknown,
  idempotencyKey: string,
  revision?: number,
): Promise<unknown> {
  return post(
    `/api/ui/views/${encodeURIComponent(viewId)}/actions/${encodeURIComponent(actionId)}`,
    {
      ...(input !== undefined ? { input } : {}),
      idempotencyKey,
      ...(revision != null ? { revision } : {}),
    },
  );
}

export async function reactivateUIView(
  viewId: string,
  options: { expectedRevision?: number; expiresAt?: string | number | null } = {},
): Promise<unknown> {
  return post(`/api/ui/views/${encodeURIComponent(viewId)}/reactivate`, options);
}

export async function setUIViewData(
  viewId: string,
  key: string,
  value: UIJson,
  expectedVersion?: number,
): Promise<unknown> {
  return put(
    `/api/ui/views/${encodeURIComponent(viewId)}/data/${encodeURIComponent(key)}`,
    { value, ...(expectedVersion != null ? { expectedVersion } : {}) },
  );
}

// ── Vault API ──

/** Coerce a note's ``tags`` to a string array. The vault API derives
 *  tags from YAML frontmatter, where ``tags: a,b,c`` parses as a bare
 *  scalar string — agents on older builds return that un-normalized,
 *  and a string reaching ``tags.slice(...).join(...)`` in the UI throws.
 *  This is the client-side guard; the server also normalizes. */
function normalizeNote(n: VaultNote): VaultNote {
  const raw = (n as { tags?: unknown }).tags;
  const tags = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === 'string')
    : typeof raw === 'string' && raw
      ? [raw]
      : [];
  return { ...n, tags };
}

export async function listNotes(): Promise<VaultNote[]> {
  const data = await get<{ notes: VaultNote[] }>('/api/vault/notes');
  return (data.notes ?? []).map(normalizeNote);
}

export async function readNote(path: string): Promise<{
  path: string;
  content: string;
  frontmatter: Record<string, any>;
  body: string;
  links: string[];
  modified: number;
}> {
  return get(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`);
}

// Returns the gateway's write result: validation warnings + the commit
// hash for the git-committed write. The UI surfaces both in the editor
// header so the user sees why a save flagged (or whether it committed).
export async function writeNote(path: string, content: string): Promise<VaultWriteResult> {
  const url = `${baseUrl}/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`;
  const init = withTimeout({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }, `PUT ${path}`);
  try {
    const res = await fetch(url, init);
    // 422 = the quality gate rejected the note. Return it as a structured
    // result (don't throw) so the editor can show the errors and keep the
    // user's text. Any other non-2xx is a real failure.
    if (res.status === 422) {
      return (await res.json()) as VaultWriteResult;
    }
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

export async function deleteNote(path: string): Promise<void> {
  await del(`/api/vault/notes/${path.split('/').map(encodeURIComponent).join('/')}`);
}

// Rename a note OR a folder. Paths travel in the JSON body (not the URL)
// so no encoding is needed. The server rewrites inbound wikilinks and
// reports how many notes/links it touched.
export async function moveNote(
  from: string,
  to: string,
): Promise<{
  moved: { from: string; to: string };
  notes_moved: number;
  notes_updated: number;
  links_rewritten: number;
  commit: string | null;
}> {
  return post('/api/vault/move', { from, to });
}

// Vault git log. ``path`` scopes to one note/folder; omit for the
// vault-wide history. ``limit`` caps the number of commits returned.
export async function getVaultHistory(path?: string, limit?: number): Promise<VaultHistory> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return get<VaultHistory>(`/api/vault/history${qs ? `?${qs}` : ''}`);
}

// The changes a single commit introduced (files touched + unified diff).
export async function getVaultCommit(hash: string): Promise<VaultCommitDetail> {
  return get<VaultCommitDetail>(`/api/vault/commit?hash=${encodeURIComponent(hash)}`);
}

// Non-destructively roll the vault back to the state at ``hash`` — adds a
// new commit; every later commit stays in history.
export async function restoreVault(hash: string): Promise<VaultRestoreResult> {
  return post<VaultRestoreResult>('/api/vault/restore', { hash });
}

// DESTRUCTIVELY make ``hash`` the latest commit, deleting every commit
// after it. The server requires the explicit ``confirm`` flag.
export async function resetVault(hash: string): Promise<VaultResetResult> {
  return post<VaultResetResult>('/api/vault/reset', { hash, confirm: true });
}

// Quality-gate report — violations grouped by rule, with counts.
export async function getVaultGate(): Promise<VaultGateReport> {
  return get<VaultGateReport>('/api/vault/gate');
}

// Aggregate vault stats: note/link counts, broken links, orphans, graph
// components. Loosely typed — the shape is informational only.
export async function getVaultStats(): Promise<{
  notes: number;
  links: number;
  broken_links: number;
  orphans: number;
  components: number;
  largest_component: number;
  notes_by_folder: Record<string, number>;
}> {
  return get('/api/vault/stats');
}

// Run the vault doctor. ``apply=false`` is a dry run (suggestions only);
// ``apply=true`` writes the auto-fixes and git-commits them.
export async function runVaultDoctor(apply: boolean): Promise<{
  before: Record<string, unknown>;
  fix: {
    files_changed: number;
    fixed: { path: string; fixes: string[] }[];
    suggestions: { path: string; rule: string; message: string; suggestion: string }[];
  };
  after: Record<string, unknown> | null;
}> {
  return post(`/api/vault/doctor?apply=${apply ? 'true' : 'false'}`);
}

// Rebuild the derived ``llms.txt`` + showcase artifacts from the vault.
export async function buildVaultDerived(): Promise<{
  llms_txt: string;
  showcase: string;
  llms_bytes: number;
  showcase_bytes: number;
  commit: string | null;
}> {
  return post('/api/vault/derived');
}

// Scaffold a fresh vault (folders + seed notes). Returns the created
// paths and the seed commit (when one was made).
export async function initVault(): Promise<{ created: string[]; count: number; commit?: string }> {
  return post('/api/vault/init');
}

export async function searchNotes(query: string): Promise<VaultNote[]> {
  const data = await get<{ results: VaultNote[] }>(
    `/api/vault/search?q=${encodeURIComponent(query)}`
  );
  return (data.results ?? []).map(normalizeNote);
}

// Search notes by file name / path only.
export async function searchNotesByFileName(query: string, limit?: number): Promise<VaultNote[]> {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set('limit', String(limit));
  const data = await get<{ results: VaultNote[] }>(
    `/api/vault/search/files?${params.toString()}`
  );
  return (data.results ?? []).map(normalizeNote);
}

// Search within a specific file, optionally using regex.
export async function searchInFile(
  path: string,
  query: string,
  regex: boolean = false,
): Promise<InFileSearchResult> {
  const params = new URLSearchParams({ path, q: query });
  if (regex) params.set('regex', 'true');
  return get<InFileSearchResult>(
    `/api/vault/search/in-file?${params.toString()}`
  );
}

export async function getGraph(): Promise<GraphData> {
  return get<GraphData>('/api/vault/graph');
}

// ── Scheduled Tasks API ──

export async function getScheduledTasks(
  enabledOnly: boolean = false,
  // Include framework built-ins (dream-mode, auto-update) in the result.
  // Off by default so the Scheduled-tasks management screen stays clean;
  // the sidebar "Recent" activity feed opts in so a dream-mode firing
  // surfaces there like any other scheduled run.
  includeBuiltin: boolean = false,
): Promise<ScheduledTask[]> {
  const params = new URLSearchParams();
  if (enabledOnly) params.set('enabled_only', 'true');
  if (includeBuiltin) params.set('include_builtin', '1');
  const q = params.toString();
  const data = await get<{ tasks: ScheduledTask[] }>(
    `/api/scheduled-tasks${q ? `?${q}` : ''}`,
  );
  return data.tasks;
}

export async function getScheduledTask(id: string): Promise<ScheduledTask> {
  return get<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(id)}`);
}

export async function createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  return post<ScheduledTask>('/api/scheduled-tasks', input);
}

export async function updateScheduledTask(id: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
  return patch<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, input);
}

export async function deleteScheduledTask(id: string): Promise<void> {
  await del(`/api/scheduled-tasks/${encodeURIComponent(id)}`);
}

// Run a scheduled task immediately, out of band from its cron schedule.
// Leaves the task's schedule + enabled flag untouched. When wait=true the
// server blocks until the firing finishes and returns the TaskRun row; when
// wait=false (the default the app uses for a snappy button) it returns
// {run_id, status:'running'} as soon as the run row exists — progress then
// arrives over the ``scheduled_task`` broadcast.
export async function runScheduledTask(
  id: string,
  opts: { wait?: boolean; timeoutS?: number } = {},
): Promise<TaskRun | { run_id: string | null; status: string }> {
  return post(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, {
    wait: opts.wait ?? false,
    timeout_s: opts.timeoutS,
  });
}

// Stop the currently-running firing(s) of a scheduled task. Hard-stops the
// in-flight agent turn(s) and records them cancelled; the schedule itself is
// untouched. When wait=true the server blocks until the firing(s) actually
// stop and returns {count, runs, …}; the app uses wait=false for a snappy
// button, then refetches on the ``scheduled_task`` broadcast.
export async function stopScheduledTask(
  id: string,
  opts: { wait?: boolean; timeoutS?: number } = {},
): Promise<{ task_id: string; stopped: string[]; count: number; runs: unknown[] }> {
  return post(`/api/scheduled-tasks/${encodeURIComponent(id)}/stop`, {
    wait: opts.wait ?? false,
    timeout_s: opts.timeoutS,
  });
}

// Per-firing execution history for one scheduled task (newest first).
// The scheduled-task analogue of ``getWorkflowRuns`` — same query
// params (limit + optional status filter) and the same envelope shape.
export async function getScheduledTaskRuns(
  id: string,
  opts: { limit?: number; status?: string } = {},
): Promise<TaskRun[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  const data = await get<{ runs: TaskRun[] }>(
    `/api/scheduled-tasks/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ''}`,
  );
  return data.runs;
}

// ── Events API (webhook channel) ──

export async function getEvents(enabledOnly: boolean = false): Promise<AgentEvent[]> {
  const q = enabledOnly ? '?enabled_only=true' : '';
  const data = await get<{ events: AgentEvent[] }>(`/api/events${q}`);
  return data.events;
}

export async function getEvent(id: string): Promise<AgentEvent> {
  return get<AgentEvent>(`/api/events/${encodeURIComponent(id)}`);
}

// Returns the event WITH its clear ``secret`` — shown once. Save it.
export async function createEvent(input: CreateEventInput): Promise<AgentEvent> {
  return post<AgentEvent>('/api/events', input);
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<AgentEvent> {
  return patch<AgentEvent>(`/api/events/${encodeURIComponent(id)}`, input);
}

export async function deleteEvent(id: string): Promise<void> {
  await del(`/api/events/${encodeURIComponent(id)}`);
}

// Generates a new secret and returns it inline (once), invalidating the old.
export async function rotateEventSecret(id: string): Promise<AgentEvent> {
  return post<AgentEvent>(`/api/events/${encodeURIComponent(id)}/rotate-secret`, {});
}

// Fire an event now from inside the app (the "Test" button) with a sample
// payload. Produces a delivery + the bound action's run, same as a real hook.
export async function triggerEvent(
  id: string,
  payload: Record<string, unknown> = {},
  opts: { wait?: boolean; timeoutS?: number } = {},
): Promise<EventDelivery | { delivery_id: string; status: string }> {
  return post(`/api/events/${encodeURIComponent(id)}/trigger`, {
    payload,
    wait: opts.wait ?? false,
    timeout_s: opts.timeoutS,
  });
}

// Per-event delivery history (newest first) — the events analogue of
// getWorkflowRuns / getScheduledTaskRuns. Powers the Recent feed's 'event'
// source and the event's history screen.
export async function getEventDeliveries(id: string, limit?: number): Promise<EventDelivery[]> {
  const q = limit ? `?limit=${limit}` : '';
  const data = await get<{ deliveries: EventDelivery[] }>(
    `/api/events/${encodeURIComponent(id)}/deliveries${q}`,
  );
  return data.deliveries;
}

export async function getEventDelivery(deliveryId: string): Promise<EventDelivery> {
  return get<EventDelivery>(`/api/event-deliveries/${encodeURIComponent(deliveryId)}`);
}

export async function getEventTypes(): Promise<EventTypeSpec[]> {
  const data = await get<{ types: EventTypeSpec[] }>('/api/event-types');
  return data.types;
}

// ── Workflows API ──

export async function getWorkflows(
  opts: { enabledOnly?: boolean; hasTriggerType?: string } = {}
): Promise<WorkflowTask[]> {
  const params = new URLSearchParams();
  if (opts.enabledOnly) params.set('enabled_only', 'true');
  if (opts.hasTriggerType) params.set('has_trigger_type', opts.hasTriggerType);
  const qs = params.toString();
  const data = await get<{ workflows: WorkflowTask[] }>(
    `/api/workflows${qs ? `?${qs}` : ''}`
  );
  return data.workflows;
}

export async function getWorkflow(id: string): Promise<WorkflowTask> {
  return get<WorkflowTask>(`/api/workflows/${encodeURIComponent(id)}`);
}

export async function createWorkflow(
  input: CreateWorkflowInput
): Promise<WorkflowTask> {
  return post<WorkflowTask>('/api/workflows', input);
}

export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput
): Promise<WorkflowTask> {
  return patch<WorkflowTask>(`/api/workflows/${encodeURIComponent(id)}`, input);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await del(`/api/workflows/${encodeURIComponent(id)}`);
}

// Trigger a run. When wait=true the server blocks until the run
// finishes and returns the full WorkflowRun with trace; when wait=false
// it returns {run_id, status:'running'} as soon as the executor has
// inserted the row.
export async function runWorkflow(
  id: string,
  opts: { inputs?: Record<string, unknown>; wait?: boolean; timeoutS?: number } = {}
): Promise<WorkflowRun | { run_id: string | null; status: string }> {
  return post(`/api/workflows/${encodeURIComponent(id)}/run`, {
    inputs: opts.inputs,
    wait: opts.wait ?? true,
    timeout_s: opts.timeoutS,
  });
}

export async function getWorkflowRuns(
  id: string,
  opts: { limit?: number; status?: string } = {}
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.status) params.set('status', opts.status);
  const qs = params.toString();
  const data = await get<{ runs: WorkflowRun[] }>(
    `/api/workflows/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ''}`
  );
  return data.runs;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  const run = await get<WorkflowRunWithCanonicalTrace>(
    `/api/workflow-runs/${encodeURIComponent(runId)}`,
  );
  return mergeCanonicalWorkflowTrace(run);
}

export async function getWorkflowStats(
  id: string,
  opts: { last?: number } = {},
): Promise<WorkflowStats> {
  const qs = opts.last ? `?last=${opts.last}` : '';
  return get<WorkflowStats>(
    `/api/workflows/${encodeURIComponent(id)}/stats${qs}`,
  );
}

export async function getWorkflowBlockTypes(): Promise<BlockTypeSpec[]> {
  const data = await get<{ block_types: BlockTypeSpec[] }>(
    '/api/workflow-block-types'
  );
  return data.block_types;
}

export async function getMcpTools(): Promise<MCPToolkitDescriptor[]> {
  const data = await get<{ mcps: MCPToolkitDescriptor[] }>('/api/mcp-tools');
  return data.mcps;
}

export interface CronDescribeResponse {
  expression: string;
  valid: boolean;
  one_shot?: boolean;
  upcoming?: Array<{ epoch: number; iso: string }>;
  error?: string;
}

export async function describeCron(
  expression: string,
  count: number = 3,
): Promise<CronDescribeResponse> {
  const qs = `expression=${encodeURIComponent(expression)}&count=${count}`;
  try {
    return await get<CronDescribeResponse>(`/api/cron/describe?${qs}`);
  } catch (e: any) {
    // The gateway returns 400 with a JSON body describing the
    // validation failure — re-shape that here so callers get a
    // uniform ``{valid, error}`` payload without having to inspect
    // HTTP status codes.
    const msg = e?.message ?? String(e);
    const match = /API \d+: (.+)$/.exec(msg);
    if (match) {
      try {
        const body = JSON.parse(match[1]);
        return {
          expression,
          valid: false,
          error: body.error || msg,
        };
      } catch {
        // fall through
      }
    }
    return { expression, valid: false, error: msg };
  }
}

// ── File Upload ──

/**
 * Guess a Content-Type for a filename + binary-kind pair when the
 * source File didn't carry one (the Electron picker hands back raw
 * paths, not File objects). Centralised here so the desktop pick path,
 * web fallback, and any future surface stay in lockstep on what the
 * gateway sees.
 */
export function guessMimeType(filename: string, kind: 'image' | 'file'): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const mimes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', tiff: 'image/tiff',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', json: 'application/json', yaml: 'application/x-yaml',
    yml: 'application/x-yaml', log: 'text/plain',
    py: 'text/x-python', js: 'application/javascript', ts: 'application/typescript',
    webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
    wav: 'audio/wav', m4a: 'audio/mp4',
  };
  return mimes[ext] || (kind === 'image' ? 'application/octet-stream' : 'application/octet-stream');
}

export async function uploadFile(
  file: File | Blob,
  filename = 'upload',
  opts?: {
    language?: string;
    sessionId?: string;
    kind?: Attachment['type'];
    signal?: AbortSignal;
  },
): Promise<Attachment & {
  transcription?: string;
  // Set by /api/upload when the file is audio. The chat screen flips
  // ``input_was_voice`` on the WS message so the gateway returns a
  // spoken reply (mirror modality).
  transcribed_from_voice?: boolean;
}> {
  const form = new FormData();
  if (file instanceof File) {
    form.append('file', file);
  } else {
    form.append('file', file, filename);
  }
  if (opts?.kind) form.append('kind', opts.kind);
  // ``lang`` (ISO-639-1) hints the STT backend; empty means auto-detect.
  const query = new URLSearchParams();
  if (opts?.language) query.set('lang', opts.language);
  if (opts?.sessionId) query.set('session_id', opts.sessionId);
  const encodedQuery = query.toString();
  const qs = encodedQuery ? `?${encodedQuery}` : '';
  const res = await fetch(`${baseUrl}/api/upload${qs}`, {
    method: 'POST',
    body: form,
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const payload = await res.json() as Record<string, unknown>;
  const [attachment] = normalizeAttachmentRefs([{ type: opts?.kind, ...payload }]);
  if (!attachment) throw new Error('Upload failed: gateway returned an invalid attachment reference');
  return {
    ...attachment,
    ...(typeof payload.transcription === 'string' ? { transcription: payload.transcription } : {}),
    ...(typeof payload.transcribed_from_voice === 'boolean'
      ? { transcribed_from_voice: payload.transcribed_from_voice }
      : {}),
  };
}

// ── File Download (agent → client) ──

/**
 * URL of the deprecated ``/api/files`` endpoint for a legacy server-side
 * path. Canonical AttachmentRefs use {@link attachmentUrl} and
 * ``/api/artifacts/{id}/content`` instead.
 *
 * Auth is enforced by the loopback sidecar's Iroh transport — the
 * URL doesn't need a token query param. The legacy ``token`` argument
 * is preserved for callers that still pass it; it's ignored.
 */
export function fileUrl(path: string, _token?: string): string {
  if (/^\/api\/artifacts\/[^/?#]+\/content$/.test(path) || /^\/api\/files\?(?:[^#]*)$/.test(path)) {
    return apiUrl(path);
  }
  const params = new URLSearchParams({ path });
  return `${baseUrl}/api/files?${params.toString()}`;
}

/** Resolve a durable attachment through its authenticated canonical URL. */
export function attachmentUrl(attachment: Attachment): string {
  const ref = attachmentContentRef(attachment);
  return ref ? fileUrl(ref) : '';
}

/** Download a canonical CAS ref, with path-only support for old gateways. */
export async function downloadAttachment(attachment: Attachment, _token?: string): Promise<void> {
  const ref = attachmentContentRef(attachment);
  if (!ref) throw new Error('Attachment has no downloadable content reference');
  return downloadFile(ref, attachment.filename);
}

/**
 * Fetch a file off the agent server and trigger a browser download.
 * Works on web + in the Electron webview. On pure-native mobile this
 * would need Expo FileSystem — not used today since the desktop app
 * is the primary target.
 */
export async function downloadFile(path: string, filename: string, _token?: string): Promise<void> {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a beat to initiate the save dialog before we
  // revoke the ObjectURL — immediate revoke races on Firefox.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ── Config API ──

export async function getConfig(): Promise<AgentConfig> {
  return get<AgentConfig>('/api/config');
}

export async function updateConfig(config: AgentConfig): Promise<{ ok: boolean }> {
  return put<{ ok: boolean }>('/api/config', config);
}

export async function updateConfigSection(
  section: string,
  data: any,
): Promise<{ ok: boolean; restart_required: boolean }> {
  const res = await fetch(`${baseUrl}/api/config/${section}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Read the owner-editable agent identity (not the framework prompt). */
export async function getAgentIdentity(): Promise<AgentIdentity> {
  return get<AgentIdentity>('/api/agent/identity');
}

/** Atomically update the agent name and/or user-defined persona. */
export async function updateAgentIdentity(data: {
  name?: string;
  system_prompt?: string;
  expected_revision?: string;
}): Promise<AgentIdentity & { ok: boolean }> {
  return patch<AgentIdentity & { ok: boolean }>('/api/agent/identity', data);
}

// ── Control API ──

export async function triggerUpdate(): Promise<{ updated: boolean; version?: string; old?: string; new?: string }> {
  const res = await fetch(`${baseUrl}/api/update`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function triggerRestart(): Promise<{ ok: boolean }> {
  const res = await fetch(`${baseUrl}/api/restart`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Providers API (DB-backed) ──
//
// Provider keys live in the SQLite ``providers`` table. The
// addModel/updateModel/deleteModel helpers below target the DB-backed
// ``/api/models/db`` endpoints.

// The server collapsed legacy framework names (``agno`` / ``litellm``)
// into ``api-based`` in v0.14, but very old caches or third-party
// integrations could still hand back the legacy literal. Coerce here
// so callers only ever see canonical ``ModelFramework`` values.
//
// @deprecated The ``'agno'`` branch exists only to swallow stale data;
// remove once v0.13 cohorts are fully off the network.
function normalizeFramework(raw: unknown): ModelFramework {
  if (raw === 'agno') return 'api-based';
  return raw as ModelFramework;
}

function normalizeProvider(p: ProviderConfig): ProviderConfig {
  return { ...p, framework: normalizeFramework(p.framework) };
}

function normalizeModel(m: ModelEntry): ModelEntry {
  return { ...m, framework: normalizeFramework(m.framework) };
}

export async function getProviders(): Promise<ProviderConfig[]> {
  const data = await get<{ providers: ProviderConfig[] }>('/api/providers');
  return (data.providers || []).map(normalizeProvider);
}

export async function testProvider(
  providerId: number, model?: string,
): Promise<{ ok: boolean; error?: string; model?: string; response?: string }> {
  try {
    return await post(`/api/providers/${providerId}/test`, { model });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function addProvider(body: {
  name: string;
  framework: 'api-based' | 'litellm';
  api_key?: string;
  base_url?: string;
  // ``kind`` defaults server-side to ``'llm'``. Audio providers (TTS
  // / STT) pass ``'tts'`` or ``'stt'`` so the LLM dispatcher skips them
  // and the audio modules route via LiteLLM.
  kind?: 'llm' | 'tts' | 'stt';
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; provider: ProviderConfig }> {
  const data = await post<{ ok: boolean; provider: ProviderConfig }>('/api/providers', body);
  return { ...data, provider: normalizeProvider(data.provider) };
}

export async function updateProvider(
  providerId: number, body: { api_key?: string; base_url?: string; enabled?: boolean },
): Promise<{ ok: boolean; provider: ProviderConfig }> {
  const data = await put<{ ok: boolean; provider: ProviderConfig }>(
    `/api/providers/${providerId}`,
    body,
  );
  return { ...data, provider: normalizeProvider(data.provider) };
}

export async function deleteProvider(providerId: number): Promise<void> {
  await del(`/api/providers/${providerId}`);
}

export async function getModels(): Promise<ModelsResponse> {
  const providers = await getProviders();
  return { models: providers };
}

// ── Usage API ──

export async function getUsage(): Promise<UsageData> {
  return get<UsageData>('/api/usage');
}

export async function getDailyUsage(days: number = 7): Promise<DailyUsageEntry[]> {
  const data = await get<{ entries: DailyUsageEntry[] }>(`/api/usage/daily?days=${days}`);
  return data.entries;
}

export async function getModelPricing(): Promise<Record<string, { input: number; output: number }>> {
  const data = await get<{ pricing: Record<string, { input_cost_per_million: number; output_cost_per_million: number }> }>('/api/usage/pricing');
  const result: Record<string, { input: number; output: number }> = {};
  for (const [k, v] of Object.entries(data.pricing)) {
    result[k] = { input: v.input_cost_per_million, output: v.output_cost_per_million };
  }
  return result;
}

// ── Model Catalog API ──

export async function getModelCatalog(provider?: string): Promise<ModelCatalogEntry[]> {
  const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const data = await get<{ models: ModelCatalogEntry[] }>(`/api/models/catalog${q}`);
  return data.models;
}

export async function getAvailableProviders(): Promise<string[]> {
  const data = await get<{ providers: string[] }>('/api/models/providers');
  return data.providers;
}

// ── DB-backed MCP registry (maps to /api/mcps) ──
//
// These replace the yaml-based MCP editor. The DB is the source of truth;
// writes trigger a pool hot-reload on the next message so the new server
// is live without a process restart.

export async function listMcps(): Promise<MCPEntry[]> {
  const data = await get<{ mcps: MCPEntry[] }>('/api/mcps');
  return data.mcps;
}

export async function getMcp(name: string): Promise<MCPEntry> {
  const data = await get<{ mcp: MCPEntry }>(`/api/mcps/${encodeURIComponent(name)}`);
  return data.mcp;
}

export async function createMcp(entry: Partial<MCPEntry> & { name: string }): Promise<MCPEntry> {
  const data = await post<{ mcp: MCPEntry }>('/api/mcps', entry);
  return data.mcp;
}

export async function updateMcp(name: string, patchBody: Partial<MCPEntry>): Promise<MCPEntry> {
  const data = await put<{ mcp: MCPEntry }>(`/api/mcps/${encodeURIComponent(name)}`, patchBody);
  return data.mcp;
}

export async function deleteMcp(name: string): Promise<void> {
  await del(`/api/mcps/${encodeURIComponent(name)}`);
}

export async function enableMcp(name: string): Promise<MCPEntry> {
  const data = await post<{ mcp: MCPEntry }>(`/api/mcps/${encodeURIComponent(name)}/enable`, {});
  return data.mcp;
}

export async function disableMcp(name: string): Promise<MCPEntry> {
  const data = await post<{ mcp: MCPEntry }>(`/api/mcps/${encodeURIComponent(name)}/disable`, {});
  return data.mcp;
}

// ── MCP Marketplace (registry.modelcontextprotocol.io via gateway proxy) ──
//
// Search hits a 5-min in-memory cache on the gateway; detail hits a 1-hr
// cache (server.json is immutable per version). Install writes the row
// straight to the same ``mcps`` table the manual "Add MCP" form uses, so
// the pool's hot-reload picks it up on the next message.

export type MarketplaceCard = {
  name: string;
  version?: string;
  title?: string;
  description?: string;
  status?: string;
  _meta?: Record<string, unknown>;
};

export type MarketplaceField = {
  name: string;
  isSecret: boolean;
  isRequired: boolean;
  description?: string;
  default?: string;
  value_template?: string;
};

export type MarketplacePlaceholder = {
  token: string;
  description?: string;
};

export type MarketplacePackage = {
  index: number;
  runtime: string;
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: string;
  env_required: MarketplaceField[];
  placeholders: MarketplacePlaceholder[];
  supported: boolean;
};

export type MarketplaceRemote = {
  index: number;
  url?: string;
  transport?: string;
  header_required: MarketplaceField[];
  placeholders: MarketplacePlaceholder[];
};

export type MarketplaceRequirements = {
  packages: MarketplacePackage[];
  remotes: MarketplaceRemote[];
};

export type MarketplaceSearchResult = {
  servers: MarketplaceCard[];
  nextCursor?: string;
  count?: number;
};

export type MarketplaceServerDetail = {
  server: any;
  _meta?: Record<string, unknown>;
  requirements: MarketplaceRequirements;
};

export type MarketplaceInstallChoice = { kind: 'package' | 'remote'; index: number };

export type MarketplaceInstallPayload = {
  name: string;
  version?: string;
  choice: MarketplaceInstallChoice;
  install_name?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  placeholders?: Record<string, string>;
};

export type MarketplaceInstallError = {
  status: number;
  error: string;
  suggested_name?: string;
};

export async function searchMcpMarketplace(
  q: string,
  cursor?: string,
  limit?: number,
): Promise<MarketplaceSearchResult> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return await get<MarketplaceSearchResult>(`/api/marketplace/search${qs ? `?${qs}` : ''}`);
}

export async function getMarketplaceServer(
  name: string,
  version: string = 'latest',
): Promise<MarketplaceServerDetail> {
  const params = new URLSearchParams({ name, version });
  return await get<MarketplaceServerDetail>(`/api/marketplace/servers?${params.toString()}`);
}

/**
 * Install an MCP from the marketplace. Returns the new MCPEntry on success.
 *
 * On 409 (name collision) the gateway returns ``{error, suggested_name}``;
 * we surface that as a typed ``MarketplaceInstallError`` thrown from this
 * function so the caller can offer the suggestion inline.
 */
export async function installFromMarketplace(
  payload: MarketplaceInstallPayload,
): Promise<MCPEntry> {
  const res = await fetch(`${baseUrl}/api/marketplace/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const err: MarketplaceInstallError = {
      status: res.status,
      error: (body && body.error) || text || `HTTP ${res.status}`,
      suggested_name: body && body.suggested_name,
    };
    throw err;
  }
  return (body as { mcp: MCPEntry }).mcp;
}

// ── DB-backed Model catalog (/api/models) ──
//
// Each row is a (provider_id, model) pair under a provider row. The
// response carries the enriched provider_name + framework + derived
// runtime_id so the UI doesn't have to re-join.
//
// Available models (what a vendor actually exposes for a given API
// key) live at /api/models/available?provider_id=N.

export async function listDbModels(opts?: {
  providerId?: number;
  framework?: 'api-based';
  enabledOnly?: boolean;
  kind?: 'llm' | 'tts' | 'stt';
}): Promise<ModelEntry[]> {
  const params = new URLSearchParams();
  if (opts?.providerId) params.set('provider_id', String(opts.providerId));
  if (opts?.framework) params.set('framework', opts.framework);
  if (opts?.enabledOnly) params.set('enabled_only', '1');
  if (opts?.kind) params.set('kind', opts.kind);
  const qs = params.toString();
  const data = await get<{ models: ModelEntry[] }>(`/api/models${qs ? `?${qs}` : ''}`);
  return (data.models || []).map(normalizeModel);
}

export async function createDbModel(entry: {
  provider_id: number;
  model: string;
  display_name?: string;
  tier_hint?: string;
  enabled?: boolean;
  is_classifier?: boolean;
  metadata?: Record<string, unknown>;
  // ``llm`` (default) goes to the router; ``tts`` / ``stt`` rows
  // are picked by the audio resolvers and dispatched via LiteLLM.
  kind?: 'llm' | 'tts' | 'stt';
}): Promise<ModelEntry> {
  const data = await post<{ model: ModelEntry }>('/api/models', entry);
  return normalizeModel(data.model);
}

// Make this model the default router — the entry model that leads a
// turn when the session has no pin. Multiple rows may carry the flag at
// once; only the first enabled one in catalog order leads, the rest are
// ordered fallbacks. Narrow PUT that only touches this row; other flags
// stay intact. Named for the ``is_classifier`` wire field it writes, not
// for any classifier call — there isn't one.
export async function setClassifierModel(modelId: number): Promise<ModelEntry> {
  return updateDbModel(modelId, { is_classifier: true });
}

export async function unsetClassifierModel(modelId: number): Promise<ModelEntry> {
  return updateDbModel(modelId, { is_classifier: false });
}

export async function updateDbModel(modelId: number, patchBody: Partial<ModelEntry>): Promise<ModelEntry> {
  const data = await put<{ model: ModelEntry }>(`/api/models/${modelId}`, patchBody);
  return normalizeModel(data.model);
}

export async function deleteDbModel(modelId: number): Promise<void> {
  await del(`/api/models/${modelId}`);
}

export async function enableDbModel(modelId: number): Promise<ModelEntry> {
  const data = await post<{ model: ModelEntry }>(`/api/models/${modelId}/enable`, {});
  return normalizeModel(data.model);
}

export async function disableDbModel(modelId: number): Promise<ModelEntry> {
  const data = await post<{ model: ModelEntry }>(`/api/models/${modelId}/disable`, {});
  return normalizeModel(data.model);
}

export async function listAvailableModels(providerId: number): Promise<AvailableModel[]> {
  const data = await get<{ provider_id: number; provider: string; framework: string; models: AvailableModel[] }>(
    `/api/models/available?provider_id=${providerId}`,
  );
  return data.models;
}

// ── Sessions API ──

export interface SessionEntry {
  session_id: string;
  client_id: string;
  title: string | null;
  model: string | null;
  framework: string | null;
  created_at: number | null;
  last_active_at: number | null;
  /** Child-session linkage (from the server's metadata JSON): the parent this
   *  session was spawned from, what spawned it, and a fine label. Drive the
   *  sidebar origin chip + the "← parent" breadcrumb. */
  parent_session_id?: string | null;
  origin?: string | null;
  kind?: string | null;
  /** True while the gateway still has live stream work for this session. */
  _live?: boolean | null;
}

export interface SessionListResponse {
  sessions: SessionEntry[];
}

/** Adapt an authorized v2 activity summary into the small metadata shape the
 * chat store needs. Message/tool content remains on-demand through the v2
 * detail endpoints; this never recreates the legacy full-session listing. */
export function sessionEntryFromActivity(item: ActivityItem): SessionEntry | null {
  if (item.kind !== 'chat' && item.kind !== 'delegated_session') return null;
  const sessionId = item.session_id || item.resource_id;
  if (!sessionId) return null;
  const occurredAt = Date.parse(item.occurred_at);
  const updatedAt = Date.parse(item.updated_at);
  return {
    session_id: sessionId,
    client_id: '',
    title: item.title,
    model: null,
    framework: null,
    created_at: Number.isFinite(occurredAt) ? Math.floor(occurredAt / 1000) : null,
    last_active_at: Number.isFinite(updatedAt) ? Math.floor(updatedAt / 1000) : null,
    parent_session_id: item.parent?.kind === 'session' ? item.parent.id : null,
    origin: item.origin || (item.kind === 'delegated_session' ? 'delegation' : 'chat'),
    kind: item.kind,
    _live: item.live,
  };
}

// ── Unified operational history/search beta ──

export async function getUnifiedCapabilities(signal?: AbortSignal): Promise<CapabilitiesResponse> {
  return get<CapabilitiesResponse>('/api/capabilities', signal);
}

export async function listUnifiedHistory(
  query: HistoryQuery = {},
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (query.kinds?.length) params.set('kinds', query.kinds.join(','));
  if (query.status?.length) params.set('status', query.status.join(','));
  if (query.origin) params.set('origin', query.origin);
  if (query.parent_type) params.set('parent_type', query.parent_type);
  if (query.parent_id) params.set('parent_id', query.parent_id);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.include_children != null) {
    params.set('include_children', query.include_children ? 'true' : 'false');
  }
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.toString();
  return get<HistoryPage>(`/api/history${suffix ? `?${suffix}` : ''}`, signal);
}

/** Causal automation runs launched from one session's normalized tool
 * invocations. Unlike the global activity parent, this relation follows the
 * caller session and therefore remains complete across workflow/task/event
 * definition kinds. */
export async function listSessionRelatedRuns(
  sessionId: string,
  query: { limit?: number; cursor?: string; includeDescendants?: boolean } = {},
  signal?: AbortSignal,
): Promise<SessionRelatedRunsPage> {
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 100)));
  params.set('limit', String(limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.includeDescendants != null) {
    params.set('include_descendants', query.includeDescendants ? 'true' : 'false');
  }
  return get<SessionRelatedRunsPage>(
    `/api/sessions/${encodeURIComponent(sessionId)}/related-runs?${params.toString()}`,
    signal,
  );
}

/** ACL-filtered, cycle-safe session subtree. The server snapshots the whole
 * normalized lineage, while this client follows it one bounded page at a
 * time so a large delegation tree never blocks opening the drawer. */
export async function listSessionDescendants(
  sessionId: string,
  query: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<SessionDescendantsPage> {
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 100)));
  params.set('limit', String(limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return get<SessionDescendantsPage>(
    `/api/sessions/${encodeURIComponent(sessionId)}/descendants?${params.toString()}`,
    signal,
  );
}

export async function searchOperationalHistory(
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchPage> {
  return post<SearchPage>('/api/search', request, signal);
}

export async function listSessionMessages(
  sessionId: string,
  query: SessionMessagesQuery = {},
  signal?: AbortSignal,
): Promise<SessionMessagePage> {
  const params = new URLSearchParams();
  if ('around' in query && query.around) {
    params.set('around', query.around);
    if (query.before != null) params.set('before', String(query.before));
    if (query.after != null) params.set('after', String(query.after));
  } else if ('cursor' in query && query.cursor) {
    params.set('cursor', query.cursor);
    params.set('direction', query.direction);
    if (query.limit != null) params.set('limit', String(query.limit));
  } else if ('limit' in query && query.limit != null) {
    params.set('limit', String(query.limit));
  }
  const suffix = params.toString();
  return get<SessionMessagePage>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix ? `?${suffix}` : ''}`,
    signal,
  );
}

export async function getToolInvocationDetail(
  toolInvocationId: string,
  signal?: AbortSignal,
): Promise<ToolInvocationDetail> {
  return get<ToolInvocationDetail>(
    `/api/tool-invocations/${encodeURIComponent(toolInvocationId)}`,
    signal,
  );
}

export async function getWorkflowRunDetail(
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunDetail> {
  return get<WorkflowRunDetail>(`/api/workflow-runs/${encodeURIComponent(runId)}`, signal);
}

export async function getScheduledRunDetail(
  runId: string,
  signal?: AbortSignal,
): Promise<ScheduledRunDetail> {
  return get<ScheduledRunDetail>(`/api/scheduled-runs/${encodeURIComponent(runId)}`, signal);
}

export async function getEventDeliveryDetail(
  deliveryId: string,
  signal?: AbortSignal,
): Promise<EventDeliveryDetail> {
  return get<EventDeliveryDetail>(`/api/event-deliveries/${encodeURIComponent(deliveryId)}`, signal);
}

export async function fetchSessions(): Promise<SessionEntry[]> {
  const data = await get<SessionListResponse>('/api/sessions');
  return data.sessions;
}

/** List just the children a session spawned (delegated sub-agents, or the AI
 *  node / firing sessions under a workflow-run / scheduled-task root). Powers
 *  the parent transcript's delegation cards and the run screen. */
export async function fetchChildSessions(
  parentSessionId: string,
  limit: number = 200,
): Promise<SessionEntry[]> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const data = await get<SessionListResponse>(
    `/api/sessions?parent=${encodeURIComponent(parentSessionId)}&limit=${boundedLimit}`,
  );
  return data.sessions;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await del(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

// Tool-call carrier on a rehydrated message — the server's native
// ``ToolExecution.to_dict()`` shape. Phase is derived in the renderer
// via ``toolPhase(toolInfo)``; the server does not emit a status enum.
export interface SessionRunMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'compaction';
  text: string;
  timestamp: number;
  toolInfo?: {
    tool_name: string;
    tool_call_id?: string;
    tool_args?: Record<string, any>;
    tool_call_error?: boolean | null;
    result?: string | null;
    // Additional tool-execution fields (metrics, child_run_id, …) pass
    // through verbatim from the server.
    [key: string]: any;
  };
  /** Set on ``role: 'compaction'`` rows — a folded-turns recap (vision §2),
   *  rebuilt into the same CompactionCard the live ``session_compacted`` frame
   *  draws. The server always sends the terminal (done) shape here. */
  compaction?: {
    phase?: 'running' | 'done' | 'error';
    folded_runs?: number;
    kept_runs_count?: number;
    summary_chars?: number;
    tokens_before?: number;
    tokens_after?: number;
  };
  attachments?: Record<string, unknown>[];
  parts?: unknown[];
  artifacts?: unknown[];
  model?: string;
  /** Per-message authorship (human handle/display, or an agent-self seed).
   *  Server-provided; absent on legacy rows. */
  author?: { kind: string; handle?: string; display?: string };
}

export interface SessionRunsResponse {
  session_id: string;
  messages: SessionRunMessage[];
}

// One place to turn a server-rehydrated message into a ChatMessage, so the
// author / toolInfo passthrough stays consistent across every loader (chat
// store hydration and the run-detail transcript alike).
export function runMsgToChat(m: SessionRunMessage): ChatMessage {
  const attachments = normalizeAttachmentRefs(m.attachments);
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    toolInfo: m.toolInfo as ToolInfo | undefined,
    // A compaction recap row (vision §2) rebuilds the same CompactionCard
    // the live frame draws; the server sends the terminal (done) shape.
    compactionInfo: m.compaction
      ? {
          phase: m.compaction.phase ?? 'done',
          foldedRuns: m.compaction.folded_runs,
          keptRuns: m.compaction.kept_runs_count,
          summaryChars: m.compaction.summary_chars,
          tokensBefore: m.compaction.tokens_before,
          tokensAfter: m.compaction.tokens_after,
        } as CompactionInfo
      : undefined,
    attachments: attachments.length ? attachments : undefined,
    parts: normalizeMessageContent(m.parts, m.artifacts, m.text, attachments),
    model: m.model,
    author: m.author as MessageAuthor | undefined,
  };
}

export async function fetchSessionRuns(sessionId: string, limit?: number): Promise<SessionRunMessage[]> {
  const qs = limit ? `?limit=${limit}` : '';
  const data = await get<SessionRunsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/runs${qs}`);
  return data.messages || [];
}

/** Fetch the context-window composition for a session (Claude-Code /context).
 *  Backs the always-visible context panel's initial paint + turn reconcile.
 *  Works for any session kind (chat, sub-agent, scheduled firing, workflow
 *  AI node) since they are all rows in the sessions table. */
export async function getSessionContext(sessionId: string): Promise<SessionContext> {
  return get<SessionContext>(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
}

export async function updateSessionMetadata(
  sessionId: string,
  body: { title?: string; model?: string },
): Promise<{ ok: boolean }> {
  if (!body.title && !body.model) return { ok: true };
  return patch(`/api/sessions/${encodeURIComponent(sessionId)}`, body);
}

// ── Per-session model pin (/api/sessions/{id}/model) ──
//
// The pin belongs to the SESSION, not to this device. A conversation
// resumed from the CLI, another client, or a channel has to answer with
// the model the user chose here — so the switcher writes through to the
// server instead of keeping the choice in local state.

/** Read the session's model pin. ``runtime_id: null`` means "no pin —
 *  the router picks the entry model". */
export async function getSessionModelPin(sessionId: string): Promise<SessionModelPin> {
  return get<SessionModelPin>(`/api/sessions/${encodeURIComponent(sessionId)}/model`);
}

/** Pin the session to ``runtimeId``. The server rejects a model that is
 *  unregistered (404) or disabled (400); both surface as a thrown Error
 *  carrying the server's message. */
export async function pinSessionModel(
  sessionId: string,
  runtimeId: string,
): Promise<{ session_id: string; runtime_id: string; pinned: boolean }> {
  return put(`/api/sessions/${encodeURIComponent(sessionId)}/model`, { runtime_id: runtimeId });
}

/** Drop the pin — the session goes back to normal entry-model resolution. */
export async function unpinSessionModel(sessionId: string): Promise<void> {
  await del(`/api/sessions/${encodeURIComponent(sessionId)}/model`);
}

// ── System telemetry ──

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  return get<SystemSnapshot>('/api/system');
}

// ── Interactive terminals ──

export interface RawTerminal {
  terminal_id: string;
  pid: number | null;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  running: boolean;
}

/** List the live PTY terminals this device already has open on the
 *  gateway host. Used to seed the System tab's terminal list on mount. */
export async function getTerminals(): Promise<RawTerminal[]> {
  const data = await get<{ terminals: RawTerminal[] }>('/api/terminals');
  return data.terminals ?? [];
}

// ── Network: users, agents, invitations ──

export interface NetworkUser {
  handle: string;
  status: string;
  pake_algo: string;
  created_at: number;
}

export interface NetworkAgent {
  handle: string;
  node_id: string;
  label: string | null;
  owner_handle: string;
  added_at: number;
  last_seen: number | null;
}

export interface NetworkInvitation {
  code: string;
  role: 'user' | 'device' | 'agent';
  bind_to: string;
  uses_left: number;
  created_at: number;
  expires_at: number;
  created_by: string;
}

export interface MintInvitationResult {
  ticket: string;
  code: string;
  role: 'user' | 'device' | 'agent';
  bind_to: string;
  intent: string;
  expires_at: number;
  uses_left: number;
}

export async function listNetworkUsers(): Promise<NetworkUser[]> {
  const d = await get<{ users: NetworkUser[] }>('/api/network/users');
  return d.users || [];
}

export async function listNetworkAgents(): Promise<NetworkAgent[]> {
  const d = await get<{ agents: NetworkAgent[] }>('/api/network/agents');
  return d.agents || [];
}

export async function listNetworkInvitations(): Promise<NetworkInvitation[]> {
  const d = await get<{ invitations: NetworkInvitation[] }>('/api/network/invitations');
  return d.invitations || [];
}

export async function mintNetworkInvitation(body: {
  handle?: string;
  role?: 'user' | 'device' | 'agent';
  ttl?: number;
}): Promise<MintInvitationResult> {
  return post<MintInvitationResult>('/api/network/invitations', body);
}

async function delJson<T>(path: string): Promise<T> {
  const init = withTimeout({ method: 'DELETE' }, `DELETE ${path}`);
  try {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new ApiError(res.status, `API ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimer(init);
  }
}

export async function revokeNetworkInvitation(code: string): Promise<{ revoked: boolean }> {
  return delJson(`/api/network/invitations/${encodeURIComponent(code)}`);
}

export async function patchNetworkUser(
  handle: string, body: { status?: 'active' | 'suspended' },
): Promise<{ updated: boolean }> {
  return patch(`/api/network/users/${encodeURIComponent(handle)}`, body);
}

export async function deleteNetworkUser(handle: string): Promise<{ deleted: boolean }> {
  return delJson(`/api/network/users/${encodeURIComponent(handle)}`);
}

export async function patchNetworkAgent(
  handle: string, body: { label?: string; owner_handle?: string },
): Promise<{ updated: boolean }> {
  return patch(`/api/network/agents/${encodeURIComponent(handle)}`, body);
}

export async function deleteNetworkAgent(handle: string): Promise<{ deleted: boolean }> {
  return delJson(`/api/network/agents/${encodeURIComponent(handle)}`);
}

// ── Budgets (/api/budgets) ──
//
// The list view reads `/usage`, not `/api/budgets`: it returns every rule
// PLUS its live meter, so one call feeds both the rows and the gauges.
// Writes nudge the live BudgetGuard server-side, so a new cap takes effect
// on the next turn rather than one TTL later.

/** Every budget rule with its current spend against the limit. */
export async function listBudgetUsage(enabledOnly = false): Promise<BudgetUsage[]> {
  const qs = enabledOnly ? '?enabled_only=1' : '';
  const data = await get<{ usage: BudgetUsage[] }>(`/api/budgets/usage${qs}`);
  return data.usage;
}

/** Create a cap. 409 if one already exists for the same
 *  scope/metric/window — that quadruple is the rule's identity. */
export async function createBudget(input: CreateBudgetInput): Promise<BudgetRule> {
  return post<BudgetRule>('/api/budgets', input);
}

export async function updateBudget(id: string, patchBody: UpdateBudgetInput): Promise<BudgetRule> {
  return put<BudgetRule>(`/api/budgets/${encodeURIComponent(id)}`, patchBody);
}

export async function deleteBudget(id: string): Promise<void> {
  await del(`/api/budgets/${encodeURIComponent(id)}`);
}

// ── Event log (/api/logs) ──
//
// The unified log every part of the agent writes to: turns, model calls,
// MCP invocations, delegations, task fires, workflow steps, errors. The
// server reads the file backwards, so a large `lines` is cheap unless an
// `event` prefix forces it to scan far back.

/** Last `lines` entries, oldest-first, optionally filtered by event prefix
 *  (`tool.` matches `tool.error`, `tool.call`, …). */
export async function getLogs(lines = 200, eventPrefix?: string): Promise<LogEntry[]> {
  const params = new URLSearchParams({ lines: String(lines) });
  if (eventPrefix) params.set('event', eventPrefix);
  return get<LogEntry[]>(`/api/logs?${params.toString()}`);
}

/** Truncate `events.jsonl`. Destructive and not undoable — the agent
 *  reads this log to diagnose itself, so confirm before calling. */
export async function clearLogs(): Promise<void> {
  await del('/api/logs');
}

// ── Quality report (/api/quality) ──

/** Quality / cost / recall over the last `windowSeconds` (default 24h,
 *  server-capped at 90 days). One reverse scan of the event log. */
export async function getQualityReport(windowSeconds?: number): Promise<QualityReport> {
  const qs = windowSeconds ? `?window=${Math.round(windowSeconds)}` : '';
  return get<QualityReport>(`/api/quality${qs}`);
}

// Hard-stop in-flight run(s) of a workflow. The mirror of
// ``stopScheduledTask`` — the server deliberately gives the two the same
// status codes and envelope so the app can treat them as one gesture —
// with ``runId`` added, because a workflow may have several concurrent
// runs and a run screen stops only the one it is showing.
//
// Stopping a run does NOT stop the workflow from firing again: that is
// ``enabled: false`` or removing its trigger-schedule block. A no-op
// (the run already finished) returns count 0, not an error.
export async function stopWorkflow(
  id: string,
  opts: { runId?: string; wait?: boolean; timeoutS?: number } = {},
): Promise<{ workflow_id: string; name: string; stopped: string[]; count: number; runs?: unknown[] }> {
  return post(`/api/workflows/${encodeURIComponent(id)}/stop`, {
    run_id: opts.runId,
    wait: opts.wait ?? false,
    timeout_s: opts.timeoutS,
  });
}

// ── Slash-command registry (/api/commands) ──

/** The gateway's command specs. The chat composer merges these with its
 *  own local handlers instead of carrying a hardcoded list, so a command
 *  added server-side appears without an app release. */
export async function getGatewayCommands(): Promise<GatewayCommandSpec[]> {
  const data = await get<{ commands: GatewayCommandSpec[] }>('/api/commands');
  return data.commands;
}

// Reconcile the vault's derived index with what is on disk. The index is a
// rebuildable cache over the Markdown — never a second source of truth — so
// this is always safe: delete it and the next sync reconstructs it, and the
// agent forgets nothing. ``force`` re-reads every note instead of trusting
// mtimes, which is what you want after an out-of-band edit (a git pull, a
// file written straight into the vault folder).
export async function syncVaultIndex(force = false): Promise<{
  added: number; updated: number; deleted: number; unchanged: number;
  total: number; links: number; broken: number; elapsed_ms: number;
}> {
  return post(`/api/vault/index/sync?force=${force ? 'true' : 'false'}`);
}

// ── Skills (/api/skills) ──
//
// Until the gateway grew this surface, the skill library was reachable only
// through the agent's own MCP tools — so reading what the agent had learned
// meant asking the agent. §10 makes the gateway the only public surface;
// this is the door.

/** Skill metadata. Archived skills are excluded unless asked for, matching
 *  what the prompt index does — the default view is what the agent can
 *  actually reach. */
export async function listSkills(includeArchived = false): Promise<SkillSummary[]> {
  const qs = includeArchived ? '?include_archived=1' : '';
  const data = await get<{ skills: SkillSummary[] }>(`/api/skills${qs}`);
  return data.skills;
}

/** One skill's full body plus any files bundled beside it. */
export async function getSkill(name: string): Promise<SkillDetail> {
  return get<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);
}

export async function createSkill(input: CreateSkillInput): Promise<SkillWriteResult> {
  return post<SkillWriteResult>('/api/skills', input);
}

export async function updateSkill(
  name: string,
  input: { description?: string; category?: string; body?: string },
): Promise<SkillWriteResult> {
  return put<SkillWriteResult>(`/api/skills/${encodeURIComponent(name)}`, input);
}

/** Retire in place: the file stays on disk and drops out of the prompt
 *  index. Reversible, unlike `deleteSkill`. */
export async function archiveSkill(name: string): Promise<SkillWriteResult> {
  return post<SkillWriteResult>(`/api/skills/${encodeURIComponent(name)}/archive`, {});
}

/** Remove the folder from disk. Irreversible — offer `archiveSkill` first. */
export async function deleteSkill(name: string): Promise<void> {
  await del(`/api/skills/${encodeURIComponent(name)}`);
}

// ── Serving accounts (/api/accounts) ──

/** The accounts serving each enabled provider, with quota where the
 *  upstream reports one. Probes run server-side under a short timeout, so a
 *  dead proxy comes back as `reachable: false` rather than stalling. */
export async function listServingAccounts(): Promise<ProviderAccounts[]> {
  const data = await get<{ providers: ProviderAccounts[] }>('/api/accounts');
  return data.providers;
}
