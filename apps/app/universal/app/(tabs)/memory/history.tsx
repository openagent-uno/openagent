/**
 * Memory — vault-wide git history. Pushed onto the Memory Stack.
 *
 * Lists the vault's git log newest-first: each commit shows its subject,
 * a relative date, the short hash, and a provenance chip (origin +
 * session / workflow / task when the agent stamped them). Subscribes to
 * the ``'vault'`` resource-event channel so it refetches live whenever
 * the agent (or another tab) writes a note — mirrors ``memory/index``.
 *
 * Per-note history lives at ``memory/history/[...path]`` — same body,
 * scoped to one note via ``getVaultHistory(path)``.
 */

import { useCallback, useEffect, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import {
  ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import type { VaultCommit, VaultCommitDetail } from '../../../../common/types';
import { useConnection } from '../../../stores/connection';
import { useEvents } from '../../../stores/events';
import {
  getVaultCommit, getVaultHistory, resetVault, restoreVault, setBaseUrl,
} from '../../../services/api';
import { colors, font, radius } from '../../../theme';
import { useHeaderInset } from '../../../components/screenHeader';

// Cross-platform confirm: a blocking ``window.confirm`` on web (RN-web's
// Alert.alert has no usable button callbacks), a native action sheet via
// Alert.alert elsewhere. Resolves true only on explicit confirmation.
function confirmAsync(
  title: string, message: string, confirmLabel: string, destructive = false,
): Promise<boolean> {
  if (Platform.OS === 'web') {
    const ok = typeof window !== 'undefined'
      && window.confirm(`${title}\n\n${message}`);
    return Promise.resolve(!!ok);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      {
        text: confirmLabel,
        style: destructive ? 'destructive' : 'default',
        onPress: () => resolve(true),
      },
    ]);
  });
}

// One line of a unified diff, coloured by its leading marker.
function DiffLine({ line }: { line: string }) {
  let color = colors.textMuted;
  if (line.startsWith('+') && !line.startsWith('+++')) color = colors.success;
  else if (line.startsWith('-') && !line.startsWith('---')) color = colors.error;
  else if (line.startsWith('@@')) color = colors.primary;
  return <Text style={[styles.diffLine, { color }]}>{line || ' '}</Text>;
}

// Relative-age label from an ISO date string (mirror ``fmtAge`` in
// MembersPanel, which works off epoch seconds).
function fmtSince(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = Math.max(0, (Date.now() - t) / 1000);
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// Compact provenance label — origin first, then whichever of
// session / workflow / task is present. Keeps the chip short.
function provenanceLabel(p: Record<string, string>): string {
  const parts: string[] = [];
  if (p.origin) parts.push(p.origin);
  for (const k of ['workflow', 'task', 'session'] as const) {
    if (p[k]) {
      parts.push(`${k}:${p[k].slice(0, 8)}`);
      break;
    }
  }
  return parts.join(' · ');
}

export function HistoryList({ path }: { path?: string }) {
  const headerInset = useHeaderInset();
  const config = useConnection((s) => s.config);
  const [commits, setCommits] = useState<VaultCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getVaultHistory(path, 100);
      setCommits(res.commits ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!config) return;
    if (config.sidecarPort) setBaseUrl('127.0.0.1', config.sidecarPort);
    void load();
    // Live-refresh on vault writes — same channel the graph screen uses.
    const unsub = useEvents.getState().subscribe('vault', () => void load());
    return () => { unsub(); };
  }, [config, path, load]);

  if (loading && commits.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Loading history…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (commits.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No commits yet</Text>
      </View>
    );
  }

  // The newest commit is the current state — there's nothing after it to
  // restore from or reset to, so its actions are hidden.
  const headHash = commits[0]?.hash;

  return (
    <ScrollView style={styles.list} contentContainerStyle={[styles.listContent, { paddingTop: headerInset + 14 }]}>
      {commits.map((c) => (
        <CommitRow
          key={c.hash}
          commit={c}
          isHead={c.hash === headHash}
          reload={load}
        />
      ))}
    </ScrollView>
  );
}

// One commit: tap to expand its changes (files + diff), then optionally
// restore the vault to that state (safe) or reset to it (destructive).
function CommitRow({
  commit, isHead, reload,
}: { commit: VaultCommit; isHead: boolean; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<VaultCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState<null | 'restore' | 'reset'>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const prov = provenanceLabel(commit.provenance ?? {});
  const short = commit.hash.slice(0, 7);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail && !loadingDetail) {
      setLoadingDetail(true);
      try {
        setDetail(await getVaultCommit(commit.hash));
      } catch (e: any) {
        setMsg(e.message ?? 'Failed to load changes');
      } finally {
        setLoadingDetail(false);
      }
    }
  };

  const onRestore = async () => {
    const ok = await confirmAsync(
      'Restore this state',
      `Bring the whole vault back to how it was at ${short} ("${commit.subject}").\n\n`
        + 'This adds a new commit — your later history is kept and this is itself undoable.',
      'Restore');
    if (!ok) return;
    setBusy('restore'); setMsg(null);
    try {
      const res = await restoreVault(commit.hash);
      if (res.error) setMsg(res.error);
      else { setMsg(res.changed ? 'Restored.' : 'Already at that state.'); await reload(); }
    } catch (e: any) {
      setMsg(e.message ?? 'Restore failed');
    } finally {
      setBusy(null);
    }
  };

  const onReset = async () => {
    const ok = await confirmAsync(
      'Reset to this commit',
      `This PERMANENTLY DELETES every commit after ${short} ("${commit.subject}") and `
        + 'makes it the latest state. This cannot be undone.',
      'Delete later commits', true);
    if (!ok) return;
    setBusy('reset'); setMsg(null);
    try {
      const res = await resetVault(commit.hash);
      if (res.error) setMsg(res.error);
      else { setMsg(`Reset — deleted ${res.deleted ?? 0} later commit(s).`); await reload(); }
    } catch (e: any) {
      setMsg(e.message ?? 'Reset failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={toggle} activeOpacity={0.6}>
        <View style={styles.rowHeader}>
          <Feather
            name={open ? 'chevron-down' : 'chevron-right'}
            size={14} color={colors.textMuted} style={styles.chevron}
          />
          <Text style={styles.subject} numberOfLines={open ? undefined : 2}>{commit.subject}</Text>
          <Text style={styles.hash}>{short}</Text>
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.metaText}>{fmtSince(commit.date)}</Text>
          {commit.author ? <Text style={styles.metaText}> · {commit.author}</Text> : null}
          {isHead ? (
            <View style={[styles.provChip, styles.headChip]}>
              <Text style={styles.provChipText}>current</Text>
            </View>
          ) : null}
          {prov ? (
            <View style={styles.provChip}>
              <Text style={styles.provChipText}>{prov}</Text>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>

      {open ? (
        <View style={styles.detail}>
          {loadingDetail ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : detail ? (
            <>
              {detail.files.map((f) => (
                <Text key={f.path} style={styles.fileLine}>
                  <Text style={styles.fileStatus}>{f.status}</Text>
                  {`  ${f.path}`}
                </Text>
              ))}
              {detail.diff ? (
                <ScrollView horizontal style={styles.diffBox} contentContainerStyle={styles.diffContent}>
                  <View>
                    {detail.diff.split('\n').map((ln, i) => <DiffLine key={i} line={ln} />)}
                  </View>
                </ScrollView>
              ) : null}
              {detail.diff_truncated ? (
                <Text style={styles.truncated}>… diff truncated</Text>
              ) : null}
            </>
          ) : null}

          {!isHead ? (
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.restoreBtn]}
                onPress={onRestore} disabled={busy !== null} activeOpacity={0.7}
              >
                {busy === 'restore'
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={styles.restoreText}>Restore this state</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, styles.resetBtn]}
                onPress={onReset} disabled={busy !== null} activeOpacity={0.7}
              >
                {busy === 'reset'
                  ? <ActivityIndicator size="small" color={colors.error} />
                  : <Text style={styles.resetText}>Reset to here</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.headNote}>This is the current state of the vault.</Text>
          )}
          {msg ? <Text style={styles.actionMsg}>{msg}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export default function VaultHistoryScreen() {
  // The header (back + "Vault history" title) is the react-navigation
  // header from memory/_layout.tsx — this screen is just the list body.
  return (
    <View style={styles.screen}>
      <HistoryList />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  row: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  rowHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  subject: { flex: 1, fontSize: 13, color: colors.text, fontWeight: '500', lineHeight: 18 },
  hash: {
    fontSize: 10, color: colors.textMuted, fontFamily: font.mono,
    marginTop: 2,
  },
  rowMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
  metaText: { fontSize: 10.5, color: colors.textMuted, fontFamily: font.mono },
  provChip: {
    marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.xs, backgroundColor: colors.mutedSoft,
  },
  provChipText: { fontSize: 9.5, color: colors.textSecondary, fontFamily: font.mono },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: colors.textMuted, fontSize: 12 },
  errorText: { color: colors.error, fontSize: 12, textAlign: 'center' },
  chevron: { marginTop: 2 },
  headChip: { backgroundColor: colors.primarySoft },
  // expanded detail
  detail: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.borderLight },
  fileLine: { fontSize: 11, color: colors.textSecondary, fontFamily: font.mono, marginBottom: 2 },
  fileStatus: { color: colors.warning, fontWeight: '700' },
  diffBox: {
    marginTop: 8, maxHeight: 320, backgroundColor: colors.codeBg,
    borderRadius: radius.xs, borderWidth: 1, borderColor: colors.borderLight,
  },
  diffContent: { padding: 10 },
  diffLine: { fontSize: 10.5, lineHeight: 15, fontFamily: font.mono },
  truncated: { fontSize: 10, color: colors.textMuted, marginTop: 4, fontStyle: 'italic' },
  // actions
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionBtn: {
    flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, minHeight: 36,
  },
  restoreBtn: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  restoreText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  resetBtn: { backgroundColor: colors.errorSoft, borderColor: colors.errorBorder },
  resetText: { fontSize: 12, color: colors.error, fontWeight: '600' },
  headNote: { fontSize: 11, color: colors.textMuted, marginTop: 8, fontStyle: 'italic' },
  actionMsg: { fontSize: 11, color: colors.textSecondary, marginTop: 8 },
});
