import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildSandboxProxyHtml, SANDBOX_PROXY_HEADERS } from '../src/sandbox.mjs';
const require = createRequire(new URL('../../../apps/app/desktop/package.json', import.meta.url));
const { chromium } = require('playwright');
const fixtureHtml = await fs.readFile(new URL('../fixtures/counter.html',import.meta.url),'utf8');
let browser, host, proxy, network, hostOrigin, proxyOrigin, networkOrigin;
const state={allowed:true,epoch:'epoch-1',count:0,calls:[],messages:[],contexts:[],networkHits:0,opens:[]};
const binding={sourceId:'source-a',toolRef:'origin-tool',contextId:'context-a',capabilityEpoch:'epoch-1'};
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
async function body(req){let data='';for await(const part of req)data+=part;if(data.length>1024*1024)throw Error('too large');return JSON.parse(data||'{}');}
async function start(handler){const server=http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>json(res,500,{error:'fixture_error'}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server;}
const origin=server=>`http://127.0.0.1:${server.address().port}`;
function allowed(value){return state.allowed&&JSON.stringify(value)===JSON.stringify({...binding,capabilityEpoch:state.epoch});}
before(async()=>{
 network=await start((req,res)=>{state.networkHits++;if(req.url.endsWith('/relative-script.js')){res.writeHead(200,{'Content-Type':'text/javascript'});res.end('document.body.dataset.relativeLoaded="yes"');return}res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end('{"network":"approved"}');});networkOrigin=origin(network);
 proxy=await start((req,res)=>{res.writeHead(200,SANDBOX_PROXY_HEADERS);res.end(buildSandboxProxyHtml());});proxyOrigin=origin(proxy);
 host=await start(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/authorize'){const input=await body(req);json(res,200,{allowed:allowed(input.binding)});return;}
  if(url.pathname==='/rpc'){
   const input=await body(req);if(!allowed(input.binding)){json(res,403,{error:'revoked'});return;}
   if(input.method==='tools/call'){
    if(input.params.name==='slow_read')await new Promise(resolve=>setTimeout(resolve,150));
    if(input.params.name!=='increment'&&input.params.name!=='slow_read'){json(res,403,{error:'wrong_source_tool'});return;}
    state.calls.push(input);if(input.params.name==='increment')state.count+=input.params.arguments.by;
    json(res,200,{content:[{type:'text',text:String(state.count)}],structuredContent:{count:state.count},_meta:{ui:{revision:state.count}}});return;
   }
   if(input.method==='ui/message')state.messages.push(input);else if(input.method==='ui/update-model-context')state.contexts.push(input);else if(input.method==='ui/open-link')state.opens.push(input);
   json(res,200,{});return;
  }
  if(url.pathname.startsWith('/src/')){
   const name=url.pathname.slice(5);if(!['index.mjs','protocol.mjs','sandbox.mjs'].includes(name)){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await fs.readFile(new URL('../src/'+name,import.meta.url),'utf8'));return;
  }
  if(url.pathname==='/secret'){state.networkHits++;res.writeHead(200);res.end('must never reach this endpoint');return;}
  const approved=url.searchParams.has('approved'),approvedFrames=url.searchParams.has('approvedFrames');
  const resource={uri:'ui://counter',mimeType:'text/html;profile=mcp-app',html:fixtureHtml,_meta:{ui:{csp:{connectDomains:[networkOrigin],frameDomains:[networkOrigin]}}}};
  const html=`<!doctype html><html><body><main id="app"></main><script type="module">
import{mountMcpApp}from'/src/index.mjs';window.nativeSecret='must-not-be-readable';window.nativeBridge={shell(){throw Error('privileged')}};
const binding=${JSON.stringify(binding)};
async function post(route,body,signal){const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});if(!response.ok)throw Error('broker_denied');return response.json()}
const broker={authorize:async(binding,operation,signal)=>(await post('/authorize',{binding,operation},signal)).allowed,
 callTool:(binding,params,signal)=>post('/rpc',{binding,method:'tools/call',params},signal),
 readResource:async()=>({contents:[]}),openLink:(binding,params,signal)=>post('/rpc',{binding,method:'ui/open-link',params},signal),
 sendMessage:(binding,params,signal)=>post('/rpc',{binding,method:'ui/message',params},signal),updateContext:(binding,params,signal)=>post('/rpc',{binding,method:'ui/update-model-context',params},signal)};
window.controller=await mountMcpApp({container:document.querySelector('#app'),sandboxUrl:${JSON.stringify(proxyOrigin+'/sandbox')},resource:${JSON.stringify(resource).replaceAll('<', '\\u003c')},binding,broker,approvedCsp:${JSON.stringify({...(approved?{connectDomains:[networkOrigin]}:{}),...(approvedFrames?{frameDomains:[networkOrigin]}:{})})},toolInput:{by:0},toolResult:{content:[{type:'text',text:'0'}],structuredContent:{count:0}}});window.mounted=true;
</script></body></html>`;
  res.writeHead(200,{'Content-Type':'text/html'});res.end(html);
 });hostOrigin=origin(host);
 browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});
});
after(async()=>{await browser?.close();for(const server of [host,proxy,network]){server?.closeAllConnections();await new Promise(resolve=>server?.close(resolve));}});
async function page(approved=false,approvedFrames=false){state.allowed=true;state.epoch='epoch-1';state.count=0;state.calls=[];state.messages=[];state.contexts=[];state.opens=[];state.networkHits=0;const page=await browser.newPage();page.setDefaultTimeout(10000);await page.goto(hostOrigin+'/?'+new URLSearchParams({...(approved?{approved:'1'}:{}),...(approvedFrames?{approvedFrames:'1'}:{})}));await page.waitForFunction(()=>window.mounted===true);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#increment').waitFor();await page.waitForFunction(()=>window.controller.session.state==='ready');const guest=await(await app.locator('body').elementHandle()).ownerFrame();return{page,app,frame:()=>guest};}

test('real double-iframe renders fixture, receives result, calls tool, resizes, messages and context',async()=>{
 const f=await page();try{
  await f.app.locator('#increment').click();await assert.doesNotReject(()=>f.app.locator('#count').filter({hasText:'1'}).waitFor());
  assert.equal(state.calls.length,1);assert.deepEqual(state.calls[0].binding,binding);
  await f.app.locator('#message').click();await f.app.locator('#status').filter({hasText:'Message requested'}).waitFor();assert.equal(state.messages.length,1);
  await f.app.locator('#context').click();await f.app.locator('#status').filter({hasText:'Context updated'}).waitFor();assert.equal(state.contexts.length,1);
  assert.equal(await f.page.locator('#app>iframe').evaluate(element=>element.style.height),'240px');
 }finally{await f.page.close();}
});

test('untrusted HTML cannot read parent privileges or storage; CSP blocks undeclared networks and nested frames',async()=>{
 const f=await page();try{
  const security=await f.frame().evaluate(async host=>{
   let parentAccess,storage;try{parentAccess=parent.parent.nativeSecret;}catch{parentAccess='blocked';}try{localStorage.getItem('secret');storage='allowed';}catch{storage='blocked';}
   const network=await fetch(host+'/secret').then(()=>true,()=>false);
   const nested=document.createElement('iframe');nested.src=host+'/secret';document.body.append(nested);
   return{parentAccess,storage,network,native:typeof window.nativeBridge};
  },hostOrigin);
  assert.deepEqual(security,{parentAccess:'blocked',storage:'blocked',network:false,native:'undefined'});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(state.networkHits,0);
 }finally{await f.page.close();}
});

test('requested external network is denied unless exact host policy approves it',async()=>{
 const denied=await page();try{assert.equal(await denied.frame().evaluate(origin=>fetch(origin+'/data').then(()=>true,()=>false),networkOrigin),false);assert.equal(state.networkHits,0);}finally{await denied.page.close();}
 const approved=await page(true);try{assert.equal(await approved.frame().evaluate(origin=>fetch(origin+'/data').then(response=>response.json()).then(value=>value.network),networkOrigin),'approved');assert.equal(state.networkHits,1);}finally{await approved.page.close();}
});

test('wrong source window and wrong origin cannot inject requests or replace sandbox content',async()=>{
 const f=await page();try{
  await f.page.evaluate(()=>{
   const data={jsonrpc:'2.0',id:999,method:'tools/call',params:{name:'increment',arguments:{by:50}}};
   window.postMessage(data,location.origin);
   window.dispatchEvent(new MessageEvent('message',{source:window.controller.iframe.contentWindow,origin:'https://wrong.example',data}));
  });
  await f.frame().evaluate(()=>parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html:'<script>parent.parent.nativeBridge.shell()<\/script>'}},'*'));
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(state.calls.length,0);assert.equal(await f.app.locator('#count').textContent(),'0');
 }finally{await f.page.close();}
});

test('source identity stays bound and dangerous links/unknown tool names are rejected',async()=>{
 const f=await page();try{
  const result=await f.frame().evaluate(async()=>{
   const denied=await request('tools/call',{name:'other_source_tool',arguments:{},sourceId:'other',toolRef:'other'}).then(()=>false,()=>true);
   const link=await request('ui/open-link',{url:'javascript:alert(1)'}).then(()=>false,()=>true);
   const ok=await request('tools/call',{name:'increment',arguments:{by:1},sourceId:'other',toolRef:'other'});
   return{denied,link,count:ok.structuredContent.count};
  });
  assert.deepEqual(result,{denied:true,link:true,count:1});assert.equal(state.opens.length,0);assert.deepEqual(state.calls[0].binding,binding);
 }finally{await f.page.close();}
});

test('revocation and epoch replacement suppress late results and remove the app',async()=>{
 const f=await page();try{
  await f.frame().evaluate(()=>{window.pendingRead=request('tools/call',{name:'slow_read',arguments:{}}).catch(()=>{});});
  state.allowed=false;
  await f.page.locator('#app>iframe').waitFor({state:'detached'});
  assert.equal(await f.page.evaluate(()=>window.controller.session.state),'closed');
 }finally{await f.page.close();}
 const epoch=await page();try{
  state.epoch='epoch-2';await epoch.page.evaluate(()=>window.controller.setToolResult({content:[{type:'text',text:'must not publish'}]}));
  assert.equal(await epoch.page.locator('#app>iframe').count(),0);
 }finally{await epoch.page.close();}
});

test('cancel updates visible tool state and disposal removes the frame',async()=>{
 const f=await page();try{
  await f.page.evaluate(()=>window.controller.cancel('Stopped by fixture'));await f.app.locator('#status').filter({hasText:'Cancelled'}).waitFor();
  await f.page.evaluate(()=>window.controller.dispose());assert.equal(await f.page.locator('#app>iframe').count(),0);
 }finally{await f.page.close();}
});


test('even an explicit CSP approval cannot expose the product or proxy origin',async()=>{
 const f=await page();try{
  for(const origin of [hostOrigin,proxyOrigin]){
   const denied=await f.page.evaluate(async origin=>{
    const {mountMcpApp}=await import('/src/index.mjs');
    try{await mountMcpApp({container:document.querySelector('#app'),sandboxUrl:window.controller.iframe.src,resource:{uri:'ui://other',mimeType:'text/html;profile=mcp-app',html:'<html></html>',_meta:{ui:{csp:{connectDomains:[origin]}}}},approvedCsp:{connectDomains:[origin]},binding:{sourceId:'a',toolRef:'b',contextId:'c',capabilityEpoch:'d'},broker:{authorize:async()=>true}});return false;}catch(error){return error.code==='privileged_origin_in_csp';}
   },origin);
   assert.equal(denied,true);
  }
 }finally{await f.page.close();}
});


test('proxy frame policy blocks guest self-navigation before any request reaches the network',async()=>{
 const f=await page();try{
  await f.frame().evaluate(url=>{location.href=url},networkOrigin+'/navigation-leak?secret=owned-fixture');
  await f.page.waitForTimeout(150);
  assert.equal(state.networkHits,0); // Chromium may replace the document with its blocked-navigation page.
 }finally{await f.page.close()}
});

test('explicit approved frame domain permits guest navigation while undeclared destinations remain blocked',async()=>{
 const f=await page(false,true);try{
  const response=f.page.waitForResponse(value=>value.url()===networkOrigin+'/approved-navigation');
  await f.frame().evaluate(url=>{location.href=url},networkOrigin+'/approved-navigation').catch(error=>{if(!/context.*destroyed|navigation/i.test(error.message))throw error});
  await response;assert.equal(state.networkHits,1);
 }finally{await f.page.close()}
});


test('approved base URI resolves relative scripts; denied base never reaches that network origin',async()=>{
 for(const approved of [false,true]){
  const f=await page();try{
   await f.page.evaluate(async({networkOrigin,proxyOrigin,approved})=>{
    const {mountMcpApp}=await import('/src/index.mjs');const broker=window.controller.session.broker,binding=window.controller.session.binding;
    await window.controller.dispose();
    const csp={resourceDomains:[networkOrigin],baseUriDomains:[networkOrigin]};
    window.controller=await mountMcpApp({container:document.querySelector('#app'),sandboxUrl:proxyOrigin+'/sandbox',
      resource:{uri:'ui://base-fixture',mimeType:'text/html;profile=mcp-app',html:'<base href="'+networkOrigin+'/owned/"><p>Base fixture</p><script src="relative-script.js"><\/script>',_meta:{ui:{csp}}},
      approvedCsp:{resourceDomains:[networkOrigin],baseUriDomains:approved?[networkOrigin]:[]},binding,broker,toolInput:{}});
   },{networkOrigin,proxyOrigin,approved});
   const app=f.page.frameLocator('iframe').frameLocator('iframe');await app.getByText('Base fixture').waitFor();
   if(approved)await app.locator('body[data-relative-loaded="yes"]').waitFor();else await f.page.waitForTimeout(150);
   assert.equal(state.networkHits,approved?1:0);
   assert.equal(await app.locator('body').evaluate((_element,origin)=>document.baseURI.startsWith(origin),networkOrigin),approved);
  }finally{await f.page.close()}
 }
});
