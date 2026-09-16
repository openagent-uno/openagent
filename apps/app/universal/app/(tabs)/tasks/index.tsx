/**
 * Scheduled tasks — dashboard grid.
 *
 * Tasks live in the backend SQLite database, served over
 * /api/scheduled-tasks. Changes take effect within ~30 seconds (the
 * scheduler's next tick) — no restart required.
 *
 * Laid out as a tile grid that mirrors Connectors (``mcps/index.tsx``):
 * a fixed header band with the hint, then a measured-column grid of
 * ``TaskTile``s. Column count derives from the *container's* measured
 * width (via ``onLayout``) so it stays correct when the sidebar / window
 * chrome reduces content width below the window width.
 *
 * Creating, editing, and viewing a task's run history each open a
 * *detached* view (``openDetached``): a separate window on the desktop
 * app, a pushed full-screen route on web / native. The list itself only
 * handles enable/disable and delete inline, and refetches when the
 * gateway broadcasts a ``scheduled_task`` change (including saves made
 * from a detached editor window).
 */

import Feather from '@expo/vector-icons/Feather';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius } from '../../../theme';
import { TileGridScreen, CONTENT_MAX_WIDTH } from '../../../components/TileGrid';
import { useConnection } from '../../../stores/connection';
import { useEvents } from '../../../stores/events';
import { useTasks } from '../../../stores/tasks';
import { setBaseUrl } from '../../../services/api';
import { openDetached } from '../../../services/windows';
import { useConfirm } from '../../../components/ConfirmDialog';
import EmptyState from '../../../components/EmptyState';
import { HeaderAction, useHeaderInset } from '../../../components/screenHeader';
import TaskTile from '../../../components/tasks/TaskTile';
import { Skeleton } from '../../../components/Skeleton';
import type { ScheduledTask } from '../../../../common/types';

export default function TasksScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const connConfig = useConnection((s) => s.config);
  const { tasks, loaded, error, loadTasks, deleteTask, toggleTask, runTask, stopTask } = useTasks();
  const confirm = useConfirm();

  const handleAdd = useCallback(() => {
    // ``new`` is the create sentinel — caught by tasks/[id].tsx since
    // task ids are uuids and never literally "new".
    openDetached(router, 'tasks/new');
  }, [router]);

  // The "create" control lives in the navigator header (same position as
  // Workflows / Connectors).
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <HeaderAction icon="plus" label="New task" onPress={handleAdd} />,
    });
  }, [navigation, handleAdd]);

  useEffect(() => {
    if (connConfig) {
      if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
      loadTasks();
    }
  }, [connConfig]);

  // Refetch on every screen focus so re-opening the tab always shows
  // fresh data (same as Connectors). The store keeps the existing list
  // visible while the refetch is in flight — ``loaded`` never resets —
  // so no skeleton flashes after the first load.
  useFocusEffect(
    useCallback(() => {
      void loadTasks();
    }, [loadTasks]),
  );

  // Refetch on chat-driven creates, scheduler ticks, and saves from a
  // detached editor window (all arrive as ``scheduled_task`` events).
  useEffect(() => {
    return useEvents.getState().subscribe('scheduled_task', () => {
      void loadTasks();
    });
  }, [loadTasks]);

  const handleRemove = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const confirmed = await confirm({
      title: 'Remove Task',
      message: `Remove task "${t.name}"?`,
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    await deleteTask(id);
  };

  const handleEdit = (t: ScheduledTask) => {
    openDetached(router, `tasks/${t.id}`);
  };

  return (
    <View style={styles.root}>
      {error && (
        <View style={[styles.errorWrap, { paddingTop: headerInset + 16 }]}>
          <View style={styles.errorBanner}>
            <Feather name="alert-circle" size={13} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        </View>
      )}

      {loaded && tasks.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No scheduled tasks yet"
          message="Schedule a recurring prompt — or ask OpenAgent to set one up for you."
          action={{ label: 'New task', icon: 'plus', onPress: handleAdd }}
        />
      ) : (
        <TileGridScreen headerInset={headerInset}>
          {!loaded
            ? Array.from({ length: 8 }).map((_, i) => <TaskTileSkeleton key={i} />)
            : tasks.map((task) => (
                <TaskTile
                  key={task.id}
                  task={task}
                  onToggle={(v) => { void toggleTask(task.id, v); }}
                  onEdit={() => handleEdit(task)}
                  onHistory={() => openDetached(router, `tasks/runs/${task.id}`)}
                  onRemove={() => { void handleRemove(task.id); }}
                  onRun={() => runTask(task.id)}
                  onStop={() => stopTask(task.id)}
                />
              ))}
        </TileGridScreen>
      )}
    </View>
  );
}

// Placeholder tile mirroring TaskTile's footprint — shown while the
// first /api/scheduled-tasks fetch is in flight so the screen renders
// immediately instead of flashing the empty state.
function TaskTileSkeleton() {
  return (
    <View style={skeletonStyles.tile}>
      <View style={skeletonStyles.rail} />
      <View style={skeletonStyles.body}>
        <View style={skeletonStyles.headRow}>
          <Skeleton width="55%" height={14} />
          <Skeleton width={34} height={18} rounded={radius.lg} />
        </View>
        <Skeleton width="100%" height={11} />
        <Skeleton width="80%" height={11} />
        <View style={skeletonStyles.badgesRow}>
          <Skeleton width={72} height={16} rounded={radius.sm} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  errorWrap: {
    maxWidth: CONTENT_MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
    borderRadius: radius.md,
  },
  errorText: { color: colors.error, fontSize: 12, flex: 1 },
});

const skeletonStyles = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: 138,
  },
  rail: { width: 3, backgroundColor: colors.borderStrong },
  body: { flex: 1, padding: 14, gap: 8 },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  badgesRow: { flexDirection: 'row', gap: 4, marginTop: 2 },
});
