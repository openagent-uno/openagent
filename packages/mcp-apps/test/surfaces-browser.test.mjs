/** Actual adopter web components bundled from their source, with real React and the shared two-origin service. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createMcpAppHostService} from '../src/desktop.mjs';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {chromium}=require('playwright'),{build}=require('esbuild');
const universal=new URL('../../../apps/app/universal/',import.meta.url).pathname;
const sourceRoot=process.env.OPENAGENT_TEST_PRODUCTS_ROOT;
const html=await fs.readFile(new URL('../fixtures/counter.html',import.meta.url),'utf8');
const products=[{name:'standalone',root:universal,bridge:'desktop'},
 {name:'glasspalace',root:sourceRoot&&path.join(sourceRoot,'GlassPalace/client/universal'),bridge:'glasspalaceDesktop'},
 {name:'ics',root:sourceRoot&&path.join(sourceRoot,'ICS/client/universal'),bridge:'icsDesktop'}];
for(const product of products)test('actual '+product.name+' interactive surface opens, closes and fences stale account/session results',{skip:!product.root,timeout:30000},async()=>{
 const request={sessionId:'session-a',toolRef:'opaque-ref',toolCallId:'invocation-id',agentId:'agent-a',workspaceId:'workspace-a',accountId:'account-a'};
 const entry=`import React from 'react';import{createRoot}from'react-dom/client';import Surface from ${JSON.stringify(path.join(product.root,'components/McpAppSurface.web.tsx'))};
 const root=createRoot(document.getElementById('root'));const post=async(route,value)=>{const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error('fixture unavailable');return response.json()};
 window[${JSON.stringify(product.bridge)}]={mcpApps:{open:request=>post('/open',request),close:viewId=>post('/close',{viewId})}};
 window.renderMcp=(request,scopeKey='account-a')=>root.render(React.createElement(Surface,{request,scopeKey}));window.renderMcp(${JSON.stringify(request)});`;
 const bundle=await build({stdin:{contents:entry,resolveDir:universal,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"','__DEV__':'false'},alias:{'react':path.join(universal,'node_modules/react'),'react-dom':path.join(universal,'node_modules/react-dom'),'react-native':path.join(universal,'node_modules/react-native-web')},nodePaths:[path.join(universal,'node_modules')],logLevel:'silent'});
 let service,browser,release,delayed=false,count=0,opened=[],closed=[];
 const server=http.createServer(async(req,res)=>{try{
  if(req.url==='/bundle.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(bundle.outputFiles[0].contents);return}
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');return}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  if(req.url==='/open'){opened.push(body);const view=await service.open(body);if(delayed)await new Promise(resolve=>{release=resolve});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(view));return}
  if(req.url==='/close'){await service.close(body.viewId);res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return}
 }catch{res.writeHead(500);res.end('{}')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  service=await createMcpAppHostService({assetRoot:new URL('../src/',import.meta.url).pathname,parentOrigins:[origin],currentOwner:async()=>product.name+'/owner',
   openSession:async reference=>({handle:'handle-'+opened.length,binding:{sourceId:'exact',toolRef:reference.toolRef,contextId:'exact-context',capabilityEpoch:'epoch'},tool:{name:'counter',_meta:{ui:{resourceUri:'ui://counter'}}},resource:{contents:[{uri:'ui://counter',mimeType:'text/html;profile=mcp-app',text:html}]},toolInput:{},toolResult:{content:[],structuredContent:{count:0}}}),
   requestSession:async(_session,method)=>method==='authorize'?{authorized:true}:method==='tools/call'?{content:[],structuredContent:{count:++count}}:{},closeSession:async session=>{closed.push(session.handle)}});
  browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});const page=await browser.newPage();await page.goto(origin);
  await page.getByRole('button',{name:'Open interactive view'}).click();const app=page.frameLocator('iframe').frameLocator('iframe').frameLocator('iframe');await app.locator('#increment').click();await app.locator('#count').filter({hasText:'1'}).waitFor();assert.deepEqual(opened[0],request);
  await page.getByRole('button',{name:'Close interactive view'}).click();await page.locator('iframe').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Open interactive view'}).click();await app.locator('#increment').waitFor();await page.evaluate(request=>window.renderMcp({...request,sessionId:'session-b'},'other-account'),request);await page.locator('iframe').waitFor({state:'detached'});assert.equal(opened.length,2);
  delayed=true;await page.getByRole('button',{name:'Open interactive view'}).click();await new Promise(resolve=>setTimeout(resolve,50));await page.evaluate(request=>window.renderMcp({...request,sessionId:'session-c'},'third-account'),request);for(let i=0;!release&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(release);release();
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await page.locator('iframe').count(),0);assert.equal(opened.length,3);assert.ok(closed.includes('handle-3'));
 }finally{release?.();await browser?.close();await service?.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
