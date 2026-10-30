import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {startProductAdapter} from '../../../../../../packages/mcp-apps/test/product-adapter.mjs';

const root=fileURLToPath(new URL('../../../../../../',import.meta.url));
const reference={sessionId:'session-alice',toolRef:'owned-tool'};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
function session(){return{handle:'owned-handle',binding:{sourceId:'owned-source',toolRef:reference.toolRef,contextId:'owned-session-context',capabilityEpoch:'1'},
 tool:{name:'Owned interactive tool',_meta:{ui:{resourceUri:'ui://owned'}}},resource:{contents:[{uri:'ui://owned',mimeType:'text/html;profile=mcp-app',text:'<p>Owned lifetime fixture</p>'}]},toolInput:{},toolResult:{content:[]}}}
async function fixture({open,native={response:1}}={}){
 return startProductAdapter({product:'standalone',root,native,apiRequest:async(operation,body)=>{
  if(operation==='open')return open?open():session();
  if(operation.endsWith('/request'))return body.method==='authorize'?{authorized:true}:{};
  return{};
 }});
}

test('actual canonical adapter retires old views across same-account relogin on the same tunnel',async()=>{
 const service=await fixture();
 try{
  const old=await service.open(reference),origin=service.origin,tunnel=service.harness.loopback;
  assert.equal((await fetch(old.url)).status,200);
  service.harness.releaseAccount();
  assert.equal((await fetch(old.url)).status,403);
  service.harness.resumeAccount();
  assert.equal(service.harness.loopback,tunnel);
  assert.equal(service.origin,origin);
  const current=await service.open(reference);
  assert.equal((await fetch(current.url)).status,200);
  assert.equal((await fetch(old.url)).status,403);
 }finally{await service.shutdown()}
});

test('logout fences an actual canonical open before the delayed backend reply arrives',async()=>{
 const entered=deferred(),reply=deferred();let first=true;
 const service=await fixture({open:async()=>{if(first){first=false;entered.resolve();await reply.promise}return session()}});
 try{
  const pending=service.open(reference);
  const rejected=assert.rejects(pending,/revoked|changed|unavailable/);
  await entered.promise;service.harness.releaseAccount();await rejected;
  service.harness.resumeAccount();reply.resolve();
  const current=await service.open(reference);
  assert.equal((await fetch(current.url)).status,200);
 }finally{reply.resolve();await service.shutdown()}
});

test('logout aborts the canonical native decision and relogin cannot apply its late approval',async()=>{
 const entered=deferred(),decision=deferred();let signal;
 const native={decide:async options=>{signal=options.signal;entered.resolve();await decision.promise;return{response:1}}};
 const service=await fixture({native});
 try{
  const view=await service.open(reference);
  const request=fetch(view.url+'/rpc',{method:'POST',headers:{'Content-Type':'application/json',Origin:service.origin},body:JSON.stringify({id:'owned-late-decision',method:'ui/open-link',params:{url:'https://docs.example.test/owned'}})});
  await entered.promise;service.harness.releaseAccount();assert.equal(signal.aborted,true);
  service.harness.resumeAccount();decision.resolve();
  assert.equal((await request).status,403);
  assert.deepEqual(service.harness.links,[]);
 }finally{decision.resolve();await service.shutdown()}
});
