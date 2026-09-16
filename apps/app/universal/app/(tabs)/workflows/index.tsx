/**
 * Workflows — dashboard grid.
 *
 * Multi-block workflow pipelines (n8n-style). Wired to /api/workflows — the
 * workflow-manager MCP and the scheduler loop read the same SQLite row, so
 * AI-initiated changes (`create_workflow`, `add_block`, …) show up here on the
 * next ``workflow`` broadcast without a restart.
 *
 * Same tile grid and proportions as Scheduled / Events (``TileGrid`` +
 * ``WorkflowTile``) — replaces the old full-width row list so the three
 * automation dashboards read as one surface. The inline "new workflow" form
 * renders above the grid inside the same measured column.
 */

import Feather from '@expo/vector-icons/Feather';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius } from '../../../theme';
import { useConnection } from '../../../stores/connection';
import { useEvents } from '../../../stores/events';
import { useWorkflows } from '../../../stores/workflows';
import { setBaseUrl } from '../../../services/api';
import { useConfirm } from '../../../components/ConfirmDialog';
import Button from '../../../components/Button';
import EmptyState from '../../../components/EmptyState';
import { Skeleton } from '../../../components/Skeleton';
import { HeaderAction, useHeaderInset } from '../../../components/screenHeader';
import WorkflowTile from '../../../components/workflow/WorkflowTile';
import { TileGridScreen, CONTENT_MAX_WIDTH } from '../../../components/TileGrid';
import { openDetached } from '../../../services/windows';
import type {
  CreateWorkflowInput,
  WorkflowNode,
  WorkflowTask,
} from '../../../../common/types';

const EMPTY_CREATE: CreateWorkflowInput = { name: '', description: '' };

// Fresh workflows get a single ``trigger-manual`` block so they're runnable
// from the Run button immediately. Users can add more triggers (scheduled, AI,
// event) inside the editor's palette.
function initialGraphNodes(): WorkflowNode[] {
  return [
    { id: 'n1', type: 'trigger-manual', label: 'Run', position: { x: 120, y: 120 }, config: {} },
  ];
}

export default function WorkflowsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const connConfig = useConnection((s) => s.config);
  const {
    workflows, loaded, error, runs, runningId,
    loadWorkflows, createWorkflow, deleteWorkflow, toggleWorkflow, runWorkflow, stopWorkflow, clearError,
  } = useWorkflows();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateWorkflowInput>(EMPTY_CREATE);
  // Concurrency cap is its own state because empty string is a meaningful
  // value (unlimited).
  const [maxConcurrentInput, setMaxConcurrentInput] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const confirm = useConfirm();

  const openCreate = useCallback(() => {
    setForm(EMPTY_CREATE);
    setMaxConcurrentInput('');
    setCreateError(null);
    setCreating(true);
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderAction icon="plus" label="New workflow" onPress={openCreate} />
      ),
    });
  }, [navigation, openCreate]);

  useEffect(() => {
    if (connConfig) {
      if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
      void loadWorkflows();
    }
  }, [connConfig]);

  useFocusEffect(useCallback(() => { void loadWorkflows(); }, [loadWorkflows]));

  // Refetch on every gateway-side change: chat-driven create_workflow, run
  // start/end, schedule tick. The store manages its own runningId, so a
  // refetch never strands a spinner.
  useEffect(() => {
    return useEvents.getState().subscribe('workflow', () => { void loadWorkflows(); });
  }, [loadWorkflows]);

  const handleCreate = async () => {
    setCreateError(null);
    const name = form.name.trim();
    if (!name) return;
    const trimmedCap = maxConcurrentInput.trim();
    let cap: number | null = null;
    if (trimmedCap !== '') {
      const parsed = Number(trimmedCap);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setCreateError('Max concurrent runs must be a whole number ≥ 1, or empty for unlimited.');
        return;
      }
      cap = parsed;
    }
    const created = await createWorkflow({
      ...form,
      name,
      nodes: initialGraphNodes(),
      edges: [],
      max_concurrent_runs: cap,
    });
    if (created) {
      setCreating(false);
      setForm(EMPTY_CREATE);
      setMaxConcurrentInput('');
      openDetached(router, `workflows/${created.id}`);
    }
  };

  const handleRemove = async (wf: WorkflowTask) => {
    const confirmed = await confirm({
      title: 'Remove Workflow',
      message: `Remove workflow "${wf.name}"? Its run history will be deleted too.`,
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    await deleteWorkflow(wf.id);
  };

  const isEmpty = loaded && workflows.length === 0 && !creating;

  const createForm = creating ? (
    <View style={styles.form}>
      <Text style={styles.formTitle}>New workflow</Text>
      <TextInput
        style={styles.input}
        value={form.name}
        onChangeText={(v) => setForm({ ...form, name: v })}
        placeholder="Name (unique)"
        placeholderTextColor={colors.textMuted}
      />
      {Platform.OS === 'web' ? (
        <textarea
          value={form.description}
          onChange={(e: any) => setForm({ ...form, description: e.target.value })}
          placeholder="What does this workflow do?"
          rows={2}
          style={{
            backgroundColor: colors.inputBg, borderRadius: 8,
            border: `1px solid ${colors.border}`, padding: 10,
            color: colors.text, fontSize: 13, fontFamily: 'inherit',
            resize: 'vertical', outline: 'none', width: '100%',
            boxSizing: 'border-box', marginBottom: 8,
          } as any}
        />
      ) : (
        <TextInput
          style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
          value={form.description}
          onChangeText={(v) => setForm({ ...form, description: v })}
          placeholder="What does this workflow do?"
          placeholderTextColor={colors.textMuted}
          multiline
        />
      )}
      <TextInput
        style={styles.input}
        value={maxConcurrentInput}
        onChangeText={setMaxConcurrentInput}
        placeholder="Max concurrent runs (empty = unlimited)"
        placeholderTextColor={colors.textMuted}
        keyboardType="number-pad"
        inputMode="numeric"
      />
      <Text style={styles.createHint}>
        Starts with a manual trigger so you can Run it right away. Add
        scheduled, AI, or event triggers from the editor's block palette. Leave
        concurrency empty to let every triggered run start immediately; set 1 to
        serialize.
      </Text>
      {createError && <Text style={styles.errorMsg}>{createError}</Text>}
      <View style={styles.formActions}>
        <Button
          variant="ghost"
          size="sm"
          label="Cancel"
          onPress={() => {
            setCreating(false);
            setForm(EMPTY_CREATE);
            setMaxConcurrentInput('');
            setCreateError(null);
            clearError();
          }}
        />
        <Button variant="primary" size="sm" label="Create" onPress={() => { void handleCreate(); }} />
      </View>
    </View>
  ) : null;

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

      {isEmpty ? (
        <EmptyState
          icon="git-merge"
          title="No workflows yet"
          message="Create one to get started, or ask OpenAgent to build one for you."
          action={{ label: 'New workflow', icon: 'plus', onPress: openCreate }}
        />
      ) : (
        <TileGridScreen headerInset={headerInset} header={createForm}>
          {!loaded && workflows.length === 0
            ? Array.from({ length: 8 }).map((_, i) => <WorkflowTileSkeleton key={i} />)
            : workflows.map((wf) => (
                <WorkflowTile
                  key={wf.id}
                  workflow={wf}
                  lastRun={runs[wf.id]}
                  running={runningId === wf.id}
                  onToggle={(v) => { void toggleWorkflow(wf.id, v); }}
                  onEdit={() => openDetached(router, `workflows/${wf.id}`)}
                  onHistory={() => openDetached(router, `workflows/runs/${wf.id}`)}
                  onRemove={() => { void handleRemove(wf); }}
                  onRun={() => runWorkflow(wf.id)}
                  onStop={() => stopWorkflow(wf.id, runs[wf.id]?.id)}
                />
              ))}
        </TileGridScreen>
      )}
    </View>
  );
}

// Placeholder tile mirroring WorkflowTile's footprint.
function WorkflowTileSkeleton() {
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

  form: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 14,
  },
  formTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 10,
    fontFamily: font.display,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 11,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 12,
    marginBottom: 8,
    fontFamily: font.mono,
  },
  createHint: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginBottom: 4 },
  errorMsg: { fontSize: 12, color: colors.error, marginTop: 6 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
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
