/**
 * Events — dashboard grid.
 *
 * Events are the webhook channel: an inbound trigger (name, type, per-event
 * secret, input schema) bound to an action — run a workflow, fire a scheduled
 * task, or start a chat prompt. Stored in the backend SQLite DB, served over
 * /api/events; the dedicated webhook listener (Settings → Channels → Webhook)
 * serves inbound deliveries.
 *
 * Same tile grid and proportions as Scheduled / Workflows (``TileGrid`` +
 * ``EventTile``): a header "New event" action, tiles with an enable switch and
 * Test / History / Edit affordances, refetched on ``event`` resource
 * broadcasts so a chat-created event or a live delivery shows up without a
 * manual refresh.
 */

import Feather from '@expo/vector-icons/Feather';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius } from '../../../theme';
import { useConnection } from '../../../stores/connection';
import { useEvents } from '../../../stores/events';
import { useEventDefs } from '../../../stores/eventDefs';
import { setBaseUrl } from '../../../services/api';
import { openDetached } from '../../../services/windows';
import { useConfirm } from '../../../components/ConfirmDialog';
import EmptyState from '../../../components/EmptyState';
import { HeaderAction, useHeaderInset } from '../../../components/screenHeader';
import EventTile from '../../../components/events/EventTile';
import { TileGridScreen, CONTENT_MAX_WIDTH } from '../../../components/TileGrid';
import { Skeleton } from '../../../components/Skeleton';
import type { AgentEvent } from '../../../../common/types';

export default function EventsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerInset = useHeaderInset();
  const connConfig = useConnection((s) => s.config);
  const { events, loaded, error, loadEvents, toggleEvent, deleteEvent, testEvent } = useEventDefs();
  const confirm = useConfirm();

  const handleAdd = useCallback(() => {
    // ``new`` is the create sentinel — caught by events/[id].tsx since event
    // ids are uuids and never literally "new".
    openDetached(router, 'events/new');
  }, [router]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <HeaderAction icon="plus" label="New event" onPress={handleAdd} />,
    });
  }, [navigation, handleAdd]);

  useEffect(() => {
    if (connConfig) {
      if (connConfig.sidecarPort) setBaseUrl('127.0.0.1', connConfig.sidecarPort);
      void loadEvents();
    }
  }, [connConfig]);

  useFocusEffect(useCallback(() => { void loadEvents(); }, [loadEvents]));

  // Refetch on chat-driven creates + every delivery (received → done) so the
  // list stays live.
  useEffect(() => {
    return useEvents.getState().subscribe('event', () => { void loadEvents(); });
  }, [loadEvents]);

  const handleRemove = async (ev: AgentEvent) => {
    const ok = await confirm({
      title: 'Remove Event',
      message:
        `Remove event "${ev.name}"? Its webhook stops working immediately and ` +
        'its delivery history is removed.',
      confirmLabel: 'Remove',
    });
    if (ok) await deleteEvent(ev.id);
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

      {loaded && events.length === 0 ? (
        <EmptyState
          icon="zap"
          title="No events yet"
          message="Create an event to let an external service — or a peer agent — trigger a workflow, a scheduled task, or a chat session over a webhook."
          action={{ label: 'New event', icon: 'plus', onPress: handleAdd }}
        />
      ) : (
        <TileGridScreen headerInset={headerInset}>
          {!loaded
            ? Array.from({ length: 8 }).map((_, i) => <EventTileSkeleton key={i} />)
            : events.map((ev) => (
                <EventTile
                  key={ev.id}
                  event={ev}
                  onToggle={(v) => { void toggleEvent(ev.id, v); }}
                  onEdit={() => openDetached(router, `events/${ev.id}`)}
                  onHistory={() => openDetached(router, `events/runs/${ev.id}`)}
                  onRemove={() => { void handleRemove(ev); }}
                  onTest={() => testEvent(ev.id, { test: true })}
                />
              ))}
        </TileGridScreen>
      )}
    </View>
  );
}

// Placeholder tile mirroring EventTile's footprint — shown while the first
// /api/events fetch is in flight so the screen renders immediately instead of
// flashing the empty state.
function EventTileSkeleton() {
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
