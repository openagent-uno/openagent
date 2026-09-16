/**
 * Event delivery-history screen — /events/runs/{id}.
 *
 * Pushed onto the Events stack; the header (back + title) comes from the
 * navigator (see events/_layout.tsx). Renders the shared
 * ``EventDeliveryHistoryContent`` body — the events analogue of the
 * scheduled-task run history.
 */

import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../../../../theme';
import { EventDeliveryHistoryContent } from '../../../../components/EventDeliveryHistoryContent';
import { useHeaderInset } from '../../../../components/screenHeader';
import { useConnection } from '../../../../stores/connection';
import { setBaseUrl, getEvent } from '../../../../services/api';

export default function EventRunsScreen() {
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
        const e = await getEvent(id);
        if (!cancelled) setName(e?.name ?? null);
      } catch {
        /* the title is optional — leave the generic one on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connConfig, id]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: 'Deliveries' });
  }, [navigation, name]);

  return (
    <View style={[styles.screen, { paddingTop: headerInset }]}>
      {connConfig && id ? (
        <EventDeliveryHistoryContent eventId={id} parentName={name ?? undefined} />
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
