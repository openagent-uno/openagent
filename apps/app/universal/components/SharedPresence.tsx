import { useCallback, useEffect, useState } from 'react';
import { getSessionParticipants, type SessionParticipant } from '../services/api';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import { useChat } from '../stores/chat';
import { useConnection } from '../stores/connection';
import { observeShared, useCollaboration } from '../stores/collaboration';
import type { SharedTarget } from '../../common/collaboration';
import { colors } from '../theme';

export function useSharedView(kind: SharedTarget['kind'], id: string | undefined, sessions: string[] = []) {
  const localDraft = useChat(s => kind === 'session' && s.sessions.some(session => session.id === id && session.localDraft));
  const key = sessions.join(',');
  useFocusEffect(useCallback(() => {
    if (!id || localDraft) return;
    return observeShared(kind === 'session' ? [id] : key ? key.split(',') : [], { kind, id });
  }, [kind, id, key, localDraft]));
}

export default function SharedPresence({ kind = 'session', id, compact = false, detailed = false }: { kind?: SharedTarget['kind']; id?: string; compact?: boolean; detailed?: boolean }) {
  const people = useCollaboration(s => s.people);
  const members = people.filter(p => p.target.kind === kind && p.target.id === id);
  const messages = useChat(s => s.sessions.find(session => session.id === id)?.messages);
  const accountId=useConnection(s=>s.activeAccountId);
  const identityKey=`${accountId}:${id}`;
  const [saved,setSaved]=useState<{key:string;people:SessionParticipant[]}>({key:'',people:[]});
  useEffect(()=>{
    if(!detailed||!id||kind!=='session')return;
    let alive=true;
    const refresh=()=>{void getSessionParticipants(id).then(values=>{if(alive)setSaved({key:identityKey,people:values});}).catch(()=>{if(alive)setSaved({key:identityKey,people:[]});});};
    refresh();const timer=setInterval(refresh,10000);
    return()=>{alive=false;clearInterval(timer);};
  },[identityKey,id,kind,detailed,messages?.length]);
  if (detailed) {
    const participants = new Map<string, { name: string; active: boolean }>();
    for(const person of saved.key===identityKey?saved.people:[])participants.set(person.handle,{name:person.display,active:false});
    for (const message of messages || []) {
      if (!message.author || !['human','user'].includes(message.author.kind || '')) continue;
      let handle=message.author.handle || '';
      try {const identity=JSON.parse(handle);if(typeof identity?.subject_id==='string')handle=identity.subject_id;} catch { /* Ordinary display handle. */ }
      const name = message.author.display || handle;
      if (name && !participants.has(handle || name)) participants.set(handle || name, { name, active: false });
    }
    for (const person of members) {
      const known = [...participants.entries()].find(([handle, entry]) => handle === person.userId || entry.name === person.name);
      participants.set(known?.[0] || person.userId, { name: person.name, active: true });
    }
    return <View style={{ gap: 10 }}>
      {[...participants].map(([key, person]) => <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ borderRadius: 16, width: 26, height: 26, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.text, fontSize: 11 }}>{person.name.slice(0, 2).toUpperCase()}</Text></View>
        <Text style={{ flex: 1, color: colors.text, fontSize: 12 }}>{person.name}</Text>
        <Text style={{ color: person.active ? colors.success : colors.textMuted, fontSize: 10 }}>{person.active ? 'Active' : 'Participated'}</Text>
      </View>)}
      {!participants.size && <Text style={{ color: colors.textMuted, fontSize: 12 }}>No participant information yet.</Text>}
    </View>;
  }
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
