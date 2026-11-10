import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Feather from '@expo/vector-icons/Feather';
import type { ComputerTarget, SessionDevice } from '../../common/devices';
import { isUnsupportedByAgent, listAgentComputerTargets, listComputerTargets, listSessionDevices } from '../services/api';
import { useConnection } from '../stores/connection';
import { colors } from '../theme';
import ComputerView from './ComputerView';

type Inventory = {
  key: string;
  devices: SessionDevice[];
  session: ComputerTarget[];
  agent: ComputerTarget[];
  historyError: boolean;
  sessionError: boolean;
  agentError: boolean;
  loading: boolean;
};

function emptyInventory(key: string): Inventory {
  return { key, devices: [], session: [], agent: [], historyError: false, sessionError: false, agentError: false, loading: true };
}

export default function SessionDevices({ sessionId }: { sessionId?: string }) {
  const active = useIsFocused();
  const accountId = useConnection(s => s.activeAccountId);
  const connected = useConnection(s => s.isConnected);
  const key = JSON.stringify([accountId, sessionId]);
  const [data, setData] = useState(() => emptyInventory(key));
  const [selected, setSelected] = useState<{ key: string; target: ComputerTarget; sessionId?: string }>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setData(emptyInventory(key));
    setSelected(undefined);
    if (!active || !connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const update = (value: Partial<Inventory>) => {
      if (!controller.signal.aborted) setData(previous => previous.key === key ? { ...previous, ...value } : previous);
    };
    const storeTargets = (kind: 'session' | 'agent', targets: ComputerTarget[], error: boolean) => {
      if (controller.signal.aborted) return;
      update(kind === 'session' ? { session: targets, sessionError: error } : { agent: targets, agentError: error });
      setSelected(previous => {
        if (!previous || (previous.sessionId ? 'session' : 'agent') !== kind) return previous;
        return targets.some(target => target.tool_ref === previous.target.tool_ref) ? previous : undefined;
      });
    };
    const refresh = async () => {
      await Promise.all([
        sessionId && listSessionDevices(sessionId, controller.signal).then(
          result => update({ devices: result.devices ?? [], historyError: false }),
          () => update({ devices: [], historyError: true }),
        ),
        sessionId && listComputerTargets(sessionId, controller.signal).then(
          result => storeTargets('session', result.targets ?? [], false),
          () => storeTargets('session', [], true),
        ),
        listAgentComputerTargets(controller.signal).then(
          result => storeTargets('agent', result.targets ?? [], false),
          error => storeTargets('agent', [], !isUnsupportedByAgent(error) && error?.status !== 403),
        ),
      ]);
      if (controller.signal.aborted) return;
      update({ loading: false });
      timer = setTimeout(refresh, 10_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, connected, key, sessionId, revision]);

  const current = data.key === key ? data : emptyInventory(key);
  const targetsError = current.sessionError || current.agentError;
  const targets = [
    ...current.agent.map(target => ({ target, sessionId: undefined })),
    ...current.session.filter(target => !target.agent_host || !current.agent.length).map(target => ({ target, sessionId })),
  ];
  return <View style={{ gap: 10 }}>
    {sessionId ? <>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Devices used in this session</Text>
      {current.devices.map(device => <View key={`${device.device_id}:${device.client_instance_id}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Feather name="monitor" size={14} color={colors.textMuted} />
        <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12 }}>{device.label}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 10 }}>Last used {new Date(device.last_used_at * 1000).toLocaleString()}</Text></View>
      </View>)}
      {!current.loading && !current.devices.length && <Text style={{ color: colors.textMuted, fontSize: 12 }}>{current.historyError ? 'Device history is unavailable for this session.' : 'No device use recorded yet.'}</Text>}
    </> : null}
    <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Open a computer</Text>
    {active && connected && current.loading && <ActivityIndicator size="small" color={colors.accent} />}
    {active && connected && targets.map(item => <Pressable key={`${item.sessionId ?? 'agent'}:${item.target.tool_ref}`} accessibilityRole="button" accessibilityLabel={`Open computer ${item.target.label}`}
      onPress={() => setSelected({ ...item, key })} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 }}>
      <Feather name="monitor" size={16} color={colors.accent} />
      <Text style={{ flex: 1, color: colors.accent, fontSize: 12 }}>{item.target.label}</Text><Feather name="external-link" size={14} color={colors.accent} />
    </Pressable>)}
    {!connected && <Text style={{ color: colors.textMuted, fontSize: 12 }}>Connect to the agent to see available computers.</Text>}
    {connected && !current.loading && !targets.length && !targetsError && <Text style={{ color: colors.textMuted, fontSize: 12 }}>No authorized computer desktop is available.</Text>}
    {(current.historyError || targetsError) && <Pressable accessibilityRole="button" onPress={() => setRevision(n => n + 1)}><Text style={{ color: colors.accent }}>{targetsError ? 'Retry computer discovery' : 'Retry device history'}</Text></Pressable>}
    {active && connected && selected?.key === key && <ComputerView key={`${key}:${selected.target.tool_ref}`} sessionId={selected.sessionId} target={selected.target} onClose={() => setSelected(undefined)} />}
  </View>;
}
