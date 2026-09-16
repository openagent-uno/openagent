/**
 * Account-scoped, memory-only state for capability discovery, unified history,
 * and operational search. Query/result text is deliberately never persisted.
 */

import { create } from 'zustand';
import type {
  ActivityItem,
  ActivityKind,
  CapabilitiesResponse,
  HistoryChangedEvent,
  RunStatus,
  SearchCoverage,
  SearchFilters,
  SearchIndexChangedEvent,
  SearchRequest,
  SearchResult,
  SearchScope,
} from '../../common/unified-history';
import { ACTIVITY_KINDS, SEARCH_SCOPES, SEARCH_TARGET_KINDS } from '../../common/unified-history';
import {
  MAX_RETAINED_HISTORY_ITEMS,
  MAX_RETAINED_SEARCH_RESULTS,
  historyCoversAllKinds,
  historyKindsKey,
  historyRequestKey,
  mergeBoundedHistory,
  normalizeHistoryKinds,
} from '../../common/history-feed-policy';
import {
  canUseUnifiedHistoryCache,
  searchPresentation,
  type SearchPeriod,
  type SearchScopeSelection,
} from '../../common/search-request-policy';
import type { ChatSearchTarget } from '../../common/search-navigation';
import {
  ApiError,
  getUnifiedCapabilities,
  isAgentUnreachable,
  isExplicitlyUnsupported,
  isUnsupportedByAgent,
  listUnifiedHistory,
  searchOperationalHistory,
} from '../services/api';

export type UnifiedSupport = 'unknown' | 'v2' | 'legacy' | 'error';
export type { SearchPeriod, SearchScopeSelection } from '../../common/search-request-policy';

export interface ChatSearchDestination {
  sessionId: string;
  messageId?: string;
  toolInvocationId?: string;
  generation: number;
}

const HISTORY_PAGE_SIZE = 60;
const SEARCH_PAGE_SIZE = 40;
const ERROR_STATUSES: RunStatus[] = ['failed', 'rejected', 'timed_out'];

let capabilityAbort: AbortController | null = null;
let historyAbort: AbortController | null = null;
let searchAbort: AbortController | null = null;
let capabilityRetryTimer: ReturnType<typeof setTimeout> | null = null;

function abortAll(): void {
  capabilityAbort?.abort();
  historyAbort?.abort();
  searchAbort?.abort();
  capabilityAbort = null;
  historyAbort = null;
  searchAbort = null;
  if (capabilityRetryTimer) clearTimeout(capabilityRetryTimer);
  capabilityRetryTimer = null;
}

function retryCapabilities(accountId: string, callback: () => void): void {
  if (capabilityRetryTimer) clearTimeout(capabilityRetryTimer);
  capabilityRetryTimer = setTimeout(() => {
    capabilityRetryTimer = null;
    callback();
  }, 1_500);
}

function messageForError(error: unknown): string {
  if (isAgentUnreachable(error)) return 'Your agent is offline. Reconnect to search.';
  if (error instanceof ApiError) {
    if (error.code === 'warming') return 'History and search are still being prepared. Try again shortly.';
    if (error.code === 'degraded') return 'Search is temporarily degraded. Some results may be missing.';
    if (error.code === 'rate_limited') {
      const retry = error.details?.retry_after_ms;
      return retry ? `Too many searches. Try again in ${Math.ceil(retry / 1000)}s.` : 'Too many searches. Try again shortly.';
    }
    if (error.code === 'unprocessable_query') return 'That query cannot be searched as written.';
    if (error.code === 'request_too_large') return 'The search query is too long.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function hasRequiredSearchContract(capabilities: CapabilitiesResponse): boolean {
  const feature = capabilities.features.global_search;
  if (!feature || feature.version !== 1) return false;
  return SEARCH_SCOPES.every((scope) => feature.scopes.includes(scope))
    && SEARCH_TARGET_KINDS.every((target) => feature.targets.includes(target));
}

function scopesFor(selection: SearchScopeSelection): [SearchScope, ...SearchScope[]] {
  return selection === 'all'
    ? [...SEARCH_SCOPES]
    : [selection];
}

function isoFromPeriod(period: SearchPeriod): string | null {
  if (period === 'any') return null;
  const hours = period === '24h' ? 24 : period === '7d' ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function buildSearchFilters(
  statuses: RunStatus[],
  errorsOnly: boolean,
  period: SearchPeriod,
): SearchFilters {
  const status = errorsOnly ? ERROR_STATUSES : statuses;
  const from = isoFromPeriod(period);
  return {
    ...(status.length ? { status } : {}),
    ...(from ? { from } : {}),
  };
}

export function searchRequestFingerprint(
  draft: string,
  scope: SearchScopeSelection,
  statuses: RunStatus[],
  errorsOnly: boolean,
  period: SearchPeriod,
): string {
  return JSON.stringify({
    query: draft.trim(),
    scopes: scopesFor(scope),
    filters: buildSearchFilters(statuses, errorsOnly, period),
  });
}

interface SearchStore {
  accountId: string | null;
  support: UnifiedSupport;
  capabilities: CapabilitiesResponse | null;
  capabilityLoading: boolean;
  capabilityError: string | null;

  historyItems: ActivityItem[];
  historyKinds: ActivityKind[];
  historyCursor: string | null;
  historyHasMore: boolean;
  historyRevision: string | null;
  historyLoading: boolean;
  historyPaginating: boolean;
  historyError: string | null;
  historyGeneration: number;

  open: boolean;
  draft: string;
  displayedQuery: string;
  scope: SearchScopeSelection;
  statuses: RunStatus[];
  errorsOnly: boolean;
  period: SearchPeriod;
  results: SearchResult[];
  searchCursor: string | null;
  searchHasMore: boolean;
  coverage: SearchCoverage | null;
  searchLoading: boolean;
  searchPaginating: boolean;
  searchError: string | null;
  displayedRequestFingerprint: string | null;
  activeRequest: SearchRequest | null;
  resultsUpdated: boolean;
  usingHistoryCache: boolean;
  requestGeneration: number;
  /** In-app exact chat result. The Chat screen consumes this independently
   * of Expo Router params, which Drawer same-route navigation may discard. */
  chatDestination: ChatSearchDestination | null;
  chatDestinationGeneration: number;

  initialize: (accountId: string, force?: boolean) => Promise<void>;
  setHistoryKinds: (kinds: ActivityKind[]) => Promise<void>;
  loadHistory: (reset?: boolean) => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  show: () => void;
  hide: () => void;
  setDraft: (draft: string) => void;
  setScope: (scope: SearchScopeSelection) => void;
  setStatuses: (statuses: RunStatus[]) => void;
  setErrorsOnly: (value: boolean) => void;
  setPeriod: (period: SearchPeriod) => void;
  clearFilters: () => void;
  executeSearch: () => Promise<void>;
  loadMoreSearch: () => Promise<void>;
  acceptUpdatedResults: () => Promise<void>;
  handleHistoryChanged: (event: HistoryChangedEvent) => void;
  handleSearchIndexChanged: (event: SearchIndexChangedEvent) => void;
  /** Patch a committed conversation rename into account-scoped v2 caches. */
  renameSessionTitle: (sessionId: string, title: string) => void;
  setChatDestination: (target: ChatSearchTarget) => void;
  clearChatDestination: () => void;
  clear: () => void;
}

const INITIAL = {
  accountId: null,
  support: 'unknown' as UnifiedSupport,
  capabilities: null,
  capabilityLoading: false,
  capabilityError: null,
  historyItems: [] as ActivityItem[],
  historyKinds: [...ACTIVITY_KINDS] as ActivityKind[],
  historyCursor: null,
  historyHasMore: false,
  historyRevision: null,
  historyLoading: false,
  historyPaginating: false,
  historyError: null,
  historyGeneration: 0,
  open: false,
  draft: '',
  displayedQuery: '',
  scope: 'all' as SearchScopeSelection,
  statuses: [] as RunStatus[],
  errorsOnly: false,
  period: 'any' as SearchPeriod,
  results: [] as SearchResult[],
  searchCursor: null,
  searchHasMore: false,
  coverage: null,
  searchLoading: false,
  searchPaginating: false,
  searchError: null,
  displayedRequestFingerprint: null,
  activeRequest: null,
  resultsUpdated: false,
  usingHistoryCache: false,
  requestGeneration: 0,
  chatDestination: null as ChatSearchDestination | null,
  chatDestinationGeneration: 0,
};

export const useSearch = create<SearchStore>((set, get) => ({
  ...INITIAL,

  initialize: async (accountId, force = false) => {
    const current = get();
    if (!force && current.accountId === accountId && current.support !== 'unknown') {
      if (current.support === 'v2' && !current.historyItems.length && !current.historyLoading) {
        await current.loadHistory(true);
      }
      return;
    }
    const sameAccount = current.accountId === accountId;
    if (sameAccount) {
      capabilityAbort?.abort();
      capabilityAbort = null;
      if (capabilityRetryTimer) clearTimeout(capabilityRetryTimer);
      capabilityRetryTimer = null;
      if (force) {
        // A reconnect is a new server snapshot even when the account id is
        // unchanged. Invalidate every old response before refreshing page 1.
        historyAbort?.abort();
        historyAbort = null;
        searchAbort?.abort();
        searchAbort = null;
      }
      set((state) => ({
        capabilityLoading: true,
        capabilityError: null,
        ...(force ? {
          historyLoading: false,
          historyPaginating: false,
          searchLoading: false,
          searchPaginating: false,
          historyGeneration: state.historyGeneration + 1,
          requestGeneration: state.requestGeneration + 1,
        } : {}),
      }));
    } else {
      abortAll();
      set({
        ...INITIAL,
        accountId,
        capabilityLoading: true,
        historyKinds: [...ACTIVITY_KINDS],
        historyGeneration: current.historyGeneration + 1,
        requestGeneration: current.requestGeneration + 1,
      });
    }
    const generation = get().requestGeneration;
    const controller = new AbortController();
    capabilityAbort = controller;
    try {
      const capabilities = await getUnifiedCapabilities(controller.signal);
      if (get().accountId !== accountId || get().requestGeneration !== generation) return;
      if (capabilities.features.history?.version !== 2) {
        if (capabilities.storage.search_state === 'warming') {
          set({
            support: 'legacy',
            capabilities,
            capabilityLoading: false,
            capabilityError: 'Preparing unified history…',
          });
          retryCapabilities(accountId, () => {
            if (get().accountId === accountId) void get().initialize(accountId, true);
          });
          return;
        }
        set({
          support: 'error',
          capabilities,
          capabilityLoading: false,
          capabilityError: capabilities.storage.search_state === 'degraded'
            ? 'Unified history is temporarily degraded on this agent.'
            : 'This server returned an incompatible history capability.',
        });
        return;
      }
      set({ support: 'v2', capabilities, capabilityLoading: false, capabilityError: null });
      if (force || !sameAccount || current.support !== 'v2' || !current.historyItems.length) {
        await get().loadHistory(true);
      }
      if (!capabilities.features.global_search
          && ['warming', 'unavailable'].includes(capabilities.storage.search_state)) {
        retryCapabilities(accountId, () => {
          if (get().accountId === accountId) void get().initialize(accountId, true);
        });
      }
    } catch (error) {
      if (controller.signal.aborted || get().accountId !== accountId) return;
      if (error instanceof ApiError && error.code === 'warming') {
        set({
          support: 'legacy',
          capabilityLoading: false,
          capabilityError: 'Preparing unified history…',
        });
        retryCapabilities(accountId, () => {
          if (get().accountId === accountId) void get().initialize(accountId, true);
        });
      } else if (isUnsupportedByAgent(error) || isExplicitlyUnsupported(error)) {
        set({ support: 'legacy', capabilityLoading: false, capabilityError: null });
      } else if (sameAccount && current.support === 'v2'
          && (!(error instanceof ApiError) || ![401, 403].includes(error.status))) {
        // A transient refresh failure must not blank an already loaded unified
        // history feed while only the derived search capability is warming.
        set({ capabilityLoading: false, capabilityError: messageForError(error) });
      } else {
        set({ support: 'error', capabilityLoading: false, capabilityError: messageForError(error) });
      }
    } finally {
      if (capabilityAbort === controller) capabilityAbort = null;
    }
  },

  setHistoryKinds: async (kinds) => {
    const normalized = normalizeHistoryKinds(kinds);
    const state = get();
    if (historyKindsKey(normalized) === historyKindsKey(state.historyKinds)) return;
    historyAbort?.abort();
    historyAbort = null;
    set({
      historyKinds: normalized,
      historyItems: [],
      historyCursor: null,
      historyHasMore: false,
      historyRevision: null,
      historyLoading: false,
      historyPaginating: false,
      historyError: null,
      historyGeneration: state.historyGeneration + 1,
      usingHistoryCache: false,
    });
    if (state.support === 'v2' && normalized.length) {
      await get().loadHistory(true);
    }
  },

  loadHistory: async (reset = false) => {
    const state = get();
    if (state.support !== 'v2') return;
    if (!state.historyKinds.length) {
      set({
        historyItems: [], historyCursor: null, historyHasMore: false,
        historyLoading: false, historyPaginating: false, historyError: null,
      });
      return;
    }
    if (reset ? state.historyLoading : state.historyPaginating) return;
    if (!reset && (!state.historyHasMore || !state.historyCursor)) return;
    historyAbort?.abort();
    const controller = new AbortController();
    historyAbort = controller;
    const requestKey = historyRequestKey(
      state.accountId, state.historyKinds, state.historyGeneration,
    );
    set(reset
      ? { historyLoading: true, historyError: null }
      : { historyPaginating: true, historyError: null });
    try {
      const page = await listUnifiedHistory({
        kinds: state.historyKinds,
        limit: Math.min(HISTORY_PAGE_SIZE, state.capabilities?.features.history?.max_page_size ?? HISTORY_PAGE_SIZE),
        ...(reset ? {} : { cursor: state.historyCursor ?? undefined }),
      }, controller.signal);
      const latest = get();
      if (controller.signal.aborted || requestKey !== historyRequestKey(
        latest.accountId, latest.historyKinds, latest.historyGeneration,
      )) return;
      set((current) => {
        const historyItems = mergeBoundedHistory(
          current.historyItems, page.items, reset, MAX_RETAINED_HISTORY_ITEMS,
        );
        const atRetentionLimit = historyItems.length >= MAX_RETAINED_HISTORY_ITEMS;
        return {
          historyItems,
          historyCursor: atRetentionLimit ? null : page.next_cursor,
          historyHasMore: page.has_more && !atRetentionLimit,
          historyRevision: page.revision,
          historyLoading: false,
          historyPaginating: false,
          historyError: null,
        };
      });
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return;
      const latest = get();
      if (requestKey !== historyRequestKey(
        latest.accountId, latest.historyKinds, latest.historyGeneration,
      )) return;
      if (isExplicitlyUnsupported(error)) {
        set({ support: 'legacy', historyLoading: false, historyPaginating: false, historyError: null });
      } else if (!reset && error instanceof ApiError && error.code === 'cursor_stale') {
        set({ historyCursor: null, historyHasMore: false, historyPaginating: false });
        await get().loadHistory(true);
      } else {
        set({
          historyLoading: false,
          historyPaginating: false,
          historyError: messageForError(error),
        });
      }
    } finally {
      if (historyAbort === controller) historyAbort = null;
    }
  },

  loadMoreHistory: async () => get().loadHistory(false),

  show: () => set({ open: true }),
  hide: () => set({ open: false }),

  setDraft: (draft) => {
    searchAbort?.abort();
    set((state) => ({
      draft,
      searchLoading: false,
      searchPaginating: false,
      searchError: null,
      requestGeneration: state.requestGeneration + 1,
    }));
  },
  setScope: (scope) => {
    searchAbort?.abort();
    set((state) => ({
      scope,
      // Chat roots have no run status. Keeping a hidden status filter after
      // switching from Workflows/Scheduled made valid chats appear missing.
      ...(scope === 'chats' || scope === 'views' ? { statuses: [], errorsOnly: false } : {}),
      searchError: null,
      requestGeneration: state.requestGeneration + 1,
    }));
  },
  setStatuses: (statuses) => {
    searchAbort?.abort();
    set((state) => ({ statuses, errorsOnly: false, searchError: null, requestGeneration: state.requestGeneration + 1 }));
  },
  setErrorsOnly: (errorsOnly) => {
    searchAbort?.abort();
    set((state) => ({ errorsOnly, statuses: [], searchError: null, requestGeneration: state.requestGeneration + 1 }));
  },
  setPeriod: (period) => {
    searchAbort?.abort();
    set((state) => ({ period, searchError: null, requestGeneration: state.requestGeneration + 1 }));
  },
  clearFilters: () => {
    searchAbort?.abort();
    set((state) => ({
      statuses: [],
      errorsOnly: false,
      period: 'any',
      searchError: null,
      requestGeneration: state.requestGeneration + 1,
    }));
  },

  executeSearch: async () => {
    const state = get();
    const searchFeature = state.capabilities?.features.global_search;
    const query = state.draft.trim();
    const fingerprint = searchRequestFingerprint(
      state.draft, state.scope, state.statuses, state.errorsOnly, state.period,
    );
    // The unfiltered All view is exactly the unified history order and can use
    // its cache. Scoped/filtered empty queries must go to the server: the first
    // history page may contain zero matching rows even when later pages do.
    const canUseHistoryCache = canUseUnifiedHistoryCache(
      query, state.scope, state.statuses, state.errorsOnly, state.period,
    ) && historyCoversAllKinds(state.historyKinds);
    if (canUseHistoryCache) {
      searchAbort?.abort();
      set({
        results: [],
        searchCursor: null,
        searchHasMore: false,
        coverage: null,
        searchLoading: false,
        searchPaginating: false,
        searchError: null,
        displayedQuery: state.draft,
        displayedRequestFingerprint: fingerprint,
        activeRequest: null,
        usingHistoryCache: true,
      });
      return;
    }
    if (state.support !== 'v2' || !state.capabilities || !searchFeature
        || !hasRequiredSearchContract(state.capabilities)) {
      set({ searchError: 'Global search is not available on this server.' });
      return;
    }
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    const generation = state.requestGeneration + 1;
    const request: SearchRequest = {
      query,
      scopes: scopesFor(state.scope),
      filters: buildSearchFilters(state.statuses, state.errorsOnly, state.period),
      ...searchPresentation(query),
      limit: Math.min(SEARCH_PAGE_SIZE, searchFeature.max_page_size),
      cursor: null,
    };
    set({
      results: [],
      searchCursor: null,
      searchHasMore: false,
      coverage: null,
      searchLoading: true,
      searchPaginating: false,
      searchError: null,
      requestGeneration: generation,
      resultsUpdated: false,
      displayedQuery: state.draft,
      displayedRequestFingerprint: fingerprint,
      activeRequest: request,
      usingHistoryCache: false,
    });
    try {
      const page = await searchOperationalHistory(request, controller.signal);
      if (controller.signal.aborted || get().requestGeneration !== generation) return;
      set({
        results: page.items,
        searchCursor: page.next_cursor,
        searchHasMore: page.has_more,
        coverage: page.coverage,
        searchLoading: false,
        searchError: null,
        displayedQuery: state.draft,
        displayedRequestFingerprint: fingerprint,
        activeRequest: request,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbort(error) || get().requestGeneration !== generation) return;
      set({ searchLoading: false, searchError: messageForError(error) });
    } finally {
      if (searchAbort === controller) searchAbort = null;
    }
  },

  loadMoreSearch: async () => {
    const state = get();
    if (state.searchLoading || state.searchPaginating || !state.searchHasMore
        || !state.searchCursor || !state.activeRequest) return;
    const currentFingerprint = searchRequestFingerprint(
      state.draft, state.scope, state.statuses, state.errorsOnly, state.period,
    );
    if (currentFingerprint !== state.displayedRequestFingerprint) return;
    const controller = new AbortController();
    searchAbort = controller;
    const generation = state.requestGeneration + 1;
    set({ searchPaginating: true, searchError: null, requestGeneration: generation });
    try {
      const page = await searchOperationalHistory(
        { ...state.activeRequest, cursor: state.searchCursor },
        controller.signal,
      );
      if (controller.signal.aborted || get().requestGeneration !== generation) return;
      set((current) => {
        const byId = new Map(current.results.map((item) => [item.result_id, item]));
        for (const item of page.items) byId.set(item.result_id, item);
        const results = [...byId.values()].slice(0, MAX_RETAINED_SEARCH_RESULTS);
        const atRetentionLimit = results.length >= MAX_RETAINED_SEARCH_RESULTS;
        return {
          results,
          searchCursor: atRetentionLimit ? null : page.next_cursor,
          searchHasMore: page.has_more && !atRetentionLimit,
          coverage: page.coverage,
          searchPaginating: false,
        };
      });
    } catch (error) {
      if (controller.signal.aborted || isAbort(error) || get().requestGeneration !== generation) return;
      if (error instanceof ApiError && error.code === 'cursor_stale') {
        set({ searchPaginating: false, resultsUpdated: true });
      } else {
        set({ searchPaginating: false, searchError: messageForError(error) });
      }
    } finally {
      if (searchAbort === controller) searchAbort = null;
    }
  },

  acceptUpdatedResults: async () => {
    set({ resultsUpdated: false, searchCursor: null, searchHasMore: false });
    await get().executeSearch();
  },

  handleHistoryChanged: (event) => {
    if (get().support !== 'v2') return;
    set((state) => {
      const selected = new Set(state.historyKinds);
      const existing = state.historyItems.filter((item) => item.id !== event.activity_id);
      const incoming = event.action === 'upsert' && selected.has(event.item.kind)
        ? [event.item]
        : [];
      return {
        historyItems: mergeBoundedHistory(
          existing, incoming, false, MAX_RETAINED_HISTORY_ITEMS,
        ),
        historyRevision: event.revision,
      };
    });
  },

  handleSearchIndexChanged: (event) => {
    const current = get();
    if (!current.activeRequest || !current.capabilities) return;
    if (event.index_generation !== current.capabilities.storage.index_generation
        || event.indexed_seq > current.capabilities.storage.indexed_seq) {
      set({ resultsUpdated: true });
    }
  },

  renameSessionTitle: (sessionId, title) => set((state) => ({
    historyItems: state.historyItems.map((item) =>
      (item.kind === 'chat' || item.kind === 'delegated_session')
        && (item.session_id || item.resource_id) === sessionId
        ? { ...item, title }
        : item,
    ),
    results: state.results.map((result) =>
      result.root.session_id === sessionId
        || (result.root.kind === 'chat' && result.root.id === sessionId)
        ? { ...result, root: { ...result.root, title } }
        : result,
    ),
  })),

  setChatDestination: (target) => set((state) => {
    const generation = state.chatDestinationGeneration + 1;
    return {
      chatDestination: {
        sessionId: target.session_id,
        ...(target.kind !== 'chat' ? { messageId: target.message_id } : {}),
        ...(target.kind === 'chat_tool'
          ? { toolInvocationId: target.tool_invocation_id }
          : {}),
        generation,
      },
      chatDestinationGeneration: generation,
    };
  }),

  clearChatDestination: () => set((state) => ({
    chatDestination: null,
    chatDestinationGeneration: state.chatDestinationGeneration + 1,
  })),

  clear: () => {
    abortAll();
    set((state) => ({
      ...INITIAL,
      historyKinds: [...ACTIVITY_KINDS],
      historyGeneration: state.historyGeneration + 1,
      requestGeneration: state.requestGeneration + 1,
      chatDestinationGeneration: state.chatDestinationGeneration + 1,
    }));
  },
}));

export function globalSearchAvailable(state: Pick<SearchStore, 'support' | 'capabilities'>): boolean {
  return state.support === 'v2' && !!state.capabilities && hasRequiredSearchContract(state.capabilities);
}
