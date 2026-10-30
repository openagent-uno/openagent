import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {colors} from '../theme';

type Scope={accountId?:string;workspaceId?:string;agentId?:string;sessionId?:string;actorUserId?:string};
type Draft=Scope&{draftId:string;sourceName:string;sourceId:string;text:string};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function valid(value:unknown):value is Draft {
 if(!record(value)||typeof value.draftId!=='string'||value.draftId.length>128||typeof value.text!=='string'||!value.text.trim()||value.text.length>32768||value.text.includes('\0')||typeof value.sourceName!=='string'||value.sourceName.length>512||typeof value.sessionId!=='string')return false;
 return ['accountId','workspaceId','agentId','actorUserId'].every(key=>value[key]===undefined||typeof value[key]==='string');
}
function matches(draft:Draft,scope:Scope){return !!scope.sessionId&&['accountId','workspaceId','agentId','sessionId','actorUserId'].every(key=>(draft[key as keyof Scope]??'')===(scope[key as keyof Scope]??''))}
/** Desktop-only suggestion. User Insert and the ordinary Send action are separate. */
export default function McpAppDraftReview({scope,scopeKey,onInsert,disabled=false}:{scope:Scope;scopeKey:string;onInsert(text:string):void;disabled?:boolean}){
 
 const [pending,setPending]=useState<{key:string;draft:Draft}|null>(null);
 const latest=useRef({scope,scopeKey,onInsert,disabled});latest.current={scope,scopeKey,onInsert,disabled};
 useEffect(()=>{
  setPending(null);let current=true;
  if(typeof window==='undefined')return()=>{current=false};
  const bridge=(window as unknown as Record<string,unknown>)['desktop'];
  const apps=record(bridge)&&record(bridge.mcpApps)?bridge.mcpApps:null;
  if(typeof apps?.onDraft!=='function')return()=>{current=false};
  const seen=new Set<string>();
  const unsubscribe=(apps.onDraft as (callback:(value:unknown)=>void)=>()=>void)(value=>{
   if(!current||!valid(value)||!matches(value,latest.current.scope)||seen.has(value.draftId))return;
   if(seen.size>=64)seen.delete(seen.values().next().value!);seen.add(value.draftId);
   setPending({key:latest.current.scopeKey,draft:value});
  });
  return()=>{current=false;unsubscribe()};
 },[scopeKey]);
 if(!pending||pending.key!==scopeKey||!matches(pending.draft,scope))return null;
 return <View testID="mcp-app-draft-review" style={{padding:12,gap:8,borderWidth:1,borderColor:colors.border,borderRadius:8}}>
  <Text style={{color:colors.text,fontWeight:'600'}}>Draft suggested by {pending.draft.sourceName}</Text>
  <ScrollView style={{maxHeight:160}}><Text selectable style={{color:colors.text}}>{pending.draft.text}</Text></ScrollView>
  <Text style={{color:colors.textMuted,fontSize:12}}>Review this suggestion before sending. No message has been sent.</Text>
  <View style={{flexDirection:'row',gap:16}}>
   <Pressable accessibilityRole="button" accessibilityLabel="Insert suggested draft into composer" disabled={disabled} onPress={()=>{
    const value=latest.current;if(value.disabled||pending.key!==value.scopeKey||!matches(pending.draft,value.scope))return;
    value.onInsert(pending.draft.text);setPending(null);
   }}><Text style={{color:colors.text,textDecorationLine:'underline'}}>Insert into composer</Text></Pressable>
   <Pressable accessibilityRole="button" accessibilityLabel="Dismiss suggested draft" onPress={()=>setPending(null)}><Text style={{color:colors.text}}>Dismiss</Text></Pressable>
  </View>
 </View>;
}
