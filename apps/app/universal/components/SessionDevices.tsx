import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Feather from '@expo/vector-icons/Feather';
import type { AgentComputer, ComputerTarget, SessionDevice } from '../../common/devices';
import { isUnsupportedByAgent, listAgentComputerTargets, listComputerTargets, listSessionDevices } from '../services/api';
import { useConnection } from '../stores/connection';
import { colors } from '../theme';
import ComputerView from './ComputerView';

type Inventory = {
  key: string;
  devices: SessionDevice[];
  session: ComputerTarget[];
  agent: ComputerTarget[];
  host?: AgentComputer;
  historyError: boolean;
  sessionError: boolean;
  agentIssue?: 'forbidden' | 'unsupported' | 'temporary';
  loading: boolean;
};

function emptyInventory(key: string): Inventory {
  return { key, devices: [], session: [], agent: [], historyError: false, sessionError: false, loading: true };
}

export default function SessionDevices({ sessionId, showHostLabel = true }: { sessionId?: string; showHostLabel?: boolean }) {
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
    const storeTargets = (kind: 'session' | 'agent', targets: ComputerTarget[], error?: Inventory['agentIssue']) => {
      if (controller.signal.aborted) return;
      if (kind === 'agent') {
        update(error === 'temporary' ? { agentIssue: error } : { agent: targets, agentIssue: error });
      } else if (error) {
        update(error === 'temporary' ? { sessionError: true } : { session: [], sessionError: true });
      } else {
        update({ session: targets, sessionError: false });
      }
      // A transient inventory failure isn't proof that a live viewer lost
      // access. Its own transport already checks each action and stream.
      if (error === 'temporary') return;
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
          result => storeTargets('session', result.targets ?? []),
          error => storeTargets('session', [], error?.status === 403 || error?.status === 404 ? 'forbidden' : 'temporary'),
        ),
        listAgentComputerTargets(controller.signal).then(
          result => {
            update({ host: result.host });
            storeTargets('agent', result.targets ?? []);
          },
          error => storeTargets('agent', [], error?.status === 403 ? 'forbidden'
            : isUnsupportedByAgent(error) ? 'unsupported' : 'temporary'),
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
  const targetsError = current.sessionError || current.agentIssue === 'temporary';
  let desktopStatus: string | undefined;
  if (current.host?.desktop === 'restricted' || current.agentIssue === 'forbidden') {
    desktopStatus = 'This login does not have permission to view the agent desktop.';
  } else if (current.host?.desktop === 'unavailable') {
    desktopStatus = 'Agent host online. No desktop display is available.';
  } else if (current.agentIssue === 'unsupported') {
    desktopStatus = 'Update the agent server to open its desktop.';
  } else if (!current.host && !current.agent.length && !current.agentIssue) {
    desktopStatus = 'This server did not provide an agent desktop.';
  }
  const agentTargets = current.agent.map(target => ({ target, sessionId: undefined }));
  const sessionTargets = current.session
    .filter(target => !target.agent_host || !current.agent.length)
    .map(target => ({ target, sessionId }));
  const selectedTarget = selected?.key === key && [...agentTargets, ...sessionTargets].find(item =>
    item.sessionId === selected.sessionId && item.target.tool_ref === selected.target.tool_ref);
  const openButton = (item: { target: ComputerTarget; sessionId?: string }) => (
    <Pressable key={`${item.sessionId ?? 'agent'}:${item.target.tool_ref}`}
      accessibilityRole="button" accessibilityLabel={`Open computer ${item.target.label}`}
      onPress={() => setSelected({ ...item, key })}
      style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 }}>
      <Feather name="monitor" size={16} color={colors.accent} />
      <Text style={{ flex: 1, color: colors.accent, fontSize: 12 }}>{item.target.label}</Text>
      <Feather name="external-link" size={14} color={colors.accent} />
    </Pressable>
  );
  return <View style={{ gap: 10 }}>
    {showHostLabel && <Text style={{ color: colors.textSecondary, fontSize: 12 }}>{current.host?.label ?? 'Agent computer'}</Text>}
    {current.host?.platform && <Text style={{ color: colors.textMuted, fontSize: 11 }}>{current.host.platform}</Text>}
    {connected && !current.loading && desktopStatus && <Text style={{ color: colors.textMuted, fontSize: 12 }}>{desktopStatus}</Text>}
    {active && connected && agentTargets.map(openButton)}
    {sessionId ? <>
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Devices used in this session</Text>
      {current.devices.map(device => <View key={`${device.device_id}:${device.client_instance_id}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Feather name="monitor" size={14} color={colors.textMuted} />
        <View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12 }}>{device.label}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 10 }}>Last used {new Date(device.last_used_at * 1000).toLocaleString()}</Text></View>
      </View>)}
      {!current.loading && !current.devices.length && <Text style={{ color: colors.textMuted, fontSize: 12 }}>{current.historyError ? 'Device history is unavailable for this session.' : 'No device use recorded yet.'}</Text>}
    </> : null}

    {active && connected && current.loading && <ActivityIndicator size="small" color={colors.accent} />}
    {active && connected && sessionTargets.map(openButton)}
    {!connected && <Text style={{ color: colors.textMuted, fontSize: 12 }}>Connect to the agent to see available computers.</Text>}
    {(current.historyError || targetsError) && <Pressable accessibilityRole="button" onPress={() => setRevision(n => n + 1)}><Text style={{ color: colors.accent }}>{targetsError ? 'Retry computer discovery' : 'Retry device history'}</Text></Pressable>}
    {active && connected && selectedTarget && <ComputerView key={`${key}:${selectedTarget.target.tool_ref}`} sessionId={selectedTarget.sessionId} target={selectedTarget.target} onClose={() => setSelected(undefined)} />}
  </View>;
}
