import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { ComputerTarget, SessionDevice } from '../../common/devices';
import { isUnsupportedByAgent, listComputerTargets, listSessionDevices } from '../services/api';
import { useConnection } from '../stores/connection';
import { colors } from '../theme';
import ComputerView from './ComputerView';

export default function SessionDevices({ sessionId }: { sessionId: string }) {
  const accountId = useConnection(s => s.activeAccountId);
  const [data, setData] = useState<{ key: string; devices: SessionDevice[]; targets: ComputerTarget[] }>({ key: '', devices: [], targets: [] });
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ComputerTarget | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${accountId}:${sessionId}`;
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError(null); setTarget(null); setData({ key, devices: [], targets: [] });
    const refresh = async () => {
      const results = await Promise.allSettled([listSessionDevices(sessionId, controller.signal), listComputerTargets(sessionId, controller.signal)]);
      if (!current) return;
      const failed = results.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') {
        setError(isUnsupportedByAgent(failed.reason) ? 'Update the agent server to use connected computers.' : 'Computer information is unavailable.');
        // Never retain actionable references following an authorization error.
        setData({ key, devices: [], targets: [] }); setTarget(null);
      } else {
        setError(null);
        setData({ key, devices: results[0].status === 'fulfilled' ? results[0].value.devices : [], targets: results[1].status === 'fulfilled' ? results[1].value.targets : [] });
      }
      timer = setTimeout(refresh, 10000);
    };
    void refresh();
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [key, sessionId, revision]);
  const close = useCallback(() => setTarget(null), []);
  const current = data.key === key ? data : { devices: [], targets: [] };
  return <View style={{ gap: 10 }}>
    <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Devices used in this session</Text>
    {current.devices.length ? current.devices.map(device => <View key={`${device.device_id}:${device.client_instance_id}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Feather name="monitor" size={14} color={colors.textMuted} />
      <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12 }}>{device.label}</Text>
        <Text style={{ color: colors.textMuted, fontSize: 10 }}>Last used {new Date(device.last_used_at * 1000).toLocaleString()}</Text></View>
    </View>) : <Text style={{ color: colors.textMuted, fontSize: 12 }}>No device use recorded yet.</Text>}
    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>Open a computer</Text>
    {current.targets.map(computer => <Pressable key={computer.tool_ref} accessibilityRole="button" accessibilityLabel={`Open computer ${computer.label}`}
      onPress={() => setTarget(computer)} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 }}>
      <Feather name="monitor" size={16} color={colors.accent} />
      <Text style={{ flex: 1, color: colors.accent, fontSize: 12 }}>{computer.label}</Text><Feather name="external-link" size={14} color={colors.accent} />
    </Pressable>)}
    {!current.targets.length && !error && <Text style={{ color: colors.textMuted, fontSize: 12 }}>No authorized computer desktop is available. Connect a device with computer tools enabled, or configure the agent’s desktop tools.</Text>}
    {error && <View style={{ gap: 6 }}><Text style={{ color: colors.textMuted, fontSize: 12 }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRevision(n => n + 1)}><Text style={{ color: colors.accent }}>Retry</Text></Pressable></View>}
    {target && data.key === key && <ComputerView key={`${key}:${target.tool_ref}`} sessionId={sessionId} target={target} onClose={close} />}
  </View>;
}
