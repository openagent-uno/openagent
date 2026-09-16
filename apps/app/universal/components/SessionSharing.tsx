import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { apiUrl } from '../services/api';
import { useCollaboration } from '../stores/collaboration';
import { colors } from '../theme';

export default function SessionSharing({ sessionId }: { sessionId: string }) {
  const shared = useCollaboration(s => s.client);
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [data, setData] = useState<{ can_manage: boolean; members: { handle: string; permission: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  // Bumping on setup already fences a reply that belongs to the previous
  // session/account: the next effect run happens before anything can be shown
  // for the new one. Reading the ref back in a cleanup would only repeat that.
  useEffect(() => {
    generation.current++;
    setBusy(false); setOpen(false); setData(null); setError('');
  }, [sessionId, shared]);
  const path = apiUrl('/api/collaboration/' + encodeURIComponent(sessionId) + '/members');
  useEffect(() => {
    if (!open || !shared) return;
    const controller = new AbortController();
    void fetch(path, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Sharing is unavailable for this session.');
      const result = await response.json();
      if (!controller.signal.aborted) setData(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open, shared, path]);
  async function save(name: string, permission: 'admin' | null) {
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: name, permission }) });
      const result = await response.json();
      if (generation.current !== current) return;
      if (!response.ok) throw new Error(result.error || 'Could not update sharing');
      setData(result); setHandle('');
    } catch (e) { if (generation.current === current) setError(String(e)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  if (!shared) return null;
  return <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
    <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}><Text style={{ color: colors.textMuted, fontSize: 12 }}>Share session</Text></Pressable>
    {open && <View style={{ gap: 8, paddingVertical: 8 }}>
      {data?.members.map(member => <View key={member.handle} style={{ flexDirection: 'row', gap: 10 }}>
        <Text style={{ color: colors.text }}>{member.handle} · {member.permission === 'admin' ? 'Can collaborate' : 'Can view'}</Text>
        {data.can_manage && <Pressable disabled={busy} onPress={() => void save(member.handle, null)}><Text style={{ color: colors.textMuted }}>Remove</Text></Pressable>}
      </View>)}
      {data?.can_manage && <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput accessibilityLabel="Collaborator username" placeholder="Username" placeholderTextColor={colors.textMuted} value={handle} onChangeText={setHandle} autoCapitalize="none" style={{ color: colors.text, flex: 1 }} />
        <Pressable disabled={busy || !handle.trim()} onPress={() => void save(handle.trim(), 'admin')}><Text style={{ color: colors.accent }}>Add collaborator</Text></Pressable>
      </View>}
      {!!error && <Text style={{ color: colors.textMuted }}>{error}</Text>}
    </View>}
  </View>;
}
