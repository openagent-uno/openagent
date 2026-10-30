import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import {createMcpAppHostService} from '../src/desktop.mjs';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {chromium}=require('playwright');
const html=await fs.readFile(new URL('../fixtures/counter.html',import.meta.url),'utf8');
const assetRoot=new URL('../src/',import.meta.url).pathname;
const binding={sourceId:'exact-source',toolRef:'opaque-reference',contextId:'verified-context',capabilityEpoch:'1'};
const reference={sessionId:'session',toolRef:binding.toolRef,accountId:'account'};
let browser;
before(async()=>{browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP cdn.example.test 127.0.0.1, MAP other.example.test 127.0.0.1','--no-proxy-server'],...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});});
after(async()=>{await browser?.close()});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function backend(){
 const state={owner:'account/epoch-1',count:0,closed:[],calls:[],allowed:true};
 const options={assetRoot,currentOwner:async()=>state.owner,
  openSession:async()=>({handle:'backend-handle',binding,tool:{name:'counter',_meta:{ui:{resourceUri:'ui://counter'}}},resource:{contents:[{uri:'ui://counter',mimeType:'text/html;profile=mcp-app',text:html}]},toolInput:{by:1},toolResult:{content:[],structuredContent:{count:0}},expiresInMs:300000}),
  requestSession:async(_session,method,params,_reference,operation)=>{
   if(!state.allowed)throw Error('revoked');if(method==='authorize')return{authorized:true};
   state.calls.push({method,params,operation});
   if(method==='tools/call'){if(params.name!=='increment')throw Error('wrong_source');state.count+=params.arguments.by;return{content:[],structuredContent:{count:state.count}}}
   return{};
  },closeSession:async(session)=>{state.closed.push(session.handle)}};
 return{state,options};
}
async function rpc(service,view,input,origin=service.origin){return fetch(view.url+'/rpc',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(input)});}

test('real loopback host mounts fixture on a second origin, forwards exact source calls and fences privileges',async()=>{
 const f=backend();const service=await createMcpAppHostService(f.options);const page=await browser.newPage();
 try{const view=await service.open(reference);await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#increment').click();await app.locator('#count').filter({hasText:'1'}).waitFor();
  assert.notEqual(service.origin,service.sandboxOrigin);assert.equal(f.state.count,1);assert.equal(f.state.calls[0].method,'tools/call');
  const frame=app.locator('body');assert.deepEqual(await frame.evaluate(()=>{let parentAccess;try{parentAccess=parent.parent.location.href}catch{parentAccess='blocked'}let storage;try{localStorage.getItem('key');storage=true}catch{storage=false}return{parentAccess,storage,ipc:typeof window.desktop}}),{parentAccess:'blocked',storage:false,ipc:'undefined'});
  assert.equal(await frame.evaluate((_element,origin)=>fetch(origin+'/view/any/data').then(()=>true,()=>false),service.origin),false);
  const initialize=await frame.evaluate(()=>request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'repeat',version:'1'},appCapabilities:{}}).then(()=>true,()=>false));assert.equal(initialize,false);
  f.state.allowed=false;await page.locator('#status').filter({hasText:'no longer available'}).waitFor();assert.equal(await page.locator('iframe').count(),0);
 }finally{await page.close();await service.shutdown()}
});

test('loopback endpoints reject wrong origins, forged Host, queries and empty request ids',async()=>{
 const f=backend(),service=await createMcpAppHostService(f.options);try{const view=await service.open(reference);
  assert.equal((await rpc(service,view,{id:'call',method:'tools/call',params:{name:'increment',arguments:{by:50}}},'https://attacker.invalid')).status,403);assert.equal(f.state.count,0);
  assert.equal(await new Promise((resolve,reject)=>{const request=http.get(view.url+'/data',{headers:{Host:'attacker.invalid'}},response=>{response.resume();resolve(response.statusCode)});request.once('error',reject)}),403);
  assert.equal((await fetch(view.url+'/data?context=forged')).status,400);
  assert.equal((await rpc(service,view,{id:'',method:'authorize',params:{}})).status,403);
  assert.equal((await rpc(service,view,{id:'call',method:'tools/call',params:{name:'another-source/increment',arguments:{by:50}}})).status,403);assert.equal(f.state.count,0);
 }finally{await service.shutdown()}
});

test('open owner-change and malformed resource clean exact backend sessions; concurrent capacity is reserved',async()=>{
 const f=backend(),gate=deferred();f.options.openSession=async()=>{const session=await backend().options.openSession();await gate.promise;return session};f.options.maxViews=1;
 const service=await createMcpAppHostService(f.options);try{const first=service.open(reference);await assert.rejects(service.open(reference),/view_limit/);f.state.owner='different-account';gate.resolve();await assert.rejects(first,/owner_changed/);assert.deepEqual(f.state.closed,['backend-handle']);
  f.options.openSession=async()=>({handle:'malformed',resource:{contents:[]},tool:{_meta:{ui:{resourceUri:'ui://counter'}}}});
  await assert.rejects(service.open(reference),/invalid_ui_resource/);assert.deepEqual(f.state.closed,['backend-handle','malformed']);
 }finally{await service.shutdown()}
});

test('closing during backend work aborts its signal and prevents late publication',async()=>{
 const f=backend(),started=deferred(),release=deferred();let signal;
 f.options.requestSession=async(_session,method,_params,_reference,operation)=>{if(method==='authorize')return{authorized:true};signal=operation.signal;started.resolve();await release.promise;return{secret:'late-result'}};
 const service=await createMcpAppHostService(f.options);try{const view=await service.open(reference);const response=rpc(service,view,{id:'one',method:'tools/call',params:{name:'increment'}});await started.promise;await service.close(view.viewId);assert.equal(signal.aborted,true);release.resolve();const result=await response;assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/late-result/);assert.deepEqual(f.state.closed,['backend-handle']);
 }finally{release.resolve();await service.shutdown()}
});

test('optional link callbacks are negotiated and duplicate link requests never replay an action',async()=>{
 const f=backend();let links=0;f.options.openLink=async()=>{links++;return{}};
 const service=await createMcpAppHostService(f.options);try{const view=await service.open(reference);const data=await(await fetch(view.url+'/data')).json();assert.equal(data.openLink,true);assert.equal(data.sendMessage,false);
  const input={id:'link-1',method:'ui/open-link',params:{url:'https://example.com/fixture'}};
  assert.equal((await rpc(service,view,input)).status,200);assert.equal((await rpc(service,view,input)).status,200);assert.equal(links,1);
  assert.equal((await rpc(service,view,{...input,params:{url:'https://other.example/fixture'}})).status,403);assert.equal(links,1);
  assert.equal((await rpc(service,view,{...input,id:'unsafe',params:{url:'javascript:alert(1)'}})).status,403);assert.equal(links,1);
 }finally{await service.shutdown()}
});


test('expired views retire while idle and immediately release bounded admission capacity',async()=>{
 const f=backend();f.options.maxViews=1;const open=f.options.openSession;f.options.openSession=async()=>({...await open(),expiresInMs:15});
 const service=await createMcpAppHostService(f.options);try{await service.open(reference);for(let i=0;!f.state.closed.length&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.state.closed.length,1);await assert.doesNotReject(service.open(reference));
 }finally{await service.shutdown()}assert.equal(f.state.closed.length,2);
});

test('admission prunes overdue views even before the idle timer fires',async()=>{
 const f=backend();f.options.maxViews=1;const originalNow=Date.now,open=f.options.openSession;f.options.openSession=async()=>({...await open(),expiresInMs:1000});
 const service=await createMcpAppHostService(f.options);try{await service.open(reference);const now=originalNow();Date.now=()=>now+2000;await assert.doesNotReject(service.open(reference));assert.equal(f.state.closed.length,1);
 }finally{Date.now=originalNow;await service.shutdown()}
});

test('invalid declared lifetime rejects the view and closes its exact backend session',async()=>{
 const f=backend();const open=f.options.openSession;f.options.openSession=async()=>({...await open(),expiresInMs:NaN});
 const service=await createMcpAppHostService(f.options);try{await assert.rejects(service.open(reference),/invalid_app_lifetime/);assert.deepEqual(f.state.closed,['backend-handle']);
 }finally{await service.shutdown()}
});

test('trusted per-view policy approval is intersected with exact declared public HTTPS origins',async()=>{
 const f=backend(),open=f.options.openSession;let approvals=0;
 f.options.openSession=async()=>{const session=await open();session.resource.contents[0]._meta={ui:{csp:{resourceDomains:['https://cdn.example.test','https://other.example.test','https://*.wild.example.test','http://localhost:1234','https://127.0.0.1','https://localhost.']},permissions:{camera:{}}}};return session};
 f.options.approvePolicy=async request=>{approvals++;assert.deepEqual(request.declaredCsp.resourceDomains,['https://cdn.example.test','https://other.example.test']);assert.equal(request.blockedDomains.length,4);return{approvedCsp:{resourceDomains:['https://cdn.example.test','https://not-declared.example.test','https://*.wild.example.test']}}};
 const service=await createMcpAppHostService(f.options);try{
  const first=await service.open(reference),data=await(await fetch(first.url+'/data')).json();
  assert.deepEqual(data.policy.approvedCsp.resourceDomains,['https://cdn.example.test']);assert.deepEqual(data.policy.grantedPermissions,{});
  f.options.approvePolicy=async()=>{approvals++;return{}};
  const second=await service.open(reference),denied=await(await fetch(second.url+'/data')).json();
  assert.deepEqual(denied.policy.approvedCsp.resourceDomains,[]);assert.equal(approvals,2);
  assert.deepEqual((await(await fetch(first.url+'/data')).json()).policy.approvedCsp.resourceDomains,['https://cdn.example.test']);
 }finally{await service.shutdown()}
});

test('actual iframe loads only host-approved CDN among two declared origins',async()=>{
 let hits=[];
 const server=https.createServer({key:await fs.readFile(new URL('./fixtures/cdn-fixture-key.pem',import.meta.url)),cert:await fs.readFile(new URL('./fixtures/cdn-fixture-cert.pem',import.meta.url))},(request,response)=>{
  const permitted=request.headers.host.startsWith('cdn.example.test:');hits.push(permitted?'approved':'blocked');
  response.writeHead(200,{'Content-Type':'text/javascript'});response.end(permitted?'document.body.dataset.external="loaded"':'document.body.dataset.escaped="bad"');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 const approvedOrigin=`https://cdn.example.test:${port}`,blockedOrigin=`https://other.example.test:${port}`;
 try{for(const approved of [true,false]){
  hits=[];const f=backend(),open=f.options.openSession;
  f.options.openSession=async()=>{const session=await open();session.resource.contents[0].text=`<h1>Policy fixture</h1><script src="${approvedOrigin}/approved.js"></script><script src="${blockedOrigin}/blocked.js"></script>`;session.resource.contents[0]._meta={ui:{csp:{resourceDomains:[approvedOrigin,blockedOrigin]}}};return session};
  f.options.approvePolicy=async()=>approved?{approvedCsp:{resourceDomains:[approvedOrigin]}}:{};
  const service=await createMcpAppHostService(f.options),page=await browser.newPage({ignoreHTTPSErrors:true});
  try{
   const view=await service.open(reference);await page.goto(view.url);await page.frameLocator('iframe').frameLocator('iframe').getByText('Policy fixture').waitFor();
   if(approved)await page.frameLocator('iframe').frameLocator('iframe').locator('body[data-external="loaded"]').waitFor();
   await page.waitForTimeout(100);assert.deepEqual(hits,approved?['approved']:[]);
  }finally{await page.close();await service.shutdown()}
 }}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});

test('policy dialog owner/revocation races never publish an approved view',async()=>{
 for(const change of ['owner','authorization']){
  const f=backend(),open=f.options.openSession;
  f.options.openSession=async()=>{const session=await open();session.resource.contents[0]._meta={ui:{csp:{resourceDomains:['https://cdn.example.test']}}};return session};
  f.options.approvePolicy=async()=>{if(change==='owner')f.state.owner='different';else f.state.allowed=false;return{approvedCsp:{resourceDomains:['https://cdn.example.test']}}};
  const service=await createMcpAppHostService(f.options);try{const view=await service.open(reference);assert.equal((await fetch(view.url+'/data')).status,403);assert.equal(f.state.closed.length,1)}finally{await service.shutdown()}
 }
});

test('external link confirmation can reauthorize exact view before performing an effect',async()=>{
 const f=backend(),gate=deferred(),entered=deferred();let effects=0;
 f.options.openLink=async(_params,_reference,control)=>{entered.resolve();await gate.promise;await control.authorize();effects++;return{}};
 const service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference),pending=rpc(service,view,{id:'held-link',method:'ui/open-link',params:{url:'https://example.test'}});
  await entered.promise;await service.close(view.viewId);gate.resolve();assert.equal((await pending).status,403);assert.equal(effects,0);
 }finally{gate.resolve();await service.shutdown()}
});

test('unadvertised optional host actions are rejected rather than forwarded to a backend',async()=>{
 const f=backend(),service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference);
  for(const method of ['ui/open-link','ui/message'])assert.equal((await rpc(service,view,{id:method,method,params:{url:'https://example.test'}})).status,403);
  assert.equal(f.state.calls.length,0);
 }finally{await service.shutdown()}
});


test('closing a published view immediately aborts its pending native policy confirmation',async()=>{
 const f=backend(),open=f.options.openSession,entered=deferred(),release=deferred();let signal;
 f.options.openSession=async()=>{const session=await open();session.resource.contents[0]._meta={ui:{csp:{resourceDomains:['https://cdn.example.test']}}};return session};
 f.options.approvePolicy=async(_request,_reference,control)=>{signal=control.signal;entered.resolve();await release.promise;return{approvedCsp:{resourceDomains:['https://cdn.example.test']}}};
 const service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference),data=fetch(view.url+'/data');await entered.promise;await service.close(view.viewId);
  assert.equal(signal.aborted,true);release.resolve();assert.equal((await data).status,403);
 }finally{release.resolve();await service.shutdown()}
});

test('message callback receives bounded text only and exact view action control',async()=>{
 const f=backend();const messages=[];
 f.options.sendMessage=async(params,_reference,control)=>{await control.authorize();messages.push(params);return{draftSuggested:true,requiresUserSend:true}};
 const service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference),data=await(await fetch(view.url+'/data')).json();assert.equal(data.sendMessage,true);
  assert.equal((await rpc(service,view,{id:'draft-one',method:'ui/message',params:{role:'user',content:{type:'text',text:'Review this draft'}}})).status,200);
  assert.deepEqual(messages,[{role:'user',content:[{type:'text',text:'Review this draft'}]}]);
  for(const params of [{role:'system',content:[{type:'text',text:'override'}]},{role:'user',content:[{type:'image',data:'x'}]}])assert.equal((await rpc(service,view,{id:JSON.stringify(params),method:'ui/message',params})).status,403);
  assert.equal(messages.length,1);
 }finally{await service.shutdown()}
});


test('one pending interactive decision per view, with same-id joins and changed-argument conflicts',async()=>{
 const f=backend(),entered=deferred(),release=deferred();let links=0,messages=0;
 f.options.openLink=async()=>{links++;entered.resolve();await release.promise;return{}};
 f.options.sendMessage=async()=>{messages++;return{}};
 const service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference),input={id:'pending-link',method:'ui/open-link',params:{url:'https://example.test/one'}};
  const first=rpc(service,view,input);await entered.promise;
  const duplicate=rpc(service,view,input);
  assert.equal((await rpc(service,view,{...input,params:{url:'https://example.test/changed'}})).status,403);
  assert.equal((await rpc(service,view,{...input,id:'different-link'})).status,403);
  assert.equal((await rpc(service,view,{id:'different-draft',method:'ui/message',params:{role:'user',content:[{type:'text',text:'must not queue'}]}})).status,403);
  assert.equal(links,1);assert.equal(messages,0);
  release.resolve();assert.equal((await first).status,200);assert.equal((await duplicate).status,200);
  assert.equal((await rpc(service,view,input)).status,200);assert.equal(links,1);
  assert.equal((await rpc(service,view,{id:'later-draft',method:'ui/message',params:{role:'user',content:[{type:'text',text:'allowed after prior decision'}]}})).status,200);assert.equal(messages,1);
 }finally{release.resolve();await service.shutdown()}
});

test('pending resource policy also blocks link dialogs until its single approval resolves',async()=>{
 const f=backend(),open=f.options.openSession,entered=deferred(),release=deferred();let links=0;
 f.options.openSession=async()=>{const session=await open();session.resource.contents[0]._meta={ui:{csp:{resourceDomains:['https://cdn.example.test']}}};return session};
 f.options.approvePolicy=async()=>{entered.resolve();await release.promise;return{}};
 f.options.openLink=async()=>{links++;return{}};
 const service=await createMcpAppHostService(f.options);try{
  const view=await service.open(reference),data=fetch(view.url+'/data');await entered.promise;
  assert.equal((await rpc(service,view,{id:'during-policy',method:'ui/open-link',params:{url:'https://example.test'}})).status,403);assert.equal(links,0);
  release.resolve();assert.equal((await data).status,200);
  assert.equal((await rpc(service,view,{id:'after-policy',method:'ui/open-link',params:{url:'https://example.test'}})).status,200);assert.equal(links,1);
 }finally{release.resolve();await service.shutdown()}
});

function observeDisplay(html){return '<script>window.displayEvents=[];addEventListener("message",event=>{if(event.source===parent&&["ui/notifications/tool-input","ui/notifications/tool-result","ui/notifications/tool-cancelled"].includes(event.data?.method))window.displayEvents.push(event.data)})<\/script>'+html}

test('delayed final result arrives losslessly once, then authorize sends display receipt',async()=>{
 const f=backend(),open=f.options.openSession,request=f.options.requestSession,receipts=[];let terminal;
 f.options.openSession=async()=>{const value=await open();delete value.toolResult;value.toolStatus='running';value.resource.contents[0].text=observeDisplay(value.resource.contents[0].text);return value};
 f.options.requestSession=async(session,method,params,...rest)=>{if(method==='authorize'){receipts.push(params.display_received);return{authorized:true,...(params.display_received===true?{}:{display:terminal??{toolInput:{by:1},toolStatus:'running'}})}}return request(session,method,params,...rest)};
 const service=await createMcpAppHostService(f.options),page=await browser.newPage();try{
  const view=await service.open(reference);await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#status').filter({hasText:'Ready'}).waitFor();
  const result={content:[{type:'text',text:'Final Unicode è 🌞'}],structuredContent:{count:47},_meta:{lossless:{value:'retained'}}};terminal={toolInput:{by:1},toolResult:result,toolStatus:'completed'};
  await app.locator('#count').filter({hasText:'47'}).waitFor();await page.waitForTimeout(2200);
  const events=await app.locator('body').evaluate(()=>window.displayEvents);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-input').length,1);
  const finals=events.filter(event=>event.method==='ui/notifications/tool-result');assert.equal(finals.length,1);assert.deepEqual(finals[0].params,result);assert.equal(events.some(event=>event.method==='ui/notifications/tool-cancelled'),false);
  assert.equal(receipts.at(-1),true);assert.equal(receipts.includes(false),true);
 }finally{await page.close();await service.shutdown()}
});

test('delayed cancellation is delivered once and late results cannot replace it',async()=>{
 const f=backend(),open=f.options.openSession,receipts=[];let display={toolInput:{by:1},toolStatus:'running'};
 f.options.openSession=async()=>{const value=await open();delete value.toolResult;value.toolStatus='running';value.resource.contents[0].text=observeDisplay(value.resource.contents[0].text);return value};
 f.options.requestSession=async(_session,method,params)=>{if(method==='authorize'){receipts.push(params.display_received);return{authorized:true,...(params.display_received===true?{}:{display})}}return{}};
 const service=await createMcpAppHostService(f.options),page=await browser.newPage();try{
  const view=await service.open(reference);await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#status').filter({hasText:'Ready'}).waitFor();
  display={toolInput:{by:1},toolCancelled:true,toolStatus:'cancelled'};await app.locator('#status').filter({hasText:'Cancelled'}).waitFor();
  display={toolInput:{by:1},toolResult:{content:[],structuredContent:{count:99}},toolStatus:'completed'};await page.waitForTimeout(2200);
  const events=await app.locator('body').evaluate(()=>window.displayEvents);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-input').length,1);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-cancelled').length,1);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-result').length,0);assert.equal(receipts.at(-1),true);
 }finally{await page.close();await service.shutdown()}
});

test('bootstrap completed and cancelled displays are buffered until controller exists and acknowledged',async()=>{
 for(const cancelled of [false,true]){
  const f=backend(),open=f.options.openSession,receipts=[];
  f.options.openSession=async()=>{const value=await open();value.resource.contents[0].text=observeDisplay(value.resource.contents[0].text);value.toolStatus=cancelled?'cancelled':'completed';if(cancelled){delete value.toolResult;value.toolCancelled=true}return value};
  f.options.requestSession=async(_session,method,params)=>{if(method==='authorize')receipts.push(params.display_received);return{authorized:true}};
  const service=await createMcpAppHostService(f.options),page=await browser.newPage();try{
   const view=await service.open(reference),data=await(await fetch(view.url+'/data')).json();assert.equal(data.toolCancelled,cancelled?true:undefined);
   await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#status').filter({hasText:cancelled?'Cancelled':'Result received'}).waitFor();await page.waitForTimeout(100);
   const events=await app.locator('body').evaluate(()=>window.displayEvents);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-input').length,1);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-result').length,cancelled?0:1);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-cancelled').length,cancelled?1:0);assert.equal(receipts.at(-1),true);
  }finally{await page.close();await service.shutdown()}
 }
});


test('result-only and cancellation-only bootstrap delivers one terminal without inventing arguments',async()=>{
 for(const cancelled of [false,true]){
  const f=backend(),open=f.options.openSession;
  f.options.openSession=async()=>{const value=await open();delete value.toolInput;value.resource.contents[0].text=observeDisplay(value.resource.contents[0].text);if(cancelled){delete value.toolResult;value.toolCancelled=true}return value};
  const service=await createMcpAppHostService(f.options),page=await browser.newPage();try{
   const view=await service.open(reference);await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#status').filter({hasText:cancelled?'Cancelled':'Result received'}).waitFor();
   const events=await app.locator('body').evaluate(()=>window.displayEvents);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-input').length,0);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-result').length,cancelled?0:1);assert.equal(events.filter(event=>event.method==='ui/notifications/tool-cancelled').length,cancelled?1:0);
  }finally{await page.close();await service.shutdown()}
 }
});
