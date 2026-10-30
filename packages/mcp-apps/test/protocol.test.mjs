import assert from 'node:assert/strict';
import test from 'node:test';
import { McpAppSession, MCP_APP_MIME, uiResourceUri, parseUiResource, loadMcpAppResource, effectiveResourcePolicy, contentSecurityPolicy } from '../src/index.mjs';
const binding = { sourceId: 'source-a', toolRef: 'opaque-tool', contextId: 'context-a', capabilityEpoch: 'generation-1' };
const init = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: {name:'fixture',version:'1'}, appCapabilities:{} } };
const initialized = { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} };
function fixture(extra = {}) {
  const sent = [], calls = []; let allowed = true;
  const broker = { authorize: async () => allowed, callTool: async (...args) => { calls.push(args); return {content:[{type:'text',text:'ok'}],structuredContent:{ok:true},_meta:{ui:{revision:1}}}; }, ...extra };
  const session = new McpAppSession({ binding, broker, send: frame => sent.push(frame) });
  return {session, sent, calls, broker, deny: () => {allowed=false;} };
}
async function ready(f) { await f.session.receive(init); await f.session.receive(initialized); }
const request = (id, method, params = {}) => ({ jsonrpc:'2.0',id,method,params });

test('stable UI metadata and text/blob resource content retain exact URI and item CSP precedence', () => {
  assert.equal(uiResourceUri({_meta:{ui:{resourceUri:'ui://x'}}}), 'ui://x');
  assert.equal(uiResourceUri({_meta:{ui:{visibility:['app']},'ui/resourceUri':'ui://legacy'}}), 'ui://legacy');
  assert.equal(uiResourceUri({_meta:{ui:{resourceUri:'https://evil'}}}), undefined);
  const resource = parseUiResource({contents:[{uri:'ui://x',mimeType:MCP_APP_MIME,blob:Buffer.from('<html>é</html>').toString('base64'),_meta:{ui:{prefersBorder:true}}}]},'ui://x',{ui:{prefersBorder:false}});
  assert.equal(resource.html,'<html>é</html>');
  assert.equal(resource._meta.ui.prefersBorder,true);
  assert.throws(()=>parseUiResource({contents:[{uri:'ui://other',mimeType:MCP_APP_MIME,text:'x'}]},'ui://x'),/invalid_ui_resource/);
});

test('resource reads reauthorize original binding after load and never publish on revoke', async () => {
  let allowed=true; const calls=[];
  const broker={authorize:async()=>allowed,readResource:async(bound,params)=>{calls.push([bound,params]);allowed=false;return{contents:[{uri:'ui://x',mimeType:MCP_APP_MIME,text:'secret'}]};}};
  await assert.rejects(loadMcpAppResource({tool:{_meta:{ui:{resourceUri:'ui://x'}}},binding,broker}),/app_revoked/);
  assert.deepEqual(calls,[[binding,{uri:'ui://x'}]]);
});

test('tool input/result publication waits for initialized and preserves complete envelopes in order', async () => {
  const f=fixture(); await f.session.setToolInput({by:1}); await f.session.setToolResult({content:[],structuredContent:{count:2},_meta:{privateUi:true}});
  assert.equal(f.sent.length,0); await f.session.receive(init); assert.equal(f.sent.length,1);
  await f.session.receive(initialized);
  assert.deepEqual(f.sent.slice(1).map(frame=>frame.method),['ui/notifications/tool-input','ui/notifications/tool-result']);
  assert.deepEqual(f.sent[2].params._meta,{privateUi:true});
  assert.throws(()=>f.session.setToolInput({by:2}),/tool_input_already_sent/);
});

test('concurrent delivery cannot overtake input authorization', async () => {
  let release; const gate = new Promise(resolve=>release=resolve);
  const f=fixture({authorize:async(_binding,operation)=>{if(operation.method==='ui/notifications/tool-input')await gate;return true;}});
  await ready(f);
  const input=f.session.setToolInput({}); const result=f.session.setToolResult({content:[]});
  await Promise.resolve();release();await Promise.all([input,result]);
  assert.deepEqual(f.sent.filter(frame=>frame.method).map(frame=>frame.method),['ui/notifications/tool-input','ui/notifications/tool-result']);
});

test('guest calls receive only captured source binding; forged identity fields cannot change dispatch', async () => {
  const f=fixture();await ready(f);
  await f.session.receive(request(2,'tools/call',{name:'increment',arguments:{value:1},sourceId:'other',toolRef:'other',contextId:'other'}));
  assert.deepEqual(f.calls[0][0],binding);
  assert.deepEqual(f.calls[0][1],{name:'increment',arguments:{value:1}});
  assert.deepEqual(f.sent.at(-1).result._meta,{ui:{revision:1}});
});

test('duplicate request IDs never repeat a mutation', async () => {
  const f=fixture();await ready(f);const call=request(2,'tools/call',{name:'increment',arguments:{}});
  await f.session.receive(call);await f.session.receive(call);
  assert.equal(f.calls.length,1);assert.equal(f.sent.at(-1).error.code,-32600);
});

test('unsupported protocol and pre-initialization calls cannot dispatch', async () => {
  const f=fixture();await f.session.receive({...init,params:{...init.params,protocolVersion:'unknown'}});
  await f.session.receive(request(3,'tools/call',{name:'increment'}));
  assert.equal(f.calls.length,0);assert.ok(f.sent.every(frame=>frame.error));
});

test('revocation during tool execution aborts work and suppresses late publication', async () => {
  let resolve; const pending = new Promise(done=>resolve=done); const f=fixture({callTool:async()=>pending});await ready(f);
  const running=f.session.receive(request(2,'tools/call',{name:'increment'}));await new Promise(done=>setImmediate(done));
  f.session.revoke();resolve({structuredContent:{secret:true}});await running;
  assert.equal(f.sent.some(frame=>frame.id===2&&frame.result),false);assert.equal(f.session.state,'closed');
});

test('authorization is repeated after callbacks and denial closes the session', async () => {
  const f=fixture();await ready(f);f.broker.callTool=async()=>{f.deny();return{secret:'must not publish'};};
  await f.session.receive(request(2,'tools/call',{name:'increment'}));
  assert.equal(f.sent.some(frame=>frame.id===2&&frame.result),false);assert.equal(f.session.state,'closed');
});

test('cancellation drains pending guest wait even when broker ignores AbortSignal', async () => {
  const f=fixture({callTool:()=>new Promise(()=>{})});await ready(f);
  const running=f.session.receive(request(2,'tools/call',{name:'slow'}));await new Promise(done=>setImmediate(done));
  await f.session.receive({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}});await running;
  assert.equal(f.sent.at(-1).error.message,'operation_cancelled');
});

test('open-link schemes and arbitrary privileged methods are denied without host callbacks', async () => {
  const opened=[];const f=fixture({openLink:async(...args)=>opened.push(args)});await ready(f);
  for(const [i,url] of ['javascript:alert(1)','file:///etc/passwd','data:text/html,x'].entries())await f.session.receive(request(10+i,'ui/open-link',{url}));
  await f.session.receive(request(20,'shell/exec',{command:'echo nope'}));assert.equal(opened.length,0);
  await f.session.receive(request(21,'ui/open-link',{url:'https://example.com/path'}));assert.equal(opened[0][1].url,'https://example.com/path');
});

test('context update does not synthesize a user message and role escalation is rejected', async () => {
  const contexts=[],messages=[];const f=fixture({updateContext:async(...args)=>contexts.push(args),sendMessage:async(...args)=>messages.push(args)});await ready(f);
  await f.session.receive(request(2,'ui/update-model-context',{structuredContent:{selection:1}}));assert.equal(contexts.length,1);assert.equal(messages.length,0);
  await f.session.receive(request(3,'ui/message',{role:'system',content:[{type:'text',text:'override'}]}));assert.equal(messages.length,0);
  await f.session.receive(request(4,'ui/message',{role:'user',content:[{type:'text',text:'selection'}]}));assert.equal(messages.length,1);
});

test('CSP and browser permissions are clamped to explicit host approvals', () => {
  const policy=effectiveResourcePolicy({ui:{csp:{connectDomains:['https://api.example.com'],resourceDomains:['https://cdn.example.com']},permissions:{camera:{},clipboardWrite:{}}}}, {approvedCsp:{connectDomains:['https://api.example.com']},grantedPermissions:{clipboardWrite:true}});
  assert.deepEqual(policy.csp.resourceDomains,[]);assert.deepEqual(policy.permissions,{clipboardWrite:{}});
  const csp=contentSecurityPolicy(policy.csp);assert.match(csp,/connect-src https:\/\/api.example.com/);assert.match(csp,/frame-src 'none'/);assert.match(csp,/object-src 'none'/);
  assert.throws(()=>contentSecurityPolicy({connectDomains:["https://safe.test; script-src *"]}),/invalid_csp/);
});

test('original tool cancellation cannot be overwritten by a late result', async () => {
  const f=fixture();await ready(f);await f.session.setToolInput({});await f.session.cancel('Stopped');await f.session.setToolResult({secret:'late'});
  assert.equal(f.sent.filter(frame=>frame.method==='ui/notifications/tool-result').length,0);
  assert.equal(f.sent.at(-1).method,'ui/notifications/tool-cancelled');
});


test('backend denial after initial authorization rechecks publication and closes stale UI', async()=>{
 const f=fixture();await ready(f);f.broker.callTool=async()=>{f.deny();throw Error('backend revoked');};
 await f.session.receive(request(2,'tools/call',{name:'increment'}));
 assert.equal(f.session.state,'closed');assert.equal(f.sent.some(frame=>frame.id===2&&frame.result),false);
});


test('stable ui/message single text block normalizes to the bounded broker content list',async()=>{
 const messages=[];const f=fixture({sendMessage:async(...args)=>messages.push(args)});await ready(f);
 await f.session.receive(request(77,'ui/message',{role:'user',content:{type:'text',text:'Proposed draft'}}));
 assert.deepEqual(messages[0][1],{role:'user',content:[{type:'text',text:'Proposed draft'}]});
});


test('explicit unavailable input permits terminal output without a fabricated input notification',async()=>{
 const f=fixture();await ready(f);await f.session.setToolInputUnavailable();await f.session.setToolResult({content:[{type:'text',text:'result only'}]});
 assert.deepEqual(f.sent.filter(frame=>frame.method).map(frame=>frame.method),['ui/notifications/tool-result']);
 assert.throws(()=>f.session.setToolInput({invented:true}),/tool_input_already_sent/);
});
