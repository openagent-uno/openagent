/**
 * Logs — the unified event log, read from `/api/logs`.
 *
 * Everything the agent does writes here on one schema: user turns, model
 * calls, MCP invocations, sub-agent delegations, scheduled fires, workflow
 * steps, federation messages, errors. The vision treats that stream as a
 * pillar — something developers read to debug and the agent reads to
 * diagnose itself — but nothing in the app could open it until now.
 *
 * The filter is an event *prefix*, matching the server's semantics
 * exactly: `tool.` catches `tool.call` and `tool.error` alike. The quick
 * chips are shortcuts for that field, not a separate mechanism.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TextInput } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors, font, radius } from '../../theme';
import { useHeaderInset } from '../../components/screenHeader';
import Button from '../../components/Button';
import Card from '../../components/Card';
import EmptyState from '../../components/EmptyState';
import ThemedSwitch from '../../components/ThemedSwitch';
import { Skeleton } from '../../components/Skeleton';
import Notice from '../../components/Notice';
import { useConfirm } from '../../components/ConfirmDialog';
import { getLogs, clearLogs, isUnsupportedByAgent } from '../../services/api';
import type { LogEntry } from '../../../common/types';

const QUICK_FILTERS: { label: string; prefix: string }[] = [
  { label: 'All', prefix: '' },
  { label: 'Errors', prefix: 'error' },
  { label: 'Tools', prefix: 'tool.' },
  { label: 'Models', prefix: 'model.' },
  { label: 'MCP', prefix: 'mcp.' },
  { label: 'Tasks', prefix: 'task.' },
  { label: 'Events', prefix: 'event.' },
  { label: 'Budgets', prefix: 'budget.' },
];

const LINE_CHOICES = [100, 200, 500, 1000];

/** Fields present on every entry — the rest is per-event payload. */
const ENVELOPE_KEYS = new Set(['ts', 'event', 'level']);

function levelColor(level: string): string {
  if (level === 'error' || level === 'critical') return colors.error;
  if (level === 'warning') return colors.warning;
  return colors.textMuted;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Render the payload compactly: `key=value` pairs, objects as JSON. A log
 *  line is scanned, not read, so a wall of pretty-printed JSON per row
 *  would defeat the purpose. */
function payloadOf(entry: LogEntry): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (ENVELOPE_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    const rendered = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${rendered}`);
  }
  return parts.join('  ');
}

export default function LogsScreen() {
  const headerInset = useHeaderInset();
  const confirm = useConfirm();
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [lines, setLines] = useState(200);
  const [follow, setFollow] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    try {
      const rows = await getLogs(lines, prefix.trim() || undefined);
      setEntries(rows);
      setError(null);
      setFailed(false);
    } catch (e) {
      // Same reasoning as the Skills screen: an empty array here would
      // render "The log is empty" next to the failure that produced it.
      setError(isUnsupportedByAgent(e)
        ? 'This agent runs an older OpenAgent that does not expose the event log yet. Update the agent and it will appear here.'
        : e instanceof Error ? e.message : String(e));
      setEntries(null);
      setFailed(true);
    }
  }, [lines, prefix]);

  useEffect(() => { void load(); }, [load]);

  // Follow mode re-reads the tail. 5s is a compromise: fast enough to
  // watch a run unfold, slow enough that a filter forcing a deep backward
  // scan doesn't run continuously.
  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [follow, load]);

  // The server returns oldest-first, so the newest line is at the bottom —
  // where a follower's eye already is.
  useEffect(() => {
    if (follow && entries) scrollRef.current?.scrollToEnd({ animated: false });
  }, [entries, follow]);

  const wipe = useCallback(async () => {
    const ok = await confirm({
      title: 'Clear the log',
      message: 'Truncate events.jsonl. This cannot be undone, and the agent reads this log to diagnose its own behaviour.',
      confirmLabel: 'Clear',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await clearLogs();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [confirm, load]);

  const counts = useMemo(() => {
    if (!entries) return { total: 0, errors: 0 };
    return {
      total: entries.length,
      errors: entries.filter((e) => e.level === 'error' || e.level === 'critical').length,
    };
  }, [entries]);

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      <View style={styles.toolbar}>
        <View style={styles.searchWrap}>
          <Feather name="filter" size={13} color={colors.textMuted} />
          <TextInput
            style={styles.search}
            value={prefix}
            onChangeText={setPrefix}
            placeholder="Event prefix — e.g. tool. or budget.create"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {prefix.length > 0 && (
            <Pressable onPress={() => setPrefix('')} hitSlop={8}>
              <Feather name="x" size={13} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
        <View style={styles.followWrap}>
          <Text style={styles.followLabel}>Follow</Text>
          <ThemedSwitch value={follow} onValueChange={setFollow} />
        </View>
        <Button label="Refresh" icon="refresh-cw" size="xs" variant="ghost" onPress={() => { void load(); }} />
        <Button label="Clear" icon="trash-2" size="xs" variant="danger" onPress={() => { void wipe(); }} />
      </View>

      {/* Two groups, not one wrapping row: a flex spacer between them
          collapses the moment the row wraps, which stranded the first
          line-count chip on the filter row and pushed the rest below. */}
      <View style={styles.chipBar}>
        <View style={styles.chipGroup}>
          {QUICK_FILTERS.map((f) => (
            <Pressable
              key={f.label}
              onPress={() => setPrefix(f.prefix)}
              style={[styles.chip, prefix === f.prefix && styles.chipActive]}
            >
              <Text style={[styles.chipText, prefix === f.prefix && styles.chipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.chipGroup}>
          <Text style={styles.chipGroupLabel}>lines</Text>
          {LINE_CHOICES.map((n) => (
            <Pressable
              key={n}
              onPress={() => setLines(n)}
              style={[styles.chip, lines === n && styles.chipActive]}
            >
              <Text style={[styles.chipText, lines === n && styles.chipTextActive]}>{n}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {error && <Notice style={styles.inset}>{error}</Notice>}

      {failed ? null : entries === null ? (
        <Card style={styles.pad}><Skeleton height={140} /></Card>
      ) : entries.length === 0 ? (
        <EmptyState
          icon="file-text"
          title={prefix ? 'No entries match that prefix' : 'The log is empty'}
          message={prefix
            ? `Nothing in the last ${lines} matching entries starts with "${prefix}".`
            : 'Nothing has been logged yet, or the log was cleared.'}
        />
      ) : (
        <>
          <ScrollView ref={scrollRef} style={styles.list} contentContainerStyle={styles.listContent}>
            {entries.map((entry, i) => {
              const payload = payloadOf(entry);
              return (
                <View key={`${entry.ts}-${i}`} style={styles.row}>
                  <Text style={styles.time}>{formatTime(entry.ts)}</Text>
                  <View style={[styles.levelDot, { backgroundColor: levelColor(entry.level) }]} />
                  <Text style={styles.event} numberOfLines={1} ellipsizeMode="tail">
                    {entry.event}
                  </Text>
                  {payload ? (
                    <Text style={styles.payload} numberOfLines={1}>{payload}</Text>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.statusBar}>
            <Text style={styles.statusText}>
              {counts.total} {counts.total === 1 ? 'entry' : 'entries'}
              {counts.errors > 0 ? ` · ${counts.errors} error${counts.errors === 1 ? '' : 's'}` : ''}
              {prefix ? ` · filtered by "${prefix}"` : ''}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  pad: { margin: 16 },
  inset: { marginHorizontal: 16, marginBottom: 8 },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 12,
  },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.inputBg,
    borderWidth: 1, borderColor: colors.border,
  },
  search: {
    flex: 1, fontSize: 12, color: colors.text,
    fontFamily: font.mono,
    // @ts-ignore — web-only: kill the default focus ring, the border is ours
    ...(typeof window !== 'undefined' ? { outlineStyle: 'none' as any } : {}),
  },
  followWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  followLabel: { fontSize: 11, color: colors.textSecondary },

  chipBar: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    justifyContent: 'space-between', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  chipGroup: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chipGroupLabel: {
    fontSize: 10, color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginRight: 2,
  },
  chip: {
    paddingHorizontal: 9, paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.inputBg,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 11, color: colors.textSecondary },
  chipTextActive: { color: colors.accent, fontWeight: '600' },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.errorSoft,
    borderWidth: 1, borderColor: colors.errorBorder,
  },
  errorText: { flex: 1, fontSize: 12, color: colors.error },

  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    // One line per entry keeps the rows an even height, which is what makes
    // a long list scannable; the full payload is still one click away in
    // the raw log.
    paddingVertical: 4,
    borderBottomWidth: 1, borderBottomColor: colors.borderLight,
  },
  time: { fontSize: 11, color: colors.textMuted, fontFamily: font.mono, width: 64 },
  levelDot: { width: 6, height: 6, borderRadius: 3 },
  // FIXED width, not minWidth: with `minWidth` a long event name pushed the
  // payload column right, so on real traffic (`agent.run_stream.start` next
  // to `task.done`) the payloads started at a different x on every row and
  // the eye had nothing to track down the page. A log is scanned, not read.
  event: { fontSize: 12, color: colors.text, fontFamily: font.mono, width: 190 },
  payload: { flex: 1, fontSize: 11, color: colors.textSecondary, fontFamily: font.mono },

  statusBar: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: colors.borderLight,
  },
  statusText: { fontSize: 11, color: colors.textMuted },
});
