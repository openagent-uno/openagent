import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { apiUrl, listNetworkUsers, type NetworkUser } from '../services/api';
import { useCollaboration } from '../stores/collaboration';
import { useConnection } from '../stores/connection';
import { colors, radius } from '../theme';
import Button from './Button';

type Members = { can_manage: boolean; members: { handle: string; permission: string }[] };

/** Session access management, opened beside the inspector's participants. */
export default function SessionSharing({ sessionId }: { sessionId: string }) {
  const shared = useCollaboration(s => s.client);
  const accountId = useConnection(s => s.activeAccountId);
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [data, setData] = useState<Members | null>(null);
  const [users, setUsers] = useState<NetworkUser[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const writes = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++;
    setBusy(false); setOpen(false); setData(null); setUsers([]); setHandle(''); setError('');
    return () => { generation.current++; writes.current?.abort(); };
  }, [sessionId, shared, accountId]);
  const path = apiUrl('/api/collaboration/' + encodeURIComponent(sessionId) + '/members');
  useEffect(() => {
    if (!open || !shared) return;
    const controller = new AbortController();
    const current = generation.current;
    setData(null); setError(''); setUsers([]);
    void fetch(path, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Sharing is unavailable for this session.');
      const result: Members = await response.json();
      if (controller.signal.aborted || generation.current !== current) return;
      setData(result);
      // Directory lookup is optional: a member-host may not expose it. The
      // operator can still enter an exact username; the server validates it.
      if (result.can_manage) void listNetworkUsers().then(values => {
        if (!controller.signal.aborted && generation.current === current) setUsers(values.filter(u => u.status === 'active'));
      }).catch(() => {});
    }).catch(e => { if (!controller.signal.aborted && generation.current === current) setError(e.message); });
    return () => controller.abort();
  }, [open, shared, path]);
  async function save(name: string, permission: 'admin' | null) {
    if (busy || !data?.can_manage) return;
    const current = generation.current;
    const controller = new AbortController();
    writes.current = controller;
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method: 'PUT', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: name, permission }) });
      const result = await response.json();
      if (generation.current !== current || controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.error || 'Could not update sharing');
      setData(result); setHandle('');
    } catch (e) { if (generation.current === current && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not update sharing'); }
    finally { if (generation.current === current && !controller.signal.aborted) setBusy(false); }
  }
  if (!shared) return null;
  const suggestions = users.filter(user => !data?.members.some(member => member.handle === user.handle)
    && user.handle.toLowerCase().includes(handle.trim().toLowerCase())).slice(0, 8);
  const close = () => setOpen(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Share session" onPress={() => setOpen(true)}
      style={{ padding: 8, borderRadius: radius.sm }}>
      <Feather name="share-2" color={colors.textSecondary} size={16} />
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: '#000a', padding: 16, alignItems: 'center', justifyContent: 'center' }}>
        <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 460, maxHeight: '90%', backgroundColor: colors.bg,
          borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: 20, gap: 16 }}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 18, fontWeight: '600', flex: 1 }}>Share session</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close sharing" onPress={close} style={{ padding: 8 }}><Feather name="x" size={18} color={colors.textMuted} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            {!data && !error && <ActivityIndicator color={colors.accent} accessibilityLabel="Loading session access" />}
            {data?.can_manage && <>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Choose a network user or enter their username.</Text>
              <TextInput accessibilityLabel="Collaborator username" placeholder="Search or enter username" placeholderTextColor={colors.textMuted}
                value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} editable={!busy}
                onSubmitEditing={() => { if (handle.trim()) void save(handle.trim(), 'admin'); }}
                style={{ color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, padding: 12, minHeight: 44 }} />
              {suggestions.map(user => <Pressable key={user.handle} disabled={busy} accessibilityRole="button" accessibilityLabel={`Select ${user.handle}`}
                onPress={() => setHandle(user.handle)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }}>
                <Feather name="user" size={15} color={colors.textMuted} />
                <Text style={{ color: colors.text, flex: 1 }}>{user.handle}</Text>
                {handle === user.handle && <Feather name="check" size={15} color={colors.accent} />}
              </Pressable>)}
              <Button label={busy ? 'Saving…' : 'Share'} icon="share-2" disabled={busy || !handle.trim()} onPress={() => void save(handle.trim(), 'admin')} />
            </>}
            {data && <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>People with access</Text>}
            {data?.members.map(member => <View key={member.handle} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <View style={{ flex: 1, minWidth: 0 }}><Text style={{ color: colors.text }}>{member.handle}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 11 }}>{member.permission === 'admin' ? 'Can collaborate' : 'Can view'}</Text></View>
              {data.can_manage && <Button variant="ghost" size="sm" label="Remove" disabled={busy} accessibilityLabel={`Remove ${member.handle}`} onPress={() => void save(member.handle, null)} />}
            </View>)}
            {data && !data.can_manage && <Text style={{ color: colors.textMuted, fontSize: 12 }}>Only the session owner can change access.</Text>}
            {!!error && <Text accessibilityRole="alert" style={{ color: colors.error }}>{error}</Text>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}
