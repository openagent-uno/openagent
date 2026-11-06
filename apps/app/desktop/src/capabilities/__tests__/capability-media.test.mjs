import assert from 'node:assert/strict';
import test from 'node:test';
import {WebSocketServer} from 'ws';
import {CapabilitySocket} from '../../../dist/capabilities/capability-socket.js';

test('media uses current identity/generation and stops its owned producer on close',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>server.once('listening',resolve));
 let invoked=0,aborted=0;const received=[];let peer;
 const done=new Promise((resolve,reject)=>server.on('connection',ws=>{peer=ws;ws.on('message',raw=>{
  const frame=JSON.parse(raw);received.push(frame);
  if(frame.type==='capability_hello'){
   try{assert.deepEqual(frame.media_protocols,['openagent-video/1']);}catch(error){reject(error);return;}
   ws.send(JSON.stringify({type:'capability_hello_ack',protocol:frame.protocol,device_id:'device',account_id:'network',network_id:'network',client_instance_id:'instance',generation:1,accepted:true}));
   const open={type:'client_media_open',stream_id:'stream',generation:1,server:'computer-control',tool:'computer',session_id:'session',account_id:'network',network_id:'network',options:{fps:20}};
   ws.send(JSON.stringify({...open,stream_id:'wrong-account',account_id:'other'}));
   ws.send(JSON.stringify({...open,stream_id:'wrong-generation',generation:2}));
   ws.send(JSON.stringify(open));
  }else if(frame.type==='client_media_packet')ws.send(JSON.stringify({type:'client_media_close',stream_id:'stream',generation:1}));
  else if(frame.type==='client_media_end')resolve();
 });}));
 const socket=new CapabilitySocket({accountId:'local',trustedAccountId:'network',trustedDeviceId:'device',url:`ws://127.0.0.1:${server.address().port}`,clientInstanceId:'instance',deviceLabel:'Fixture',reconnect:false,getOffer:()=>({generation:1,servers:[]}),invoke:async()=>{throw new Error('unexpected invocation')},
  openMedia:async(_request,signal,onPacket)=>{invoked++;onPacket({type:'test'});await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));}});
 const timeout=setTimeout(()=>peer?.terminate(),5000);
 try{socket.start();await done;assert.equal(invoked,1);assert.equal(aborted,1);assert.equal(received.filter(f=>f.type==='client_media_packet').length,1);}
 finally{clearTimeout(timeout);socket.stop();for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));}
});
