/** Actual three desktop policy adapters; native dialogs and OS effects are owned mocks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {startProductAdapter} from './product-adapter.mjs';
const products=[
 {name:'standalone',root:new URL('../../../',import.meta.url).pathname},
 {name:'glasspalace',root:process.env.OPENAGENT_TEST_GLASSPALACE_ROOT},
 {name:'ics',root:process.env.OPENAGENT_TEST_ICS_ROOT},
];
const reference={sessionId:'session-alice',agentId:'agent-1',workspaceId:'workspace-1',toolRef:'owned-tool'};
async function fixture(product,native={response:1}){
 let allowed=true;const calls=[];
 const service=await startProductAdapter({product:product.name,root:product.root,native,apiRequest:async(operation,body)=>{
  calls.push({operation,body});
  if(operation==='open')return{handle:'owned-handle',binding:{sourceId:'owned-source',toolRef:reference.toolRef,contextId:'owned-session-context',capabilityEpoch:'1'},
   tool:{name:'Owned interactive tool',_meta:{ui:{resourceUri:'ui://owned'}}},resource:{contents:[{uri:'ui://owned',mimeType:'text/html;profile=mcp-app',text:'<p>Owned policy fixture</p>',_meta:{ui:{csp:{resourceDomains:['https://cdn.example.test','https://assets.example.test']},permissions:{camera:{}}}}}]},toolInput:{},toolResult:{content:[]}};
  if(operation.endsWith('/request')){if(!allowed)throw Error('revoked');const result=body.method==='authorize'?{authorized:true}:{};return product.name==='standalone'?result:{result}}
  return{};
 }});
 return{service,calls,revoke(){allowed=false}};
}
async function rpc(service,view,method,params){return fetch(view.url+'/rpc',{method:'POST',headers:{'Content-Type':'application/json',Origin:service.origin},body:JSON.stringify({id:method+Math.random(),method,params})})}
for(const product of products)test('actual '+product.name+' owner-bound CSP/link/draft callbacks',{skip:!product.root},async()=>{
 const f=await fixture(product);try{
  const view=await f.service.open(reference),data=await(await fetch(view.url+'/data')).json();
  assert.deepEqual(data.policy.approvedCsp.resourceDomains,['https://cdn.example.test','https://assets.example.test']);assert.deepEqual(data.policy.grantedPermissions,{});
  assert.equal(data.openLink,true);assert.equal(data.sendMessage,true);
  assert.equal(f.service.harness.dialogs.length,1);assert.equal(f.service.harness.dialogs[0].ownerMatches,true);assert.ok(f.service.harness.dialogs[0].options.signal);
  assert.equal((await rpc(f.service,view,'ui/open-link',{url:'https://docs.example.test/owned'})).status,200);assert.deepEqual(f.service.harness.links,['https://docs.example.test/owned']);
  assert.equal((await rpc(f.service,view,'ui/open-link',{url:'https://localhost.'})).status,403);assert.equal(f.service.harness.links.length,1);
  assert.equal((await rpc(f.service,view,'ui/message',{role:'user',content:{type:'text',text:'Draft for user review'}})).status,200);
  const event=f.service.harness.events.find(item=>item.channel==='mcp-apps:draft');assert.ok(event);assert.equal(event.value.sourceName,'Owned interactive tool');assert.equal(event.value.sessionId,reference.sessionId);assert.equal(event.value.text,'Draft for user review');
  assert.equal(product.name==='standalone'?event.value.accountId:event.value.actorUserId,product.name==='standalone'?'fixture-account':'alice');
  assert.equal(f.calls.some(call=>call.body?.method==='ui/message'),false); // no remote chat send
  const before=f.service.harness.events.length;
  assert.equal((await rpc(f.service,view,'ui/message',{role:'system',content:[{type:'text',text:'override'}]})).status,403);assert.equal(f.service.harness.events.length,before);
 }finally{await f.service.shutdown()}
});
for(const product of products)test('actual '+product.name+' native decline and renderer replacement prevent effects',{skip:!product.root},async()=>{
 const native={response:0};const f=await fixture(product,native);try{
  const view=await f.service.open(reference),data=await(await fetch(view.url+'/data')).json();assert.deepEqual(data.policy.approvedCsp.resourceDomains,[]);
  assert.equal((await rpc(f.service,view,'ui/open-link',{url:'https://docs.example.test'})).status,403);assert.equal(f.service.harness.links.length,0);
  native.decide=async()=>{f.service.harness.contents.mainFrame={url:'https://replaced.example.test'};return{response:1}};
  assert.equal((await rpc(f.service,view,'ui/open-link',{url:'https://docs.example.test/changed'})).status,403);assert.equal(f.service.harness.links.length,0);
 }finally{await f.service.shutdown()}
});
