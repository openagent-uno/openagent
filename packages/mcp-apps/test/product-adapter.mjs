/** Compile the actual product adapter. Only external auth/IPC ingress is a controlled fixture. */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {build}=require('esbuild');
export async function startProductAdapter({product,root,apiRequest,parentOrigins=[],native={},clientInstanceId}){
 const canonical=product==='standalone';
 const desktop=canonical?path.join(root,'apps/app/desktop'):path.join(root,'client/desktop');
 const entry=path.join(desktop,canonical?'src/services/mcp-apps.ts':'src/mcp-apps.ts');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'openagent-mcp-app-adapter-'));
 const handlers=new Map();let service;
 const server=http.createServer(async(request,response)=>{try{
  if(request.url==='/api/v1/session'&&request.method==='GET'){
   if(request.headers.authorization!=='Bearer fixture-session')throw Error('unauthorized');
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({user:{userId:'alice'}}));return;
  }
  const prefix=canonical?'/api/sessions/session-alice/mcp-apps/':'/api/v1/workspaces/workspace-1/agents/agent-1/sessions/session-alice/mcp-apps/';
  if(request.method!=='POST'||!request.url.startsWith(prefix)||!canonical&&request.headers.authorization!=='Bearer fixture-session')throw Error('invalid_scoped_proxy');
  const operation=request.url.slice(prefix.length);let raw='';for await(const chunk of request)raw+=chunk;
  if(canonical&&clientInstanceId&&request.headers['x-openagent-client-instance']!==clientInstanceId)throw Error('wrong_main_client_header');
  const result=await apiRequest(operation,JSON.parse(raw),request.headers);response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
 }catch{response.writeHead(403,{'Content-Type':'application/json'});response.end('{"error":"fixture_proxy_denied"}')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const frame={url:origin+'/chat'},events=[],dialogs=[],links=[];
 const contents={id:7,mainFrame:frame,isDestroyed:()=>false,send:(channel,value)=>events.push({channel,value})};
 const owner={webContents:contents,isDestroyed:()=>false,isVisible:()=>true};
 let active=true,lifetime={};const listeners=new Set();
 const harness={handlers,contents,owner,events,dialogs,links,native,
  getMcpAppConsumerLifetime:(accountId,rendererId)=>{harness.getMcpAppLoopback(accountId,rendererId);return lifetime},
  onMcpAppContextReleased:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
  releaseAccount:()=>{active=false;for(const callback of listeners)callback("fixture-account",7)},resumeAccount:()=>{active=true;lifetime={}},
  getMcpAppLoopback:(accountId,rendererId)=>{if(!active||accountId!=='fixture-account'||rendererId!==7)throw Error('wrong_renderer_account');return harness.loopback},loopback:{baseUrl:origin}};
 const key='__openagentMcpAppAdapterHarness';globalThis[key]=harness;
 try{
  await build({entryPoints:[entry],outfile:path.join(directory,'adapter.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'fixture-authenticated-ingress',setup(build){
   build.onResolve({filter:/^@openagent\/mcp-apps\/desktop$/},()=>({path:fileURLToPath(new URL('../src/desktop.mjs',import.meta.url))}));
   build.onResolve({filter:/^(electron|\.\/loopback|\.\.\/security\/trusted-ipc|\.\.\/security\/trusted-renderers)$/},args=>({path:args.path,namespace:'fixture-ingress'}));
   build.onLoad({filter:/.*/,namespace:'fixture-ingress'},args=>({contents:args.path==='electron'?`
    const state=globalThis.${key};
    export const webContents={fromId:id=>id===7?state.contents:undefined};
    export const BrowserWindow={fromWebContents:contents=>contents===state.contents?state.owner:null};
    export const dialog={showMessageBox:async(owner,options)=>{state.dialogs.push({ownerMatches:owner===state.owner,options});return state.native.decide?state.native.decide(options):{response:state.native.response??0}}};
    export const shell={openExternal:async url=>{state.links.push(url)}};
   `:args.path==='./loopback'?`export const getMcpAppLoopback=(...args)=>globalThis.${key}.getMcpAppLoopback(...args);export const getMcpAppConsumerLifetime=(...args)=>globalThis.${key}.getMcpAppConsumerLifetime(...args);export const onMcpAppContextReleased=(...args)=>globalThis.${key}.onMcpAppContextReleased(...args)`:
    args.path==='../security/trusted-renderers'?`export const sendToTrustedRenderer=(contents,channel,payload)=>{contents.send(channel,payload);return true}`:
    `export const handleTrustedIpc=(name,handler)=>globalThis.${key}.handlers.set(name,handler)`,loader:'js'}));
  }}]});
  const module=await import(pathToFileURL(path.join(directory,'adapter.mjs')).href);
  service=canonical?await module.registerMcpApps(desktop,parentOrigins,clientInstanceId):await module.startMcpApps({appPath:desktop,apiBase:new URL(origin),parentOrigins,accessToken:async()=>native.accessToken?native.accessToken():'fixture-session'});
  const open=canonical?reference=>handlers.get('mcp-apps:open')({sender:contents},{...reference,accountId:'fixture-account'}):reference=>service.openForRenderer(reference,7);
  return{...service,open,harness,async shutdown(){try{await service.shutdown()}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});if(globalThis[key]===harness)delete globalThis[key]}}};
 }catch(error){await service?.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});if(globalThis[key]===harness)delete globalThis[key];throw error}
}
