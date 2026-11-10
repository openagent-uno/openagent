import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
  currentAgentScope, getAgentAccess, isUnsupportedByAgent, transferAgentOwner, updateAgentAccess,
  type AgentAccessSettings,
} from '../services/api';
import { useConnection } from '../stores/connection';
import { useConfig } from '../stores/config';
import { colors, radius } from '../theme';
import Button from './Button';
import Card from './Card';
import { useConfirm } from './ConfirmDialog';

export default function AgentAccessPanel() {
  const config = useConnection(state => state.config);
  const [access, setAccess] = useState<AgentAccessSettings | null>(null);
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();

  useEffect(() => {
    if (!config?.sidecarPort) return;
    let cancelled = false;
    setAccess(null); setError(''); setOwner('');
    void getAgentAccess().then(result => {
      if (!cancelled) setAccess(result);
    }, e => {
      if (!cancelled) setError(isUnsupportedByAgent(e) ? 'Update the server to manage access here.' : String(e.message || e));
    });
    return () => { cancelled = true; };
  }, [config]);

  async function save(operation: () => Promise<AgentAccessSettings>) {
    const scope = currentAgentScope();
    setBusy(true); setError('');
    try {
      const result = await operation();
      if (scope === currentAgentScope()) setAccess(result);
    } catch (e) {
      if (scope === currentAgentScope()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (scope === currentAgentScope()) setBusy(false);
    }
  }

  const newOwner = owner.trim().toLowerCase().replace(/^@/, '');
  async function transfer() {
    const scope = currentAgentScope();
    const ok = await confirm({ title: 'Transfer primary ownership?',
      message: `@${newOwner} will become the owner of this agent and manage its settings.`, confirmLabel: 'Transfer ownership' });
    if (ok && scope === currentAgentScope()) {
      await save(async () => {
        const result = await transferAgentOwner(newOwner);
        if (scope === currentAgentScope()) void useConfig.getState().loadConfig();
        return result;
      });
    }
  }

  return (
    <Card>
      <Text style={styles.title}>Agent access</Text>
      {access ? <>
        <Text style={styles.hint}>Primary owner: {access.owner_handle ? `@${access.owner_handle}` : 'Not assigned'}</Text>
        <Text style={styles.hint}>Who can view Scheduled, Workflows, Events, Connectors and Agent Identity?</Text>
        <View style={styles.row}>
          {([['members', 'All members'], ['owner', 'Owner only']] as const).map(([value, label]) => (
            <Button key={value} size="sm" label={label}
              variant={access.visibility === value ? 'primary' : 'secondary'}
              disabled={busy || !access.can_manage || access.visibility === value}
              onPress={() => void save(() => updateAgentAccess(value))} />
          ))}
        </View>
        <Text style={styles.hint}>Only the primary owner can change settings and manage these pages.</Text>
        {!access.owner_handle && <Text style={styles.hint}>A server operator must assign the first owner.</Text>}
        {access.can_manage && !access.can_transfer && <Text style={styles.hint}>Transfer ownership from the coordinator's Federated agents list.</Text>}
        {access.can_transfer && <View style={styles.row}>
          <TextInput value={owner} onChangeText={setOwner} placeholder="New owner's username" accessibilityLabel="New owner's username"
            placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} editable={!busy} style={styles.input} />
          <Button size="sm" variant="secondary" label="Transfer ownership" disabled={busy || !newOwner || newOwner === access.owner_handle} onPress={() => void transfer()} />
        </View>}
      </> : !error && <Text style={styles.hint}>Loading access settings…</Text>}
      {!!error && <Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>{error}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 8 },
  hint: { color: colors.textSecondary, fontSize: 13, marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 },
  input: { color: colors.text, minWidth: 170, flex: 1, padding: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
});
