/** Real Computers desktop MCP executor + adopter catalog/API + actual Chromium app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startProductAdapter} from './product-adapter.mjs';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {chromium}=require('playwright');
const python=process.env.OPENAGENT_TEST_PYTHON,repo=process.env.OPENAGENT_TEST_RUNTIME_ROOT,product=process.env.OPENAGENT_TEST_PRODUCT;
const enabled=python&&repo&&['glasspalace','ics'].includes(product)&&process.env.OPENAGENT_TEST_COMPUTER_CLIENT_RESOURCES==='1';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('actual ComputerMcpTools -> facade -> two stdio peers -> adopter HTTP -> product adapter -> Chromium',{skip:!enabled,timeout:90000},async()=>{
 const {ComputerMcpTools}=require(path.join(repo,'client/desktop/dist/computer-mcp-tools.js'));
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'openagent-computer-mcp-app-'));
 await fs.writeFile(path.join(temporary,'owned-mcp-app-fixture'),'owned computer fixture');
 const tools=new ComputerMcpTools({command:python,args:[new URL('./fixtures/direct_app_host.py',import.meta.url).pathname,temporary],source:'development',env:{...process.env,OPENAGENT_HOST_TOOLS_HOME:temporary}});
 const secret=randomBytes(32).toString('hex');const routed=[];
 const computer=http.createServer(async(request,response)=>{
  try{
   if(request.method!=='POST'||request.headers.authorization!=='Bearer '+secret)throw Error('invalid_owned_ingress');
   let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>2*1024*1024)throw Error('too_large')}
   const {method,params,actor,session}=JSON.parse(raw);
   if(!['alice','bob'].includes(actor)||session!=='session-'+actor)throw Error('invalid_trusted_context');
   const context={workspaceId:'workspace-1',computerId:'computer-1',generation:4,actorUserId:actor,sessionId:session,sharedMcpServers:['alpha','beta']};
   const current=selector=>selector.computerId==='computer-1'&&selector.generation===4;
   let args;
   if(method==='openagent/computers/mcp/catalog'){
    if(Object.keys(params).length&&!current(params))throw Error('stale_computer');
    args={operation:'catalog',...(params.server?{server:params.server}:{})};
   }else if(method==='openagent/computers/mcp/call'){
    if(!current(params))throw Error('stale_computer');args={operation:'call',server:params.server,name:params.name,arguments:params.arguments,catalog_digest:params.catalog_digest};
   }else if(method==='resources/read'){
    const meta=params._meta;if(!meta||meta['openagent/computerId']!=='computer-1'||meta['openagent/generation']!==4)throw Error('stale_computer');
    args={operation:'read_resource',server:meta['openagent/server'],uri:params.uri,catalog_digest:meta['openagent/catalogDigest']};
   }else throw Error('unsupported_method');
   routed.push({method,server:args.server,actor,session,name:args.name});
   let result=await tools.invoke(args,context);
   if(method==='openagent/computers/mcp/catalog')result={...result,servers:result.servers.map(row=>({...row,computerId:'computer-1',generation:4})),unavailable:[],truncated:false};
   response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
  }catch(error){response.writeHead(403,{'Content-Type':'application/json'});response.end(JSON.stringify({error:String(error.message)}))}
 });
 await new Promise(resolve=>computer.listen(0,'127.0.0.1',resolve));
 const peer=spawn(python,[new URL('./computer_runtime_fixture.py',import.meta.url).pathname,repo,product,'http://127.0.0.1:'+computer.address().port,secret,temporary],{stdio:['pipe','pipe','pipe'],env:{...process.env}});
 const lines=createInterface({input:peer.stdout});const queue=[],waiters=[];let errors='',exit;
 peer.stderr.on('data',chunk=>errors=(errors+chunk).slice(-16000));peer.once('exit',(code,signal)=>{exit={code,signal};for(const waiter of waiters.splice(0))waiter.reject(Error('Fixture exited '+JSON.stringify(exit)+' '+errors))});
 lines.on('line',line=>{try{const value=JSON.parse(line),waiter=waiters.shift();waiter?waiter.resolve(value):queue.push(value)}catch{}});
 const next=()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{if(exit)return reject(Error('Fixture exited '+JSON.stringify(exit)+' '+errors));const timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(Error('Fixture timeout '+errors))},20000);const waiter={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}};waiters.push(waiter)});
 const command=async action=>{peer.stdin.write(JSON.stringify({action})+'\n');const value=await next();assert.equal(value.ack,action);return value};
 let service,browser;
 try{
  const info=await next();assert.ok(info.origin,errors);
  const apiRequest=async(operation,body)=>{const response=await fetch(info.origin+info.prefix+'/'+operation,{method:'POST',headers:{...info.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error('actual_gateway_'+response.status+' '+await response.text());return response.json()};
  service=await startProductAdapter({product,root:repo,apiRequest});
  const view=await service.open({sessionId:'session-alice',workspaceId:'workspace-1',agentId:'agent-1',toolRef:info.toolRef,toolCallId:info.toolCallId});
  browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});
  const page=await browser.newPage();await page.goto(view.url);const app=page.frameLocator('iframe').frameLocator('iframe');
  await app.locator('body[data-fixture-source="alpha"]').waitFor();
  await app.locator('#increment').click();await app.locator('#count').filter({hasText:'1'}).waitFor({timeout:5000}).catch(async error=>{throw Error(error.message+' STATUS '+await app.locator('#status').textContent()+' ROUTED '+JSON.stringify(routed)+' FIXTURE '+errors)});
  await app.locator('#increment').click();await app.locator('#count').filter({hasText:'2'}).waitFor();
  assert.equal(await app.locator('body').evaluate(()=>request('tools/call',{name:'beta_only',arguments:{}}).then(()=>false,()=>true)),true);
  const stats=await command('stats');assert.equal(stats.alpha.filter(row=>row.kind==='increment').length,2);assert.equal(stats.beta.filter(row=>row.kind==='increment'||row.kind==='beta_only').length,0);
  assert.equal(routed.filter(row=>row.method==='resources/read').every(row=>row.server==='alpha'),true);
  assert.equal(routed.filter(row=>row.method==='openagent/computers/mcp/call').every(row=>row.server==='alpha'),true);
  await command('revoke');await page.locator('#status').filter({hasText:'no longer available'}).waitFor();assert.equal(await page.locator('iframe').count(),0);
 }finally{
  await browser?.close();await service?.shutdown();
  if(peer.exitCode===null&&peer.signalCode===null){peer.stdin.write('{"action":"shutdown"}\n');peer.stdin.end();await Promise.race([new Promise(resolve=>peer.once('exit',resolve)),delay(3000)]);if(peer.exitCode===null&&peer.signalCode===null){peer.kill('SIGKILL');await new Promise(resolve=>peer.once('exit',resolve))}}
  lines.close();await tools.close();computer.closeAllConnections();await new Promise(resolve=>computer.close(resolve));
  // Retained per-peer PID files originate in this owned home. Child close must
  // finish before its fixture home disappears; never discover/kill user brokers.
  for(const name of ['alpha','beta']){let pid;try{pid=Number(await fs.readFile(path.join(temporary,'peers',name+'.pid'),'utf8'))}catch{continue}let alive=true;for(let n=0;n<100;n++){try{process.kill(pid,0)}catch{alive=false;break}await delay(20)}assert.equal(alive,false,'Owned '+name+' MCP child did not stop')}
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
