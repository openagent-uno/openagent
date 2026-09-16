/**
 * EventDeliveryHistoryContent — the events analogue of
 * ``TaskRunHistoryContent``.
 *
 * Fetches an event's recent deliveries from
 * ``GET /api/events/{id}/deliveries`` and renders them as a centered list of
 * navigable rows. A delivery's payload/transcript lives in the single run
 * screen (``/runs/{id}?kind=event``), so rows never expand inline — exactly
 * like a scheduled firing.
 *
 * Chrome-less so it drops straight into the history *screen*
 * (``app/(tabs)/events/runs/[id].tsx``) under that screen's header.
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
import { getEventDeliveries } from '../services/api';
import { openDetached } from '../services/windows';
import { useEvents } from '../stores/events';
import { runRoutePath } from '../../common/types';
import type { EventDelivery, EventDeliveryStatus } from '../../common/types';

// Shares the scheduled-run palette for the statuses they have in common.
const STATUS_COLOR: Record<EventDeliveryStatus, string> = {
  received: '#CC8020',
  running: '#CC8020',
  success: '#15885E',
  failed: '#C94A43',
  rejected: '#C94A43',
  // Muted, deliberately NOT the red of failed/rejected: a cancelled delivery
  // (usually a barge-in) is a normal outcome, not a fault.
  cancelled: '#8A8A8A',
};

export function EventDeliveryHistoryContent({
  eventId,
  parentName,
}: {
  eventId: string;
  parentName?: string;
}) {
  const router = useRouter();
  const [deliveries, setDeliveries] = useState<EventDelivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const load = async () => {
      if (first) setLoading(true);
      setError(null);
      try {
        const fetched = await getEventDeliveries(eventId, 20);
        if (!cancelled) setDeliveries(fetched);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      } finally {
        first = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const off = useEvents.getState().subscribe('event', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [eventId]);

  const summary = useMemo(() => {
    if (deliveries.length === 0) return null;
    const ok = deliveries.filter((d) => d.status === 'success').length;
    const failed = deliveries.filter(
      (d) => d.status === 'failed' || d.status === 'rejected',
    ).length;
    return { total: deliveries.length, ok, failed };
  }, [deliveries]);

  return (
    <View style={styles.content}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.listContent}>
        {summary ? (
          <Text style={styles.summary}>
            {summary.total} recent deliver{summary.total === 1 ? 'y' : 'ies'} ·{' '}
            {summary.ok} ok · {summary.failed} failed
          </Text>
        ) : null}
        {loading ? (
          <View style={styles.loadingPane}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : deliveries.length === 0 ? (
          <Text style={styles.emptyText}>
            No deliveries yet. Nothing has called this event's webhook.
          </Text>
        ) : (
          deliveries.map((d) => (
            <DeliveryCard
              key={d.id}
              delivery={d}
              onOpen={() => {
                const path = runRoutePath({
                  kind: 'event',
                  parentId: eventId,
                  runId: d.id,
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

function DeliveryCard({
  delivery,
  onOpen,
}: {
  delivery: EventDelivery;
  onOpen: () => void;
}) {
  const colorBand = STATUS_COLOR[delivery.status] || colors.textMuted;
  const live = delivery.status === 'running' || delivery.status === 'received';
  const duration =
    delivery.finished_at != null && delivery.started_at
      ? (delivery.finished_at - delivery.started_at).toFixed(2) + 's'
      : live
        ? '…'
        : '—';
  const started = delivery.started_at
    ? new Date(
        delivery.started_at < 1e12 ? delivery.started_at * 1000 : delivery.started_at,
      ).toLocaleString()
    : delivery.id.slice(0, 8);
  return (
    <TouchableOpacity
      onPress={onOpen}
      activeOpacity={0.85}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open event delivery ${started}`}
      // @ts-ignore web hover
      {...(Platform.OS === 'web' ? { className: 'oa-card-hover' } : {})}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.statusDot, { backgroundColor: colorBand }]} />
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{started}</Text>
          <Text style={styles.cardMeta}>
            {delivery.status} · {duration} · {delivery.source}
          </Text>
        </View>
        <Feather name="chevron-right" size={15} color={colors.textMuted} />
      </View>
      {delivery.error ? (
        <Text style={styles.cardError} numberOfLines={2}>
          {delivery.error}
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
  scroll: { flex: 1 },
  listContent: {
    padding: 20,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  loadingPane: { paddingVertical: 30, alignItems: 'center' },
  errorText: { color: colors.error, fontSize: 12 },
  emptyText: { color: colors.textMuted, fontSize: 12 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  cardText: { flex: 1 },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '500' },
  cardMeta: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: font.mono,
    marginTop: 2,
  },
  cardError: { color: colors.error, fontSize: 11, marginTop: 8 },
});
