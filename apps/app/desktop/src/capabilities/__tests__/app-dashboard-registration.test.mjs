import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openagent-app-offer-'));
after(() => fs.rm(temp, { recursive: true, force: true }));
for (const name of ['ws', 'collaboration']) await build({entryPoints:[path.join(root, `universal/services/${name}.ts`)],bundle:true,outfile:path.join(temp,`${name}.mjs`),format:'esm',platform:'node',logLevel:'silent'});
const { OpenAgentWS } = await import(pathToFileURL(path.join(temp,'ws.mjs')).href);
const { CollaborationClient } = await import(pathToFileURL(path.join(temp,'collaboration.mjs')).href);
class Socket {
  static OPEN=1; static latest; readyState=1; sent=[];
  constructor(){ Socket.latest=this; }
  send(value){ this.sent.push(JSON.parse(value)); }
  close(){this.readyState=3;this.onclose?.({code:1000,reason:''});}
  receive(frame){this.onmessage?.({data:JSON.stringify(frame)});}
}
test('App offers dashboards without local computer consent or instance',()=>{
  const original=globalThis.WebSocket; globalThis.WebSocket=Socket;
  try {
    const app=new OpenAgentWS('ws://fixture/ws');app.connect();const socket=Socket.latest;socket.onopen();
    assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].type,'auth');
    socket.receive({type:'auth_ok',connection_id:'verified-connection'});
    assert.deepEqual(socket.sent[1],{type:'app_capability_register',product:'openagent-app',dashboard_tools:1});
    socket.receive({type:'app_capability_registered',dashboard_tools:1,connection_id:'verified-connection'});
    app.sendSessionOpen('session',{clientKind:'webapp'});
    const opened=socket.sent.find(frame=>frame.type==='session_open');
    assert.equal(opened.client_capabilities.dashboard_tools,1);assert.equal(opened.client_instance_id,undefined);app.disconnect();
  } finally {globalThis.WebSocket=original;}
});
test('Shared HTTP turn awaits registration and carries exact connection reference',async()=>{
  const original=globalThis.fetch;const requests=[];
  globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({response:'ok'})};};
  try {
    let accept;const registration=new Promise(resolve=>{accept=resolve;});
    const client=new CollaborationClient('https://fixture',undefined,()=>registration);
    const turn=client.sendTurn('session','request','create dashboard');await Promise.resolve();assert.equal(requests.length,0);
    accept('verified-connection');await turn;assert.equal(requests[0].body.app_connection_id,'verified-connection');
    assert.equal(requests[0].body.principal,undefined);assert.equal(requests[0].body.client_instance_id,undefined);client.dispose();
  } finally {globalThis.fetch=original;}
});
