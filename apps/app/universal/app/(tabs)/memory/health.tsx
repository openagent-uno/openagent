/**
 * Memory health — the vault's maintenance surface.
 *
 * The API for all of this already existed in `services/api.ts` and nothing
 * in the app called any of it: stats, the doctor, the derived artifacts,
 * and the index sync were reachable only from the agent's own tools. So a
 * vault with a stale index or a hundred broken links looked perfectly fine
 * from the UI, and the only fix was to ask the agent to run it.
 *
 * The framing follows the vision: the Markdown is the memory, the index is
 * a rebuildable cache over it. Nothing here can lose a note — the doctor's
 * default is a dry run, and rebuilding the index is safe by construction.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors, font, radius } from '../../../theme';
import Card from '../../../components/Card';
import Button from '../../../components/Button';
import { Skeleton } from '../../../components/Skeleton';
import Notice from '../../../components/Notice';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useHeaderInset } from '../../../components/screenHeader';
import {
  getVaultStats, syncVaultIndex, runVaultDoctor, buildVaultDerived,
} from '../../../services/api';

type Stats = Awaited<ReturnType<typeof getVaultStats>>;
type DoctorResult = Awaited<ReturnType<typeof runVaultDoctor>>;

function Stat({ label, value, tint }: { label: string; value: string | number; tint?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tint ? { color: tint } : null]}>{value}</Text>
    </View>
  );
}

export default function MemoryHealthScreen() {
  const confirm = useConfirm();
  const headerInset = useHeaderInset();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getVaultStats());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void loadStats(); }, [loadStats]);

  /** Every action here shares the same shape: mark busy, run, report what
   *  actually happened, refresh the counts. */
  const run = useCallback(async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
      await loadStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadStats]);

  const rebuildIndex = (force: boolean) => run(force ? 'force' : 'sync', async () => {
    const r = await syncVaultIndex(force);
    return `Index reconciled in ${r.elapsed_ms}ms — ${r.added} added, ${r.updated} updated, ${r.deleted} removed, ${r.unchanged} unchanged. ${r.links} links, ${r.broken} broken.`;
  });

  const dryRunDoctor = () => run('doctor', async () => {
    const r = await runVaultDoctor(false);
    setDoctor(r);
    const fixable = r.fix.fixed.length;
    const suggested = r.fix.suggestions.length;
    return suggested === 0 && fixable === 0
      ? 'Dry run: nothing to fix.'
      : `Dry run: ${fixable} note${fixable === 1 ? '' : 's'} the doctor can fix automatically, ${suggested} suggestion${suggested === 1 ? '' : 's'} needing a human.`;
  });

  const applyDoctor = async () => {
    const ok = await confirm({
      title: 'Apply the doctor’s fixes',
      message: 'The doctor rewrites the notes it can fix and git-commits them. The commit means it is reversible, but it does write to the vault.',
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    await run('apply', async () => {
      const r = await runVaultDoctor(true);
      setDoctor(r);
      return `Applied: ${r.fix.files_changed} file${r.fix.files_changed === 1 ? '' : 's'} changed.`;
    });
  };

  const rebuildDerived = () => run('derived', async () => {
    const r = await buildVaultDerived();
    return `Rebuilt llms.txt (${r.llms_bytes} bytes) and the showcase (${r.showcase_bytes} bytes)${r.commit ? ` — committed ${r.commit.slice(0, 7)}` : ''}.`;
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: headerInset + 16 }]}>
      {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}
      {note && <Notice tone="success" onDismiss={() => setNote(null)}>{note}</Notice>}

      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Vault</Text>
        {!stats ? (
          <Skeleton height={56} />
        ) : (
          <>
            <View style={styles.statRow}>
              <Stat label="Notes" value={stats.notes} />
              <Stat label="Links" value={stats.links} />
              <Stat
                label="Broken"
                value={stats.broken_links}
                tint={stats.broken_links > 0 ? colors.warning : undefined}
              />
              <Stat
                label="Orphans"
                value={stats.orphans}
                tint={stats.orphans > 0 ? colors.warning : undefined}
              />
            </View>
            <Text style={styles.footnote}>
              {stats.components} disconnected {stats.components === 1 ? 'cluster' : 'clusters'}
              {stats.largest_component > 0 ? `, largest holds ${stats.largest_component} notes` : ''}.
              A vault that fragments into many clusters is one the agent
              cross-links too little — that is what dream mode exists to fix.
            </Text>
          </>
        )}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Index</Text>
        <Text style={styles.body}>
          The search index is a rebuildable cache over the Markdown, never a
          second source of truth. Rebuilding it cannot lose anything — after
          an edit made outside the app (a git pull, a file dropped into the
          vault folder), a full re-read is how it catches up.
        </Text>
        <View style={styles.actions}>
          <Button
            label={busy === 'sync' ? 'Reconciling…' : 'Reconcile'}
            icon="refresh-cw"
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onPress={() => { void rebuildIndex(false); }}
          />
          <Button
            label={busy === 'force' ? 'Rebuilding…' : 'Full rebuild'}
            icon="rotate-ccw"
            size="sm"
            disabled={!!busy}
            onPress={() => { void rebuildIndex(true); }}
          />
        </View>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Doctor</Text>
        <Text style={styles.body}>
          Checks every note against the vault's rules and reports what it can
          repair. The dry run only looks; applying rewrites the fixable notes
          and git-commits them.
        </Text>
        <View style={styles.actions}>
          <Button
            label={busy === 'doctor' ? 'Checking…' : 'Dry run'}
            icon="search"
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onPress={() => { void dryRunDoctor(); }}
          />
          <Button
            label={busy === 'apply' ? 'Applying…' : 'Apply fixes'}
            icon="tool"
            size="sm"
            disabled={!!busy || !doctor || doctor.fix.fixed.length === 0}
            onPress={() => { void applyDoctor(); }}
          />
        </View>
        {doctor && doctor.fix.suggestions.length > 0 && (
          <View style={styles.suggestions}>
            {doctor.fix.suggestions.slice(0, 12).map((s, i) => (
              <View key={`${s.path}-${i}`} style={styles.suggestion}>
                <Text style={styles.suggestionPath}>{s.path}</Text>
                <Text style={styles.suggestionText}>
                  <Text style={styles.suggestionRule}>{s.rule}</Text> — {s.message}
                </Text>
              </View>
            ))}
            {doctor.fix.suggestions.length > 12 && (
              <Text style={styles.footnote}>
                …and {doctor.fix.suggestions.length - 12} more.
              </Text>
            )}
          </View>
        )}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Derived artifacts</Text>
        <Text style={styles.body}>
          Regenerates llms.txt and the showcase from the current vault.
        </Text>
        <View style={styles.actions}>
          <Button
            label={busy === 'derived' ? 'Rebuilding…' : 'Rebuild'}
            icon="file-text"
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onPress={() => { void rebuildDerived(); }}
          />
        </View>
      </Card>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.error },
  noteBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  noteText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },

  card: { gap: 10 },
  cardTitle: {
    fontSize: 11, color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  body: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  footnote: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },

  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
  stat: { minWidth: 62 },
  statLabel: { fontSize: 10, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: {
    fontSize: 19, fontWeight: '600', color: colors.text,
    fontFamily: font.display, marginTop: 2,
  },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  suggestions: { gap: 8, marginTop: 4 },
  suggestion: {
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: radius.md,
    backgroundColor: colors.mutedSoft,
  },
  suggestionPath: { fontSize: 11, color: colors.text, fontFamily: font.mono },
  suggestionText: { fontSize: 11, color: colors.textSecondary, marginTop: 2, lineHeight: 15 },
  suggestionRule: { color: colors.warning },
});
