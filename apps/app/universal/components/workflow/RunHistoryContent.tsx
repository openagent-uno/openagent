/**
 * RunHistoryContent — the workflow run-history body.
 *
 * Fetches a workflow's last runs from ``/api/workflows/{id}/runs`` +
 * ``/stats`` (via the workflows store), merges any in-flight live run on
 * top, and renders a centered list of navigable run rows. Tapping a row
 * opens the single workflow-run screen instead of expanding trace output
 * inline; the run detail screen owns the full transcript/trace surface.
 *
 * Carries no chrome of its own so it drops straight into the run-history
 * *screen* (``app/(tabs)/workflows/runs/[id].tsx``) under that screen's
 * react-navigation header. Run history used to be an in-editor slide-over
 * drawer; it now opens as its own window/screen everywhere (the list
 * rows and the editor's History button both ``openDetached`` to that
 * route), so the drawer shell was retired and only this body remains.
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
import { colors, font, radius } from '../../theme';
import { getWorkflowRuns } from '../../services/api';
import { openDetached } from '../../services/windows';
import { useWorkflows } from '../../stores/workflows';
import { runRoutePath } from '../../../common/types';
import type {
  WorkflowRun,
  WorkflowRunStatus,
} from '../../../common/types';

const STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  running: '#CC8020',
  success: '#15885E',
  failed: '#C94A43',
  cancelled: '#55524B',
};

export function RunHistoryContent({
  workflowId,
  parentName,
}: {
  workflowId: string;
  parentName?: string;
}) {
  const router = useRouter();
  const stats = useWorkflows((s) => s.stats[workflowId]);
  const liveRun = useWorkflows((s) => s.runs[workflowId]);
  const loadStats = useWorkflows((s) => s.loadStats);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [fetched] = await Promise.all([
          getWorkflowRuns(workflowId, { limit: 20 }),
          loadStats(workflowId, 10),
        ]);
        if (!cancelled) setRuns(fetched);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, loadStats]);

  // Merge the live run (if any) into the fetched list so in-flight
  // runs appear at the top — even before the first stats refresh.
  const displayRuns = useMemo(() => {
    if (!liveRun) return runs;
    const others = runs.filter((r) => r.id !== liveRun.id);
    return [liveRun, ...others];
  }, [liveRun, runs]);

  return (
    <View style={styles.content}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.listContent}>
        {stats ? (
          <Text style={styles.summary}>
            {stats.total_runs} run{stats.total_runs === 1 ? '' : 's'} ·{' '}
            {(stats.success_rate * 100).toFixed(0)}% success
            {stats.avg_duration_s != null
              ? ` · avg ${stats.avg_duration_s.toFixed(1)}s`
              : ''}
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.loadingPane}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : displayRuns.length === 0 ? (
          <Text style={styles.emptyText}>
            No runs yet. Hit Run to create the first one.
          </Text>
        ) : (
          displayRuns.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onOpen={() => {
                const path = runRoutePath({
                  kind: 'workflow',
                  parentId: workflowId,
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
  run: WorkflowRun;
  onOpen: () => void;
}) {
  const colorBand = STATUS_COLOR[run.status] || colors.textMuted;
  const duration =
    run.finished_at != null && run.started_at
      ? (run.finished_at - run.started_at).toFixed(2) + 's'
      : run.status === 'running'
      ? '…'
      : '—';
  const traceCount = run.trace?.length ?? 0;
  return (
    <TouchableOpacity
      onPress={onOpen}
      activeOpacity={0.85}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open workflow run ${run.started_at_iso || run.id}`}
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
            {run.status} · {duration} · {run.trigger} · {traceCount} step{traceCount === 1 ? '' : 's'}
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
  // Fills its parent (the run-history screen's flex column).
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
