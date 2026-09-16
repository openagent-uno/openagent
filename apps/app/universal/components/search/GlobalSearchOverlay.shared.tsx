import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type {
  ActivityItem,
  EventCause,
  HighlightFragment,
  RunStatus,
  SearchMatch,
  SearchScope,
  SearchRootKind,
  SearchTarget,
} from '../../../common/unified-history';
import type { SearchOpenMetadata } from '../../../common/search-navigation';
import { colors, font, glassSurface, radius, shadows, spacing } from '../../theme';
import BlurView from '../BlurView';
import {
  globalSearchAvailable,
  searchRequestFingerprint,
  useSearch,
  type SearchPeriod,
  type SearchScopeSelection,
} from '../../stores/search';

type IconName = keyof typeof Feather.glyphMap;

interface Props {
  platform: 'web' | 'native';
  onOpenTarget: (
    target: SearchTarget,
    causedBy?: EventCause | null,
    metadata?: SearchOpenMetadata,
  ) => void;
}

interface DisplayRow {
  key: string;
  title: string;
  breadcrumb: string;
  occurredAt: string;
  status?: string | null;
  icon: IconName;
  fragments?: HighlightFragment[];
  fidelity?: string;
  target: SearchTarget;
  rootKind: SearchRootKind;
  causedBy?: EventCause | null;
}

const SCOPES: { key: SearchScopeSelection; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'chats', label: 'Chats' },
  { key: 'tools', label: 'Tools' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'events', label: 'Events' },
  { key: 'views', label: 'Views' },
];

const PERIODS: { key: SearchPeriod; label: string }[] = [
  { key: 'any', label: 'Any time' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

const STATUS_FILTERS: { value: RunStatus[]; label: string }[] = [
  { value: [], label: 'Any status' },
  { value: ['running', 'received', 'pending', 'queued'], label: 'Running' },
  { value: ['success'], label: 'Success' },
  { value: ['failed', 'rejected', 'timed_out'], label: 'Failed' },
];

function iconForScope(scope: SearchScope | SearchScopeSelection): IconName {
  switch (scope) {
    case 'chats': return 'message-circle';
    case 'tools': return 'tool';
    case 'workflows': return 'git-branch';
    case 'scheduled': return 'clock';
    case 'events': return 'zap';
    case 'views': return 'layout';
    default: return 'search';
  }
}

function iconForActivity(kind: ActivityItem['kind']): IconName {
  if (kind === 'chat' || kind === 'delegated_session') return 'message-circle';
  if (kind === 'workflow_run') return 'git-branch';
  if (kind === 'scheduled_run') return 'clock';
  return 'zap';
}

function scopeContainsActivity(scope: SearchScopeSelection, item: ActivityItem): boolean {
  if (scope === 'all') return true;
  if (scope === 'chats') return item.kind === 'chat' || item.kind === 'delegated_session';
  if (scope === 'workflows') return item.kind === 'workflow_run';
  if (scope === 'scheduled') return item.kind === 'scheduled_run';
  if (scope === 'events') return item.kind === 'event_delivery';
  return false;
}

function activityTarget(item: ActivityItem): SearchTarget | null {
  if (item.kind === 'chat' || item.kind === 'delegated_session') {
    return { kind: 'chat', session_id: item.session_id || item.resource_id };
  }
  if (!item.parent?.id) return null;
  if (item.kind === 'workflow_run') {
    return { kind: 'workflow_run', run_id: item.resource_id, workflow_id: item.parent.id };
  }
  if (item.kind === 'scheduled_run') {
    return {
      kind: 'scheduled_run',
      run_id: item.resource_id,
      task_id: item.parent.id,
      ...(item.session_id ? { session_id: item.session_id } : {}),
    };
  }
  return {
    kind: 'event_delivery',
    delivery_id: item.resource_id,
    event_id: item.parent.id,
    ...(item.session_id ? { session_id: item.session_id } : {}),
  };
}

function fidelityLabel(completeness: ActivityItem['completeness'], redacted = false): string | undefined {
  if (redacted) return 'Redacted';
  if (completeness === 'partial') return 'Partial';
  if (completeness !== 'complete') return 'Incomplete history';
  return undefined;
}

function matchBreadcrumb(match: SearchMatch): string {
  const author = match.author?.display || match.author?.handle;
  const base = match.kind.replaceAll('_', ' ');
  return author ? `${base} · ${author}` : base;
}

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return 'now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function asRows(
  historyItems: ActivityItem[],
  results: ReturnType<typeof useSearch.getState>['results'],
  query: string,
  scope: SearchScopeSelection,
  statuses: RunStatus[],
  errorsOnly: boolean,
  period: SearchPeriod,
  usingHistoryCache: boolean,
): DisplayRow[] {
  if (usingHistoryCache) {
    const minTime = period === 'any'
      ? 0
      : Date.now() - (period === '24h' ? 1 : period === '7d' ? 7 : 30) * 86_400_000;
    const wantedStatuses = errorsOnly ? ['failed', 'rejected', 'timed_out'] : statuses;
    return historyItems.flatMap((item): DisplayRow[] => {
      if (!scopeContainsActivity(scope, item)) return [];
      if (Date.parse(item.occurred_at) < minTime) return [];
      if (wantedStatuses.length && (!item.status || !wantedStatuses.includes(item.status))) return [];
      const target = activityTarget(item);
      if (!target) return [];
      return [{
        key: `history:${item.id}`,
        title: item.title,
        breadcrumb: item.parent?.title || item.kind.replaceAll('_', ' '),
        occurredAt: item.occurred_at,
        status: item.status,
        icon: iconForActivity(item.kind),
        fidelity: fidelityLabel(item.completeness),
        target,
        rootKind: item.kind,
      }];
    });
  }
  return results.flatMap((result) => result.matches.map((match) => ({
    key: `search:${result.result_id}:${match.id}`,
    title: result.root.title,
    breadcrumb: matchBreadcrumb(match),
    occurredAt: match.occurred_at,
    status: result.root.status,
    icon: iconForScope(
      result.root.kind.startsWith('workflow') ? 'workflows'
        : result.root.kind.startsWith('scheduled') ? 'scheduled'
          : result.root.kind.startsWith('event') ? 'events'
            : result.root.kind === 'ui_view' ? 'views'
            : match.kind.startsWith('tool') ? 'tools' : 'chats',
    ),
    fragments: match.fragments,
    fidelity: fidelityLabel(match.completeness, match.sensitivity === 'redacted'),
    target: match.target,
    rootKind: result.root.kind,
    causedBy: result.caused_by,
  })));
}

export default function GlobalSearchOverlayShared({ platform, onOpenTarget }: Props) {
  const widthAndHeight = useWindowDimensions();
  const listRef = useRef<FlatList<DisplayRow>>(null);
  const inputRef = useRef<TextInput>(null);
  const [active, setActive] = useState(0);

  const state = useSearch();
  const available = globalSearchAvailable(state);
  const currentFingerprint = searchRequestFingerprint(
    state.draft, state.scope, state.statuses, state.errorsOnly, state.period,
  );
  const displayedCurrent = currentFingerprint === state.displayedRequestFingerprint;
  const showingHistory = state.usingHistoryCache;
  const effectiveLoading = showingHistory ? state.historyLoading : state.searchLoading;
  const effectiveError = showingHistory ? state.historyError : state.searchError;
  const retryCurrentPage = () => showingHistory
    ? state.loadHistory(state.historyItems.length === 0 || !state.historyHasMore)
    : state.executeSearch();

  useEffect(() => {
    if (!state.open || !available) return;
    const timer = setTimeout(() => { void useSearch.getState().executeSearch(); }, 180);
    return () => clearTimeout(timer);
  }, [state.open, available, state.draft, state.scope, state.statuses, state.errorsOnly, state.period]);

  const rows = useMemo(() => asRows(
    state.historyItems,
    state.results,
    state.displayedQuery,
    state.scope,
    state.statuses,
    state.errorsOnly,
    state.period,
    state.usingHistoryCache,
  ), [
    state.historyItems, state.results, state.displayedQuery, state.scope,
    state.statuses, state.errorsOnly, state.period, state.usingHistoryCache,
  ]);

  useEffect(() => {
    if (!state.open) return;
    setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [state.open]);

  useEffect(() => {
    setActive((value) => Math.max(0, Math.min(value, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    if (platform !== 'web' || !state.open || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, active + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, active - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = Math.max(0, rows.length - 1);
      else if (event.key === 'PageDown') next = Math.min(rows.length - 1, active + 8);
      else if (event.key === 'PageUp') next = Math.max(0, active - 8);
      else if (event.key === 'Escape') {
        event.preventDefault();
        useSearch.getState().hide();
        return;
      } else if (event.key === 'Enter') {
        const row = rows[active];
        if (!row || !displayedCurrent || effectiveLoading) return;
        event.preventDefault();
        onOpenTarget(row.target, row.causedBy, {
          title: row.title,
          occurredAt: row.occurredAt,
          rootKind: row.rootKind,
        });
        useSearch.getState().hide();
        return;
      }
      if (next == null) return;
      event.preventDefault();
      setActive(next);
      listRef.current?.scrollToIndex({ index: next, animated: false, viewPosition: 0.5 });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, displayedCurrent, effectiveLoading, onOpenTarget, platform, rows, state.open]);

  if (!state.open || !available) return null;

  const maxHeight = Math.max(320, Math.min(560, widthAndHeight.height * 0.7));
  const statusLabel = effectiveLoading && rows.length
    ? 'Updating results…'
    : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`;

  const openRow = (row: DisplayRow) => {
    if (!displayedCurrent || effectiveLoading) return;
    onOpenTarget(row.target, row.causedBy, {
      title: row.title,
      occurredAt: row.occurredAt,
      rootKind: row.rootKind,
    });
    useSearch.getState().hide();
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={() => state.hide()}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.modal}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        accessibilityViewIsModal
        onAccessibilityEscape={() => state.hide()}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => state.hide()}
          accessibilityRole="button"
          accessibilityLabel="Close search"
          {...(Platform.OS === 'web' ? ({ dataSet: { oaHover: 'off' } } as any) : {})}
        />
        <BlurView
          intensity={2.6}
          style={[styles.panel, { maxHeight }, widthAndHeight.width < 560 && styles.panelNarrow]}
        >
          <View style={styles.inputRow}>
            <Feather name="search" size={16} color={colors.textMuted} />
            <TextInput
              ref={inputRef}
              value={state.draft}
              onChangeText={state.setDraft}
              placeholder="Search OpenAgent…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search OpenAgent"
              // RN Web forwards these to the underlying input.
              {...(platform === 'web' ? ({
                role: 'combobox',
                'aria-expanded': true,
                'aria-controls': 'global-search-results',
                'aria-activedescendant': rows[active] ? `search-option-${rows[active].key}` : undefined,
              } as any) : {})}
            />
            {state.draft ? (
              <Pressable
                onPress={() => state.setDraft('')}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
              >
                <Feather name="x" size={16} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>

          <View
            style={styles.chipRow}
            {...(platform === 'web' ? ({ role: 'tablist', 'aria-label': 'Search categories' } as any) : {})}
          >
            {SCOPES.map((entry) => (
              <Pressable
                key={entry.key}
                onPress={() => state.setScope(entry.key)}
                style={[styles.chip, state.scope === entry.key && styles.chipActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: state.scope === entry.key }}
                {...(platform === 'web'
                  ? ({ 'aria-selected': state.scope === entry.key } as any)
                  : {})}
              >
                <Text style={[styles.chipText, state.scope === entry.key && styles.chipTextActive]}>
                  {entry.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.filterRow}>
            {state.scope !== 'chats' && state.scope !== 'views' && STATUS_FILTERS.map((entry) => {
              const selected = !state.errorsOnly
                && entry.value.join(',') === state.statuses.join(',');
              return (
                <Pressable
                  key={entry.label}
                  onPress={() => state.setStatuses(entry.value)}
                  style={[styles.filterChip, selected && styles.filterChipActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  {...(platform === 'web' ? ({ 'aria-pressed': selected } as any) : {})}
                >
                  <Text style={[styles.filterText, selected && styles.filterTextActive]}>{entry.label}</Text>
                </Pressable>
              );
            })}
            {state.scope !== 'chats' && state.scope !== 'views' ? (
              <Pressable
                onPress={() => state.setErrorsOnly(!state.errorsOnly)}
                style={[styles.filterChip, state.errorsOnly && styles.filterChipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: state.errorsOnly }}
                {...(platform === 'web' ? ({ 'aria-pressed': state.errorsOnly } as any) : {})}
              >
                <Text style={[styles.filterText, state.errorsOnly && styles.filterTextActive]}>Errors only</Text>
              </Pressable>
            ) : null}
            {PERIODS.map((entry) => (
              <Pressable
                key={entry.key}
                onPress={() => state.setPeriod(entry.key)}
                style={[styles.filterChip, state.period === entry.key && styles.filterChipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: state.period === entry.key }}
                {...(platform === 'web'
                  ? ({ 'aria-pressed': state.period === entry.key } as any)
                  : {})}
              >
                <Text style={[styles.filterText, state.period === entry.key && styles.filterTextActive]}>{entry.label}</Text>
              </Pressable>
            ))}
            {(state.statuses.length || state.errorsOnly || state.period !== 'any') ? (
              <Pressable
                onPress={state.clearFilters}
                style={styles.filterChip}
                accessibilityRole="button"
                accessibilityLabel="Clear search filters"
              >
                <Text style={styles.filterText}>Clear filters</Text>
              </Pressable>
            ) : null}
          </View>

          {state.resultsUpdated ? (
            <Pressable style={styles.updatedBanner} onPress={() => { void state.acceptUpdatedResults(); }}>
              <Feather name="refresh-cw" size={12} color={colors.accent} />
              <Text style={styles.updatedText}>Results updated · Refresh</Text>
            </Pressable>
          ) : null}

          <View style={styles.resultsRegion} nativeID="global-search-results">
            {effectiveLoading && rows.length === 0 ? (
              <View style={styles.centerState}>
                <ActivityIndicator size="small" color={colors.textMuted} />
                <Text style={styles.stateText}>Searching…</Text>
              </View>
            ) : effectiveError && rows.length === 0 ? (
              <View style={styles.centerState}>
                <Text style={styles.errorText}>{effectiveError}</Text>
                <Pressable style={styles.retryButton} onPress={() => { void retryCurrentPage(); }}>
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ) : rows.length === 0 ? (
              <View style={styles.centerState}>
                <Text style={styles.stateText}>
                  {state.draft.trim() ? 'No results.' : state.scope === 'tools' ? 'No recent tools.' : 'Nothing here yet.'}
                </Text>
              </View>
            ) : (
              <FlatList
                ref={listRef}
                data={rows}
                keyExtractor={(row) => row.key}
                keyboardShouldPersistTaps="handled"
                onEndReached={() => {
                  void (showingHistory ? state.loadMoreHistory() : state.loadMoreSearch());
                }}
                onEndReachedThreshold={0.35}
                onScrollToIndexFailed={({ index, averageItemLength }) => {
                  listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
                }}
                renderItem={({ item, index }) => (
                  <SearchRow
                    row={item}
                    active={index === active}
                    disabled={!displayedCurrent || effectiveLoading}
                    onHover={() => setActive(index)}
                    onPress={() => openRow(item)}
                  />
                )}
                ListFooterComponent={(showingHistory ? state.historyPaginating : state.searchPaginating) ? (
                  <ActivityIndicator size="small" color={colors.textMuted} style={styles.footerSpinner} />
                ) : (showingHistory ? state.historyError : state.searchError) ? (
                  <Pressable
                    onPress={() => {
                      void (showingHistory
                        ? (state.historyHasMore ? state.loadMoreHistory() : state.loadHistory(true))
                        : state.loadMoreSearch());
                    }}
                    style={styles.paginationError}
                  >
                    <Text style={styles.errorText}>
                      {showingHistory ? state.historyError : state.searchError} · Retry
                    </Text>
                  </Pressable>
                ) : null}
              />
            )}
          </View>

          <View style={styles.footer} accessibilityLiveRegion="polite">
            <Text style={styles.footerText}>
              {state.scope === 'tools' && !state.draft.trim() ? 'Recent tools' : statusLabel}
            </Text>
            {state.coverage && !state.coverage.complete ? (
              <Text style={styles.coverageText}>
                {state.coverage.state === 'ready'
                  ? 'Partial results · refine your search'
                  : `Indexing · ${state.coverage.pending} pending`}
              </Text>
            ) : null}
            {platform === 'web' ? <Text style={styles.shortcut}>↑↓ navigate · ↵ open · esc close</Text> : null}
          </View>
        </BlurView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SearchRow({ row, active, disabled, onHover, onPress }: {
  row: DisplayRow;
  active: boolean;
  disabled: boolean;
  onHover: () => void;
  onPress: () => void;
}) {
  return (
    <Pressable
      nativeID={`search-option-${row.key}`}
      onPress={onPress}
      disabled={disabled}
      onHoverIn={onHover}
      style={[styles.resultRow, active && styles.resultRowActive, disabled && styles.resultRowDisabled]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={`${row.title}, ${row.breadcrumb}`}
      // RN Web option semantics; native ignores this branch.
      {...(Platform.OS === 'web' ? ({ role: 'option', 'aria-selected': active } as any) : {})}
    >
      <View style={styles.resultIcon}>
        <Feather name={row.icon} size={15} color={active ? colors.accent : colors.textMuted} />
      </View>
      <View style={styles.resultText}>
        <View style={styles.titleRow}>
          <Text style={styles.resultTitle} numberOfLines={1}>{row.title}</Text>
          {row.fidelity ? <Text style={styles.fidelity}>{row.fidelity}</Text> : null}
        </View>
        <Text style={styles.breadcrumb} numberOfLines={1}>{row.breadcrumb}</Text>
        {row.fragments ? (
          <Text style={styles.snippet} numberOfLines={2}>
            {row.fragments.map((fragment, index) => (
              <Text key={`${index}:${fragment.text}`} style={fragment.highlight ? styles.highlight : undefined}>
                {fragment.text}
              </Text>
            ))}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {row.status ? <Text style={styles.statusText}>{row.status}</Text> : null}
        <Text style={styles.timeText}>{relativeTime(row.occurredAt)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 76,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  panel: {
    width: '92%',
    maxWidth: 620,
    minHeight: 320,
    backgroundColor: glassSurface.backgroundColor,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.lg,
  },
  panelNarrow: { width: '100%', marginTop: 'auto', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  inputRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  input: { flex: 1, minHeight: 44, color: colors.text, fontFamily: font.sans, fontSize: 15, paddingVertical: 0 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  chip: { minHeight: 28, justifyContent: 'center', paddingHorizontal: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderLight },
  chipActive: { backgroundColor: colors.surface, borderColor: colors.border },
  chipText: { color: colors.textMuted, fontFamily: font.sans, fontSize: 11.5, fontWeight: '500' },
  chipTextActive: { color: colors.text, fontWeight: '600' },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingBottom: 7,
  },
  filterChip: { minHeight: 25, justifyContent: 'center', paddingHorizontal: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight },
  filterChipActive: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  filterText: { color: colors.textMuted, fontFamily: font.sans, fontSize: 10.5 },
  filterTextActive: { color: colors.text, fontWeight: '600' },
  updatedBanner: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: spacing.md, paddingVertical: 7, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.borderLight },
  updatedText: { color: colors.accent, fontFamily: font.sans, fontSize: 11.5, fontWeight: '600' },
  resultsRegion: { flex: 1, minHeight: 190, borderTopWidth: 1, borderTopColor: colors.borderLight },
  centerState: { flex: 1, minHeight: 190, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
  stateText: { color: colors.textMuted, fontFamily: font.sans, fontSize: 12.5, textAlign: 'center' },
  errorText: { color: colors.error, fontFamily: font.sans, fontSize: 12, textAlign: 'center' },
  retryButton: { minWidth: 72, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  retryText: { color: colors.text, fontFamily: font.sans, fontSize: 12, fontWeight: '600' },
  resultRow: { minHeight: 66, flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginHorizontal: 4, paddingHorizontal: 9, paddingVertical: 8, borderRadius: radius.md },
  resultRowActive: { backgroundColor: colors.hover },
  resultRowDisabled: { opacity: 0.62 },
  resultIcon: { width: 20, paddingTop: 2, alignItems: 'center' },
  resultText: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resultTitle: { flexShrink: 1, color: colors.text, fontFamily: font.sans, fontSize: 13, fontWeight: '600' },
  fidelity: { color: colors.textMuted, fontFamily: font.sans, fontSize: 9.5, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xs, paddingHorizontal: 4, paddingVertical: 1 },
  breadcrumb: { color: colors.textMuted, fontFamily: font.sans, fontSize: 10.5, marginTop: 1, textTransform: 'capitalize' },
  snippet: { color: colors.textSecondary, fontFamily: font.sans, fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  highlight: { color: colors.accent, fontWeight: '700' },
  trailing: { minWidth: 42, alignItems: 'flex-end', gap: 3, paddingTop: 1 },
  statusText: { color: colors.textSecondary, fontFamily: font.sans, fontSize: 9.5 },
  timeText: { color: colors.textMuted, fontFamily: font.mono, fontSize: 9.5 },
  footerSpinner: { marginVertical: 12 },
  paginationError: { padding: spacing.md },
  footer: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderTopWidth: 1, borderTopColor: colors.borderLight },
  footerText: { color: colors.textMuted, fontFamily: font.sans, fontSize: 10.5 },
  coverageText: { color: colors.warning, fontFamily: font.sans, fontSize: 10.5 },
  shortcut: { marginLeft: 'auto', color: colors.textMuted, fontFamily: font.mono, fontSize: 9 },
});
