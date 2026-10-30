import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {startProductAdapter} from './product-adapter.mjs';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {chromium}=require('playwright');
const runtimeRoot=process.env.OPENAGENT_TEST_RUNTIME_ROOT;
const python=process.env.OPENAGENT_TEST_PYTHON;
const product=process.env.OPENAGENT_TEST_PRODUCT;
const enabled=runtimeRoot&&python&&['glasspalace','ics','standalone'].includes(product);

test('real adopter HTTP + Core exact-source MCP stdio + loopback host + Chromium app', {skip:!enabled,timeout:45000},async()=>{
 const peer=spawn(python,[new URL('./runtime_fixture.py',import.meta.url).pathname,runtimeRoot,product,new URL('../fixtures/counter.html',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
 let errors='';peer.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-12000)});
 const lines=createInterface({input:peer.stdout});const queue=[],waiters=[];lines.on('line',line=>{try{const value=JSON.parse(line);const waiter=waiters.shift();waiter?waiter.resolve(value):queue.push(value)}catch{}});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Runtime fixture timed out: '+errors)),20000);waiters.push({resolve:value=>{clearTimeout(timer);resolve(value)}})});
 const info=await next();let service,browser,lastRpc;
 try{
  assert.ok(info.origin,errors);
  async function request(path,body,signal){const response=await fetch(info.origin+path,{method:'POST',headers:{...info.headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal});const value=await response.json();if(!response.ok)throw Error(value.error);return value}
  service=await startProductAdapter({product,root:runtimeRoot,apiRequest:(operation,body)=>request(info.prefix+'/'+operation,body)});
  const view=await service.open({toolRef:info.toolRef,sessionId:'session-alice',workspaceId:'workspace-1',agentId:'agent-1'});
  browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});
  const page=await browser.newPage();await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');await app.locator('#increment').click();await app.locator('#count').filter({hasText:'1'}).waitFor({timeout:5000}).catch(async error=>{throw Error(error.message+'\nRPC '+JSON.stringify(lastRpc)+'\nSTATUS '+await app.locator('#status').textContent())});
  await app.locator('#increment').click();await app.locator('#count').filter({hasText:'2'}).waitFor();
  const frame=page.frames().find(frame=>frame.url()==='about:srcdoc');const denied=await frame.evaluate(()=>request('tools/call',{name:'private_model',arguments:{}}).then(()=>false,()=>true));assert.equal(denied,true);
  peer.stdin.write(JSON.stringify({action:'revoke'})+'\n');assert.equal((await next()).ack,'revoke');await page.locator('#status').filter({hasText:'no longer available'}).waitFor();assert.equal(await page.locator('iframe').count(),0);
 }finally{
  await browser?.close();await service?.shutdown();peer.stdin.write(JSON.stringify({action:'shutdown'})+'\n');peer.stdin.end();await new Promise(resolve=>{if(peer.exitCode!==null)return resolve();const timer=setTimeout(()=>{peer.kill('SIGKILL');resolve()},3000);peer.once('exit',()=>{clearTimeout(timer);resolve()})});lines.close();
 }
});
