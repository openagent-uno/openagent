import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { ConnectedDevice } from '../../../common/devices';
import { isUnsupportedByAgent, listDevices } from '../../services/api';
import { useConnection } from '../../stores/connection';
import { colors, radius } from '../../theme';
import { useHeaderInset } from '../../components/screenHeader';

export default function DevicesScreen() {
  const inset = useHeaderInset();
  const accountId = useConnection(s => s.activeAccountId);
  const [state, setState] = useState<{ account: string | null; devices: ConnectedDevice[] }>({ account: null, devices: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // Revision intentionally restarts this focused inventory subscription.
  useFocusEffect(useCallback(() => {
    void revision;
    let current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError(null); setState({ account: accountId, devices: [] });
    const refresh = async () => {
      try {
        const result = await listDevices(controller.signal);
        if (current) { setState({ account: accountId, devices: result.devices }); setError(null); }
      } catch (e) {
        if (current) { setState({ account: accountId, devices: [] }); setError(isUnsupportedByAgent(e) ? 'Update the agent server to see connected devices.' : 'Devices are unavailable. Check your connection and try again.'); }
      } finally { if (current) { setLoading(false); timer = setTimeout(refresh, 10000); } }
    };
    void refresh();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [accountId, revision]));
  const devices = state.account === accountId ? state.devices : [];
  return <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: inset + 20, paddingHorizontal: 20, paddingBottom: 32, gap: 20 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ flex: 1, color: colors.text, fontSize: 24, fontWeight: '600' }}>Devices</Text>
      {loading && <ActivityIndicator color={colors.accent} />}
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh devices" onPress={() => setRevision(n => n + 1)} style={{ padding: 10 }}><Feather name="refresh-cw" size={18} color={colors.accent} /></Pressable>
    </View>
    <Text style={{ color: colors.textSecondary }}>Your connected OpenAgent clients share their enabled tools with your interactive sessions. Device access is managed in Settings on each computer.</Text>
    {error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}
    {!loading && !error && !devices.length && <Text style={{ color: colors.textMuted }}>No devices yet. Open the desktop app and enable local computer tools in Settings.</Text>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
      {devices.map(device => <View key={`${device.device_id}:${device.client_instance_id}`} style={{ flexGrow: 1, flexBasis: 260, flexShrink: 1, maxWidth: 480, minWidth: 0, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 20, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Feather name="monitor" size={24} color={device.online ? colors.accent : colors.textMuted} />
          <Text style={{ flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' }}>{device.label}</Text>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: device.online ? colors.success : colors.textMuted }} />
        </View>
        <Text style={{ color: device.online ? colors.success : colors.textMuted, fontSize: 12 }}>{device.online ? 'Connected' : 'Offline'}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{device.modules.map(module => <Text key={module} style={{ color: colors.textSecondary, backgroundColor: colors.bg, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, fontSize: 11 }}>{module}</Text>)}</View>
        {!device.online && <Text style={{ color: colors.textMuted, fontSize: 11 }}>Last seen {new Date(device.last_seen_at * 1000).toLocaleString()}</Text>}
      </View>)}
    </View>
  </ScrollView>;
}
