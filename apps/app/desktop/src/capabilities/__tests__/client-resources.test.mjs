import assert from 'node:assert/strict';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {CapabilitySocket} from '../../../dist/capabilities/capability-socket.js';
import {parseCapabilityServerFrame} from '../../../dist/capabilities/protocol.js';

const uri='ui://fixture/shared';
const call={type:'client_resource_read',call_id:'resource-1',generation:3,server:'alpha',uri,session_id:'session',account_id:'network',network_id:'network',deadline_ms:5000};
const servers=[{name:'alpha',resource_protocol:'mcp-app-resources/1',tools:[{name:'show',_meta:{ui:{resourceUri:uri}}}]}];
async function run(frame,options={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));let invoked=0,observed;
 let complete;const done=new Promise(resolve=>{complete=resolve});
 server.on('connection',ws=>ws.on('message',raw=>{
  const value=JSON.parse(String(raw));
  if(value.type==='capability_hello'){
   ws.send(JSON.stringify({type:'capability_hello_ack',protocol:'client-capabilities/1',device_id:'device',account_id:'network',network_id:'network',client_instance_id:'instance',generation:3,accepted:true}));
   ws.send(JSON.stringify(frame));
  }else if(value.type==='client_tool_result')complete(value);
 }));
 const socket=new CapabilitySocket({accountId:'account',trustedAccountId:'network',trustedDeviceId:'device',url:`ws://127.0.0.1:${server.address().port}`,clientInstanceId:'instance',deviceLabel:'Owned fixture',reconnect:false,getOffer:()=>({generation:3,servers:options.servers??servers}),invoke:async()=>{throw Error('Resource must never call a model tool')},readResource:async(value,signal)=>{invoked++;observed=value;if(options.abort){await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}return{contents:[{uri:value.uri,mimeType:'text/html;profile=mcp-app',text:'<p>alpha</p>'}]}}});
 let timer;socket.start();try{const result=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned resource WS did not settle')),4000)})]);return{result,invoked,observed}}finally{clearTimeout(timer);socket.stop();for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve))}
}

test('resource frames preserve exact session/server/URI and return raw MCP contents over a real socket',async()=>{
 assert.equal(parseCapabilityServerFrame(JSON.stringify(call)).type,'client_resource_read');const value=await run(call);assert.equal(value.invoked,1);assert.equal(value.observed.server,'alpha');assert.equal(value.observed.session_id,'session');assert.equal(value.result.result.contents[0].text,'<p>alpha</p>');assert.equal(value.result.result.content,undefined);
});
test('wrong account, network, generation, source, URI and old server feature are denied before resource dispatch',async()=>{
 for(const change of [{account_id:'other'},{network_id:'other'},{generation:4},{server:'beta'},{uri:'ui://fixture/other'}]){const value=await run({...call,...change});assert.equal(value.invoked,0);assert.ok(value.result.error)}
 const value=await run(call,{servers:[{name:'alpha',tools:servers[0].tools}]});assert.equal(value.invoked,0);assert.ok(value.result.error);
});
test('invalid URI/deadline/session shapes cannot enter the client resource handler',()=>{
 for(const change of [{uri:'file:///private'},{uri:'ui://fixture/\u0000'},{session_id:''},{deadline_ms:'soon'},{generation:0}])assert.throws(()=>parseCapabilityServerFrame(JSON.stringify({...call,...change})));
});
