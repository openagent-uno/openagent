import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { officialConnectorsAPI as api, type OfficialConnector, type OfficialConnection, type OfficialConnectorSetup, type OfficialConnectorSite, type MarketplaceCard } from '../../services/api';
import { colors, radius } from '../../theme';
import MarketplaceTile from './MarketplaceTile';
import ConnectorLogo from './ConnectorLogo';
import Button from '../Button';
import Grid from './MarketplaceGrid';
import { useConnection } from '../../stores/connection';

function currentTarget() {
  const { config, activeAccountId } = useConnection.getState();
  return config?.sidecarPort ? JSON.stringify([activeAccountId, config.sidecarPort, config.network, config.handle, config.agentHandle]) : '';
}

export default function OfficialConnectorsPane({ query = '', cols = 1, registryResults = [], registryInstalledNames = new Set<string>(), onInstallRegistry }: { query?: string; cols?: number; registryResults?: MarketplaceCard[]; registryInstalledNames?: Set<string>; onInstallRegistry?: (card: MarketplaceCard) => void }) {
  const config = useConnection(s => s.config);
  const activeAccountId = useConnection(s => s.activeAccountId);
  const target = config?.sidecarPort ? JSON.stringify([activeAccountId, config.sidecarPort, config.network, config.handle, config.agentHandle]) : '';
  const boundTarget = useRef('');
  const [catalog, setCatalog] = useState<OfficialConnector[]>([]);
  const [connections, setConnections] = useState<OfficialConnection[]>([]);
  const [available, setAvailable] = useState(true);
  const [selected, setSelected] = useState<OfficialConnector | null>(null);
  const [token, setToken] = useState('');
  const [showSetup, setShowSetup] = useState(true);
  const [account, setAccount] = useState('');
  const [mail, setMail] = useState<Record<string, string>>({ mailbox: 'INBOX' });
  const [allowWrite, setAllowWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<OfficialConnectorSetup | null>(null);
  const [sites, setSites] = useState<{ connectionId: string; items: OfficialConnectorSite[]; selectedId: string | null } | null>(null);
  const generation = useRef(0);
  const operation = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => {
    generation.current++; operation.current++; busyRef.current = false; boundTarget.current = target;
    setSelected(null); setShowSetup(true); setToken(''); setMail({ mailbox: 'INBOX' }); setPending(null); setBusy(false);
    setCatalog([]); setConnections([]); setSites(null); setError(''); setNotice('');
    if (target) void refresh();
    return () => { generation.current++; operation.current++; busyRef.current = false; boundTarget.current = ''; };
  }, [target]);
  function beginOperation() {
    if (busyRef.current) return null;
    const id = ++operation.current;
    busyRef.current = true; setBusy(true);
    return id;
  }
  function finishOperation(id: number) {
    if (operation.current === id) { busyRef.current = false; setBusy(false); }
  }
  async function refresh() {
    const expected = boundTarget.current;
    const epoch = generation.current;
    if (!expected || expected !== currentTarget()) return;
    try { const [c, i] = await Promise.all([api.catalog(), api.list()]); if (epoch !== generation.current || expected !== currentTarget() || expected !== boundTarget.current) return; setCatalog(c.connectors); setConnections(i.connections); setAvailable(c.available && i.available); setError(''); }
    catch { if (epoch === generation.current && expected === currentTarget() && expected === boundTarget.current) setError('The server could not load connectors. Try again.'); }
  }
  async function loadSites(id: string, expected = boundTarget.current) {
    const epoch = generation.current;
    if (expected !== currentTarget() || expected !== boundTarget.current) return;
    setSites(null);
    const result = await api.sites(id);
    if (epoch !== generation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
    setSites({ connectionId: id, items: result.sites, selectedId: result.selected_cloud_id });
  }
  async function connected(setup: OfficialConnectorSetup, expected: string) {
    const epoch = generation.current;
    await refresh();
    if (epoch !== generation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
    setShowSetup(false);
    if (setup.connection.catalog_id === 'atlassian') await loadSites(setup.connection.id, expected);
    else setSelected(null);
    if (epoch !== generation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
    setNotice(`${setup.connection.display_name} connected to this server.`);
  }
  async function authorize(setup: OfficialConnectorSetup, expected = boundTarget.current) {
    if (!expected || expected !== currentTarget() || expected !== boundTarget.current) return;
    const epoch = generation.current;
    if (!setup.authorization_url) {
      if (setup.connection?.status !== 'connected') throw new Error('Connection not completed');
      await connected(setup, expected); return;
    }
    if (!setup.expires_at || !Number.isFinite(Date.parse(setup.expires_at)) || Date.parse(setup.expires_at) <= Date.now()) throw new Error('Invalid authorization expiry');
    const url = new URL(setup.authorization_url);
    if (url.protocol !== "https:" || url.hash || url.username || url.password || (setup.authorization_mode === "own-app" ? !["https://accounts.google.com", "https://app.clickup.com", "https://platform.postiz.com", "https://github.com", "https://api.notion.com", "https://slack.com", "https://auth.atlassian.com"].includes(url.origin) : url.origin !== (setup.authorization_origin || "https://auth.openagent.uno") || !/^\/authorize\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || !!url.search)) throw new Error('Invalid authorization link');
    setPending(setup);
    if (Platform.OS === 'web') { const tab = window.open(url.toString(), '_blank'); if (tab) tab.opener = null; }
    else await Linking.openURL(url.toString());
    if (epoch !== generation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
    const current = ++generation.current;
    while (current === generation.current && Date.now() < Date.parse(setup.expires_at)) {
      const status = await api.poll(setup.connection.id);
      if (current !== generation.current || expected !== currentTarget()) return;
      if (status.status === 'connected') { setPending(null); await connected(setup, expected); return; }
      if (status.status === 'cancelled') { setPending(null); throw new Error('Authorization cancelled'); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (current === generation.current) { setPending(null); throw new Error('Authorization expired. Connect again.'); }
  }
  async function connect() {
    const expected = boundTarget.current;
    if (!selected || !expected || expected !== currentTarget()) return;
    const id = beginOperation();
    if (id === null) return;
    setError(''); setNotice('');
    try {
      const config: Record<string, string | number> = {};
      if (selected.id === 'shopify') config.shop = account.trim().toLowerCase();
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
      if (id !== operation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
      setToken(''); setMail({ mailbox: 'INBOX' });
      await authorize(setup, expected);
    } catch (e) { if (id === operation.current && expected === currentTarget() && expected === boundTarget.current) { generation.current++; setPending(null); setError(e instanceof Error && e.message === 'Authorization cancelled' ? e.message : 'Could not connect. Check your account details or try authorization again.'); } }
    finally { finishOperation(id); }
  }
  async function action(run: (expected: string) => Promise<unknown>, successNotice = '') {
    const expected = boundTarget.current;
    if (!expected || expected !== currentTarget()) return;
    const id = beginOperation();
    if (id === null) return;
    setError(''); setNotice('');
    try {
      await run(expected);
      if (id !== operation.current || expected !== currentTarget() || expected !== boundTarget.current) return;
      await refresh();
      if (successNotice && id === operation.current && expected === currentTarget() && expected === boundTarget.current) setNotice(successNotice);
    } catch {
      if (id === operation.current && expected === currentTarget() && expected === boundTarget.current) { generation.current++; setPending(null); setError('The server could not update this connection. Try again.'); }
    } finally { finishOperation(id); }
  }
  function select(item: OfficialConnector) {
    if (busyRef.current) return;
    setSelected(item); setShowSetup(!connections.some(c => c.catalog_id === item.id && c.status !== 'disconnected'));
    setSites(null); setAllowWrite(false); setAccount(''); setToken(''); setMail({ mailbox: 'INBOX' }); setError(''); setNotice('');
  }
  const items = [
    ...catalog.filter(item => `${item.name} ${item.description} ${item.category}`.toLowerCase().includes(query.trim().toLowerCase())).map(item => ({ key: `connector:${item.id}`, name: item.name, connector: item, registry: undefined as MarketplaceCard | undefined })),
    ...registryResults.map(item => ({ key: `registry:${item.name}@${item.version || 'latest'}`, name: item.title || item.name, connector: undefined as OfficialConnector | undefined, registry: item })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return <View style={styles.root}>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!!notice && <Text accessibilityRole="alert" style={styles.subtitle}>{notice}</Text>}
    {!selected && <Grid cols={cols}>{items.map(entry => {
      const item = entry.connector;
      const installed = item ? connections.some(c => c.catalog_id === item.id && c.status !== 'disconnected') : registryInstalledNames.has(entry.registry!.name);
      return <View key={entry.key} style={{ flex: 1 }}>
        <MarketplaceTile card={item ? { name: item.name, title: item.name, description: item.description } : entry.registry!} installed={installed}
          icon={item ? <ConnectorLogo id={item.id} /> : undefined}
          disabled={item ? busy || !item.available : false}
          unavailableReason={item && !item.available ? item.unavailableReason || 'Not available yet' : undefined}
          onManage={item ? () => { if (!busy) select(item); } : undefined}
          onInstall={() => item ? select(item) : onInstallRegistry?.(entry.registry!)} style={{ height: '100%' }} />
      </View>;
    })}</Grid>}
    {!selected && !items.length && catalog.length > 0 && <Text style={styles.subtitle}>No connectors match your search.</Text>}
    {selected && <>
      <Button variant="ghost" size="sm" label="Back to marketplace" icon="arrow-left" disabled={busy} onPress={() => { setSelected(null); setToken(''); setMail({ mailbox: 'INBOX' }); }} />
      <View style={styles.row}><ConnectorLogo id={selected.id} /><Text style={styles.title}>{selected.name}</Text></View>
      <Text style={styles.subtitle}>{selected.description} Your server stores credentials and connects directly to the service.</Text>
      {!available && <Text style={styles.subtitle}>This server cannot manage these connections yet.</Text>}
    </>}
    {selected && connections.filter(c => c.catalog_id === selected.id && c.status !== 'disconnected').map(c => <View key={c.id} style={styles.card}>
      <Text style={styles.name}>{c.display_name}</Text><Text style={styles.subtitle}>{c.status}</Text>
      <View style={styles.row}><Text style={styles.label}>Enabled</Text><Switch accessibilityLabel={`Enable ${c.display_name}`} disabled={busy} value={!!c.enabled} onValueChange={enabled => void action(() => { setSites(null); return api.update(c.id, { enabled }); })} /></View>
      {selected.agentTools.length > 0 && <View style={styles.row}><Text style={styles.label}>Allow changes</Text><Switch accessibilityLabel={`Allow changes with ${c.display_name}`} disabled={busy} value={!!c.allow_write} onValueChange={allow_write => void action(() => { setSites(null); return api.update(c.id, { allow_write }); })} /></View>}
      <View style={styles.row}>{selected.auth === "oauth" && <Pressable accessibilityRole="button" style={{ opacity: busy || !selected.available ? 0.45 : 1 }} disabled={busy || !selected.available} onPress={() => void action(async expected => { const epoch = generation.current; setSites(null); const setup = await api.connect(c.id); if (epoch === generation.current) await authorize(setup, expected); })}><Text style={styles.link}>Reconnect</Text></Pressable>}
        {selected.auth === 'oauth' && c.status === 'connected' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void action(() => api.refreshToken(c.id), 'Access token renewed and saved on this server.')}><Text style={styles.link}>Refresh access</Text></Pressable>}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void action(() => { setSites(null); return api.disconnect(c.id); })}><Text style={styles.link}>Disconnect from this server</Text></Pressable></View>
      {selected.id === 'atlassian' && c.status === 'connected' && <>
        <Button variant="secondary" size="sm" label="Choose Jira site" disabled={busy} onPress={() => void action(expected => loadSites(c.id, expected))} />
        {sites?.connectionId === c.id && <View style={{ gap: 8 }}>
          <Text style={styles.subtitle}>Choose a site authorized by Atlassian. Tools use only the site saved on this server.</Text>
          {sites.items.length === 0 && <Text style={styles.subtitle}>No Jira sites have the required permissions. Reconnect and grant access to a Jira site.</Text>}
          {sites.items.map(site => <Button key={site.id} variant={site.id === sites.selectedId ? 'secondary' : 'ghost'} size="sm" label={`${site.name}${site.id === sites.selectedId ? ' (selected)' : ''}`} disabled={busy} onPress={() => void action(async expected => { const epoch = generation.current; await api.selectSite(c.id, site.id); if (epoch === generation.current && expected === currentTarget() && expected === boundTarget.current) await loadSites(c.id, expected); })} />)}
        </View>}
      </>}
      <Text style={styles.subtitle}>Removing OpenAgent in the provider's settings can affect your other connected products.</Text>
    </View>)}
    {selected && !showSetup && !pending && selected.available && <Button variant="secondary" size="sm" label="Connect another account" disabled={busy} onPress={() => setShowSetup(true)} />}
    {pending && <View style={styles.card}><ActivityIndicator /><Text style={styles.name}>Complete authorization in your browser</Text><Pressable accessibilityRole="button" onPress={() => void Linking.openURL(pending.authorization_url!)}><Text style={styles.link}>Open authorization</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { generation.current++; operation.current++; busyRef.current = false; setPending(null); setBusy(false); }}><Text style={styles.link}>Stop waiting</Text></Pressable></View>}
    {selected && showSetup && !pending && <View style={styles.card}>
      <Text style={styles.name}>Connect {selected.name}</Text>
      {selected.auth === 'token' && <TextInput accessibilityLabel={`${selected.name} API token`} placeholder="API token" secureTextEntry value={token} onChangeText={setToken} style={styles.input} autoCapitalize="none" />}
      {['replio', 'billingbear', 'pipeboard'].includes(selected.id) && <TextInput accessibilityLabel="Account identifier" placeholder={selected.id === 'replio' ? 'Organization ID' : selected.id === 'billingbear' ? 'Project ID' : 'Ads provider: meta_ads or google_ads'} value={account} onChangeText={setAccount} style={styles.input} autoCapitalize="none" />}
      {selected.id === 'shopify' && <TextInput accessibilityLabel="Shopify store" placeholder="your-store.myshopify.com" value={account} onChangeText={setAccount} style={styles.input} autoCapitalize="none" autoCorrect={false} />}
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
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, color: colors.text },
  link: { color: colors.accent, paddingVertical: 8, fontWeight: '600' },
});
