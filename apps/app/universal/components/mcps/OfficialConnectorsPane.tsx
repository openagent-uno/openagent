import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { officialConnectorsAPI as api, type OfficialConnector, type OfficialConnection, type OfficialConnectorSetup } from '../../services/api';
import { colors, radius } from '../../theme';
import Feather from '@expo/vector-icons/Feather';

export default function OfficialConnectorsPane({ query = '', showConnections = true }: { query?: string; showConnections?: boolean }) {
  const [catalog, setCatalog] = useState<OfficialConnector[]>([]);
  const [connections, setConnections] = useState<OfficialConnection[]>([]);
  const [available, setAvailable] = useState(true);
  const [selected, setSelected] = useState<OfficialConnector | null>(null);
  const [token, setToken] = useState('');
  const [account, setAccount] = useState('');
  const [mail, setMail] = useState<Record<string, string>>({ mailbox: 'INBOX' });
  const [allowWrite, setAllowWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<OfficialConnectorSetup | null>(null);
  const generation = useRef(0);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  async function refresh() {
    try { const [c, i] = await Promise.all([api.catalog(), api.list()]); setCatalog(c.connectors); setConnections(i.connections); setAvailable(c.available && i.available); }
    catch { setError('The server could not load connectors. Try again.'); }
  }
  async function authorize(setup: OfficialConnectorSetup) {
    if (!setup.authorization_url || !setup.expires_at) { await refresh(); setSelected(null); return; }
    const url = new URL(setup.authorization_url);
    if (url.protocol !== "https:" || url.hash || url.username || url.password || (setup.authorization_mode === "own-app" ? !["https://accounts.google.com", "https://app.clickup.com", "https://platform.postiz.com"].includes(url.origin) : url.origin !== (setup.authorization_origin || "https://auth.openagent.uno") || !/^\/authorize\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || !!url.search)) throw new Error('Invalid authorization link');
    setPending(setup);
    if (Platform.OS === 'web') { const tab = window.open(url.toString(), '_blank'); if (tab) tab.opener = null; }
    else await Linking.openURL(url.toString());
    const current = ++generation.current;
    while (current === generation.current && Date.now() < Date.parse(setup.expires_at)) {
      const status = await api.poll(setup.connection.id);
      if (status.status === 'connected') { setPending(null); setSelected(null); await refresh(); return; }
      if (status.status === 'cancelled') { setPending(null); throw new Error('Authorization cancelled'); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (current === generation.current) { setPending(null); throw new Error('Authorization expired. Connect again.'); }
  }
  async function connect() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const config: Record<string, string | number> = {};
      if (selected.id === 'replio') config.organization_id = account.trim();
      if (selected.id === 'billingbear') config.project_id = account.trim();
      if (selected.id === 'pipeboard') config.ads_provider = account || 'meta_ads';
      const body: Record<string, unknown> = { catalog_id: selected.id, allow_write: allowWrite, config };
      if (selected.auth === 'token') body.token = token;
      if (selected.auth === 'credentials') {
        Object.assign(config, { imap_host: mail.imap_host, imap_port: mail.imap_tls === 'starttls' ? 143 : 993, username: mail.username, mailbox: mail.mailbox || 'INBOX', tls_mode: mail.imap_tls || 'implicit_tls', smtp_host: mail.smtp_host, smtp_port: mail.smtp_tls === 'starttls' ? 587 : 465, smtp_tls_mode: mail.smtp_tls || 'implicit_tls', smtp_from: mail.smtp_from || mail.username });
        body.credentials = { imap_password: mail.password, smtp_password: mail.smtp_password || mail.password };
      }
      const setup = await api.create(body);
      setToken(''); setMail({ mailbox: 'INBOX' });
      await authorize(setup);
    } catch (e) { setError(e instanceof Error && e.message === 'Authorization cancelled' ? e.message : 'Could not connect. Check your account details or try authorization again.'); }
    finally { setBusy(false); }
  }
  async function action(operation: () => Promise<unknown>) { setError(''); try { await operation(); await refresh(); } catch { setError('The server could not update this connection. Try again.'); } }
  return <View style={styles.root}>
    <Text style={styles.title}>Official connectors</Text>
    <Text style={styles.subtitle}>OpenAgent provides the integration. Your server stores credentials and connects directly to the service.</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!available && <Text style={styles.subtitle}>Official connectors are not available on this server yet.</Text>}
    {showConnections && !selected && connections.filter(c => c.status !== 'disconnected').map(c => <View key={c.id} style={styles.card}>
      <Text style={styles.name}>{c.display_name}</Text><Text style={styles.subtitle}>{c.status}</Text>
      <View style={styles.row}><Text style={styles.label}>Enabled</Text><Switch accessibilityLabel={`Enable ${c.display_name}`} value={!!c.enabled} onValueChange={enabled => void action(() => api.update(c.id, { enabled }))} /></View>
      <View style={styles.row}><Text style={styles.label}>Allow changes</Text><Switch accessibilityLabel={`Allow changes with ${c.display_name}`} value={!!c.allow_write} onValueChange={allow_write => void action(() => api.update(c.id, { allow_write }))} /></View>
      <View style={styles.row}>{catalog.find(item => item.id === c.catalog_id)?.auth === "oauth" && <Pressable accessibilityRole="button" style={{ opacity: busy || !catalog.find(item => item.id === c.catalog_id)?.available ? 0.45 : 1 }} disabled={busy || !catalog.find(item => item.id === c.catalog_id)?.available} onPress={() => void action(async () => { setBusy(true); try { await authorize(await api.connect(c.id)); } finally { setBusy(false); } })}><Text style={styles.link}>Reconnect</Text></Pressable>}
        <Pressable accessibilityRole="button" onPress={() => void action(() => api.disconnect(c.id))}><Text style={styles.link}>Disconnect from this server</Text></Pressable></View>
      <Text style={styles.subtitle}>Removing OpenAgent in the provider's settings can affect your other connected products.</Text>
    </View>)}
    {pending && <View style={styles.card}><ActivityIndicator /><Text style={styles.name}>Complete authorization in your browser</Text><Pressable accessibilityRole="button" onPress={() => void Linking.openURL(pending.authorization_url!)}><Text style={styles.link}>Open authorization</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { generation.current++; setPending(null); setBusy(false); }}><Text style={styles.link}>Stop waiting</Text></Pressable></View>}
    {!selected && <View style={styles.grid}>{catalog.filter(item => `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.toLowerCase())).map(item => <Pressable accessibilityRole="button" accessibilityLabel={`Connect ${item.name}`} key={item.id} disabled={!item.available || busy} style={[styles.card, styles.tile]} onPress={() => { setSelected(item); setAllowWrite(false); setAccount(''); setToken(''); setMail({ mailbox: 'INBOX' }); setError(''); }}>
      <View style={styles.row}><Feather name={(['mail', 'hard-drive', 'shopping-bag', 'check-square', 'share-2', 'bar-chart-2', 'credit-card', 'message-square', 'message-circle', 'trending-up', 'inbox', 'github'].includes(item.icon || '') ? item.icon : 'link') as React.ComponentProps<typeof Feather>['name']} size={26} color={colors.accent} /><Text style={styles.badge}>OpenAgent · Official</Text></View>
      <Text style={styles.name}>{item.name}</Text><Text style={styles.subtitle}>{item.description}</Text><Text style={styles.subtitle}>{item.available ? item.auth === 'oauth' ? 'Connect account' : item.auth === 'token' ? 'Connect with API token' : 'Configure account' : item.unavailableReason || 'Not available yet'}</Text>
    </Pressable>)}</View>}
    {selected && !pending && <View style={styles.card}>
      <Text style={styles.name}>Connect {selected.name}</Text>
      {selected.auth === 'token' && <TextInput accessibilityLabel={`${selected.name} API token`} placeholder="API token" secureTextEntry value={token} onChangeText={setToken} style={styles.input} autoCapitalize="none" />}
      {['replio', 'billingbear', 'pipeboard'].includes(selected.id) && <TextInput accessibilityLabel="Account identifier" placeholder={selected.id === 'replio' ? 'Organization ID' : selected.id === 'billingbear' ? 'Project ID' : 'Ads provider: meta_ads or google_ads'} value={account} onChangeText={setAccount} style={styles.input} autoCapitalize="none" />}
      {selected.auth === 'credentials' && <>
        {['imap_host', 'smtp_host', 'username', 'password', 'smtp_password', 'smtp_from', 'mailbox'].map(field => <TextInput key={field} accessibilityLabel={field.replaceAll('_', ' ')} placeholder={field.replaceAll('_', ' ')} secureTextEntry={field.includes('password')} value={mail[field] || ''} onChangeText={value => setMail(previous => ({ ...previous, [field]: value }))} style={styles.input} autoCapitalize="none" />)}
        <View style={styles.row}><Text style={styles.label}>Use STARTTLS for IMAP (port 143)</Text><Switch accessibilityLabel="Use STARTTLS for IMAP" value={mail.imap_tls === 'starttls'} onValueChange={enabled => setMail(previous => ({ ...previous, imap_tls: enabled ? 'starttls' : 'implicit_tls' }))} /></View>
        <View style={styles.row}><Text style={styles.label}>Use STARTTLS for SMTP (port 587)</Text><Switch accessibilityLabel="Use STARTTLS for SMTP" value={mail.smtp_tls === 'starttls'} onValueChange={enabled => setMail(previous => ({ ...previous, smtp_tls: enabled ? 'starttls' : 'implicit_tls' }))} /></View>
      </>}
      {selected.agentTools.length > 0 && <View style={styles.row}><Text style={styles.label}>Allow this connector to make changes</Text><Switch accessibilityLabel="Allow connector changes" value={allowWrite} onValueChange={setAllowWrite} /></View>}
      <View style={styles.row}><Pressable accessibilityRole="button" disabled={busy} onPress={() => void connect()}><Text style={styles.link}>{busy ? 'Connecting…' : 'Connect'}</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSelected(null); setToken(''); setMail({ mailbox: 'INBOX' }); }}><Text style={styles.link}>Cancel</Text></Pressable></View>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  root: { gap: 16 }, title: { fontSize: 22, fontWeight: '600', color: colors.text },
  subtitle: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 }, name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  label: { color: colors.text, fontSize: 14, flex: 1 }, error: { color: colors.error },
  card: { borderWidth: 1, borderColor: colors.border, padding: 18, borderRadius: radius.lg, gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, tile: { flexBasis: 280, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, color: colors.text },
  link: { color: colors.accent, paddingVertical: 8, fontWeight: '600' },
  badge: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
});
