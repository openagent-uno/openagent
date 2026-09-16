/**
 * Workflow run-history screen — /workflows/runs/{id}.
 *
 * Pushed onto the Workflows stack (from the list and the editor's History
 * button); the react-navigation header (back + title) comes from the
 * navigator (see workflows/_layout.tsx). Renders the shared
 * ``RunHistoryContent`` body.
 *
 * Each window is its own renderer, so the API base URL is set from the
 * resumed connection and the workflow name fetched for the header title.
 */

import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../../../../theme';
import { RunHistoryContent } from '../../../../components/workflow/RunHistoryContent';
import { useHeaderInset } from '../../../../components/screenHeader';
import { useConnection } from '../../../../stores/connection';
import { setBaseUrl, getWorkflow } from '../../../../services/api';

export default function WorkflowRunsScreen() {
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
        const wf = await getWorkflow(id);
        if (!cancelled) setName(wf?.name ?? null);
      } catch {
        /* the title is optional — leave the generic one on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connConfig, id]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Workflow runs' });
  }, [navigation, name]);

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      {/* Wait for the connection to resume before mounting the content:
          a fresh window's REST base URL isn't set until ``_openWebsocket``
          runs (it calls setBaseUrl right before populating ``config``), and
          the content fetches on mount. */}
      {connConfig && id ? (
        <RunHistoryContent workflowId={id} parentName={name ?? undefined} />
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
