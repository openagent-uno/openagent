/**
 * TaskRunHistoryContent — the scheduled-task analogue of the workflow
 * ``RunHistoryContent``.
 *
 * Fetches a task's recent firings from
 * ``GET /api/scheduled-tasks/{id}/runs`` and renders them as a centered
 * list of navigable run rows. A firing's transcript/output now lives in
 * the single scheduled-run screen, so rows never expand inline.
 *
 * Chrome-less so it drops straight into the run-history *screen*
 * (``app/(tabs)/tasks/runs/[id].tsx``) under that screen's
 * react-navigation header.
 */

import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, font, radius } from '../theme';
import { getScheduledTaskRuns } from '../services/api';
import { openDetached } from '../services/windows';
import { useEvents } from '../stores/events';
import { runRoutePath } from '../../common/types';
import type { TaskRun, TaskRunStatus } from '../../common/types';

// Shares the workflow run palette for the statuses they have in common.
const STATUS_COLOR: Record<TaskRunStatus, string> = {
  running: '#CC8020',
  success: '#15885E',
  failed: '#C94A43',
};

export function TaskRunHistoryContent({
  taskId,
  parentName,
}: {
  taskId: string;
  parentName?: string;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const load = async () => {
      if (first) setLoading(true);
      setError(null);
      try {
        const fetched = await getScheduledTaskRuns(taskId, { limit: 20 });
        if (!cancelled) setRuns(fetched);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      } finally {
        first = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const off = useEvents.getState().subscribe('scheduled_task', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId]);

  // No server-side stats endpoint for tasks, so summarize the fetched
  // window. Labelled "recent" so the count isn't read as an all-time
  // total.
  const summary = useMemo(() => {
    if (runs.length === 0) return null;
    const ok = runs.filter((r) => r.status === 'success').length;
    const failed = runs.filter((r) => r.status === 'failed').length;
    return { total: runs.length, ok, failed };
  }, [runs]);

  return (
    <View style={styles.content}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.listContent}>
        {summary ? (
          <Text style={styles.summary}>
            {summary.total} recent run{summary.total === 1 ? '' : 's'} ·{' '}
            {summary.ok} ok · {summary.failed} failed
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.loadingPane}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : runs.length === 0 ? (
          <Text style={styles.emptyText}>
            No runs yet. This task hasn't fired since history tracking
            began.
          </Text>
        ) : (
          runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onOpen={() => {
                const path = runRoutePath({
                  kind: 'task',
                  parentId: taskId,
                  runId: run.id,
                  name: parentName,
                });
                if (path) openDetached(router, path);
              }}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function RunCard({
  run,
  onOpen,
}: {
  run: TaskRun;
  onOpen: () => void;
}) {
  const colorBand = STATUS_COLOR[run.status] || colors.textMuted;
  const duration =
    run.finished_at != null && run.started_at
      ? (run.finished_at - run.started_at).toFixed(2) + 's'
      : run.status === 'running'
      ? '…'
      : '—';
  return (
    <TouchableOpacity
      onPress={onOpen}
      activeOpacity={0.85}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open scheduled run ${run.started_at_iso || run.id}`}
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-card-hover' } : {})}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.statusDot, { backgroundColor: colorBand }]} />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>
            {run.started_at_iso || run.id.slice(0, 8)}
          </Text>
          <Text style={styles.cardMeta}>
            {run.status} · {duration} · {run.trigger}
          </Text>
        </View>
        <Feather name="chevron-right" size={15} color={colors.textMuted} />
      </View>
      {run.error ? (
        <Text style={styles.cardError} numberOfLines={2}>
          {run.error}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1 },
  summary: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 10,
    fontFamily: font.mono,
  },
  scroll: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  loadingPane: {
    padding: 30,
    alignItems: 'center',
  },
  errorText: {
    padding: 20,
    fontSize: 11,
    color: colors.error,
    textAlign: 'center',
  },
  emptyText: {
    padding: 20,
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    fontStyle: 'italic',
    lineHeight: 16,
  },
  card: {
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 10,
  },
  cardText: { flex: 1, minWidth: 0 },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    fontSize: 12,
    color: colors.text,
    fontWeight: '500',
    fontFamily: font.mono,
  },
  cardMeta: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  cardError: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    fontSize: 10,
    color: colors.error,
    fontFamily: font.mono,
  },
});
