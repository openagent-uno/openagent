/** Real canonical client socket/resource chain; only certificate/renderer ingress is owned. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProductAdapter} from './product-adapter.mjs';
const root=new URL('../../../',import.meta.url).pathname;
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {chromium}=require('playwright');
const python=process.env.OPENAGENT_TEST_PYTHON;
const enabled=python&&process.env.OPENAGENT_TEST_CANONICAL_CLIENT_RESOURCES==='1';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('actual canonical client MCP resource -> WebSocket -> API -> hostservice -> Chromium',{skip:!enabled,timeout:90000},async()=>{
 const {CapabilitySocket}=require('../../../apps/app/desktop/dist/capabilities/capability-socket.js');
 const {LocalHostBridge}=require('../../../apps/app/desktop/dist/capabilities/host-bridge.js');
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'openagent-canonical-client-resource-'));
 const peer=spawn(python,[new URL('./canonical_resource_fixture.py',import.meta.url).pathname,temporary],{stdio:['pipe','pipe','pipe'],env:{...process.env}});
 const lines=createInterface({input:peer.stdout});const queue=[],waiters=[];let errors='',exit;
 peer.stderr.on('data',chunk=>errors=(errors+chunk).slice(-16000));peer.once('exit',(code,signal)=>{exit={code,signal};for(const waiter of waiters.splice(0))waiter.reject(Error('Fixture exited '+JSON.stringify(exit)+' '+errors))});
 lines.on('line',line=>{try{const value=JSON.parse(line),waiter=waiters.shift();waiter?waiter.resolve(value):queue.push(value)}catch{}});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{
  if(exit){reject(Error('Fixture already exited '+JSON.stringify(exit)+' '+errors));return}
  const timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(Error('Canonical fixture timeout '+errors))},20000);
  const waiter={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};waiters.push(waiter);
 });
 const command=async action=>{peer.stdin.write(JSON.stringify({action})+'\n');const value=await next();assert.equal(value.ack,action);assert.equal(value.error,undefined);return value};
 let bridge,socket,service,browser;
 try{
  const info=await next();assert.ok(info.origin,errors);
  await fs.writeFile(path.join(info.hostHome,'owned-mcp-app-fixture'),'owned canonical client fixture');
  const principal={kind:'desktop',client_instance_id:info.instance,network_id:info.network,account_id:info.network,device_id:info.device,generation:4};
  bridge=new LocalHostBridge({launch:{command:python,args:[new URL('./fixtures/direct_app_host.py',import.meta.url).pathname,info.hostHome],source:'development',env:{...process.env,OPENAGENT_HOST_TOOLS_HOME:info.hostHome}},principal});
  await bridge.start();await bridge.setConsent(true);const catalog=await bridge.catalog();const servers=catalog.servers.filter(server=>['alpha','beta'].includes(server.name));
  assert.equal(servers.length,2);assert.ok(servers.every(server=>server.resource_protocol==='mcp-app-resources/1'));
  const routed=[];
  socket=new CapabilitySocket({accountId:'fixture-account',trustedAccountId:info.network,trustedDeviceId:info.device,url:info.origin.replace(/^http/,'ws')+'/capabilities',clientInstanceId:info.instance,deviceLabel:'Owned canonical fixture',getOffer:()=>({generation:4,servers}),reconnect:false,
   invoke:async(call,signal)=>{routed.push({kind:'tool',server:call.server,name:call.tool});return bridge.call({callId:call.call_id,server:call.server,tool:call.tool,toolArgs:call.args,idempotencyKey:call.idempotency_key,argumentsSha256:call.arguments_sha256,deadlineMs:call.deadline_ms,principal,signal})},
   readResource:async(call,signal)=>{routed.push({kind:'resource',server:call.server,uri:call.uri});return bridge.readResource({callId:call.call_id,server:call.server,uri:call.uri,deadlineMs:call.deadline_ms,principal,signal})},
  });socket.start();
  for(let attempt=0;!socket.isAcknowledged&&attempt<300;attempt++)await delay(20);assert.equal(socket.isAcknowledged,true,errors);
  const refs=(await command('tools')).tools;assert.ok(refs.alpha&&refs.beta);assert.notEqual(refs.alpha,refs.beta);
  const api=async(operation,body,actualHeaders={},override)=>{
   const headers={Authorization:info.headers.Authorization,'X-OpenAgent-Client-Instance':override??actualHeaders['x-openagent-client-instance']??info.instance,'Content-Type':'application/json'};
   const response=await fetch(info.origin+'/api/sessions/'+info.session+'/mcp-apps/'+operation,{method:'POST',headers,body:JSON.stringify(body)});
   if(!response.ok)throw Error('actual_gateway_status_'+response.status+' '+await response.text());return response.json();
  };
  service=await startProductAdapter({product:'standalone',root,clientInstanceId:info.instance,apiRequest:api});
  const view=await service.open({sessionId:info.session,toolRef:refs.alpha});
  browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});
  const page=await browser.newPage();await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');
  await app.locator('body[data-fixture-source="alpha"]').waitFor();
  await app.locator('#increment').click();await app.locator('#count').filter({hasText:'1'}).waitFor({timeout:5000}).catch(async error=>{throw Error(error.message+' STATUS '+await app.locator('#status').textContent()+' ROUTED '+JSON.stringify(routed)+' FIXTURE '+errors)});
  await app.locator('#increment').click();await app.locator('#count').filter({hasText:'2'}).waitFor();
  assert.equal(await app.locator('body').evaluate(()=>request('tools/call',{name:'beta_only',arguments:{}}).then(()=>false,()=>true)),true);
  assert.equal(routed.filter(row=>row.kind==='tool').every(row=>row.server==='alpha'),true);
  await assert.rejects(api('open',{tool_ref:refs.alpha},{},'wrong-instance'),/actual_gateway_status_/);
  const stats=await command('stats');assert.equal(stats.alpha.filter(row=>row.kind==='increment').length,2);assert.equal(stats.beta.filter(row=>row.kind==='increment'||row.kind==='beta_only').length,0);
  // Actual resource cancellation travels through registry -> socket -> facade -> SDK.
  await command('hold');await command('begin_read');let resourceCount=stats.alpha.filter(row=>row.kind==='resource').length;
  for(let attempt=0;attempt<100;attempt++){const current=await command('stats');if(current.alpha.filter(row=>row.kind==='resource').length>resourceCount)break;await delay(20)}
  await command('cancel_read');await delay(100);const after=await command('stats');assert.equal(after.alpha.filter(row=>row.kind==='resource').length,resourceCount+1);
  await command('revoke');await page.locator('#status').filter({hasText:'no longer available'}).waitFor();assert.equal(await page.locator('iframe').count(),0);
 }finally{
  await browser?.close();await service?.shutdown();socket?.stop();await bridge?.hardStop();
  if(peer.exitCode===null&&peer.signalCode===null){peer.stdin.write('{"action":"shutdown"}\n');peer.stdin.end();await Promise.race([new Promise(resolve=>peer.once('exit',resolve)),delay(3000)]);if(peer.exitCode===null&&peer.signalCode===null){peer.kill('SIGKILL');await new Promise(resolve=>peer.once('exit',resolve))}}
  lines.close();await fs.rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
