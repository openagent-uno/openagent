/** One new connection at a time; API and subscriptions never replace siblings. */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ProviderConfig } from '../../../common/types';
import { colors } from '../../theme';
import { addProvider } from '../../services/api';
import Button from '../Button';
import { Chip, Field, InlineError, ModalShell } from './ui';
import { vendorLabel } from './connectionHelpers';
import SubscriptionSignIn from './SubscriptionSignIn';
import { ALL_VENDORS, errorMessage, type Access } from './modelHelpers';

const VENDORS = [...ALL_VENDORS, 'moonshot', 'qwen', 'local', 'custom'];

export default function ConnectProviderDialog({ onClose, onCreated }: {
  onClose: () => void; onCreated: (provider: ProviderConfig) => void;
}) {
  const [vendor, setVendor] = useState('anthropic');
  const [customVendor, setCustomVendor] = useState('');
  const [access, setAccess] = useState<Access>('api');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [custom, setCustom] = useState(false);
  const [created, setCreated] = useState<ProviderConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscription = vendor === 'anthropic' || vendor === 'openai';

  const create = async () => {
    const service = vendor === 'custom' ? customVendor.trim().toLowerCase() : vendor;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(service)) { setError('Enter a service identifier using letters, numbers, dots, hyphens or underscores.'); return; }
    if (!label.trim()) { setError('Name this connection or account.'); return; }
    if (access === 'api' && !key.trim()) { setError('Enter an API key.'); return; }
    if ((access === 'local' || vendor === 'custom' || custom) && !/^https?:\/\//i.test(url.trim())) { setError('Enter an HTTP or HTTPS endpoint.'); return; }
    setBusy(true); setError(null);
    try {
      const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await addProvider({ name: `${service}-${access}-${suffix}`, framework: 'api-based',
        api_key: access !== 'subscription' && key.trim() ? key.trim() : undefined,
        base_url: access === 'local' || vendor === 'custom' || custom ? url.trim() : undefined,
        metadata: { vendor: service, access, label: label.trim(), budget_group: service },
      });
      setCreated(result.provider);
      if (access !== 'subscription') onCreated(result.provider);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return <ModalShell visible width={760} title="Connect a provider" subtitle="Add an API connection or a subscription account. Existing connections stay available."
    onClose={busy ? () => {} : onClose} footer={<>
      <Button variant="ghost" label="Close" disabled={busy} onPress={onClose} />
      <View style={{ flex: 1 }} />
      {!created && <Button label={busy ? 'Connecting…' : access === 'subscription' ? 'Continue to sign-in' : 'Connect & choose models'} disabled={busy} onPress={() => { void create(); }} />}
    </>}>
    {created ? <View style={styles.gap}>
      <Text style={styles.title}>{vendorLabel(vendor)} · {label}</Text>
      <SubscriptionSignIn providerId={created.id} label={`Sign in to ${vendor === 'openai' ? 'Codex' : 'Claude'}`} onDone={() => onCreated(created)} />
      <Text style={styles.hint}>Closing before sign-in keeps this connection so you can finish later.</Text>
    </View> : <View style={styles.gap}>
      <Text style={styles.title}>Service</Text>
      <View style={styles.row}>{VENDORS.map((v) => <Chip key={v} label={vendorLabel(v)} active={v === vendor} onPress={() => {
        setVendor(v); setCustom(false); setAccess(v === 'local' ? 'local' : 'api'); setKey(''); setUrl(''); setError(null);
      }} />)}</View>
      {vendor === 'custom' && <Field label="Service identifier" value={customVendor} onChangeText={setCustomVendor} autoCapitalize="none" placeholder="my-gateway" hint="Use a stable identifier for this compatible service. Name each connection separately below." />}
      <Text style={styles.title}>Access for this connection</Text>
      <View style={styles.row}>
        {vendor !== 'local' && <Chip label="API key" active={access === 'api'} onPress={() => setAccess('api')} />}
        {subscription && <Chip label={vendor === 'openai' ? 'Codex subscription' : 'Claude subscription'} active={access === 'subscription'} onPress={() => setAccess('subscription')} />}
        {vendor === 'local' && <Chip label="Local / compatible server" active onPress={() => setAccess('local')} />}
      </View>
      <Field label={access === 'subscription' ? 'Account name' : 'Connection name'} placeholder="e.g. Personal, Work, Production" value={label} onChangeText={setLabel} />
      {access !== 'subscription' && <Field label={access === 'local' ? 'API key (optional)' : 'API key'} value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" hint="Used only by the models of this connection." />}
      {access === 'api' && vendor !== 'custom' && <Chip label={custom ? 'Custom endpoint' : 'Use a custom endpoint'} active={custom} onPress={() => setCustom(!custom)} />}
      {(access === 'local' || (access === 'api' && (vendor === 'custom' || custom))) && <Field label="Endpoint" value={url} onChangeText={setUrl} autoCapitalize="none" placeholder="http://localhost:11434/v1" />}
      {access === 'subscription' && <Text style={styles.hint}>Sign in in your browser. You can connect another account without disconnecting this one.</Text>}
    </View>}
    <InlineError>{error}</InlineError>
  </ModalShell>;
}
const styles = StyleSheet.create({ gap: { gap: 18 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' }, hint: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 } });
