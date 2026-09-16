/**
 * Scheduled-task run-history screen — /tasks/runs/{id}.
 *
 * Pushed onto the Scheduled stack; the react-navigation header (back +
 * title) is provided by the navigator (see tasks/_layout.tsx). Renders
 * the shared ``TaskRunHistoryContent`` body.
 *
 * Each window is its own renderer, so the API base URL is set from the
 * resumed connection and the task name fetched for the header title.
 */

import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../../../../theme';
import { TaskRunHistoryContent } from '../../../../components/TaskRunHistoryContent';
import { useHeaderInset } from '../../../../components/screenHeader';
import { useConnection } from '../../../../stores/connection';
import { setBaseUrl, getScheduledTask } from '../../../../services/api';

export default function TaskRunsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const connConfig = useConnection((s) => s.config);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!connConfig) return;
    if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getScheduledTask(id);
        if (!cancelled) setName(t?.name ?? null);
      } catch {
        /* the title is optional — leave the generic one on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connConfig, id]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Scheduled runs' });
  }, [navigation, name]);

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      {/* Wait for the connection to resume before mounting the content:
          a fresh window's REST base URL isn't set until ``_openWebsocket``
          runs (it calls setBaseUrl right before populating ``config``), and
          the content fetches on mount. */}
      {connConfig && id ? (
        <TaskRunHistoryContent taskId={id} parentName={name ?? undefined} />
      ) : (
        <View style={styles.statusPane}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  statusPane: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
