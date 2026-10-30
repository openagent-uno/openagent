import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createMcpAppHostService} from '../src/desktop.mjs';
const assetRoot=new URL('../src/',import.meta.url).pathname;
const ref={sessionId:'session-a',toolRef:'tool-a'},other={sessionId:'session-b',toolRef:'tool-b'};
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes});return{promise,resolve}}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const state={closed:[],writes:0,opens:0};
 const options={assetRoot,currentOwner:async()=> 'same-account',
  openSession:async(reference)=>{state.opens++;return{handle:reference.sessionId,resource:{contents:[{uri:'ui://fixture',mimeType:'text/html;profile=mcp-app',text:'<p>owned fixture</p>'}]},tool:{_meta:{ui:{resourceUri:'ui://fixture'}}}}},
  requestSession:async(_session,method)=>{if(method==='authorize')return{authorized:true};state.writes++;return{}},closeSession:async(session)=>{state.closed.push(session.handle)}};
 return{state,options};
}
const rpc=(view,method='tools/call')=>fetch(view.url+'/rpc',{method:'POST',headers:{Origin:new URL(view.url).origin,'Content-Type':'application/json'},body:JSON.stringify({id:'call',method,params:{name:'increment'}})});

test('revocation immediately aborts active work; same-account reopen keeps origin but cannot revive the old view',async()=>{
 const f=fixture(),started=deferred(),release=deferred();let signal;
 f.options.requestSession=async(_session,method,_params,_reference,control)=>{if(method==='authorize')return{authorized:true};signal=control.signal;started.resolve();await release.promise;return{secret:'old-result'}};
 const service=await createMcpAppHostService(f.options);
 try{const view=await service.open(ref),response=rpc(view);await started.promise;service.revokeAll();assert.equal(signal.aborted,true);release.resolve();assert.equal((await response).status,403);const replacement=await service.open(ref);assert.equal(new URL(replacement.url).origin,new URL(view.url).origin);assert.notEqual(replacement.viewId,view.viewId);assert.equal((await fetch(view.url+'/data')).status,403);await turn();assert.deepEqual(f.state.closed,['session-a']);}finally{release.resolve();await service.shutdown()}
});

test('targeted revocation catches pending opens before first auth await and leaves another context usable',async()=>{
 const f=fixture(),gate=deferred();let first=true;
 f.options.currentOwner=async()=>{if(first){first=false;await gate.promise}return'same-account'};
 const service=await createMcpAppHostService(f.options);
 try{const pending=service.open(ref),failed=assert.rejects(pending,/revoked/);service.revokeViews(value=>value.sessionId===ref.sessionId);await failed;assert.equal(f.state.opens,0);const unaffected=await service.open(other);assert.equal((await fetch(unaffected.url+'/data')).status,200);gate.resolve();await turn();assert.equal(f.state.opens,1);}finally{gate.resolve();await service.shutdown()}
});

test('late allocation from an abort-ignoring backend is closed exactly once and never published',async()=>{
 const f=fixture(),started=deferred(),release=deferred();let signal;const original=f.options.openSession;
 f.options.openSession=async(reference,received)=>{signal=received;started.resolve();await release.promise;return original(reference)};
 const service=await createMcpAppHostService(f.options);
 try{const pending=service.open(ref),failed=assert.rejects(pending,/revoked/);await started.promise;service.revokeAll();assert.equal(signal.aborted,true);await failed;release.resolve();await turn();await turn();assert.deepEqual(f.state.closed,['session-a']);assert.equal(f.state.opens,1);}finally{release.resolve();await service.shutdown()}
});

test('revocation during the final owner check disposes the allocated session once',async()=>{
 const f=fixture(),started=deferred(),release=deferred();let checks=0;
 f.options.currentOwner=async()=>{if(++checks===2){started.resolve();await release.promise}return'same-account'};
 const service=await createMcpAppHostService(f.options);
 try{const pending=service.open(ref),failed=assert.rejects(pending,/revoked/);await started.promise;service.revokeAll();await failed;release.resolve();await turn();assert.deepEqual(f.state.closed,['session-a']);}finally{release.resolve();await service.shutdown()}
});

test('a request body completed after revocation cannot begin a tool mutation',async()=>{
 const f=fixture(),admitted=deferred();f.options.requestSession=async(_session,method)=>{if(method==='authorize'){admitted.resolve();return{authorized:true}}f.state.writes++;return{}};
 const service=await createMcpAppHostService(f.options);
 try{const view=await service.open(ref);let request;
 const response=new Promise((resolve,reject)=>{request=http.request(view.url+'/rpc',{method:'POST',headers:{Origin:service.origin,'Content-Type':'application/json'}},result=>{result.resume();resolve(result.statusCode)});request.once('error',reject);request.write('{"id":"late","method":"tools/call","params":');});
 await admitted.promise;service.revokeAll();request.end('{"name":"increment"}}');assert.equal(await response,403);assert.equal(f.state.writes,0);}finally{await service.shutdown()}
});

test('targeted revocation aborts a pending approval while preserving a different live view',async()=>{
 const f=fixture(),started=deferred(),release=deferred();let signal,decisions=0;
 f.options.openLink=async(_params,_reference,control)=>{signal=control.signal;started.resolve();await release.promise;await control.authorize();decisions++;return{}};
 const service=await createMcpAppHostService(f.options);
 try{const view=await service.open(ref),unaffected=await service.open(other);const decision=fetch(view.url+'/rpc',{method:'POST',headers:{Origin:service.origin,'Content-Type':'application/json'},body:JSON.stringify({id:'link',method:'ui/open-link',params:{url:'https://example.com'}})});await started.promise;service.revokeViews(value=>value===ref);assert.equal(signal.aborted,true);release.resolve();assert.equal((await decision).status,403);assert.equal(decisions,0);assert.equal((await fetch(unaffected.url+'/data')).status,200);}finally{release.resolve();await service.shutdown()}
});

test('revoked abort-ignoring open work still consumes bounded admission until actual settlement',async()=>{
 const f=fixture(),started=deferred(),release=deferred();f.options.maxViews=1;const original=f.options.openSession;
 f.options.openSession=async reference=>{started.resolve();await release.promise;return original(reference)};
 const service=await createMcpAppHostService(f.options);
 try{const pending=service.open(ref),failed=assert.rejects(pending,/revoked/);await started.promise;service.revokeAll();await failed;
  for(let i=0;i<4;i++){service.revokeAll();await assert.rejects(service.open(other),/view_limit/)}
  assert.equal(f.state.opens,0);release.resolve();await turn();await turn();assert.deepEqual(f.state.closed,['session-a']);const fresh=await service.open(other);assert.ok(fresh.viewId);
 }finally{release.resolve();await service.shutdown()}
});
