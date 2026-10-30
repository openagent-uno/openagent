import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors } from '../theme';

type DecisionAction='resume'|'grant'|'revoke';
type Pending={request_id:string;action:'resume'|'permission';browser_id:string;tab_id:number;origin?:string;permissions?:string[];expires_at_ms:number};
type Scope={workspaceId?:string;scopeId?:string;actorUserId?:string;sessionId?:string;inventory:unknown};
function payload(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const raw=value as Record<string,unknown>;
 if(raw.isError===true||raw.is_error===true)throw new Error('Browser inventory is unavailable');
 if(raw.structuredContent&&typeof raw.structuredContent==='object')return raw.structuredContent as Record<string,unknown>;
 if(Array.isArray(raw.content))for(const item of raw.content){if(item?.type==='text'){try{const result=JSON.parse(item.text);if(result&&typeof result==='object'&&!Array.isArray(result))return result}catch{}}}
 return raw;
}
export default function BrowserControlPanel({inventory,decide,scopeKey,enabled=true}:{
 inventory:()=>Promise<unknown>;decide:(input:{scopeId?:string;requestId:string;action:DecisionAction})=>Promise<unknown>;scopeKey:string;enabled?:boolean;
}){
 
 const [state,setState]=useState<{key:string;scopes:Scope[]}>({key:scopeKey,scopes:[]});
 const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let current=true,loading=false;setState({key:scopeKey,scopes:[]});setError(null);
  if(!enabled)return()=>{current=false};
  const refresh=async()=>{if(loading)return;loading=true;try{const value=await inventory();const scopes=Array.isArray(value)?value as Scope[]:[{inventory:value}];for(const scope of scopes)payload(scope.inventory);if(current){setError(null);setState({key:scopeKey,scopes})}}catch(e){if(current){setState({key:scopeKey,scopes:[]});setError(e instanceof Error?e.message:'Browser control unavailable')}}finally{loading=false}};
  void refresh();const timer=setInterval(()=>void refresh(),3000);
  return()=>{current=false;clearInterval(timer)};
 },[scopeKey,enabled,inventory]);
 const scopes=state.key===scopeKey?state.scopes:[];
 const rows=scopes.flatMap(scope=>{const requests=payload(scope.inventory).pending_decisions;return Array.isArray(requests)?requests.filter((request):request is Pending=>request&&typeof request.request_id==='string'&&request.expires_at_ms>Date.now()).map(request=>({scope,request})):[]});
 if(!enabled)return null;
 return <View testID="browser-control-panel" style={{gap:8,padding:10}}>
  <Text style={{color:colors.text,fontWeight:'600'}}>Browser control</Text>
  {!rows.length?<Text style={{color:colors.textMuted,fontSize:12}}>No browser decisions pending.</Text>:null}
  {rows.map(({scope,request})=><View key={`${scope.scopeId??''}:${request.request_id}`} style={{gap:6,paddingVertical:6}}>
   {scope.actorUserId?<Text style={{color:colors.textMuted,fontSize:12}}>Workspace {scope.workspaceId} · User {scope.actorUserId} · Session {scope.sessionId}</Text>:null}
   <Text style={{color:colors.text,fontSize:12}}>{request.browser_id} · Tab {request.tab_id}</Text>
   <Text style={{color:colors.text,fontSize:12}}>{request.action==='resume'?'Manual step in progress. Resume when ready.':`${request.origin} · ${(request.permissions??[]).join(', ')}`}</Text>
   <View style={{flexDirection:'row',gap:12,flexWrap:'wrap'}}>{(request.action==='resume'?['resume']:['grant','revoke']).map(action=><Pressable key={action} accessibilityRole="button" accessibilityLabel={action==='resume'?'Resume browser control':action==='grant'?'Allow requested browser permissions':'Reset requested browser permissions'} disabled={busy} onPress={()=>{
    setBusy(true);setError(null);void decide({scopeId:scope.scopeId,requestId:request.request_id,action:action as DecisionAction}).then(()=>inventory()).then(value=>setState({key:scopeKey,scopes:Array.isArray(value)?value as Scope[]:[{inventory:value}]})).catch(e=>setError(e instanceof Error?e.message:'Browser decision failed')).finally(()=>setBusy(false));
   }} style={{paddingVertical:6,opacity:busy?.5:1}}><Text style={{color:colors.text,textDecorationLine:'underline'}}>{action==='resume'?'Resume control':action==='grant'?'Allow permissions':'Reset permissions'}</Text></Pressable>)}</View>
  </View>)}
  {error?<Text accessibilityRole="alert" style={{color:colors.text,fontSize:12}}>{error}</Text>:null}
 </View>;
}
