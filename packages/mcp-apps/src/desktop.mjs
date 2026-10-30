/** Optional loopback presentation service. Authentication and tool execution belong to its host callbacks. */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSandboxProxyHtml, SANDBOX_PROXY_HEADERS } from './sandbox.mjs';
import { parseUiResource, normalizeCsp, effectiveResourcePolicy, boundedCopy, normalizeTextMessage } from './index.mjs';
import { isIP } from 'node:net';

const HOST_SCRIPT = `import {mountMcpApp} from '/static/index.mjs';
const base=location.pathname.replace(/\\/$/,'');
const status=document.querySelector('#status');let controller,pendingDisplay,delivering=false,inputDelivered=false,terminalDelivered=false,displayReceived=false;
const viewId=base.split('/').pop();function notify(status){parent.postMessage({type:'openagent-mcp-app-status',viewId,status},'*')}
async function rpc(method,params={},signal){const response=await fetch(base+'/rpc',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({id:crypto.randomUUID(),method,params})});if(!response.ok)throw new Error('Interactive tool unavailable');const data=await response.json();return data.result;}
function captureDisplay(display){
 if(!display||typeof display!=='object'||Array.isArray(display)||terminalDelivered)return;
 const snapshot={};for(const key of ['toolInput','toolResult','toolCancelled','toolStatus'])if(display[key]!==undefined)snapshot[key]=display[key];
 if(!Object.keys(snapshot).length)return;pendingDisplay={...pendingDisplay,...snapshot};if(display.toolCancelled===true)delete pendingDisplay.toolResult;
 if(controller)queueMicrotask(()=>void deliverDisplay());
}
async function deliverDisplay(){
 if(!controller||delivering||terminalDelivered)return;delivering=true;
 try{
  while(pendingDisplay&&!terminalDelivered){
   const display=pendingDisplay;pendingDisplay=undefined;
   if(!inputDelivered&&display.toolInput!==undefined){inputDelivered=true;await controller.setToolInput(display.toolInput)}
   if(!inputDelivered&&(display.toolCancelled===true||display.toolResult!==undefined)){inputDelivered=true;await controller.setToolInputUnavailable()}
   if(!inputDelivered){pendingDisplay={...display,...pendingDisplay};break}
   // Set the receipt before publication authorizes again. Authorization never
   // awaits this delivery queue, so there is no authorize/flush recursion.
   if(display.toolCancelled===true){terminalDelivered=true;displayReceived=true;await controller.cancel('Tool execution cancelled')}
   else if(display.toolResult!==undefined){terminalDelivered=true;displayReceived=true;await controller.setToolResult(display.toolResult)}
  }
 }catch{controller.revoke();notify('error');status.textContent='The interactive tool result is unavailable.'}
 finally{delivering=false;if(terminalDelivered)pendingDisplay=undefined}
}
try{
 const response=await fetch(base+'/data');if(!response.ok)throw new Error('Interactive tool unavailable');const data=await response.json();captureDisplay(data);
 const broker={authorize:async(_binding,_operation,signal)=>{
  try{const value=await rpc('authorize',{display_received:displayReceived},signal);if(value.authorized!==true)return false;captureDisplay(value.display);return true}catch{return false}
 },callTool:(_,params,signal)=>rpc('tools/call',params,signal),readResource:(_,params,signal)=>rpc('resources/read',params,signal),...(data.openLink?{openLink:(_,params,signal)=>rpc('ui/open-link',params,signal)}:{}),...(data.sendMessage?{sendMessage:(_,params,signal)=>rpc('ui/message',params,signal)}:{}),updateContext:(_,params,signal)=>rpc('ui/update-model-context',params,signal),requestDisplayMode:async()=>({mode:'inline'})};
 controller=await mountMcpApp({container:document.querySelector('#app'),sandboxUrl:data.sandboxUrl,resource:data.resource,binding:data.binding,broker,...data.policy,hostContext:{...data.hostContext,availableDisplayModes:['inline']},title:data.title});status.textContent='';await deliverDisplay();
 let verifying=false;
 const verify=setInterval(()=>{if(verifying)return;verifying=true;void broker.authorize().then(allowed=>{if(!allowed){clearInterval(verify);controller.revoke();notify('revoked');status.textContent='This interactive tool is no longer available.'}}).finally(()=>{verifying=false})},2000);
 addEventListener('pagehide',()=>{clearInterval(verify);pendingDisplay=undefined;controller.dispose();notify('closed');navigator.sendBeacon(base+'/close','')},{once:true});
}catch(error){controller?.revoke();notify('error');status.textContent=error.message;}`;

export function approvableResourcePolicy(resource) {
  const ui=resource?._meta?.ui??{},declaredCsp=normalizeCsp(ui.csp??{}),blockedDomains=[];
  const publicOrigin=value=>{
    try{
      const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
      if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||host.includes('*')||!host.includes('.')||
         /(?:^|\.)(?:localhost|local|internal|localdomain)$/.test(host)||isIP(host.replace(/^\[|\]$/g,'')))return false;
      return true;
    }catch{return false}
  };
  const approvedCsp=Object.fromEntries(Object.entries(declaredCsp).map(([key,values])=>[key,values.filter(value=>{if(publicOrigin(value))return true;blockedDomains.push(value);return false})]));
  const declaredPermissions=Object.fromEntries(['camera','microphone','geolocation','clipboardWrite'].filter(key=>ui.permissions?.[key]&&typeof ui.permissions[key]==='object'&&!Array.isArray(ui.permissions[key])).map(key=>[key,{}]));
  return {resourceUri:resource.uri,declaredCsp:approvedCsp,declaredPermissions,blockedDomains:[...new Set(blockedDomains)]};
}
function clampPolicy(resource,request,decision={}) {
  const approval=normalizeCsp(decision.approvedCsp??{});
  const approvedCsp=Object.fromEntries(Object.keys(request.declaredCsp).map(key=>[key,approval[key].filter(value=>request.declaredCsp[key].includes(value))]));
  const effective=effectiveResourcePolicy(resource._meta??{},{approvedCsp,grantedPermissions:decision.grantedPermissions??{}});
  return {approvedCsp:effective.csp,grantedPermissions:Object.fromEntries(Object.keys(effective.permissions).map(key=>[key,true]))};
}

function listen(server) {return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port)})})}
function shut(server){return new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
function json(response,status,value){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value))}
async function body(request){let size=0,parts=[];for await(const chunk of request){size+=chunk.length;if(size>2*1024*1024)throw new Error('request_limit');parts.push(chunk)}const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_request');return value}

export async function createMcpAppHostService(options) {
  if(!path.isAbsolute(options.assetRoot)||typeof options.openSession!=='function'||typeof options.requestSession!=='function'||typeof options.currentOwner!=='function')throw new Error('invalid_mcp_app_host');
  const views=new Map(),retiring=new Set();let origin='',sandboxOrigin='',closed=false,opening=0;
  for(const ancestor of options.parentOrigins??[]){if(!/^(https?:\/\/[^\s;]+|[a-z][a-z0-9+.-]*:)$/i.test(ancestor))throw new Error('invalid_parent_origin')} 
  const maxViews=options.maxViews??16;
  if(!Number.isInteger(maxViews)||maxViews<1||maxViews>256)throw new Error('invalid_view_limit');
  async function authorize(view){if(closed||!view||view.expires<=Date.now()||await options.currentOwner()!==view.owner)throw new Error('app_revoked');const result=await options.requestSession(view.session,'authorize',{display_received:true},view.reference);if(result?.authorized!==true||closed||!views.has(view.id)||view.expires<=Date.now()||await options.currentOwner()!==view.owner)throw new Error('app_revoked')}
  async function once(view,input,operation) {
    // Retain a fixed-size identity, not thousands of copies of user draft text.
    const digest=createHash('sha256').update(JSON.stringify({method:input.method,params:input.params})).digest('hex');
    const previous=view.requests.get(input.id);
    if(previous){if(previous.digest!==digest)throw new Error('request_conflict');return previous.promise}
    if(view.requests.size>=2048)throw new Error('request_limit');
    if(view.interactive!==null)throw new Error('interactive_decision_busy');
    const token=Symbol(input.id);view.interactive=token;
    const promise=Promise.resolve().then(operation).finally(()=>{if(view.interactive===token)view.interactive=null});
    view.requests.set(input.id,{digest,promise});return promise;
  }
  function retire(id){
    const view=views.get(id);if(!view)return Promise.resolve();
    views.delete(id);clearTimeout(view.timer);for(const operation of view.active)operation.abort();
    const task=Promise.resolve().then(()=>options.closeSession?.(view.session,view.reference)).catch(()=>{});
    retiring.add(task);void task.then(()=>retiring.delete(task));return task;
  }
  function actionControl(view,signal) {return {signal,ownerId:view.owner,sourceName:String(view.session.tool?.name??'Interactive tool').slice(0,512),sourceId:String(view.session.binding?.sourceId??'').slice(0,512),authorize:async()=>{if(signal.aborted)throw new Error('app_revoked');await authorize(view);if(signal.aborted)throw new Error('app_revoked')}}}
  function resourcePolicy(view) {
    if(view.policyPromise)return view.policyPromise;
    if(view.interactive!==null)return Promise.reject(new Error('interactive_decision_busy'));
    const token=Symbol('resource-policy');view.interactive=token;
    const cancel=new AbortController();view.active.add(cancel);
    let checking=false;
    const check=async()=>{if(cancel.signal.aborted)throw new Error('app_revoked');await authorize(view);if(cancel.signal.aborted)throw new Error('app_revoked')};
    const timer=setInterval(()=>{if(checking)return;checking=true;void check().catch(()=>cancel.abort()).finally(()=>{checking=false})},2000);timer.unref?.();
    view.policyPromise=(async()=>{
      try{
        await check();
        const request={...approvableResourcePolicy(view.resource),toolName:String(view.session.tool?.name??'Interactive tool').slice(0,512),sourceId:String(view.session.binding?.sourceId??'').slice(0,512)};
        const declared=Object.values(request.declaredCsp).some(values=>values.length)||Object.keys(request.declaredPermissions).length||request.blockedDomains.length;
        const decision=declared&&options.approvePolicy?await options.approvePolicy(boundedCopy(request),view.reference,{signal:cancel.signal,authorize:check}):{};
        await check();view.policy=clampPolicy(view.resource,request,decision??{});return view.policy;
      }catch(error){await retire(view.id);throw error}
      finally{clearInterval(timer);view.active.delete(cancel);if(view.interactive===token)view.interactive=null}
    })();
    return view.policyPromise;
  }
  const sandbox=http.createServer((request,response)=>{
    if(!sandboxOrigin||request.headers.host!==new URL(sandboxOrigin).host){response.writeHead(403);response.end();return}
    if(request.url!=='/proxy'||request.method!=='GET'){response.writeHead(404);response.end();return}
    response.writeHead(200,{...SANDBOX_PROXY_HEADERS,'Cache-Control':'no-store'});response.end(buildSandboxProxyHtml());
  });
  const host=http.createServer(async(request,response)=>{
    try{
      if(request.headers.host!==new URL(origin).host){json(response,403,{error:'invalid_host'});return}
      const url=new URL(request.url,origin);
      if(url.search){json(response,400,{error:'invalid_query'});return}
      if(request.method==='GET'&&url.pathname.startsWith('/static/')){
        const name=url.pathname.slice(8);if(!['index.mjs','protocol.mjs','sandbox.mjs'].includes(name)){json(response,404,{error:'not_found'});return}
        const content=await readFile(path.join(options.assetRoot,name));response.writeHead(200,{'Content-Type':'text/javascript','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});response.end(content);return;
      }
      if(request.method==='GET'&&url.pathname==='/host.mjs'){response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});response.end(HOST_SCRIPT);return}
      const match=url.pathname.match(/^\/view\/([a-zA-Z0-9_-]{43})(?:\/(data|rpc|close))?$/);
      if(!match){json(response,404,{error:'not_found'});return}
      const id=match[1],route=match[2],view=views.get(id);if(request.method==='GET'&&route==='data')response.once('close',()=>{if(!response.writableEnded)void retire(id)});await authorize(view);
      if(request.method==='GET'&&!route){
        const ancestors=["'self'",...(options.parentOrigins??[])].join(' ');
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${sandboxOrigin}; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`});
        response.end('<!doctype html><html><head><meta charset="utf-8"><title>Interactive tool</title></head><body><p id="status" role="status">Loading interactive tool…</p><main id="app"></main><script type="module" src="/host.mjs"></script></body></html>');return;
      }
      if(request.method==='GET'&&route==='data'){const policy=resourcePolicy(view);await policy;await authorize(view);json(response,200,{sandboxUrl:sandboxOrigin+'/proxy',binding:view.session.binding,resource:view.resource,policy:view.policy,...(view.session.toolInput===undefined?{}:{toolInput:view.session.toolInput}),toolResult:view.session.toolResult,toolCancelled:view.session.toolCancelled,toolStatus:view.session.toolStatus,title:view.session.tool?.name??'Interactive tool',hostContext:options.hostContext??{},openLink:!!options.openLink,sendMessage:!!options.sendMessage});return}
      if(request.method==='POST'&&route==='close'){
        if(request.headers.origin!==origin){json(response,403,{error:'invalid_origin'});return}
        await retire(id);json(response,200,{closed:true});return;
      }
      if(request.method!=='POST'||route!=='rpc'||request.headers.origin!==origin){json(response,403,{error:'invalid_origin'});return}
      const input=await body(request);
      if(typeof input.id!=='string'||input.id.length===0||input.id.length>128||typeof input.method!=='string'||!input.params||typeof input.params!=='object'||Array.isArray(input.params))throw new Error('invalid_request');
      if(!['authorize','tools/call','resources/read','ui/open-link','ui/message','ui/update-model-context'].includes(input.method))throw new Error('unsupported_method');
      const cancel=new AbortController();view.active.add(cancel);
      response.once('close',()=>{if(!response.writableEnded)cancel.abort()});
      try{
        let result;
        if(input.method==='ui/open-link'&&!options.openLink||input.method==='ui/message'&&!options.sendMessage)throw new Error('unsupported_method');
        if(input.method==='ui/open-link'&&options.openLink){const link=new URL(input.params.url);if(!['https:','http:'].includes(link.protocol)||link.username||link.password)throw new Error('invalid_link');result=await once(view,input,()=>options.openLink(input.params,view.reference,actionControl(view,cancel.signal)));}
        else if(input.method==='ui/message'&&options.sendMessage){
          const params=normalizeTextMessage(input.params);
          result=await once(view,input,()=>options.sendMessage(params,view.reference,actionControl(view,cancel.signal)));
        }
        else result=await options.requestSession(view.session,input.method,input.params,view.reference,{requestId:input.id,signal:cancel.signal});
        await authorize(view);json(response,200,{result});
      }finally{view.active.delete(cancel)}
    }catch{json(response,403,{error:'mcp_app_unavailable'})}
  });
  try{sandboxOrigin='http://127.0.0.1:'+await listen(sandbox);origin='http://127.0.0.1:'+await listen(host)}catch(error){await Promise.allSettled([shut(host),shut(sandbox)]);throw error}
  return {
    origin,sandboxOrigin,
    async open(reference){
      for(const [id,view] of views)if(view.expires<=Date.now())void retire(id);
      if(closed||views.size+opening>=maxViews)throw new Error('mcp_app_view_limit');
      opening++;
      let session;
      try{
        const owner=await options.currentOwner();if(!owner)throw new Error('mcp_app_authentication_required');
        session=await options.openSession(reference);
        if(closed||await options.currentOwner()!==owner)throw new Error('mcp_app_owner_changed');
        const resource=parseUiResource(session.resource,session.tool?._meta?.ui?.resourceUri);
        const policy=clampPolicy(resource,approvableResourcePolicy(resource),{});
        const id=randomBytes(32).toString('base64url');
        const declaredTtl=session.expiresInMs??300000;
        if(typeof declaredTtl!=='number'||!Number.isFinite(declaredTtl)||declaredTtl<=0)throw new Error('invalid_app_lifetime');
        const lifetime=Math.min(declaredTtl,300000),view={id,owner,session,resource,policy,policyPromise:null,interactive:null,reference,expires:Date.now()+lifetime,active:new Set(),requests:new Map(),timer:null};
        views.set(id,view);view.timer=setTimeout(()=>{void retire(id)},lifetime);view.timer.unref?.();
        return {viewId:id,url:origin+'/view/'+id};
      }catch(error){if(session)await options.closeSession?.(session,reference).catch(()=>{});throw error}
      finally{opening--}
    },
    async close(viewId){const view=views.get(viewId);if(view&&await options.currentOwner()!==view.owner)throw new Error('mcp_app_owner_changed');await retire(viewId)},
    async shutdown(){closed=true;for(const id of [...views.keys()])void retire(id);await Promise.allSettled([...retiring]);await Promise.all([shut(host),shut(sandbox)])},
  };
}
