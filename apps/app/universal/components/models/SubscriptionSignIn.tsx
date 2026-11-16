/**
 * Sign an account in to a subscription provider.
 *
 * The provider owns the sign-in: the server asks it for a page, the person
 * signs in there, and the page hands back a code (often in the address bar of
 * a page that fails to load). Pasting that code, or the whole address,
 * finishes the sign-in. Nothing secret passes through the app.
 */
import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import Button from '../Button';
import { colors, radius } from '../../theme';
import { completeProviderSignIn, startProviderSignIn } from '../../services/api';
import { errorMessage } from './modelHelpers';
import { Field, InlineError, formStyles } from './ui';

async function openPage(url: string): Promise<void> {
  if (!/^https:\/\//i.test(url)) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const tab = window.open(url, '_blank');
    if (tab) tab.opener = null;
    return;
  }
  await Linking.openURL(url);
}

export default function SubscriptionSignIn({
  providerId, label = 'Sign in', onDone,
}: {
  providerId: number;
  label?: string;
  /** Called after an account was signed in, so the caller reloads accounts. */
  onDone: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState<{ url: string; state: string } | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const start = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const started = await startProviderSignIn(providerId);
      setPending({ url: started.authorize_url, state: started.state });
      setCode('');
      await openPage(started.authorize_url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!pending) return;
    if (!code.trim()) { setError('Paste the code from the sign-in page first.'); return; }
    setBusy(true); setError(null);
    try {
      const result = await completeProviderSignIn(providerId, {
        state: pending.state, code: code.trim(), ...(name.trim() ? { name: name.trim() } : {}),
      });
      setPending(null); setCode(''); setName('');
      setDone(result.account?.name ? `Signed in: ${result.account.name}` : 'Signed in');
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!pending) {
    return (
      <View style={styles.block}>
        <View style={formStyles.row}>
          <Button variant="secondary" size="sm" icon="log-in" label={busy ? 'Opening…' : label}
            onPress={() => { void start(); }} disabled={busy} />
          {done ? <Text style={formStyles.success}>{done}</Text> : null}
        </View>
        <InlineError>{error}</InlineError>
      </View>
    );
  }
  return (
    <View style={[styles.block, styles.panel]}>
      <Text style={formStyles.body}>
        Sign in on the page that opened. When it finishes, copy the code it shows, or the address of
        the page you land on (even if that page does not load), and paste it here.
      </Text>
      <Field label="Code or page address" value={code} mono autoCapitalize="none"
        onChangeText={(v) => { setCode(v); if (error) setError(null); }}
        placeholder="abc123… or http://localhost:1455/auth/callback?code=…" />
      <Field label="Account name (optional)" value={name} onChangeText={setName}
        placeholder="Work" />
      <InlineError>{error}</InlineError>
      <View style={formStyles.row}>
        <Button variant="primary" size="sm" label={busy ? 'Finishing…' : 'Finish sign-in'}
          onPress={() => { void finish(); }} disabled={busy} />
        <Button variant="ghost" size="sm" icon="external-link" label="Open the page again"
          onPress={() => { void openPage(pending.url); }} disabled={busy} />
        <Button variant="ghost" size="sm" label="Cancel"
          onPress={() => { setPending(null); setError(null); }} disabled={busy} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  panel: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, backgroundColor: colors.inputBg,
  },
});
