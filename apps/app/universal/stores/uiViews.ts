/** Account-scoped OA-UI custom-view store.
 *
 * REST owns discovery/snapshots; WebSocket subscriptions only run while a
 * surface is focused and visible. A reference count lets the same view appear
 * in more than one message without opening duplicate server pipelines.
 */

import { create } from 'zustand';
import type {
  UIAction,
  UICapabilities,
  UIDataEntry,
  UIJson,
  UINode,
  UISource,
  UISpec,
  UIView,
  UIViewStatus,
  UIViewSummary,
} from '../../common/ui-views';
import type { ServerMessage } from '../../common/types';
import {
  getUICapabilities,
  getUIView,
  invokeUIViewAction,
  isUnsupportedByAgent,
  listUIViews,
  reactivateUIView,
} from '../services/api';
import type { OpenAgentWS } from '../services/ws';
import { useConnection } from './connection';

type Support = 'unknown' | 'available' | 'unavailable';

export interface UISourceRuntimeStatus {
  status: string;
  error?: string;
  updatedAt?: string | number;
}

interface UIViewState {
  accountId: string | null;
  support: Support;
  capabilities: UICapabilities | null;
  items: UIViewSummary[];
  views: Record<string, UIView>;
  loadingList: boolean;
  loadingViews: Record<string, boolean>;
  listError: string | null;
  viewErrors: Record<string, string | null>;
  sourceStatus: Record<string, Record<string, UISourceRuntimeStatus>>;
  boundWs: OpenAgentWS | null;
  unbind: (() => void) | null;

  initialize: (accountId: string, force?: boolean) => Promise<void>;
  clear: () => void;
  loadList: () => Promise<void>;
  loadView: (viewId: string, options?: boolean | { force?: boolean; revision?: number }) => Promise<UIView | null>;
  subscribe: (viewId: string, options?: { revision?: number; knownRevision?: number }) => () => void;
  invokeAction: (
    viewId: string,
    actionId: string,
    input: unknown,
    actionRevision: number,
    pinnedRefreshRevision?: number,
  ) => Promise<unknown>;
  reactivate: (viewId: string) => Promise<UIView | null>;
  ensureWs: () => void;
}

interface ActiveSubscription {
  count: number;
  subscriptionId: string;
  viewId: string;
  revision?: number;
  knownRevision?: number;
}

const activeSubscriptions = new Map<string, ActiveSubscription>();
const lastSequences = new Map<string, number>();
let subscriptionNonce = 0;
const UI_VIEW_PAGE_LIMIT = 100;

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function revision(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeSurface(value: unknown): UIViewSummary['surface'] {
  return value === 'sidebar' ? 'sidebar' : 'inline';
}

function normalizeStatus(value: unknown): UIViewStatus {
  return value === 'stale' || value === 'expired' || value === 'deleted' || value === 'error'
    ? value
    : 'active';
}

export function normalizeUISummary(raw: unknown): UIViewSummary | null {
  const row = record(raw);
  const id = row.id ?? row.viewId ?? row.view_id;
  if (typeof id !== 'string' || !id) return null;
  return {
    id,
    surface: normalizeSurface(row.surface),
    title: text(row.title, 'Untitled view'),
    description: optionalText(row.description),
    icon: optionalText(row.icon),
    revision: revision(row.revision),
    status: normalizeStatus(row.status),
    sessionId: optionalText(row.sessionId ?? row.session_id),
    expiresAt: row.expiresAt ?? row.expires_at ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
    sidebarOrder: typeof (row.sidebarOrder ?? row.sidebar_order) === 'number'
      ? (row.sidebarOrder ?? row.sidebar_order) : undefined,
    sidebarGroup: optionalText(row.sidebarGroup ?? row.sidebar_group),
    lastViewedAt: row.lastViewedAt ?? row.last_viewed_at,
    frozen: row.frozen === true,
    frozenAt: row.frozenAt ?? row.frozen_at ?? null,
    // This is an authorization decision, not a permissive wire-format
    // coercion. Missing/legacy/truthy values must all remain read-only.
    canExecute: (row.canExecute ?? row.can_execute) === true,
  };
}

function normalizeNode(raw: unknown, state: { count: number }, depth = 0): UINode | null {
  if (depth > 24 || state.count >= 500) return null;
  const row = record(raw);
  if (typeof row.type !== 'string' || !row.type || row.type.length > 64) return null;
  state.count += 1;
  const props = record(row.props);
  const childrenRaw = Array.isArray(row.children) ? row.children : [];
  const children: UINode[] = [];
  for (const child of childrenRaw) {
    const normalized = normalizeNode(child, state, depth + 1);
    if (normalized) children.push(normalized);
  }
  return {
    type: row.type,
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    ...(Object.keys(props).length ? { props } : {}),
    ...(children.length ? { children } : {}),
  } as UINode;
}

function normalizeSpec(raw: unknown, schemaVersion: number): UISpec | null {
  const spec = record(raw);
  const root = normalizeNode(spec.root ?? spec.document ?? spec.node, { count: 0 });
  if (!root) return null;
  const version = revision(spec.schemaVersion ?? spec.schema_version ?? schemaVersion);
  if (version !== 1) return null;
  const normalized: UISpec = { schemaVersion: 1, root };
  const stateRows = record(spec.states);
  const states: NonNullable<UISpec['states']> = {};
  for (const key of ['loading', 'empty', 'stale', 'error'] as const) {
    if (!(key in stateRows)) continue;
    const node = normalizeNode(stateRows[key], { count: 0 });
    if (node) states[key] = node;
  }
  if (Object.keys(states).length) normalized.states = states;
  return normalized;
}

function normalizeData(raw: unknown): Record<string, UIDataEntry> {
  const rows = record(raw);
  const out: Record<string, UIDataEntry> = {};
  for (const [key, value] of Object.entries(rows)) {
    const row = record(value);
    const wrapped = Object.prototype.hasOwnProperty.call(row, 'value');
    const rawStatus = row.status;
    const statusValue = typeof rawStatus === 'string'
      ? rawStatus
      : text(record(rawStatus).status ?? record(rawStatus).state, 'ready');
    const rawError = row.error;
    out[key] = {
      value: (wrapped ? row.value : value) as UIJson,
      version: revision(row.version),
      generation: revision(row.generation),
      sequence: revision(row.sequence ?? row.seq),
      updatedAt: row.updatedAt ?? row.updated_at ?? 0,
      status: normalizeDataStatus(statusValue),
      error: typeof rawError === 'string' ? rawError : optionalText(record(rawError).message),
    };
  }
  return out;
}

function normalizeDataStatus(value: unknown): UIDataEntry['status'] {
  return value === 'loading' || value === 'empty' || value === 'stale' || value === 'error'
    ? value
    : 'ready';
}

function dataEntryIsNewer(candidate: UIDataEntry, current: UIDataEntry): boolean {
  const candidateGeneration = candidate.generation ?? 0;
  const currentGeneration = current.generation ?? 0;
  if (candidateGeneration !== currentGeneration) return candidateGeneration > currentGeneration;
  const candidateSequence = candidate.sequence ?? 0;
  const currentSequence = current.sequence ?? 0;
  if (candidateSequence !== currentSequence) return candidateSequence > currentSequence;
  if (candidate.version !== current.version) return candidate.version > current.version;
  return timestamp(candidate.updatedAt) >= timestamp(current.updatedAt);
}

function preserveNewerData(candidate: UIView, current?: UIView): UIView {
  if (!current || current.id !== candidate.id || current.revision !== candidate.revision) return candidate;
  const data = { ...candidate.data };
  for (const [key, entry] of Object.entries(current.data)) {
    const incoming = data[key];
    if (!incoming || dataEntryIsNewer(entry, incoming)) data[key] = entry;
  }
  return { ...candidate, data };
}

function normalizeSources(raw: unknown): Record<string, UISource> {
  const sourceRows = Array.isArray(raw)
    ? Object.fromEntries(raw.map((item) => {
        const row = record(item);
        return [row.key, row];
      }).filter(([key]) => typeof key === 'string'))
    : record(raw);
  const out: Record<string, UISource> = {};
  for (const [key, value] of Object.entries(sourceRows)) {
    const row = record(value);
    out[key] = {
      key,
      driver: text(row.driver, 'static') as UISource['driver'],
      activation: text(row.activation ?? row.mode, 'manual') as UISource['activation'],
      status: text(row.status, 'idle'),
      config: record(row.config) as Record<string, UIJson>,
      outputSchema: row.outputSchema ?? row.output_schema,
      updatedAt: row.updatedAt ?? row.updated_at,
      expiresAt: row.expiresAt ?? row.expires_at,
    };
  }
  return out;
}

function normalizeActions(raw: unknown): Record<string, UIAction> {
  const actionRows = Array.isArray(raw)
    ? Object.fromEntries(raw.map((item) => {
        const row = record(item);
        return [row.id, row];
      }).filter(([id]) => typeof id === 'string'))
    : record(raw);
  const out: Record<string, UIAction> = {};
  for (const [id, value] of Object.entries(actionRows)) {
    const row = record(value);
    out[id] = {
      id,
      kind: text(row.kind, 'local') as UIAction['kind'],
      label: optionalText(row.label),
      inputSchema: row.inputSchema ?? row.input_schema,
      confirm: row.confirm === true,
      config: record(row.config) as Record<string, UIJson>,
    };
  }
  return out;
}

export function normalizeUIView(raw: unknown): UIView | null {
  const wrapper = record(raw);
  const row = record(wrapper.view ?? raw);
  const summary = normalizeUISummary(row);
  if (!summary) return null;
  const schemaVersion = revision(row.schemaVersion ?? row.schema_version ?? record(row.spec).schemaVersion ?? 1);
  const spec = normalizeSpec(row.spec, schemaVersion);
  if (!spec) return null;
  return {
    ...summary,
    schemaVersion,
    markup: optionalText(row.markup),
    spec,
    data: normalizeData(row.data),
    sources: normalizeSources(row.sources),
    actions: normalizeActions(row.actions),
  };
}

function normalizeCapabilities(raw: unknown): UICapabilities {
  const wrapper = record(raw);
  const row = record(wrapper.capabilities ?? raw);
  const schemasRaw = row.schemaVersions ?? row.schema_versions ?? row.versions;
  const surfacesRaw = Array.isArray(row.surfaces) ? row.surfaces : ['inline', 'sidebar'];
  return {
    version: revision(row.version ?? row.customUiVersion ?? row.custom_ui_version ?? 1) || 1,
    schemaVersions: (Array.isArray(schemasRaw) ? schemasRaw : [1]).map(revision).filter(Boolean),
    surfaces: Array.from(new Set(surfacesRaw.map(normalizeSurface))),
    realtime: row.realtime !== false,
    maxNodes: row.maxNodes ?? row.max_nodes,
    maxDepth: row.maxDepth ?? row.max_depth,
    componentTypes: Array.isArray(row.componentTypes ?? row.component_types)
      ? (row.componentTypes ?? row.component_types).filter((item: unknown) => typeof item === 'string')
      : undefined,
  };
}

function listRows(raw: unknown): UIViewSummary[] {
  const wrapper = record(raw);
  const rows = Array.isArray(raw)
    ? raw
    : wrapper.items ?? wrapper.views ?? [];
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeUISummary)
    .filter((item): item is UIViewSummary => item != null)
    .sort(compareSidebarViews);
}

async function listAllSidebarViews(): Promise<UIViewSummary[]> {
  const byId = new Map<string, UIViewSummary>();
  let cursor: string | undefined;
  // Bound the walk even if a buggy gateway repeats a cursor forever.
  for (let page = 0; page < 10; page += 1) {
    // The Custom Views API deliberately caps pages at 100. Keep the client
    // contract inside that bound and follow cursors for larger collections.
    const raw = await listUIViews({ surface: 'sidebar', limit: UI_VIEW_PAGE_LIMIT, cursor });
    for (const item of listRows(raw)) byId.set(item.id, item);
    const wrapper = record(raw);
    const next = wrapper.nextCursor ?? wrapper.next_cursor;
    if (typeof next !== 'string' || !next || next === cursor) break;
    cursor = next;
  }
  return Array.from(byId.values()).sort(compareSidebarViews);
}

function compareSidebarViews(a: UIViewSummary, b: UIViewSummary): number {
  const group = (a.sidebarGroup ?? '').localeCompare(b.sidebarGroup ?? '');
  if (group) return group;
  const order = (a.sidebarOrder ?? Number.MAX_SAFE_INTEGER) - (b.sidebarOrder ?? Number.MAX_SAFE_INTEGER);
  return order || timestamp(b.updatedAt) - timestamp(a.updatedAt);
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function subscriptionForView(viewId: string): ActiveSubscription | undefined {
  return Array.from(activeSubscriptions.values()).find(
    (sub) => sub.viewId === viewId && sub.revision == null,
  );
}

function subscriptionById(subscriptionId: unknown): ActiveSubscription | undefined {
  if (typeof subscriptionId !== 'string') return undefined;
  return Array.from(activeSubscriptions.values()).find(
    (sub) => sub.subscriptionId === subscriptionId,
  );
}

function sendAllSubscriptions(ws: OpenAgentWS): void {
  for (const sub of activeSubscriptions.values()) {
    ws.subscribeUIView(sub.subscriptionId, sub.viewId, {
      revision: sub.revision,
      knownRevision: sub.knownRevision,
    });
  }
}

function subscriptionKey(viewId: string, revision?: number): string {
  return revision != null ? `${viewId}@${revision}` : `${viewId}@latest`;
}

function reconcileSubscriptionSnapshot(
  get: () => UIViewState,
  viewId: string,
  subscriptionId: unknown,
): void {
  const subscription = subscriptionById(subscriptionId);
  void get().loadView(
    viewId,
    subscription?.revision != null
      ? { revision: subscription.revision, force: true }
      : true,
  );
}

function mergeSummary(items: UIViewSummary[], summary: UIViewSummary): UIViewSummary[] {
  if (summary.surface !== 'sidebar') return items;
  const existing = items.find((item) => item.id === summary.id);
  if (existing && existing.revision > summary.revision) return items;
  const next = items.filter((item) => item.id !== summary.id);
  if (summary.status !== 'deleted') next.push(summary);
  return next.sort(compareSidebarViews);
}

function messageField(msg: Record<string, any>, camel: string, snake: string): any {
  return msg[camel] ?? msg[snake];
}

function handleWsMessage(msg: ServerMessage, set: any, get: () => UIViewState): void {
  const wire = msg as unknown as Record<string, any>;
  if (wire.type === 'auth_ok') {
    const ws = get().boundWs;
    if (ws) sendAllSubscriptions(ws);
    return;
  }
  if (wire.type === 'resource_event' && wire.resource === 'ui_view') {
    void get().loadList();
    return;
  }
  if (wire.type === 'ui_snapshot') {
    const view = normalizeUIView(wire.view ?? wire.snapshot);
    if (!view) return;
    const subscription = subscriptionById(
      messageField(wire, 'subscriptionId', 'subscription_id'),
    );
    const pinned = subscription?.revision != null;
    const cacheKey = pinned ? `${view.id}@${subscription.revision}` : view.id;
    if (
      subscription
      && (view.id !== subscription.viewId
        || (pinned && view.revision !== subscription.revision))
    ) {
      const cacheKey = subscriptionKey(subscription.viewId, subscription.revision)
        .replace(/@latest$/, '');
      set((state: UIViewState) => ({
        views: Object.fromEntries(
          Object.entries(state.views).filter(([key]) => key !== cacheKey),
        ),
        viewErrors: {
          ...state.viewErrors,
          [cacheKey]: 'The agent returned a mismatched View snapshot',
        },
      }));
      return;
    }
    const currentSnapshot = get().views[cacheKey];
    if (!pinned && currentSnapshot && currentSnapshot.revision > view.revision) return;
    if (subscription) {
      for (const [key, entry] of Object.entries(view.data)) {
        if ((entry.sequence ?? 0) > 0) {
          lastSequences.set(
            `${subscription.subscriptionId}:${key}:data:${entry.generation ?? 0}`,
            entry.sequence!,
          );
        }
      }
    }
    set((state: UIViewState) => {
      const merged = preserveNewerData(view, state.views[cacheKey]);
      const revisionKey = `${view.id}@${view.revision}`;
      return {
        views: {
          ...state.views,
          [cacheKey]: merged,
          [revisionKey]: preserveNewerData(merged, state.views[revisionKey]),
        },
        items: pinned ? state.items : mergeSummary(state.items, merged),
        viewErrors: { ...state.viewErrors, [cacheKey]: null },
      };
    });
    return;
  }
  if (wire.type === 'ui_data') {
    const viewId = messageField(wire, 'viewId', 'view_id');
    const subId = messageField(wire, 'subscriptionId', 'subscription_id');
    const key = wire.key;
    if (typeof viewId !== 'string' || typeof key !== 'string') return;
    const sequence = revision(wire.seq);
    const sequenceKey = `${subId ?? viewId}:${key}:data:${revision(wire.generation)}`;
    const lastSequence = lastSequences.get(sequenceKey);
    if (sequence && sequence <= (lastSequence ?? -1)) return;
    if (sequence && lastSequence != null && sequence > lastSequence + 1) {
      // A dropped frame must never leave a dashboard silently inconsistent.
      // REST returns an ACL-checked reconciliation snapshot; the live event is
      // still applied below so the screen does not visibly jump backwards.
      reconcileSubscriptionSnapshot(get, viewId, subId);
    }
    if (sequence) lastSequences.set(sequenceKey, sequence);
    set((state: UIViewState) => {
      const version = revision(wire.version);
      const entry: UIDataEntry = {
        value: wire.value as UIJson,
        version,
        generation: revision(wire.generation),
        sequence,
        updatedAt: wire.updatedAt ?? wire.updated_at ?? Date.now(),
        status: normalizeDataStatus(
          typeof wire.status === 'string'
            ? wire.status
            : record(wire.status).status ?? record(wire.status).state,
        ),
        error: typeof wire.error === 'string'
          ? wire.error
          : optionalText(record(wire.error).message),
      };
      const views = { ...state.views };
      let changed = false;
      for (const [cacheKey, current] of Object.entries(state.views)) {
        if (cacheKey !== viewId && !cacheKey.startsWith(`${viewId}@`)) continue;
        const prior = current.data[key];
        if (prior && !dataEntryIsNewer(entry, prior)) continue;
        views[cacheKey] = { ...current, data: { ...current.data, [key]: entry } };
        changed = true;
      }
      return changed ? { views } : state;
    });
    return;
  }
  if (wire.type === 'ui_source_status') {
    const viewId = messageField(wire, 'viewId', 'view_id');
    const key = wire.key;
    if (typeof viewId !== 'string' || typeof key !== 'string') return;
    const subId = messageField(wire, 'subscriptionId', 'subscription_id');
    const sequence = revision(wire.seq);
    const sequenceKey = `${subId ?? viewId}:${key}:source:${revision(wire.generation)}`;
    const lastSequence = lastSequences.get(sequenceKey);
    if (sequence && sequence <= (lastSequence ?? -1)) return;
    if (sequence && lastSequence != null && sequence > lastSequence + 1) {
      reconcileSubscriptionSnapshot(get, viewId, subId);
    }
    if (sequence) lastSequences.set(sequenceKey, sequence);
    const error = typeof wire.error === 'string' ? wire.error : optionalText(record(wire.error).message);
    set((state: UIViewState) => ({
      sourceStatus: {
        ...state.sourceStatus,
        [viewId]: {
          ...(state.sourceStatus[viewId] ?? {}),
          [key]: {
            status: text(wire.status, 'idle'),
            error,
            updatedAt: wire.updatedAt ?? wire.updated_at,
          },
        },
      },
    }));
    return;
  }
  if (wire.type === 'ui_view_changed') {
    const viewId = messageField(wire, 'viewId', 'view_id');
    if (typeof viewId !== 'string') return;
    const nextRevision = revision(wire.revision);
    const current = get().views[viewId];
    if (current && nextRevision <= current.revision) return;
    if (subscriptionForView(viewId)) void get().loadView(viewId, true);
    void get().loadList();
    return;
  }
  if (wire.type === 'ui_error') {
    const direct = messageField(wire, 'viewId', 'view_id');
    const subscriptionId = messageField(wire, 'subscriptionId', 'subscription_id');
    const subscription = subscriptionById(subscriptionId);
    const viaSub = subscription?.viewId;
    const viewId = typeof direct === 'string' ? direct : viaSub;
    if (!viewId) return;
    const cacheKey = subscription?.revision != null
      ? `${viewId}@${subscription.revision}`
      : viewId;
    const rawError = wire.message ?? wire.error;
    const message = typeof rawError === 'string'
      ? rawError
      : optionalText(record(rawError).message) ?? 'Live view error';
    set((state: UIViewState) => ({
      views: Object.fromEntries(
        Object.entries(state.views).filter(([key]) => key !== cacheKey),
      ),
      viewErrors: { ...state.viewErrors, [cacheKey]: message },
    }));
  }
}

export const useUIViews = create<UIViewState>((set, get) => ({
  accountId: null,
  support: 'unknown',
  capabilities: null,
  items: [],
  views: {},
  loadingList: false,
  loadingViews: {},
  listError: null,
  viewErrors: {},
  sourceStatus: {},
  boundWs: null,
  unbind: null,

  initialize: async (accountId, force = false) => {
    if (!force && get().accountId === accountId && get().support !== 'unknown') {
      get().ensureWs();
      return;
    }
    if (get().accountId !== accountId) {
      get().clear();
      set({ accountId });
    }
    get().ensureWs();
    set({ loadingList: true, listError: null });
    try {
      const [capabilitiesRaw, viewsRaw] = await Promise.all([
        getUICapabilities(),
        listAllSidebarViews(),
      ]);
      if (get().accountId !== accountId) return;
      set({
        support: 'available',
        capabilities: normalizeCapabilities(capabilitiesRaw),
        items: viewsRaw,
        loadingList: false,
      });
    } catch (error) {
      if (get().accountId !== accountId) return;
      if (isUnsupportedByAgent(error)) {
        set({ support: 'unavailable', capabilities: null, items: [], loadingList: false });
      } else {
        set({ support: 'unknown', listError: errorMessage(error), loadingList: false });
      }
    }
  },

  clear: () => {
    const ws = get().boundWs;
    if (ws) {
      for (const sub of activeSubscriptions.values()) ws.unsubscribeUIView(sub.subscriptionId);
    }
    activeSubscriptions.clear();
    lastSequences.clear();
    get().unbind?.();
    set({
      accountId: null,
      support: 'unknown',
      capabilities: null,
      items: [],
      views: {},
      loadingList: false,
      loadingViews: {},
      listError: null,
      viewErrors: {},
      sourceStatus: {},
      boundWs: null,
      unbind: null,
    });
  },

  loadList: async () => {
    const accountId = get().accountId;
    if (!accountId || get().support === 'unavailable') return;
    set({ loadingList: true, listError: null });
    try {
      const raw = await listAllSidebarViews();
      if (get().accountId !== accountId) return;
      set({ items: raw, loadingList: false, support: 'available' });
    } catch (error) {
      if (get().accountId !== accountId) return;
      set({ loadingList: false, listError: errorMessage(error) });
    }
  },

  loadView: async (viewId, options = false) => {
    const force = typeof options === 'boolean' ? options : options.force === true;
    const pinnedRevision = typeof options === 'object' ? options.revision : undefined;
    const cacheKey = pinnedRevision != null ? `${viewId}@${pinnedRevision}` : viewId;
    const accountId = get().accountId;
    if (!accountId) return null;
    const cached = get().views[cacheKey];
    if (!force && cached) return cached;
    set((state) => ({
      loadingViews: { ...state.loadingViews, [cacheKey]: true },
      viewErrors: { ...state.viewErrors, [cacheKey]: null },
    }));
    try {
      const raw = await getUIView(viewId, pinnedRevision);
      if (get().accountId !== accountId) return null;
      const normalized = normalizeUIView(raw);
      if (!normalized) throw new Error('The agent returned an invalid OA-UI view');
      if (normalized.id !== viewId) {
        throw new Error('The agent returned a mismatched View snapshot');
      }
      if (pinnedRevision != null && normalized.revision !== pinnedRevision) {
        throw new Error('The agent returned a different immutable View revision');
      }
      let accepted: UIView | null = normalized;
      set((state) => {
        const current = state.views[cacheKey];
        // Concurrent latest GETs may finish out of order. An old response must
        // not downgrade either the rendered revision or newer live data.
        if (pinnedRevision == null && current && current.revision > normalized.revision) {
          accepted = current;
          return { loadingViews: { ...state.loadingViews, [cacheKey]: false } };
        }
        const view = preserveNewerData(normalized, current);
        accepted = view;
        return {
          views: { ...state.views, [cacheKey]: view },
          items: mergeSummary(state.items, view),
          loadingViews: { ...state.loadingViews, [cacheKey]: false },
        };
      });
      return accepted;
    } catch (error) {
      if (get().accountId !== accountId) return null;
      set((state) => ({
        loadingViews: { ...state.loadingViews, [cacheKey]: false },
        viewErrors: { ...state.viewErrors, [cacheKey]: errorMessage(error) },
      }));
      return null;
    }
  },

  subscribe: (viewId, options = {}) => {
    get().ensureWs();
    const key = subscriptionKey(viewId, options.revision);
    const existing = activeSubscriptions.get(key);
    if (existing) {
      existing.count += 1;
      if ((options.knownRevision ?? 0) > (existing.knownRevision ?? 0)) {
        existing.knownRevision = options.knownRevision;
      }
    } else {
      const account = get().accountId ?? 'account';
      const sub: ActiveSubscription = {
        count: 1,
        viewId,
        revision: options.revision,
        knownRevision: options.knownRevision,
        subscriptionId: `ui:${account}:${viewId}:${options.revision ?? 'latest'}:${++subscriptionNonce}`,
      };
      activeSubscriptions.set(key, sub);
      get().boundWs?.subscribeUIView(sub.subscriptionId, viewId, {
        revision: sub.revision,
        knownRevision: sub.knownRevision,
      });
    }
    const cacheKey = options.revision != null ? `${viewId}@${options.revision}` : viewId;
    if (!get().views[cacheKey]) {
      void get().loadView(viewId, options.revision != null ? { revision: options.revision } : undefined);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const sub = activeSubscriptions.get(key);
      if (!sub) return;
      sub.count -= 1;
      if (sub.count > 0) return;
      get().boundWs?.unsubscribeUIView(sub.subscriptionId);
      activeSubscriptions.delete(key);
      for (const key of Array.from(lastSequences.keys())) {
        if (key.startsWith(`${sub.subscriptionId}:`)) lastSequences.delete(key);
      }
    };
  },

  invokeAction: async (viewId, actionId, input, actionRevision, pinnedRefreshRevision) => {
    const latest = get().views[viewId];
    const rendered = get().views[`${viewId}@${actionRevision}`]
      ?? (latest?.revision === actionRevision ? latest : undefined);
    if (rendered?.canExecute !== true) {
      throw new Error('This view is read-only for the current account');
    }
    const key = idempotencyKey();
    // REST is the reliable request/response path; the WS action frame remains
    // available for future streaming actions but is not duplicated here.
    const result = await invokeUIViewAction(viewId, actionId, input, key, actionRevision);
    await get().loadView(
      viewId,
      pinnedRefreshRevision != null ? { revision: pinnedRefreshRevision, force: true } : true,
    );
    return result;
  },

  reactivate: async (viewId) => {
    const current = get().views[viewId] ?? get().items.find((item) => item.id === viewId);
    try {
      const raw = await reactivateUIView(viewId, {
        expectedRevision: current?.revision,
      });
      const view = normalizeUIView(raw);
      if (!view) throw new Error('The agent returned an invalid reactivated view');
      set((state) => ({
        views: { ...state.views, [view.id]: view },
        items: mergeSummary(state.items, view),
        viewErrors: { ...state.viewErrors, [viewId]: null },
      }));
      return view;
    } catch (error) {
      set((state) => ({
        viewErrors: { ...state.viewErrors, [viewId]: errorMessage(error) },
      }));
      return null;
    }
  },

  ensureWs: () => {
    const ws = useConnection.getState().ws;
    if (ws === get().boundWs && get().unbind) return;
    get().unbind?.();
    if (!ws) {
      set({ boundWs: null, unbind: null });
      return;
    }
    const off = ws.onMessage((msg) => handleWsMessage(msg, set, get));
    set({ boundWs: ws, unbind: off });
    sendAllSubscriptions(ws);
  },
}));
