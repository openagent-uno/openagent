import assert from 'node:assert/strict';
import test from 'node:test';
import {startProductAdapter} from './product-adapter.mjs';
const products=[{name:'ics',root:process.env.OPENAGENT_TEST_ICS_ROOT},{name:'glasspalace',root:process.env.OPENAGENT_TEST_GLASSPALACE_ROOT}];
const reference={sessionId:'session-alice',agentId:'agent-1',workspaceId:'workspace-1',toolRef:'owned-tool'};
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes});return{promise,resolve}}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function session(){return{handle:'owned-handle',binding:{sourceId:'owned-source',toolRef:reference.toolRef,contextId:'owned-context',capabilityEpoch:'1'},tool:{name:'Owned app',_meta:{ui:{resourceUri:'ui://owned'}}},resource:{contents:[{uri:'ui://owned',mimeType:'text/html;profile=mcp-app',text:'<p>owned</p>',_meta:{ui:{csp:{resourceDomains:['https://cdn.example.test']}}}}]}}}
for(const product of products){
 test(`actual ${product.name} logout suspends before native approval and same-user relogin cannot revive old views`,{skip:!product.root},async()=>{
  const started=deferred(),release=deferred(),closed=[];let signal;
  const service=await startProductAdapter({product:product.name,root:product.root,native:{decide:async options=>{signal=options.signal;started.resolve();await release.promise;return{response:1}}},apiRequest:async(operation)=>{if(operation==='open')return session();if(operation.endsWith('/request'))return{result:{authorized:true}};closed.push(operation);return{}}});
  try{const view=await service.open(reference),pending=fetch(view.url+'/data');await started.promise;const epoch=service.suspend();assert.equal(signal.aborted,true);await assert.rejects(service.open(reference),/context_changed/);release.resolve();assert.equal((await pending).status,403);await service.resume(epoch);const replacement=await service.open(reference);assert.equal(new URL(replacement.url).origin,new URL(view.url).origin);assert.notEqual(replacement.viewId,view.viewId);assert.equal((await fetch(view.url+'/data')).status,403);await turn();assert.equal(closed.filter(value=>value.endsWith('/close')).length,1);}finally{release.resolve();await service.shutdown()}
 });
 test(`actual ${product.name} pending authentication cannot publish after logout or resume an older login epoch`,{skip:!product.root},async()=>{
  const started=deferred(),release=deferred();let calls=0,opens=0;
  const service=await startProductAdapter({product:product.name,root:product.root,native:{accessToken:async()=>{if(++calls===1){started.resolve();await release.promise}return'fixture-session'}},apiRequest:async(operation)=>{if(operation==='open'){opens++;return session()}return{result:{authorized:true}}}});
  try{const pending=service.open(reference),failed=assert.rejects(pending,/revoked|context_changed/);await started.promise;const old=service.suspend();await failed;const current=service.suspend();release.resolve();await assert.rejects(service.resume(old),/context_changed/);assert.equal(opens,0);await service.resume(current);const view=await service.open(reference);assert.equal(opens,1);assert.ok(view.url);await turn();assert.equal(opens,1);}finally{release.resolve();await service.shutdown()}
 });
}
