import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import { observeShared, useCollaboration } from '../stores/collaboration';
import type { SharedTarget } from '../../common/collaboration';
import { colors } from '../theme';

export function useSharedView(kind: SharedTarget['kind'], id: string | undefined, sessions: string[] = []) {
  const key = sessions.join(',');
  useFocusEffect(useCallback(() => {
    if (!id) return;
    return observeShared(kind === 'session' ? [id] : key ? key.split(',') : [], { kind, id });
  }, [kind, id, key]));
}

export default function SharedPresence({ kind = 'session', id, compact = false }: { kind?: SharedTarget['kind']; id?: string; compact?: boolean }) {
  const people = useCollaboration(s => s.people);
  const members = people.filter(p => p.target.kind === kind && p.target.id === id);
  if (!members.length) return null;
  return <View accessibilityLabel={`In this session: ${members.map(p => p.name).join(', ')}`}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: compact ? 0 : 8 }}>
    {members.slice(0, 5).map(p => <View key={p.userId} accessibilityLabel={p.name}
      style={{ borderRadius: 16, width: compact ? 20 : 26, height: compact ? 20 : 26, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.text, fontSize: compact ? 9 : 11 }}>{p.name.slice(0, 2).toUpperCase()}</Text>
    </View>)}
    {!compact && <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: 11 }}>{members.map(p => p.name).join(', ')}</Text>}
  </View>;
}
