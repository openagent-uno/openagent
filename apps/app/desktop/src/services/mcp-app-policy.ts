import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { McpAppPolicyRequest, McpAppReference, McpAppHostActionControl } from '@openagent/mcp-apps/desktop';

function requireOwner(owner:BrowserWindow, signal:AbortSignal):void {
  if(signal.aborted||!owner||owner.isDestroyed()||!owner.isVisible())throw new Error('mcp_app_owner_unavailable');
}
/** All decisions require an exact main-owned parent. Unparented dialogs block macOS main. */
export async function approveMcpAppPolicy(request:McpAppPolicyRequest, reference:McpAppReference, control:McpAppHostActionControl, owner:BrowserWindow) {
  const origins=Object.values(request.declaredCsp).flat();
  if(!origins.length)return {approvedCsp:{},grantedPermissions:{}};
  requireOwner(owner,control.signal);
  const {dialog}=await import('electron');
  const labels:Record<string,string>={connectDomains:'Network requests',resourceDomains:'Scripts and media',frameDomains:'Embedded frames',baseUriDomains:'Base URLs'};
  const detail=[`Chat session: ${reference.sessionId}`,`Interactive tool: ${request.toolName??request.resourceUri}`,`Resource: ${request.resourceUri}`,
    ...Object.entries(request.declaredCsp).filter(([,values])=>values?.length).map(([key,values])=>`${labels[key]}: ${values!.join(', ')}`),
    ...(request.blockedDomains.length?[`Blocked origins: ${request.blockedDomains.join(', ')}`]:[]),
    'Permission applies only to this open view. Camera, microphone, location and clipboard permissions remain blocked.'].join('\n');
  const result=await dialog.showMessageBox(owner,{signal:control.signal,type:'question',title:'Interactive tool resources',message:'Allow this interactive tool to load the listed external resources?',detail,
    buttons:['Block external resources','Allow listed origins'],defaultId:0,cancelId:0,noLink:true});
  requireOwner(owner,control.signal);await control.authorize();
  return result.response===1?{approvedCsp:request.declaredCsp,grantedPermissions:{}}:{approvedCsp:{},grantedPermissions:{}};
}
export function safeMcpAppLink(value:unknown):string {
  if(typeof value!=='string'||!value||value.length>2048||/[\u0000-\u001f\u007f]/.test(value))throw new Error('invalid_mcp_app_link');
  const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!host.includes('.')||
     /(?:^|\.)(?:localhost|local|internal|localdomain)$/.test(host)||/^[0-9.]+$/.test(host)||host.includes(':'))throw new Error('invalid_mcp_app_link');
  return url.href;
}
export async function openMcpAppLink(params:{url:string}, reference:McpAppReference,control:McpAppHostActionControl,owner:BrowserWindow) {
  const url=safeMcpAppLink(params.url);requireOwner(owner,control.signal);
  const {dialog,shell}=await import('electron');
  const result=await dialog.showMessageBox(owner,{signal:control.signal,type:'question',title:'Open interactive tool link',message:'Open this link in your browser?',detail:`Chat session: ${reference.sessionId}\n${url}`,
    buttons:['Cancel','Open link'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)throw new Error('mcp_app_link_denied');
  await control.authorize();requireOwner(owner,control.signal);
  await shell.openExternal(url,{activate:true});return {};
}
export interface McpAppDraft {
  draftId:string;sessionId:string;actorUserId?:string;accountId?:string;workspaceId?:string;agentId?:string;
  sourceName:string;sourceId:string;text:string;
}
/** Never sends a message. The renderer offers a second explicit Insert action. */
export async function requestMcpAppDraft(params:unknown,reference:McpAppReference,control:McpAppHostActionControl,owner:BrowserWindow,publish:(draft:McpAppDraft)=>void) {
  const raw=params as {role?:unknown;content?:unknown};
  if(!raw||raw.role!=='user'||!Array.isArray(raw.content)||!raw.content.length||raw.content.length>32||raw.content.some(block=>!block||typeof block!=='object'||block.type!=='text'||typeof block.text!=='string'))throw new Error('invalid_mcp_app_draft');
  const text=raw.content.map(block=>(block as {text:string}).text).join('\n');
  if(!text.trim()||Buffer.byteLength(text,'utf8')>32768||text.includes('\0'))throw new Error('invalid_mcp_app_draft');
  requireOwner(owner,control.signal);const {dialog}=await import('electron');
  const sourceName=control.sourceName??'Interactive tool';
  const result=await dialog.showMessageBox(owner,{signal:control.signal,type:'question',title:'Suggested chat draft',message:'Review a draft suggested by this interactive tool?',
    detail:`Source: ${sourceName}\nChat session: ${reference.sessionId}\n\n${text.slice(0,8000)}${text.length>8000?'\n… Review the complete draft in the composer.':''}\n\nThis will not send a message.`,
    buttons:['Cancel','Review draft'],defaultId:0,cancelId:0,noLink:true});
  if(result.response!==1)throw new Error('mcp_app_draft_denied');
  await control.authorize();requireOwner(owner,control.signal);
  publish({draftId:randomUUID(),sessionId:reference.sessionId,...(reference.accountId?{accountId:reference.accountId}:{}),...(reference.workspaceId?{workspaceId:reference.workspaceId}:{}),...(reference.agentId?{agentId:reference.agentId}:{}),sourceName,sourceId:control.sourceId??'',text});
  return {draftSuggested:true,requiresUserSend:true};
}
