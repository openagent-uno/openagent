import { sendToTrustedRenderer } from '../security/trusted-renderers';
import { approveMcpAppPolicy, openMcpAppLink, requestMcpAppDraft } from './mcp-app-policy';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMcpAppHostService,type McpAppHostService,type McpAppReference,type McpAppHostActionControl} from '@openagent/mcp-apps/desktop';
import {getMcpAppLoopback,getMcpAppConsumerLifetime,onMcpAppContextReleased} from './loopback';
import {handleTrustedIpc} from '../security/trusted-ipc';
export async function registerMcpApps(appPath:string,parentOrigins:string[],clientInstanceId?:string):Promise<McpAppHostService>{
 const bindings=new WeakMap<object,{rendererId:number;frame:unknown;url:string;lifetime:object;loopback:ReturnType<typeof getMcpAppLoopback>}>();
 const boot=randomUUID();
 function currentBinding(reference:McpAppReference){
  const binding=bindings.get(reference);
  if(!binding||!reference.accountId||getMcpAppLoopback(reference.accountId,binding.rendererId)!==binding.loopback||getMcpAppConsumerLifetime(reference.accountId,binding.rendererId)!==binding.lifetime)throw new Error('mcp_app_account_changed');
  return binding;
 }
 async function dialogOwner(reference:McpAppReference){
  const binding=currentBinding(reference);
  const {BrowserWindow,webContents}=await import('electron'),contents=webContents.fromId(binding.rendererId);
  if(currentBinding(reference)!==binding)throw new Error('mcp_app_owner_changed');
  if(!contents||contents.isDestroyed()||contents.mainFrame!==binding.frame||contents.mainFrame.url!==binding.url)throw new Error('mcp_app_owner_changed');
  const owner=BrowserWindow.fromWebContents(contents);if(!owner||owner.isDestroyed())throw new Error('mcp_app_owner_changed');return owner;
 }
 function ownerControl(reference:McpAppReference,control:McpAppHostActionControl,owner:Awaited<ReturnType<typeof dialogOwner>>):McpAppHostActionControl {
  return {...control,authorize:async()=>{await control.authorize();if(await dialogOwner(reference)!==owner)throw new Error('mcp_app_owner_changed')}};
 }
 async function api(reference:McpAppReference,operation:string,body:unknown,signal?:AbortSignal){
  const binding=currentBinding(reference);
  const response=await fetch(new URL(`/api/sessions/${encodeURIComponent(reference.sessionId)}/mcp-apps/${operation}`,binding.loopback.baseUrl),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(clientInstanceId?{'X-OpenAgent-Client-Instance':clientInstanceId}:{})},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('mcp_app_unavailable');const result=await response.json();if(currentBinding(reference)!==binding)throw new Error('mcp_app_account_changed');return result;
 }
 const service=await createMcpAppHostService({
  approvePolicy:async(request,reference,control)=>{const owner=await dialogOwner(reference);return approveMcpAppPolicy(request,reference,ownerControl(reference,control,owner),owner)},
  openLink:async(params,reference,control)=>{const owner=await dialogOwner(reference);return openMcpAppLink(params,reference,ownerControl(reference,control,owner),owner)},
  sendMessage:async(params,reference,control)=>{
    const owner=await dialogOwner(reference);
    return requestMcpAppDraft(params,reference,ownerControl(reference,control,owner),owner,draft=>{
      const binding=currentBinding(reference);
      if(owner.isDestroyed()||owner.webContents.mainFrame!==binding.frame||owner.webContents.mainFrame.url!==binding.url||!sendToTrustedRenderer(owner.webContents,'mcp-apps:draft',draft))throw new Error('mcp_app_owner_changed');
    });
  },assetRoot:path.join(appPath,'node_modules/@openagent/mcp-apps/src'),parentOrigins,currentOwner:async()=>boot,
  openSession:(reference,signal)=>api(reference,'open',{tool_ref:reference.toolRef,...(reference.toolCallId?{tool_call_id:reference.toolCallId}:{})},signal),
  requestSession:(session,method,params,reference,control)=>api(reference,`${encodeURIComponent(session.handle)}/request`,{method,params,request_id:control?.requestId},control?.signal),
  closeSession:(session,reference)=>api(reference,`${encodeURIComponent(session.handle)}/close`,{}),
 });
 const unsubscribe=onMcpAppContextReleased((accountId,rendererId)=>{
  service.revokeViews(reference=>reference.accountId===accountId&&bindings.get(reference)?.rendererId===rendererId);
 });
 handleTrustedIpc('mcp-apps:open',async(event,value:unknown)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_mcp_app_reference');
  const raw=value as Record<string,unknown>;const reference:Record<string,string>={};
  for(const key of ['sessionId','toolRef','accountId','toolCallId']){const item=raw[key];if(key==='toolCallId'&&item===undefined)continue;if(typeof item!=='string'||!item||item.length>2048||/[\u0000-\u001f\u007f]/.test(item))throw new Error('invalid_mcp_app_reference');reference[key]=item}
  const typed=reference as unknown as McpAppReference;
  bindings.set(typed,{rendererId:event.sender.id,frame:event.sender.mainFrame,url:event.sender.mainFrame.url,lifetime:getMcpAppConsumerLifetime(typed.accountId!,event.sender.id),loopback:getMcpAppLoopback(typed.accountId!,event.sender.id)});
  return service.open(typed);
 });
 handleTrustedIpc('mcp-apps:close',async(_event,id:unknown)=>{if(typeof id!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(id))throw new Error('invalid_mcp_app_view');await service.close(id)});
 return {...service,shutdown:async()=>{unsubscribe();await service.shutdown()}};
}
