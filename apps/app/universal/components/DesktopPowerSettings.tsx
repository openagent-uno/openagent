import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { DesktopPowerAPI, DesktopPowerStatus } from '../../common/desktop-power';
import { colors } from '../theme';
import Card from './Card';
import Button from './Button';
import ThemedSwitch from './ThemedSwitch';

function bridge(): DesktopPowerAPI | null {
  const api = typeof window !== 'undefined' ? (window as any).desktop : undefined;
  return typeof api?.getPowerStatus === 'function' ? api : null;
}

export default function DesktopPowerSettings() {
  const [status, setStatus] = useState<DesktopPowerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const api = bridge(); if (!api) return;
    let current = true;
    const read = () => { void api.getPowerStatus().then(value => { if (current) setStatus(value); }).catch(() => {}); };
    read(); const timer = setInterval(read, 2_000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  if (!status) return null;
  const change = async (input: { preventSleep?: boolean; closedLid?: boolean }) => {
    const api = bridge(); if (!api) return;
    setBusy(true); setError('');
    try { setStatus(await api.setPowerPreferences(input)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Power settings unavailable'); }
    finally { setBusy(false); }
  };
  return <Card style={{ marginBottom: 14 }}>
    <View style={styles.row}>
      <Text style={styles.label}>Keep computer awake during active sessions</Text>
      <ThemedSwitch value={status.preventSleep} disabled={busy} accessibilityLabel="Keep computer awake during active sessions"
        onValueChange={value => { void change({ preventSleep: value }); }} />
    </View>
    <Text style={styles.hint}>Applies across connected agents and windows. The display can turn off normally.</Text>
    <Text style={styles.state}>{status.blocking ? 'Keeping computer awake' : status.preventSleep ? 'Waiting for active sessions' : 'Using system sleep settings'}</Text>
    {status.lidStatus !== 'unsupported' && <>
      <View style={[styles.row, { marginTop: 16 }]}>
        <Text style={styles.label}>Continue with lid closed</Text>
        <ThemedSwitch value={status.closedLid} disabled={busy || !status.preventSleep} accessibilityLabel="Continue with lid closed"
          onValueChange={value => { void change({ closedLid: value }); }} />
      </View>
      <Text style={styles.hint}>macOS requires approval for the OpenAgent power service. Sleep settings are restored after active work ends, including if the app closes.</Text>
      {status.lidStatus === 'approval-required' && <Button label="Open macOS approval" variant="secondary" disabled={busy}
        onPress={() => { void change({ closedLid: true }); }} />}
      {status.lidStatus === 'setup-required' && status.closedLid && <Button label="Enable macOS power service" variant="secondary" disabled={busy}
        onPress={() => { void change({ closedLid: true }); }} />}
      {status.lidStatus === 'active' && <Text style={styles.state}>Closed-lid protection active</Text>}
      {status.lidStatus === 'paused' && <Text style={styles.state}>Closed-lid mode paused at the battery or temperature limit.</Text>}
      {status.lidStatus === 'error' && <Text style={styles.error}>Closed-lid protection is unavailable. Normal sleep prevention remains available.</Text>}
    </>}
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </Card>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { flex: 1, color: colors.text, fontSize: 13 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: 8, lineHeight: 18 },
  state: { color: colors.textMuted, fontSize: 11, marginTop: 8 },
  error: { color: colors.error, fontSize: 12, marginTop: 8 },
});
