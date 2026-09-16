/**
 * Workflow editor route — /workflows/{id}.
 *
 * Hosts the visual editor: React Flow canvas on web/desktop, a
 * touch-first SVG canvas on native (Phase 7). Metro picks the right
 * variant via the ``.web.tsx`` / ``.native.tsx`` split on
 * ``WorkflowEditor``.
 *
 * Keeps its own "dirty" state so unsaved graph edits don't disappear
 * on tab switches. Save / Run / Back controls live on the editor
 * component so the native variant can ship a different layout without
 * rewriting this shell.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors, font } from '../../../theme';
import WorkflowEditor from '../../../components/workflow/WorkflowEditor';
import SharedPresence, { useSharedView } from '../../../components/SharedPresence';
import { useConnection } from '../../../stores/connection';
import { setBaseUrl, getWorkflow } from '../../../services/api';
import { goBack } from '../../../services/windows';
import type { WorkflowTask } from '../../../../common/types';

export default function WorkflowEditorScreen() {
  const { id, node, field } = useLocalSearchParams<{ id: string; node?: string; field?: string }>();
  useSharedView('workflow', id === 'new' ? undefined : id);
  const router = useRouter();
  const connConfig = useConnection((s) => s.config);
  const [workflow, setWorkflow] = useState<WorkflowTask | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Back" steps to wherever the editor was opened from (the Workflows
  // list normally, or a deeper origin) via expo-router history; opened cold
  // from a deep link it falls back to the Workflows list rather than chat.
  const backToList = useCallback(() => {
    goBack(router, '/(tabs)/workflows');
  }, [router]);

  useEffect(() => {
    if (!connConfig || !id) return;
    if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
    let cancelled = false;
    (async () => {
      try {
        const wf = await getWorkflow(id);
        if (!cancelled) setWorkflow(wf);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connConfig, id]);

  if (error) {
    return (
      <View style={styles.status}>
        <Text style={styles.errorText}>Failed to load workflow: {error}</Text>
      </View>
    );
  }

  if (!workflow) {
    return (
      <View style={styles.status}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.statusText}>Loading workflow…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
    <SharedPresence kind="workflow" id={id} />
    <WorkflowEditor
      workflow={workflow}
      onBack={backToList}
      onWorkflowUpdated={setWorkflow}
      initialNodeId={node}
      initialField={field}
    />
    </View>
  );
}

const styles = StyleSheet.create({
  status: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  statusText: { fontSize: 12, color: colors.textMuted, fontFamily: font.sans },
  errorText: {
    fontSize: 13,
    color: colors.error,
    padding: 24,
    maxWidth: 480,
    textAlign: 'center',
    fontFamily: font.sans,
  },
});
