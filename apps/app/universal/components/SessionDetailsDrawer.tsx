/**
 * Right-side, react-navigation-owned session inspector.
 *
 * The canonical source is deliberately small and on demand: active-session
 * metadata/context already held by the chat store, the ACL-filtered normalized
 * session subtree from ``GET /api/sessions/{id}/descendants``, and causal run links from
 * ``GET /api/sessions/{id}/related-runs``. Focused workflow/scheduled/event
 * screens use the canonical v2 detail resolvers. No loaded-transcript fallback
 * is used here because it cannot claim complete causal coverage.
 */

import Feather from '@expo/vector-icons/Feather';
import {
  createDrawerNavigator,
  useDrawerStatus,
} from '@react-navigation/drawer';
import {
  NavigationContainer,
  NavigationIndependentTree,
  useNavigation,
} from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  EventDeliveryDetail,
  ScheduledRunDetail,
  SessionDescendantItem,
  SessionRelatedRunItem,
  WorkflowRunDetail,
} from '../../common/unified-history';
import { normalizeRunTimestamp } from '../../common/run-date-normalization';
import {
  RUN_RELATIONS_REFRESH_EVERY_POLLS,
  isLiveRunStatus,
  mergeSessionHierarchyRows,
  planRunRelationRefresh,
  runLivePollDelay,
  shouldContinueRunPolling,
} from '../../common/session-details';
import {
  runRoutePath,
  runTargetForChildSession,
  type ChatSession,
  type RunLaunchTarget,
  type SessionContext,
} from '../../common/types';
import {
  fetchChildSessions,
  getEventDeliveryDetail,
  getScheduledRunDetail,
  getSessionContext,
  getWorkflowRunDetail,
  listSessionDescendants,
  listSessionRelatedRuns,
  type SessionEntry,
} from '../services/api';
import { useChat } from '../stores/chat';
import { useConnection } from '../stores/connection';
import { useDrawerPreferences } from '../stores/drawerPreferences';
import { useNavigationSidebar } from '../stores/navigationSidebar';
import { useSearch } from '../stores/search';
import { useRenameSession } from './RenameSessionDialog';
import {
  useSessionDetailsDrawer,
  type SessionDetailsRunTarget,
} from '../stores/sessionDetailsDrawer';
import { colors, font, radius, spacing } from '../theme';
import { useLayout } from '../hooks/useLayout';
import {
  configureNextDrawerLayout,
  useReducedMotion,
  useRetainedPresence,
  useWebInert,
  webDrawerWidthTransition,
} from '../hooks/useDrawerMotion';
import ContextPanel from './ContextPanel';
import DrawerResizeHandle from './DrawerResizeHandle';
import {
  drawerContentRetentionDuration,
  drawerMotionDuration,
  resolvedDrawerWidth,
} from '../../common/drawer-motion';
import {
  SESSION_DETAILS_DRAWER_DEFAULT_WIDTH,
  clampDrawerWidth,
  responsiveDrawerWidthBounds,
} from '../../common/drawer-resize';

const RightDrawer = createDrawerNavigator();

interface RelatedState {
  children: ChildRow[];
  childrenCursor: string | null;
  childrenHasMore: boolean;
  relatedRuns: SessionRelatedRunItem[];
  relatedRunsCursor: string | null;
  relatedRunsHasMore: boolean;
  warning: string | null;
}

const EMPTY_RELATED: RelatedState = {
  children: [],
  childrenCursor: null,
  childrenHasMore: false,
  relatedRuns: [],
  relatedRunsCursor: null,
  relatedRunsHasMore: false,
  warning: null,
};

interface ChildRow {
  id: string;
  title: string;
  origin?: string | null;
  model?: string | null;
  framework?: string | null;
  createdAt?: number | null;
  lastActiveAt?: number | null;
  live: boolean;
  status?: string | null;
  depth: number;
  lineageRedacted: boolean;
  entry: SessionEntry;
}

interface LinkedRun {
  key: string;
  target: RunLaunchTarget;
  title: string;
  status?: string | null;
  occurredAt: number;
}

function toMs(value?: number | null): number {
  if (!value) return 0;
  return value < 1e12 ? value * 1000 : value;
}

function dateLabel(value?: number | null): string | null {
  const ms = toMs(value);
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
}

function runDateLabel(value?: string | number | null): string | null {
  const normalized = normalizeRunTimestamp(value);
  return normalized ? new Date(normalized.iso).toLocaleString() : null;
}

function originLabel(origin?: string | null): string {
  switch (origin) {
    case 'delegation': return 'Sub-agent';
    case 'scheduler': return 'Scheduled task';
    case 'workflow': return 'Workflow';
    case 'event': return 'Event';
    default: return 'Chat';
  }
}

function runKindForActivity(kind: SessionRelatedRunItem['kind']): RunLaunchTarget['kind'] | null {
  if (kind === 'scheduled_run') return 'task';
  if (kind === 'workflow_run') return 'workflow';
  if (kind === 'event_delivery') return 'event';
  return null;
}

function runLabel(kind: RunLaunchTarget['kind']): string {
  if (kind === 'workflow') return 'Workflow run';
  if (kind === 'event') return 'Event delivery';
  return 'Scheduled run';
}

function iconForRun(kind: RunLaunchTarget['kind']): keyof typeof Feather.glyphMap {
  if (kind === 'workflow') return 'git-branch';
  if (kind === 'event') return 'zap';
  return 'clock';
}

function statusColor(status?: string | null): string {
  if (!status) return colors.textMuted;
  if (['failed', 'rejected', 'timed_out', 'error'].includes(status)) return colors.error;
  if (['success', 'completed'].includes(status)) return colors.success;
  if (['running', 'pending', 'queued', 'received'].includes(status)) return colors.warning;
  return colors.textMuted;
}

function relatedChildren(entries: SessionEntry[]): ChildRow[] {
  const byId = new Map<string, ChildRow>();
  for (const entry of entries) {
    if (!entry.session_id) continue;
    byId.set(entry.session_id, {
      id: entry.session_id,
      title: entry.title || 'Untitled session',
      origin: entry.origin,
      model: entry.model,
      framework: entry.framework,
      createdAt: entry.created_at,
      lastActiveAt: entry.last_active_at,
      live: !!entry._live,
      depth: 1,
      lineageRedacted: false,
      entry,
    });
  }
  return [...byId.values()].sort(
    (a, b) => toMs(b.lastActiveAt || b.createdAt) - toMs(a.lastActiveAt || a.createdAt),
  );
}

function descendantEntry(item: SessionDescendantItem): SessionEntry {
  const createdAt = Date.parse(item.created_at);
  const lastActiveAt = Date.parse(item.last_active_at || item.updated_at);
  return {
    session_id: item.session_id,
    client_id: '',
    title: item.title ?? null,
    model: item.model ?? null,
    framework: item.framework ?? null,
    created_at: Number.isFinite(createdAt) ? Math.floor(createdAt / 1000) : null,
    last_active_at: Number.isFinite(lastActiveAt) ? Math.floor(lastActiveAt / 1000) : null,
    parent_session_id: item.parent_session_id ?? null,
    origin: item.origin ?? null,
    kind: item.kind,
    _live: ['pending', 'queued', 'received', 'running'].includes(item.status),
  };
}

function descendantChildren(items: SessionDescendantItem[]): ChildRow[] {
  return items.map((item) => {
    const entry = descendantEntry(item);
    return {
      id: item.session_id,
      title: item.title || 'Untitled session',
      origin: item.origin,
      model: item.model,
      framework: item.framework,
      createdAt: entry.created_at,
      lastActiveAt: entry.last_active_at,
      live: !!entry._live,
      status: item.status,
      depth: Math.max(1, item.depth),
      lineageRedacted: item.lineage_redacted,
      entry,
    };
  });
}

function mergeChildRows(current: ChildRow[], incoming: ChildRow[]): ChildRow[] {
  return mergeSessionHierarchyRows(current, incoming).sort((a, b) => (
    a.depth - b.depth
    || toMs(b.lastActiveAt || b.createdAt) - toMs(a.lastActiveAt || a.createdAt)
    || a.id.localeCompare(b.id)
  ));
}

function causalLinkedRuns(relatedRuns: SessionRelatedRunItem[]): LinkedRun[] {
  const rows: LinkedRun[] = [];
  for (const item of relatedRuns) {
    const kind = runKindForActivity(item.kind);
    if (!kind) continue;
    const target: RunLaunchTarget = {
      kind,
      runId: item.resource_id,
      parentId: item.parent?.id,
      name: item.title,
      status: item.status || undefined,
    };
    rows.push({
      key: `${kind}:${target.runId}`,
      target,
      title: item.title || runLabel(kind),
      status: item.status,
      occurredAt: Date.parse(item.started_at) || 0,
    });
  }
  return rows;
}

function linkedRuns(
  session: ChatSession,
  relatedRuns: SessionRelatedRunItem[],
): LinkedRun[] {
  const byKey = new Map(causalLinkedRuns(relatedRuns).map((run) => [run.key, run]));
  const owningRun = runTargetForChildSession(session.id);
  if (owningRun?.runId) {
    const key = `${owningRun.kind}:${owningRun.runId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        target: owningRun,
        title: session.title || runLabel(owningRun.kind),
        status: session.isProcessing ? 'running' : undefined,
        occurredAt: toMs(session.lastActiveAt || session.createdAt),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.occurredAt - a.occurredAt);
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {count != null ? <Text style={styles.sectionCount}>{count}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text selectable style={[styles.metaValue, mono && styles.monoValue]} numberOfLines={mono ? 2 : 1}>
        {value}
      </Text>
    </View>
  );
}

function SessionDetailsContent({
  onNavigate,
  onClose,
}: {
  onNavigate?: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const renameSession = useRenameSession();
  const accountId = useConnection((state) => state.activeAccountId);
  const activeSessionId = useChat((state) => state.activeSessionId);
  const session = useChat((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId),
  );
  const relatedRunsAvailable = useSearch((state) => {
    const version = state.capabilities?.features.session_related_runs?.version;
    return version === 1 || version === 2;
  });
  const recursiveRunsAvailable = useSearch((state) => {
    const feature = state.capabilities?.features.session_related_runs;
    return feature?.version === 2 && feature.include_descendants === true;
  });
  const descendantsAvailable = useSearch((state) => (
    state.capabilities?.features.session_descendants?.version === 1
  ));
  const historyRevision = useSearch((state) => state.historyRevision);
  const [related, setRelated] = useState<RelatedState>(EMPTY_RELATED);
  const [loading, setLoading] = useState(false);
  const [loadingMoreChildren, setLoadingMoreChildren] = useState(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!activeSessionId) {
      setRelated(EMPTY_RELATED);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      const childRequest = descendantsAvailable
        ? listSessionDescendants(activeSessionId, { limit: 100 }, controller.signal)
            .then((page) => ({
              rows: descendantChildren(page.items),
              cursor: page.next_cursor,
              hasMore: page.has_more,
            }))
        : fetchChildSessions(activeSessionId, 200).then((entries) => ({
            rows: relatedChildren(entries),
            cursor: null,
            hasMore: entries.length >= 200,
          }));
      const relatedRunsRequest = relatedRunsAvailable
        ? listSessionRelatedRuns(
            activeSessionId,
            { limit: 100, includeDescendants: recursiveRunsAvailable },
            controller.signal,
          )
        : Promise.resolve(null);
      const [childrenResult, relatedRunsResult] = await Promise.allSettled([
        childRequest,
        relatedRunsRequest,
      ]);
      if (cancelled) return;
      const warnings: string[] = [];
      const childPage = childrenResult.status === 'fulfilled' ? childrenResult.value : null;
      if (childrenResult.status === 'rejected') warnings.push('Sub-sessions are temporarily unavailable.');
      const runPage = relatedRunsResult.status === 'fulfilled' ? relatedRunsResult.value : null;
      if (relatedRunsResult.status === 'rejected') warnings.push('Causal run links are temporarily unavailable.');
      setRelated({
        children: childPage?.rows ?? [],
        childrenCursor: childPage?.cursor ?? null,
        childrenHasMore: childPage?.hasMore ?? false,
        relatedRuns: runPage?.items ?? [],
        relatedRunsCursor: runPage?.next_cursor ?? null,
        relatedRunsHasMore: !!runPage?.has_more,
        warning: warnings.length ? warnings.join(' ') : null,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    accountId,
    activeSessionId,
    descendantsAvailable,
    historyRevision,
    recursiveRunsAvailable,
    refreshGeneration,
    relatedRunsAvailable,
  ]);

  const children = related.children;
  const runs = useMemo(
    () => session ? linkedRuns(session, related.relatedRuns) : [],
    [related.relatedRuns, session],
  );

  const loadMoreRuns = useCallback(async () => {
    const cursor = related.relatedRunsCursor;
    if (!accountId || !activeSessionId || !cursor || loadingMoreRuns) return;
    setLoadingMoreRuns(true);
    try {
      const page = await listSessionRelatedRuns(activeSessionId, {
        limit: 100,
        cursor,
        includeDescendants: recursiveRunsAvailable,
      });
      if (
        useConnection.getState().activeAccountId !== accountId
        || useChat.getState().activeSessionId !== activeSessionId
        || useSearch.getState().historyRevision !== historyRevision
      ) return;
      setRelated((current) => {
        if (current.relatedRunsCursor !== cursor) return current;
        const items = new Map(current.relatedRuns.map((item) => [item.id, item]));
        for (const item of page.items) items.set(item.id, item);
        return {
          ...current,
          relatedRuns: [...items.values()],
          relatedRunsCursor: page.next_cursor,
          relatedRunsHasMore: page.has_more,
        };
      });
    } catch {
      setRelated((current) => ({
        ...current,
        warning: [current.warning, 'More causal run links could not be loaded.']
          .filter(Boolean)
          .join(' '),
      }));
    } finally {
      setLoadingMoreRuns(false);
    }
  }, [
    accountId,
    activeSessionId,
    historyRevision,
    loadingMoreRuns,
    recursiveRunsAvailable,
    related.relatedRunsCursor,
  ]);

  const loadMoreChildren = useCallback(async () => {
    const cursor = related.childrenCursor;
    if (
      !accountId || !activeSessionId || !cursor
      || loadingMoreChildren || !descendantsAvailable
    ) return;
    setLoadingMoreChildren(true);
    try {
      const page = await listSessionDescendants(activeSessionId, { limit: 100, cursor });
      if (
        useConnection.getState().activeAccountId !== accountId
        || useChat.getState().activeSessionId !== activeSessionId
        || useSearch.getState().historyRevision !== historyRevision
      ) return;
      setRelated((current) => (
        current.childrenCursor !== cursor
          ? current
          : {
              ...current,
              children: mergeChildRows(current.children, descendantChildren(page.items)),
              childrenCursor: page.next_cursor,
              childrenHasMore: page.has_more,
            }
      ));
    } catch {
      setRelated((current) => ({
        ...current,
        warning: [current.warning, 'More sub-sessions could not be loaded.']
          .filter(Boolean)
          .join(' '),
      }));
    } finally {
      setLoadingMoreChildren(false);
    }
  }, [
    activeSessionId,
    accountId,
    descendantsAvailable,
    historyRevision,
    loadingMoreChildren,
    related.childrenCursor,
  ]);

  const openSession = useCallback((entry: SessionEntry) => {
    useChat.getState().hydrateFromServer([entry]);
    useChat.getState().setActiveSession(entry.session_id);
    router.replace({ pathname: '/(tabs)/chat', params: { session: entry.session_id } } as any);
    onNavigate?.();
  }, [onNavigate, router]);

  const openSessionId = useCallback((id: string) => {
    useChat.getState().setActiveSession(id);
    router.replace({ pathname: '/(tabs)/chat', params: { session: id } } as any);
    onNavigate?.();
  }, [onNavigate, router]);

  const openRun = useCallback((run: LinkedRun) => {
    const path = runRoutePath(run.target);
    if (!path) return;
    router.push(`/${path}` as any);
    onNavigate?.();
  }, [onNavigate, router]);

  if (!session) {
    return (
      <View style={styles.emptyRoot}>
        <Feather name="sidebar" size={22} color={colors.textMuted} style={{ transform: [{ scaleX: -1 }] }} />
        <Text style={styles.emptyTitle}>No session selected</Text>
        <Text style={styles.emptyText}>Open a chat to inspect its context and related work.</Text>
      </View>
    );
  }

  const contextModel = session.contextUsage?.model_label
    || session.contextUsage?.model
    || session.model
    || session.llmPin;
  const created = dateLabel(session.createdAt);
  const lastActive = dateLabel(session.lastActiveAt);

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View style={styles.topTitleWrap}>
          <Text style={styles.eyebrow}>Session details</Text>
          <Pressable
            onPress={() => renameSession({ id: session.id, title: session.title })}
            style={styles.renameTitleButton}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${session.title || 'conversation'}`}
            {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          >
            <Text style={[styles.drawerTitle, styles.renameTitleText]} numberOfLines={2}>{session.title}</Text>
            <Feather name="edit-2" size={12} color={colors.textMuted} />
          </Pressable>
        </View>
        <View style={styles.topActions}>
          <Pressable
            onPress={() => setRefreshGeneration((value) => value + 1)}
            disabled={loading}
            style={styles.topButton}
            accessibilityRole="button"
            accessibilityLabel="Refresh session details"
            {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          >
            {loading
              ? <ActivityIndicator size="small" color={colors.textMuted} />
              : <Feather name="refresh-cw" size={14} color={colors.textSecondary} />}
          </Pressable>
          <Pressable
            onPress={onClose}
            style={styles.topButton}
            accessibilityRole="button"
            accessibilityLabel="Close session details"
            {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          >
            <Feather name="x" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Section title="Current context">
          {session.contextUsage?.context_window ? (
            <ContextPanel
              context={session.contextUsage}
              variant="inline"
              respectVisibilityPreference={false}
            />
          ) : (
            <Text style={styles.emptyText}>Context usage is available after the first completed turn.</Text>
          )}
        </Section>

        <Section title="Session">
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: session.isProcessing ? colors.warning : colors.success }]} />
            <Text style={styles.statusText}>{session.isProcessing ? 'Running' : 'Ready'}</Text>
            <Text style={styles.originBadge}>{originLabel(session.origin)}</Text>
          </View>
          {contextModel ? <MetaRow label="Model" value={contextModel} /> : null}
          {session.framework ? <MetaRow label="Runtime" value={session.framework} /> : null}
          {created ? <MetaRow label="Created" value={created} /> : null}
          {lastActive ? <MetaRow label="Last active" value={lastActive} /> : null}
          <MetaRow label="Loaded messages" value={String(session.messages.length)} />
          <MetaRow label="Session ID" value={session.id} mono />
          {session.parentSessionId ? (
            <Pressable
              onPress={() => openSessionId(session.parentSessionId!)}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel="Open parent session"
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <Feather name="corner-up-left" size={14} color={colors.accent} />
              <Text style={styles.linkText}>Open parent session</Text>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </Section>

        <Section title="Sub-sessions" count={children.length}>
          {children.length ? children.map((child) => (
            <Pressable
              key={child.id}
              onPress={() => openSession(child.entry)}
              style={[
                styles.itemRow,
                child.depth > 1 && { paddingLeft: Math.min(child.depth - 1, 4) * 10 + spacing.sm },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${child.title}`}
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <View style={styles.itemIcon}>
                <Feather name="git-merge" size={14} color={colors.accent} />
              </View>
              <View style={styles.itemBody}>
                <Text style={styles.itemTitle} numberOfLines={1}>{child.title}</Text>
                <View style={styles.itemMetaRow}>
                  <Text style={styles.itemMeta} numberOfLines={1}>
                    {originLabel(child.origin)}
                    {child.depth > 1 ? ` · Depth ${child.depth}` : ''}
                    {child.lineageRedacted ? ' · Restricted lineage' : ''}
                  </Text>
                  {child.status || child.live ? (
                    <Text style={[styles.itemMeta, { color: statusColor(child.status || (child.live ? 'running' : null)) }]}>
                      {child.status || 'running'}
                    </Text>
                  ) : null}
                </View>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          )) : (
            <Text style={styles.emptyText}>{loading ? 'Loading sub-sessions…' : 'No sub-sessions.'}</Text>
          )}
          {related.childrenHasMore && related.childrenCursor ? (
            <Pressable
              onPress={loadMoreChildren}
              disabled={loadingMoreChildren}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel="Load more sub-sessions"
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              {loadingMoreChildren
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Feather name="chevrons-down" size={14} color={colors.accent} />}
              <Text style={styles.linkText}>Load more sub-sessions</Text>
            </Pressable>
          ) : related.childrenHasMore ? (
            <Text style={styles.limitNote}>This older server returned only its first 200 sub-sessions.</Text>
          ) : null}
        </Section>

        <Section title="Linked runs" count={runs.length}>
          {runs.length ? runs.map((run) => (
            <Pressable
              key={run.key}
              onPress={() => openRun(run)}
              style={styles.itemRow}
              accessibilityRole="button"
              accessibilityLabel={`Open ${run.title}`}
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <View style={styles.itemIcon}>
                <Feather name={iconForRun(run.target.kind)} size={14} color={colors.accent} />
              </View>
              <View style={styles.itemBody}>
                <Text style={styles.itemTitle} numberOfLines={1}>{run.title}</Text>
                <View style={styles.itemMetaRow}>
                  <Text style={styles.itemMeta}>{runLabel(run.target.kind)}</Text>
                  {run.status ? (
                    <Text style={[styles.itemMeta, { color: statusColor(run.status) }]}>{run.status}</Text>
                  ) : null}
                </View>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          )) : (
            <Text style={styles.emptyText}>
              {loading
                ? 'Loading related runs…'
                : relatedRunsAvailable
                  ? 'No causally linked runs.'
                  : 'This server does not expose causal run links.'}
            </Text>
          )}
          {related.relatedRunsHasMore ? (
            <Pressable
              onPress={loadMoreRuns}
              disabled={loadingMoreRuns}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel="Load more linked runs"
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              {loadingMoreRuns
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Feather name="chevrons-down" size={14} color={colors.accent} />}
              <Text style={styles.linkText}>Load more linked runs</Text>
            </Pressable>
          ) : null}
        </Section>

        {related.warning ? (
          <View style={styles.warningRow}>
            <Feather name="alert-circle" size={13} color={colors.warning} />
            <Text style={styles.warningText}>{related.warning}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

type ResolvedRunDetail = WorkflowRunDetail | ScheduledRunDetail | EventDeliveryDetail;

interface RunDrawerState {
  detail: ResolvedRunDetail | null;
  context: SessionContext | null;
  childSessions: ChildRow[];
  childPageQueue: RunPageRequest[];
  childCoverageLimited: boolean;
  relatedRuns: SessionRelatedRunItem[];
  relatedRunPageQueue: RunPageRequest[];
  warning: string | null;
}

const EMPTY_RUN_DETAILS: RunDrawerState = {
  detail: null,
  context: null,
  childSessions: [],
  childPageQueue: [],
  childCoverageLimited: false,
  relatedRuns: [],
  relatedRunPageQueue: [],
  warning: null,
};

interface RunPageRequest {
  sessionId: string;
  cursor?: string;
}

interface ChildPageBatch {
  rows: ChildRow[];
  queue: RunPageRequest[];
  failed: boolean;
  limited: boolean;
}

interface RelatedRunPageBatch {
  items: SessionRelatedRunItem[];
  queue: RunPageRequest[];
  failed: boolean;
}

const RUN_PAGE_SIZE = 50;
// Opening a drawer must stay cheap even when a workflow has hundreds of AI
// sessions. Remaining roots and server cursors stay in these queues until the
// user explicitly asks for another bounded batch.
const RUN_INITIAL_SOURCE_BATCH_SIZE = 2;
const RUN_LOAD_MORE_SOURCE_BATCH_SIZE = 4;

function makeRunPageQueue(parentIds: string[]): RunPageRequest[] {
  return [...new Set(parentIds.filter(Boolean))].map((sessionId) => ({ sessionId }));
}

function reconcileRunPageQueue(
  current: RunPageRequest[],
  refreshedSourceIds: string[],
  incoming: RunPageRequest[],
): RunPageRequest[] {
  const refreshed = new Set(refreshedSourceIds);
  const queue = new Map<string, RunPageRequest>();
  for (const request of current) {
    if (refreshed.has(request.sessionId)) continue;
    queue.set(`${request.sessionId}:${request.cursor ?? ''}`, request);
  }
  for (const request of incoming) {
    queue.set(`${request.sessionId}:${request.cursor ?? ''}`, request);
  }
  return [...queue.values()];
}

function mergeRelatedRunItems(
  current: SessionRelatedRunItem[],
  incoming: SessionRelatedRunItem[],
): SessionRelatedRunItem[] {
  const items = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) items.set(item.id, item);
  return [...items.values()];
}

async function loadChildSessionPageBatch(
  queue: RunPageRequest[],
  descendantsAvailable: boolean,
  sourceLimit: number,
): Promise<ChildPageBatch> {
  const batch = queue.slice(0, sourceLimit);
  const remaining = queue.slice(batch.length);
  let rows: ChildRow[] = [];
  const continuations: RunPageRequest[] = [];
  const retries: RunPageRequest[] = [];
  let failed = false;
  let limited = false;
  const results = await Promise.allSettled(batch.map(async (request) => {
    if (!descendantsAvailable) {
      const entries = await fetchChildSessions(request.sessionId, 200);
      return {
        rows: relatedChildren(entries),
        next: undefined,
        limited: entries.length >= 200,
      };
    }
    const page = await listSessionDescendants(request.sessionId, {
      limit: RUN_PAGE_SIZE,
      cursor: request.cursor,
    });
    const next = page.has_more && page.next_cursor && page.next_cursor !== request.cursor
      ? { sessionId: request.sessionId, cursor: page.next_cursor }
      : undefined;
    return {
      rows: descendantChildren(page.items),
      next,
      limited: page.has_more && !next,
    };
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed = true;
      retries.push(batch[index]);
      return;
    }
    limited ||= result.value.limited;
    rows = mergeChildRows(rows, result.value.rows);
    if (result.value.next) continuations.push(result.value.next);
  });
  return {
    rows,
    queue: [...remaining, ...continuations, ...retries],
    failed,
    limited,
  };
}

async function loadRelatedRunPageBatch(
  queue: RunPageRequest[],
  includeDescendants: boolean,
  sourceLimit: number,
): Promise<RelatedRunPageBatch> {
  const batch = queue.slice(0, sourceLimit);
  const remaining = queue.slice(batch.length);
  const items = new Map<string, SessionRelatedRunItem>();
  const continuations: RunPageRequest[] = [];
  const retries: RunPageRequest[] = [];
  let failed = false;
  const results = await Promise.allSettled(batch.map(async (request) => {
    const page = await listSessionRelatedRuns(request.sessionId, {
      limit: RUN_PAGE_SIZE,
      cursor: request.cursor,
      includeDescendants,
    });
    return {
      items: page.items,
      next: page.has_more && page.next_cursor && page.next_cursor !== request.cursor
        ? { sessionId: request.sessionId, cursor: page.next_cursor }
        : undefined,
      stalled: page.has_more && (!page.next_cursor || page.next_cursor === request.cursor),
    };
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed = true;
      retries.push(batch[index]);
      return;
    }
    failed ||= result.value.stalled;
    for (const item of result.value.items) items.set(item.id, item);
    if (result.value.next) continuations.push(result.value.next);
  });
  return {
    items: [...items.values()],
    queue: [...remaining, ...continuations, ...retries],
    failed,
  };
}

interface RunSessionRow {
  id: string;
  title: string;
  subtitle: string;
  status?: string | null;
  entry?: SessionEntry;
  depth: number;
  lineageRedacted: boolean;
}

function eventTargetSession(detail: EventDeliveryDetail): string | undefined {
  if (detail.session_id) return detail.session_id;
  const target = detail.downstream_target;
  if (!target) return undefined;
  if (
    target.kind === 'chat'
    || target.kind === 'chat_message'
    || target.kind === 'chat_tool'
    || target.kind === 'scheduled_run'
  ) {
    return target.session_id || undefined;
  }
  return undefined;
}

function primaryRunSession(
  target: SessionDetailsRunTarget,
  detail: ResolvedRunDetail | null,
): string | undefined {
  if (target.sessionId) return target.sessionId;
  if (!detail) return undefined;
  if (target.kind === 'task') return (detail as ScheduledRunDetail).session_id || undefined;
  if (target.kind === 'event') return eventTargetSession(detail as EventDeliveryDetail);
  return undefined;
}

function relatedSessionIdsForRun(
  target: SessionDetailsRunTarget,
  detail: ResolvedRunDetail | null,
): string[] {
  const primary = primaryRunSession(target, detail);
  const workflowSessions = target.kind === 'workflow' && detail
    ? (detail as WorkflowRunDetail).trace_steps
        .map((step) => step.child_session_id || '')
        .filter(Boolean)
    : [];
  return [...new Set([
    ...(primary ? [primary] : []),
    ...workflowSessions,
  ])];
}

function runSessionRows(
  target: SessionDetailsRunTarget,
  detail: ResolvedRunDetail | null,
  children: ChildRow[],
): RunSessionRow[] {
  const rows = new Map<string, RunSessionRow>();
  const primary = primaryRunSession(target, detail);
  if (primary) {
    rows.set(primary, {
      id: primary,
      title: target.kind === 'event' ? 'Delivery session' : 'Run session',
      subtitle: 'Owning session',
      depth: 0,
      lineageRedacted: false,
    });
  }
  if (target.kind === 'workflow' && detail) {
    for (const step of (detail as WorkflowRunDetail).trace_steps) {
      if (!step.child_session_id) continue;
      const startedAt = Date.parse(step.started_at);
      rows.set(step.child_session_id, {
        id: step.child_session_id,
        title: step.node_id,
        subtitle: `${step.type} node`,
        status: step.status,
        depth: 0,
        lineageRedacted: false,
        entry: {
          session_id: step.child_session_id,
          client_id: '',
          title: step.node_id,
          model: null,
          framework: null,
          created_at: Number.isFinite(startedAt) ? Math.floor(startedAt / 1000) : null,
          last_active_at: null,
          origin: 'workflow',
          kind: step.type,
          _live: step.status === 'running',
        },
      });
    }
  }
  for (const child of children) {
    const entry = child.entry;
    if (!entry.session_id) continue;
    const existing = rows.get(entry.session_id);
    const hierarchy = [
      child.depth > 1 ? `Depth ${child.depth}` : null,
      child.lineageRedacted ? 'Restricted lineage' : null,
    ].filter(Boolean).join(' · ');
    rows.set(entry.session_id, {
      id: entry.session_id,
      title: entry.title || existing?.title || entry.session_id,
      subtitle: [existing?.subtitle || originLabel(entry.origin), hierarchy]
        .filter(Boolean)
        .join(' · '),
      status: child.status || existing?.status || (entry._live ? 'running' : null),
      entry,
      depth: child.depth,
      lineageRedacted: child.lineageRedacted,
    });
  }
  return [...rows.values()];
}

function runKindLabel(kind: SessionDetailsRunTarget['kind']): string {
  if (kind === 'workflow') return 'Workflow run';
  if (kind === 'event') return 'Event delivery';
  return 'Scheduled run';
}

function runKindIcon(kind: SessionDetailsRunTarget['kind']): keyof typeof Feather.glyphMap {
  if (kind === 'workflow') return 'git-branch';
  if (kind === 'event') return 'zap';
  return 'clock';
}

async function resolveRunDetail(target: SessionDetailsRunTarget): Promise<ResolvedRunDetail> {
  if (target.kind === 'workflow') return getWorkflowRunDetail(target.runId);
  if (target.kind === 'event') return getEventDeliveryDetail(target.runId);
  return getScheduledRunDetail(target.runId);
}

function appendWarning(current: string | null, message: string): string {
  if (!current) return message;
  if (current.includes(message)) return current;
  return `${current} ${message}`;
}

function RunDetailsContent({
  target,
  onNavigate,
  onClose,
}: {
  target: SessionDetailsRunTarget;
  onNavigate?: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const accountId = useConnection((state) => state.activeAccountId);
  const relatedRunsAvailable = useSearch((state) => {
    const version = state.capabilities?.features.session_related_runs?.version;
    return version === 1 || version === 2;
  });
  const recursiveRunsAvailable = useSearch((state) => {
    const feature = state.capabilities?.features.session_related_runs;
    return feature?.version === 2 && feature.include_descendants === true;
  });
  const descendantsAvailable = useSearch((state) => (
    state.capabilities?.features.session_descendants?.version === 1
  ));
  const historyRevision = useSearch((searchState) => searchState.historyRevision);
  const [state, setState] = useState<RunDrawerState>(EMPTY_RUN_DETAILS);
  const [loading, setLoading] = useState(false);
  const [loadingMoreChildren, setLoadingMoreChildren] = useState(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const loadedTarget = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const backgroundAncillaryRefresh = useRef(false);
  const manualChildLoad = useRef(false);
  const manualRelatedRunLoad = useRef(false);
  const handledHistoryRevision = useRef(historyRevision);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const generation = ++loadGeneration.current;
    const livePollStartedAt = Date.now();
    const hydratedSourceIds = new Set<string>();
    let livePollAttempts = 0;
    let roundRobinCursor = 0;
    setLoading(true);
    const targetKey = `${accountId ?? ''}:${target.kind}:${target.runId}`;
    if (loadedTarget.current !== targetKey) {
      loadedTarget.current = targetKey;
      setState(EMPTY_RUN_DETAILS);
    }

    const refreshAncillaryState = async (
      snapshot: ResolvedRunDetail,
      sourceIds: string[],
    ) => {
      if (
        !sourceIds.length
        || backgroundAncillaryRefresh.current
        || manualChildLoad.current
        || manualRelatedRunLoad.current
      ) {
        return;
      }
      backgroundAncillaryRefresh.current = true;
      try {
        const sessionId = primaryRunSession(target, snapshot);
        const sourceQueue = makeRunPageQueue(sourceIds);
        const [contextResult, childrenResult, relatedRunsResult] = await Promise.allSettled([
          sessionId ? getSessionContext(sessionId) : Promise.resolve(null),
          loadChildSessionPageBatch(
            sourceQueue,
            descendantsAvailable,
            sourceIds.length,
          ),
          relatedRunsAvailable
            ? loadRelatedRunPageBatch(
                sourceQueue,
                recursiveRunsAvailable,
                sourceIds.length,
              )
            : Promise.resolve<RelatedRunPageBatch>({ items: [], queue: [], failed: false }),
        ]);
        if (cancelled || loadGeneration.current !== generation) return;

        const childrenOk = childrenResult.status === 'fulfilled'
          && !childrenResult.value.failed;
        const runsOk = !relatedRunsAvailable || (
          relatedRunsResult.status === 'fulfilled' && !relatedRunsResult.value.failed
        );
        if (childrenOk && runsOk) {
          for (const sourceId of sourceIds) hydratedSourceIds.add(sourceId);
        }

        setState((current) => {
          let warning = current.warning;
          if (sessionId && contextResult.status === 'rejected') {
            warning = appendWarning(warning, 'Session context is temporarily unavailable.');
          }
          if (!childrenOk) {
            warning = appendWarning(warning, 'Child sessions are temporarily unavailable.');
          }
          if (!runsOk) {
            warning = appendWarning(warning, 'Causal run links are temporarily unavailable.');
          }
          return {
            ...current,
            detail: snapshot,
            context: contextResult.status === 'fulfilled' && contextResult.value
              ? contextResult.value
              : current.context,
            childSessions: childrenResult.status === 'fulfilled'
              ? mergeChildRows(current.childSessions, childrenResult.value.rows)
              : current.childSessions,
            childPageQueue: childrenResult.status === 'fulfilled'
              ? reconcileRunPageQueue(
                  current.childPageQueue,
                  sourceIds,
                  childrenResult.value.queue,
                )
              : current.childPageQueue,
            childCoverageLimited: current.childCoverageLimited || (
              childrenResult.status === 'fulfilled' && childrenResult.value.limited
            ),
            relatedRuns: relatedRunsResult.status === 'fulfilled'
              ? mergeRelatedRunItems(current.relatedRuns, relatedRunsResult.value.items)
              : current.relatedRuns,
            relatedRunPageQueue: relatedRunsResult.status === 'fulfilled'
              ? reconcileRunPageQueue(
                  current.relatedRunPageQueue,
                  sourceIds,
                  relatedRunsResult.value.queue,
                )
              : current.relatedRunPageQueue,
            warning,
          };
        });
      } finally {
        backgroundAncillaryRefresh.current = false;
      }
    };

    const scheduleLiveRefresh = (snapshot: ResolvedRunDetail | null) => {
      if (!snapshot || !isLiveRunStatus(snapshot.status)) return;
      const elapsedMs = Date.now() - livePollStartedAt;
      if (!shouldContinueRunPolling(snapshot.status, elapsedMs, livePollAttempts)) {
        setState((current) => ({
          ...current,
          warning: appendWarning(
            current.warning,
            'Live refresh paused after ten minutes. Use Refresh to continue.',
          ),
        }));
        return;
      }
      refreshTimer = setTimeout(() => {
        void (async () => {
          livePollAttempts += 1;
          let refreshed: ResolvedRunDetail;
          try {
            refreshed = await resolveRunDetail(target);
          } catch {
            if (!cancelled && loadGeneration.current === generation) {
              scheduleLiveRefresh(snapshot);
            }
            return;
          }
          if (cancelled || loadGeneration.current !== generation) return;
          setState((current) => ({ ...current, detail: refreshed }));

          const sourceIds = relatedSessionIdsForRun(target, refreshed);
          const terminalRefresh = !isLiveRunStatus(refreshed.status);
          const plan = planRunRelationRefresh({
            sessionIds: sourceIds,
            hydratedSessionIds: hydratedSourceIds,
            roundRobinCursor,
            pollAttempt: terminalRefresh
              ? RUN_RELATIONS_REFRESH_EVERY_POLLS
              : livePollAttempts,
            sourceLimit: RUN_INITIAL_SOURCE_BATCH_SIZE,
          });
          roundRobinCursor = plan.nextRoundRobinCursor;
          await refreshAncillaryState(refreshed, plan.sourceIds);
          if (!cancelled && loadGeneration.current === generation) {
            scheduleLiveRefresh(refreshed);
          }
        })();
      }, runLivePollDelay(livePollAttempts));
    };

    void (async () => {
      const warnings: string[] = [];
      let detail: ResolvedRunDetail | null = null;
      try {
        detail = await resolveRunDetail(target);
      } catch {
        warnings.push('Canonical run details are temporarily unavailable.');
      }
      if (cancelled || loadGeneration.current !== generation) return;

      const sessionId = primaryRunSession(target, detail);
      const relatedSessionIds = relatedSessionIdsForRun(target, detail);
      const childQueue = makeRunPageQueue(relatedSessionIds);
      const relatedRunQueue = relatedRunsAvailable
        ? makeRunPageQueue(relatedSessionIds)
        : [];
      const [contextResult, childrenResult, relatedRunsResult] = await Promise.allSettled([
        sessionId ? getSessionContext(sessionId) : Promise.resolve(null),
        loadChildSessionPageBatch(
          childQueue,
          descendantsAvailable,
          RUN_INITIAL_SOURCE_BATCH_SIZE,
        ),
        relatedRunsAvailable
          ? loadRelatedRunPageBatch(
              relatedRunQueue,
              recursiveRunsAvailable,
              RUN_INITIAL_SOURCE_BATCH_SIZE,
            )
          : Promise.resolve<RelatedRunPageBatch>({ items: [], queue: [], failed: false }),
      ]);
      if (cancelled || loadGeneration.current !== generation) return;
      if (sessionId && contextResult.status === 'rejected') {
        warnings.push('Session context is temporarily unavailable.');
      }
      if (
        childrenResult.status === 'rejected'
        || (childrenResult.status === 'fulfilled' && childrenResult.value.failed)
      ) {
        warnings.push('Child sessions are temporarily unavailable.');
      }
      if (
        relatedRunsResult.status === 'rejected'
        || (relatedRunsResult.status === 'fulfilled' && relatedRunsResult.value.failed)
      ) {
        warnings.push('Causal run links are temporarily unavailable.');
      }
      setState({
        detail,
        context: contextResult.status === 'fulfilled' ? contextResult.value : null,
        childSessions: childrenResult.status === 'fulfilled' ? childrenResult.value.rows : [],
        childPageQueue: childrenResult.status === 'fulfilled'
          ? childrenResult.value.queue
          : childQueue,
        childCoverageLimited: childrenResult.status === 'fulfilled'
          ? childrenResult.value.limited
          : false,
        relatedRuns: relatedRunsResult.status === 'fulfilled'
          ? relatedRunsResult.value.items
          : [],
        relatedRunPageQueue: relatedRunsResult.status === 'fulfilled'
          ? relatedRunsResult.value.queue
          : relatedRunQueue,
        warning: warnings.length ? warnings.join(' ') : null,
      });
      const initialSources = relatedSessionIds.slice(0, RUN_INITIAL_SOURCE_BATCH_SIZE);
      const childrenOk = childrenResult.status === 'fulfilled' && !childrenResult.value.failed;
      const runsOk = !relatedRunsAvailable || (
        relatedRunsResult.status === 'fulfilled' && !relatedRunsResult.value.failed
      );
      if (childrenOk && runsOk) {
        for (const sourceId of initialSources) hydratedSourceIds.add(sourceId);
      }
      setLoading(false);
      scheduleLiveRefresh(detail);
    })();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [
    accountId,
    descendantsAvailable,
    recursiveRunsAvailable,
    refreshGeneration,
    relatedRunsAvailable,
    target,
  ]);

  useEffect(() => {
    if (handledHistoryRevision.current === historyRevision) return;
    handledHistoryRevision.current = historyRevision;
    if (state.detail && !isLiveRunStatus(state.detail.status)) {
      setRefreshGeneration((value) => value + 1);
    }
  }, [historyRevision, state.detail]);

  const loadMoreChildSessions = useCallback(async () => {
    const queue = state.childPageQueue;
    if (!queue.length || loadingMoreChildren || backgroundAncillaryRefresh.current) return;
    const generation = loadGeneration.current;
    manualChildLoad.current = true;
    setLoadingMoreChildren(true);
    try {
      const batch = await loadChildSessionPageBatch(
        queue,
        descendantsAvailable,
        RUN_LOAD_MORE_SOURCE_BATCH_SIZE,
      );
      if (loadGeneration.current !== generation) return;
      setState((current) => {
        if (current.childPageQueue !== queue) return current;
        return {
          ...current,
          childSessions: mergeChildRows(current.childSessions, batch.rows),
          childPageQueue: batch.queue,
          childCoverageLimited: current.childCoverageLimited || batch.limited,
          warning: batch.failed
            ? appendWarning(current.warning, 'More child sessions could not be loaded.')
            : current.warning,
        };
      });
    } finally {
      manualChildLoad.current = false;
      setLoadingMoreChildren(false);
    }
  }, [descendantsAvailable, loadingMoreChildren, state.childPageQueue]);

  const loadMoreRelatedRuns = useCallback(async () => {
    const queue = state.relatedRunPageQueue;
    if (!queue.length || loadingMoreRuns || backgroundAncillaryRefresh.current) return;
    const generation = loadGeneration.current;
    manualRelatedRunLoad.current = true;
    setLoadingMoreRuns(true);
    try {
      const batch = await loadRelatedRunPageBatch(
        queue,
        recursiveRunsAvailable,
        RUN_LOAD_MORE_SOURCE_BATCH_SIZE,
      );
      if (loadGeneration.current !== generation) return;
      setState((current) => {
        if (current.relatedRunPageQueue !== queue) return current;
        return {
          ...current,
          relatedRuns: mergeRelatedRunItems(current.relatedRuns, batch.items),
          relatedRunPageQueue: batch.queue,
          warning: batch.failed
            ? appendWarning(current.warning, 'More causal run links could not be loaded.')
            : current.warning,
        };
      });
    } finally {
      manualRelatedRunLoad.current = false;
      setLoadingMoreRuns(false);
    }
  }, [loadingMoreRuns, recursiveRunsAvailable, state.relatedRunPageQueue]);

  const detail = state.detail;
  const sessions = useMemo(
    () => runSessionRows(target, detail, state.childSessions),
    [detail, state.childSessions, target],
  );
  const status = detail?.status || null;
  const title = detail?.title || target.name || runKindLabel(target.kind);
  const parentId = target.kind === 'workflow'
    ? (detail as WorkflowRunDetail | null)?.workflow_id || target.parentId
    : target.kind === 'event'
      ? (detail as EventDeliveryDetail | null)?.event_id || target.parentId
      : (detail as ScheduledRunDetail | null)?.task_id || target.parentId;
  const startedAt = target.kind === 'event'
    ? (detail as EventDeliveryDetail | null)?.occurred_at
    : (detail as WorkflowRunDetail | ScheduledRunDetail | null)?.started_at;
  const finishedAt = detail?.finished_at;
  const startedLabel = runDateLabel(startedAt);
  const finishedLabel = runDateLabel(finishedAt);
  const eventDownstream = target.kind === 'event'
    ? (detail as EventDeliveryDetail | null)?.downstream_target
    : null;
  const downstreamRun = eventDownstream?.kind === 'workflow_run'
    || eventDownstream?.kind === 'scheduled_run'
    ? eventDownstream
    : null;
  const runLinks = causalLinkedRuns(state.relatedRuns);
  if (downstreamRun) {
    const runTarget: RunLaunchTarget = downstreamRun.kind === 'workflow_run'
      ? {
          kind: 'workflow',
          runId: downstreamRun.run_id,
          parentId: downstreamRun.workflow_id,
        }
      : {
          kind: 'task',
          runId: downstreamRun.run_id,
          parentId: downstreamRun.task_id,
        };
    const key = `${runTarget.kind}:${runTarget.runId}`;
    if (!runLinks.some((run) => run.key === key)) {
      runLinks.push({
        key,
        target: runTarget,
        title: 'Downstream run',
        occurredAt: 0,
      });
    }
  }

  const openSession = useCallback((row: RunSessionRow) => {
    if (row.entry) useChat.getState().hydrateFromServer([row.entry]);
    useChat.getState().setActiveSession(row.id);
    router.replace({ pathname: '/(tabs)/chat', params: { session: row.id } } as any);
    onNavigate?.();
  }, [onNavigate, router]);

  const openParent = useCallback(() => {
    if (!parentId) return;
    const section = target.kind === 'workflow'
      ? 'workflows'
      : target.kind === 'event'
        ? 'events'
        : 'tasks';
    router.push(`/(tabs)/${section}/${encodeURIComponent(parentId)}` as any);
    onNavigate?.();
  }, [onNavigate, parentId, router, target.kind]);

  const openLinkedRun = useCallback((run: LinkedRun) => {
    const path = runRoutePath(run.target);
    if (!path) return;
    router.push(`/${path}` as any);
    onNavigate?.();
  }, [onNavigate, router]);

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <View style={styles.topTitleWrap}>
          <Text style={styles.eyebrow}>{runKindLabel(target.kind)}</Text>
          <Text style={styles.drawerTitle} numberOfLines={2}>{title}</Text>
        </View>
        <View style={styles.topActions}>
          <Pressable
            onPress={() => setRefreshGeneration((value) => value + 1)}
            disabled={loading}
            style={styles.topButton}
            accessibilityRole="button"
            accessibilityLabel="Refresh run details"
            {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          >
            {loading
              ? <ActivityIndicator size="small" color={colors.textMuted} />
              : <Feather name="refresh-cw" size={14} color={colors.textSecondary} />}
          </Pressable>
          <Pressable
            onPress={onClose}
            style={styles.topButton}
            accessibilityRole="button"
            accessibilityLabel="Close session details"
            {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
          >
            <Feather name="x" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Section title="Current context">
          {state.context?.context_window ? (
            <ContextPanel
              context={state.context}
              variant="inline"
              respectVisibilityPreference={false}
            />
          ) : (
            <Text style={styles.emptyText}>
              {target.kind === 'workflow'
                ? 'Workflow context belongs to each AI-node session. Open one below to inspect it.'
                : loading
                  ? 'Loading session context…'
                  : 'No context report is available for this run session.'}
            </Text>
          )}
        </Section>

        <Section title="Run">
          <View style={styles.statusRow}>
            <View style={[styles.itemIcon, styles.runTypeIcon]}>
              <Feather name={runKindIcon(target.kind)} size={14} color={colors.accent} />
            </View>
            <Text style={styles.statusText}>{runKindLabel(target.kind)}</Text>
            {status ? (
              <Text style={[styles.originBadge, { color: statusColor(status) }]}>{status}</Text>
            ) : null}
          </View>
          {detail && 'trigger' in detail && detail.trigger ? (
            <MetaRow label="Trigger" value={detail.trigger} />
          ) : null}
          {detail && 'source' in detail ? <MetaRow label="Source" value={detail.source} /> : null}
          {startedLabel ? <MetaRow label="Started" value={startedLabel} /> : null}
          {finishedLabel ? <MetaRow label="Finished" value={finishedLabel} /> : null}
          {detail?.completeness ? <MetaRow label="Record" value={detail.completeness} /> : null}
          <MetaRow label="Run ID" value={target.runId} mono />
          {parentId ? (
            <Pressable
              onPress={openParent}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel={`Open parent ${target.kind}`}
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <Feather name="external-link" size={14} color={colors.accent} />
              <Text style={styles.linkText}>Open parent definition</Text>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </Section>

        <Section title="Sessions" count={sessions.length}>
          {sessions.length ? sessions.map((row) => (
            <Pressable
              key={row.id}
              onPress={() => openSession(row)}
              style={[
                styles.itemRow,
                row.depth > 0 && { paddingLeft: Math.min(row.depth, 4) * 10 + spacing.sm },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${row.title}`}
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <View style={styles.itemIcon}>
                <Feather name="message-square" size={14} color={colors.accent} />
              </View>
              <View style={styles.itemBody}>
                <Text style={styles.itemTitle} numberOfLines={1}>{row.title}</Text>
                <View style={styles.itemMetaRow}>
                  <Text style={styles.itemMeta}>{row.subtitle}</Text>
                  {row.status ? (
                    <Text style={[styles.itemMeta, { color: statusColor(row.status) }]}>{row.status}</Text>
                  ) : null}
                </View>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          )) : (
            <Text style={styles.emptyText}>{loading ? 'Loading sessions…' : 'This run has no linked session.'}</Text>
          )}
          {state.childPageQueue.length ? (
            <Pressable
              onPress={loadMoreChildSessions}
              disabled={loadingMoreChildren}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel="Load more run sub-sessions"
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              {loadingMoreChildren
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Feather name="chevrons-down" size={14} color={colors.accent} />}
              <Text style={styles.linkText}>Load more sub-sessions</Text>
            </Pressable>
          ) : null}
          {state.childCoverageLimited ? (
            <Text style={styles.limitNote}>
              This server's legacy session endpoint capped results for at least one run session.
            </Text>
          ) : null}
        </Section>

        <Section title="Linked runs" count={runLinks.length}>
          {runLinks.length ? runLinks.map((run) => (
            <Pressable
              key={run.key}
              onPress={() => openLinkedRun(run)}
              style={styles.itemRow}
              accessibilityRole="button"
              accessibilityLabel={`Open ${run.title}`}
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              <View style={styles.itemIcon}>
                <Feather
                  name={iconForRun(run.target.kind)}
                  size={14}
                  color={colors.accent}
                />
              </View>
              <View style={styles.itemBody}>
                <Text style={styles.itemTitle} numberOfLines={1}>{run.title}</Text>
                <View style={styles.itemMetaRow}>
                  <Text style={styles.itemMeta}>{runLabel(run.target.kind)}</Text>
                  {run.status ? (
                    <Text style={[styles.itemMeta, { color: statusColor(run.status) }]}>{run.status}</Text>
                  ) : null}
                </View>
              </View>
              <Feather name="chevron-right" size={14} color={colors.textMuted} />
            </Pressable>
          )) : (
            <Text style={styles.emptyText}>
              {relatedRunsAvailable
                ? 'No causally linked runs.'
                : 'This server does not expose causal run links.'}
            </Text>
          )}
          {state.relatedRunPageQueue.length ? (
            <Pressable
              onPress={loadMoreRelatedRuns}
              disabled={loadingMoreRuns}
              style={styles.linkRow}
              accessibilityRole="button"
              accessibilityLabel="Load more linked runs"
              {...(Platform.OS === 'web' ? { className: 'oa-side-row' } as any : {})}
            >
              {loadingMoreRuns
                ? <ActivityIndicator size="small" color={colors.accent} />
                : <Feather name="chevrons-down" size={14} color={colors.accent} />}
              <Text style={styles.linkText}>Load more linked runs</Text>
            </Pressable>
          ) : null}
        </Section>

        {state.warning ? (
          <View style={styles.warningRow}>
            <Feather name="alert-circle" size={13} color={colors.warning} />
            <Text style={styles.warningText}>{state.warning}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DrawerContent({
  topInset,
  present,
}: {
  topInset: number;
  present: boolean;
}) {
  const isOpen = useSessionDetailsDrawer((state) => state.isOpen);
  const runTarget = useSessionDetailsDrawer((state) => state.runTarget);
  const requestClose = useSessionDetailsDrawer((state) => state.requestClose);
  const { isPhone } = useLayout();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const onNavigate = isPhone ? requestClose : undefined;
  const onClose = useCallback(() => {
    if (!isPhone) configureNextDrawerLayout(reducedMotion);
    requestClose();
  }, [isPhone, reducedMotion, requestClose]);
  const resolvedTopInset = Math.max(topInset, isPhone ? insets.top : 0);
  const inertRef = useWebInert(!isOpen);
  return (
    <View
      ref={inertRef}
      testID="session-details-drawer-content"
      pointerEvents={isOpen ? 'auto' : 'none'}
      accessibilityElementsHidden={!isOpen}
      importantForAccessibility={isOpen ? 'auto' : 'no-hide-descendants'}
      style={[
        styles.drawerSurface,
        Platform.OS === 'web' && !isPhone && styles.drawerSurfaceResizeBoundary,
        { paddingTop: resolvedTopInset },
        isPhone && { paddingBottom: insets.bottom },
      ]}
      {...(Platform.OS === 'web'
        ? ({ 'aria-hidden': !isOpen } as any)
        : {})}
    >
      {present ? (
        runTarget
          ? <RunDetailsContent target={runTarget} onNavigate={onNavigate} onClose={onClose} />
          : <SessionDetailsContent onNavigate={onNavigate} onClose={onClose} />
      ) : null}
    </View>
  );
}

const ShellContent = createContext<ReactNode>(null);

function WorkspaceScreen() {
  const children = useContext(ShellContent);
  const navigation = useNavigation<any>();
  const drawerStatus = useDrawerStatus();
  const toggleRequested = useSessionDetailsDrawer((state) => state.toggleRequested);
  const closeRequested = useSessionDetailsDrawer((state) => state.closeRequested);
  const setOpen = useSessionDetailsDrawer((state) => state.setOpen);
  const isOpen = useSessionDetailsDrawer((state) => state.isOpen);
  const reducedMotion = useReducedMotion();
  const { isPhone } = useLayout();
  const lastToggle = useRef(toggleRequested);
  const lastClose = useRef(closeRequested);

  useEffect(() => {
    if (toggleRequested === lastToggle.current) return;
    lastToggle.current = toggleRequested;
    navigation.toggleDrawer();
  }, [navigation, toggleRequested]);

  useEffect(() => {
    if (closeRequested === lastClose.current) return;
    lastClose.current = closeRequested;
    navigation.closeDrawer();
  }, [closeRequested, navigation]);

  useEffect(() => {
    const nextOpen = drawerStatus === 'open';
    if (nextOpen === isOpen) return;
    if (!isPhone) configureNextDrawerLayout(reducedMotion);
    setOpen(nextOpen);
  }, [drawerStatus, isOpen, isPhone, reducedMotion, setOpen]);

  return <View style={styles.workspace}>{children}</View>;
}

/** Wrap one detail-capable route in a right-positioned Drawer. Keeping this
 *  navigator below the file route (never around the Expo Router drawer) lets
 *  Expo Router remain the sole owner of URL and cross-section history. */
export default function SessionDetailsDrawerShell({
  children,
  topInset = 0,
}: {
  children: ReactNode;
  topInset?: number;
}) {
  const layout = useLayout();
  const isOpen = useSessionDetailsDrawer((state) => state.isOpen);
  const detailsWidth = useDrawerPreferences((state) => state.sessionDetailsWidth);
  const navigationWidth = useDrawerPreferences((state) => state.navigationWidth);
  const setDetailsWidth = useDrawerPreferences((state) => state.setSessionDetailsWidth);
  const navigationOpen = useNavigationSidebar((state) => state.isOpen);
  const [isResizing, setIsResizing] = useState(false);
  const reducedMotion = useReducedMotion();
  const resizeBounds = useMemo(() => responsiveDrawerWidthBounds(
    'session-details',
    layout.width,
    { otherDrawerOpen: navigationOpen, otherDrawerWidth: navigationWidth },
  ), [layout.width, navigationOpen, navigationWidth]);
  const expandedWidth = layout.isPhone
    ? Math.min(
        SESSION_DETAILS_DRAWER_DEFAULT_WIDTH,
        Math.max(280, layout.width * 0.88),
      )
    : clampDrawerWidth(detailsWidth || SESSION_DETAILS_DRAWER_DEFAULT_WIDTH, resizeBounds);
  const motionDuration = drawerMotionDuration(reducedMotion);
  const width = resolvedDrawerWidth(expandedWidth, layout.isPhone, isOpen);
  const contentPresent = useRetainedPresence(
    isOpen,
    drawerContentRetentionDuration(layout.isPhone, reducedMotion),
  );
  return (
    <ShellContent.Provider value={children}>
      <NavigationIndependentTree>
        <NavigationContainer documentTitle={{ enabled: false }}>
          <RightDrawer.Navigator
            defaultStatus={isOpen ? 'open' : 'closed'}
            drawerContent={() => (
              <View style={styles.drawerHost}>
                <DrawerContent topInset={topInset} present={contentPresent} />
                {!layout.isPhone && isOpen && Platform.OS === 'web' ? (
                  <DrawerResizeHandle
                    side="right"
                    width={expandedWidth}
                    bounds={resizeBounds}
                    label="Resize session details drawer"
                    onChange={setDetailsWidth}
                    onResizingChange={setIsResizing}
                  />
                ) : null}
              </View>
            )}
            screenOptions={{
              headerShown: false,
              drawerPosition: 'right',
              drawerType: layout.isPhone ? 'front' : 'permanent',
              drawerStyle: {
                width,
                overflow: 'hidden',
                backgroundColor: 'transparent',
                borderLeftWidth: 0,
                ...(!layout.isPhone
                  ? webDrawerWidthTransition(isResizing ? 0 : motionDuration)
                  : undefined),
              },
              sceneStyle: { backgroundColor: colors.bg },
              overlayColor: layout.isPhone ? 'rgba(0, 0, 0, 0.30)' : 'transparent',
              swipeEnabled: false,
              freezeOnBlur: false,
            }}
          >
            <RightDrawer.Screen name="__workspace__" component={WorkspaceScreen} />
          </RightDrawer.Navigator>
        </NavigationContainer>
      </NavigationIndependentTree>
    </ShellContent.Provider>
  );
}

const styles = StyleSheet.create({
  workspace: { flex: 1 },
  drawerHost: { flex: 1, position: 'relative' },
  drawerSurface: {
    flex: 1,
    backgroundColor: colors.sidebar,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderLight,
  },
  drawerSurfaceResizeBoundary: { borderLeftWidth: 0 },
  root: { flex: 1 },
  topBar: {
    minHeight: 74,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  topTitleWrap: { flex: 1, minWidth: 0 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  eyebrow: {
    fontFamily: font.sans,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.textMuted,
    marginBottom: 3,
  },
  drawerTitle: {
    fontFamily: font.display,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.text,
  },
  renameTitleText: { flex: 1 },
  renameTitleButton: {
    minHeight: 28,
    marginLeft: -6,
    paddingHorizontal: 6,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  topButton: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  section: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sectionTitle: {
    flex: 1,
    fontFamily: font.sans,
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.65,
  },
  sectionCount: {
    minWidth: 21,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.mutedSoft,
    color: colors.textSecondary,
    fontFamily: font.mono,
    fontSize: 9,
    textAlign: 'center',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontFamily: font.sans, fontSize: 12.5, color: colors.text },
  originBadge: {
    marginLeft: 'auto',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.primaryLight,
    color: colors.accent,
    fontFamily: font.sans,
    fontSize: 9.5,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  metaLabel: { width: 92, fontFamily: font.sans, fontSize: 11, color: colors.textMuted },
  metaValue: {
    flex: 1,
    fontFamily: font.sans,
    fontSize: 11.5,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  monoValue: { fontFamily: font.mono, fontSize: 9.5, lineHeight: 13 },
  linkRow: {
    minHeight: 34,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
  },
  linkText: { flex: 1, fontFamily: font.sans, fontSize: 11.5, fontWeight: '600', color: colors.accent },
  itemRow: {
    minHeight: 48,
    paddingHorizontal: 7,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: radius.md,
  },
  itemIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryLight,
  },
  runTypeIcon: { marginRight: 1 },
  itemBody: { flex: 1, minWidth: 0, gap: 3 },
  itemTitle: { fontFamily: font.sans, fontSize: 12, fontWeight: '600', color: colors.text },
  itemMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemMeta: { fontFamily: font.mono, fontSize: 9.5, color: colors.textMuted },
  emptyRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontFamily: font.display, fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  emptyText: { fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, color: colors.textMuted },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.mutedSoft,
  },
  warningText: { flex: 1, fontFamily: font.sans, fontSize: 10.5, lineHeight: 15, color: colors.textSecondary },
  limitNote: { fontFamily: font.sans, fontSize: 10, color: colors.textMuted, fontStyle: 'italic' },
});
