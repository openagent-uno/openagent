import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserDecision, performBrowserDecision } from '../../../dist/capabilities/browser-operator.js';

const pending = (extra={})=>({request_id:'pending-local',action:'permission',browser_id:'dedicated',tab_id:4,origin:'https://owned.test',permissions:['camera'],expires_at_ms:Date.now()+60000,...extra});
const wire = request=>({content:[],structuredContent:{pending_decisions:[request]}});
const input = {requestId:'pending-local',action:'grant'};

test('operator decision uses only current host inventory origin, permissions and target',()=>{
 const decision=resolveBrowserDecision(wire(pending()),input);
 assert.deepEqual(decision.args,{action:'grant',browser_id:'dedicated',tabId:4,request_id:'pending-local',origin:'https://owned.test',permissions:['camera']});
 for(const extra of [{origin:'https://forged.test'},{permissions:['microphone']},{_meta:{}},{principal:'forged'}])assert.throws(()=>resolveBrowserDecision(wire(pending()),{...input,...extra}),/invalid_browser_decision/);
 assert.throws(()=>resolveBrowserDecision(wire(pending({expires_at_ms:0})),input),/expired/);
 assert.throws(()=>resolveBrowserDecision(wire(pending({action:'resume'})),input),/expired/);
});

test('native confirmation decline never dispatches; approval dispatches exact record',async()=>{
 const calls=[];let dialogs=0;
 const inventory=async()=>wire(pending());
 const dispatch=async decision=>{calls.push(decision);return 'confirmed'};
 assert.deepEqual(await performBrowserDecision(inventory,dispatch,input,async()=>{dialogs++;return false}),{cancelled:true});
 assert.equal(calls.length,0);
 assert.equal(await performBrowserDecision(inventory,dispatch,input,async detail=>{assert.match(detail,/https:\/\/owned.test/);return true}),'confirmed');
 assert.equal(calls.length,1);assert.equal(dialogs,1);
});

test('revoked or changed pending record during native dialog never dispatches',async()=>{
 for(const change of [null,pending({origin:'https://changed.test'}),pending({tab_id:5})]){
  let reads=0,dispatches=0;
  const inventory=async()=>++reads===1?wire(pending()):change?wire(change):{pending_decisions:[]};
  await assert.rejects(performBrowserDecision(inventory,async()=>{dispatches++},input,async()=>true),/expired|changed/);
  assert.equal(dispatches,0);
 }
});

test('provider tool error is visible to operator and never treated as success',async()=>{
 await assert.rejects(performBrowserDecision(async()=>wire(pending()),async()=>({isError:true,content:[{type:'text',text:'expired'}]}),input,async()=>true),/browser_decision_failed/);
});
