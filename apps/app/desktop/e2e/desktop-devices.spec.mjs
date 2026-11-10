import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { _electron as electron, expect, test } from '@playwright/test';
import { DeterministicGateway } from './fixtures.mjs';
import { WebSocketServer } from 'ws';
const VIDEO=JSON.parse(await readFile(new URL('./video-desktop.json',import.meta.url),'utf8'));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixturePng() {
  const crc = b => { let c = 0xffffffff; for (const byte of b) { c ^= byte; for (let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (name, bytes) => { const payload=Buffer.concat([Buffer.from(name),bytes]); const head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);const tail=Buffer.alloc(4);tail.writeUInt32BE(crc(payload));return Buffer.concat([head,payload,tail]); };
  const width=800,height=450,rows=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) { const p=y*(width*3+1)+1+x*3; const app=x>70&&x<640&&y>50&&y<360; rows[p]=app?225:32;rows[p+1]=app?232:50;rows[p+2]=app?240:72; }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
class DeviceGateway extends DeterministicGateway {
  calls=[]; offline=false; live=false; streamCloses=0; streamHellos=[]; members=[]; inputDelay=0; draftRequests=[];
  acceptedSessions=new Set();
  receivedTurns=[];
  sharedRevision=0;
  sharedTurns=[];
  heldTurn=null;
  async start(){
    await super.start();const original=this.server.listeners('upgrade');this.server.removeAllListeners('upgrade');
    this.videoServer=new WebSocketServer({noServer:true});
    this.collaborationServer=new WebSocketServer({noServer:true});
    this.server.on('upgrade',(request,socket,head)=>{
      if(new URL(request.url,this.baseUrl).pathname==='/ws/collaboration'){
        this.collaborationServer.handleUpgrade(request,socket,head,ws=>{
          ws.send(JSON.stringify({type:'auth_ok',shared:true}));
          ws.on('message',raw=>{const observation=JSON.parse(raw);for(const id of observation.sessions||[])
            if(id.startsWith('session-')&&!this.acceptedSessions.has(id))ws.send(JSON.stringify({type:'shared_state',session_id:id,revision:0,turns:[]}));});
        });return;
      }
      if(new URL(request.url,this.baseUrl).pathname==='/api/sessions/e2e-session/computer-stream'){
        this.videoServer.handleUpgrade(request,socket,head,ws=>{
          let timer;ws.once('message',raw=>{const hello=JSON.parse(raw);this.streamHellos.push(hello);if(hello.tool_ref!=='exact-agent-desktop'){ws.close();return;}
            ws.send(JSON.stringify(VIDEO.config));let seq=0;timer=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'frame',seq:seq++,timestamp_us:seq*50000,key:true,data:VIDEO.data}));},50);});
          ws.on('close',()=>{clearInterval(timer);this.streamCloses++;});
        });return;
      }
      for(const listener of original)listener(request,socket,head);
    });return this;
  }
  async close(){for(const server of [this.videoServer,this.collaborationServer]){for(const socket of server?.clients||[])socket.terminate();server?.close();}await super.close();}
  async handleHttp(request,response) {
    const incomingPath=new URL(request.url,'http://fixture').pathname;
    const sessionId=incomingPath.split('/')[3];
    const path=this.acceptedSessions.has(sessionId)?incomingPath.replace('/'+sessionId+'/', '/e2e-session/'):incomingPath;
    if (/^\/api\/sessions\/session-[^/]+\/(?:devices|computer-targets|participants|descendants|related-runs)(?:\/|$)/.test(path)
        || /^\/api\/collaboration\/session-[^/]+\/members$/.test(path)) this.draftRequests.push(path);
    const reply=(value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));};
    if(path==='/api/collaboration')return reply({version:1});
    if(path==='/api/collaboration/turns'&&request.method==='POST'){
      let body='';for await(const chunk of request)body+=chunk;
      const turn=JSON.parse(body);this.acceptedSessions.add(turn.session_id);
      this.receivedTurns.push(turn);
      if (this.heldTurn) await this.heldTurn;
      const before = 'Session started';
      const answer = before + 'Check complete';
      const now=Date.now()/1000;const accepted={id:turn.request_id,runId:turn.request_id,providerRunId:turn.request_id,active:this.receivedTurns.length===1,startedAt:now,messages:[
        {id:'accepted-user',role:'user',text:turn.message,timestamp:now,author:{kind:'human',handle:'alice',display:'Alice'}},
        {id:'accepted-assistant',role:'assistant',text:answer,timestamp:now,author:{kind:'agent'}},
      ], tools: [{id:'timeline-call',afterText:before.length,timestamp:now,
        toolInfo:{tool_name:'timeline_probe',tool_call_id:'timeline-call',result:'ok'}}]};
      for (const previous of this.sharedTurns) previous.active=false;
      this.sharedTurns.push(accepted);
      const snapshot={type:'shared_state',session_id:turn.session_id,revision:++this.sharedRevision,turns:this.sharedTurns};
      for(const socket of this.collaborationServer.clients)if(socket.readyState===1)socket.send(JSON.stringify(snapshot));
      return reply({session_id:turn.session_id,request_id:turn.request_id,response:answer});
    }
    if(path==='/api/network/users')return reply({users:[{handle:'bob',status:'active'},{handle:'suspended-user',status:'suspended'}]});
    if(path==='/api/collaboration/e2e-session/members'){
      if(request.method==='PUT'){
        let body='';for await(const chunk of request)body+=chunk;
        const {handle,permission}=JSON.parse(body);this.members=this.members.filter(member=>member.handle!==handle);
        if(permission)this.members.push({handle,permission});
      }
      return reply({can_manage:true,members:this.members});
    }
    if(path==='/api/devices')return reply({devices:[{device_id:'one',client_instance_id:'a',label:'Studio laptop',online:true,modules:['shell','editor','computer-control','agent-in-chrome'],last_seen_at:1700000000},{device_id:'two',client_instance_id:'b',label:'Home desktop',online:false,modules:['filesystem'],last_seen_at:1700000000}]});
    if(path==='/api/devices/computer-targets')return reply({
      host: {label:'Agent computer',platform:'Linux',desktop:'available'},
      targets:[{tool_ref:'exact-owner-desktop',label:'Agent host',agent_host:true,can_control:!this.live}],
    });
    if(path==='/api/scheduled-tasks')return reply({tasks:[{id:'legacy-task',name:'Historical report',prompt:'Report',cron_expression:'0 10 * * *',enabled:true}]});
    if(path==='/api/scheduled-tasks/legacy-task/runs')return reply({runs:[{id:'legacy-e2e',status:'success',started_at:1793527200,started_at_iso:'2026-11-01T10:00:00Z'}]});
    if(path==='/api/scheduled-runs/legacy-e2e')return reply({id:'legacy-e2e',task_id:'legacy-task',title:'Historical report',status:'success',output_summary_safe:'Saved report output',session_id:null,started_at:'2026-11-01T10:00:00Z',finished_at:'2026-11-01T10:01:00Z'});
    if(path==='/api/devices/computer') {
      let body='';for await(const chunk of request)body+=chunk;
      const call=JSON.parse(body);
      if(call.tool_ref!=='exact-owner-desktop'||call.action!=='get_screenshot')return reply({error:'wrong destination'},403);
      return reply({content:[{type:'text',text:JSON.stringify({image_width:800,image_height:450})},{type:'image',mimeType:'image/png',data:fixturePng()}]});
    }
    if(path==='/api/sessions/e2e-session/devices')return reply({devices:[{device_id:'one',client_instance_id:'a',label:'Studio laptop',first_used_at:1700000000,last_used_at:1700000001}]});
    if(path==='/api/sessions/e2e-session/participants')return reply({participants:[{id:'alice',handle:'alice',display:'Alice'}]});
    if(path==='/api/sessions/e2e-session/computer-targets')return reply({targets:[{tool_ref:'exact-agent-desktop',label:'Agent environment',...(this.live?{live_media:'openagent-video/1'}:{})}]});
    if(path==='/api/sessions/e2e-session/computer') {
      let body='';for await(const chunk of request)body+=chunk;
      const call=JSON.parse(body);this.calls.push(call);
      if(this.inputDelay && call.action!=='get_screenshot')await new Promise(resolve=>setTimeout(resolve,this.inputDelay));
      if(this.offline)return reply({error:'The exact computer is unavailable'},409);
      if(call.tool_ref!=='exact-agent-desktop')return reply({error:'wrong destination'},403);
      return reply({content:call.action==='get_screenshot'?[{type:'text',text:JSON.stringify({image_width:800,image_height:450})},{type:'image',mimeType:'image/png',data:fixturePng()}]:[]});
    }
    return super.handleHttp(request,response);
  }
}

for(const live of [false,true])test(`device directory, session inspector and responsive exact-computer control (${live?'video':'snapshot'})`,async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'openagent-device-ui-'));
  const userData=join(temporary,'profile');await mkdir(userData);
  const gateway=await new DeviceGateway({webRoot:resolve(ROOT,'../universal/dist'),accountId:'devices-test',networkId:'device-network',deviceId:'device-certificate',agentNodeId:'agent-node'}).start();
  gateway.live=live;
  gateway.runMessages=[{role:'user',text:'A shared conversation',timestamp:1700000000,author:{kind:'human',handle:'alice',display:'Alice'}}];
  let app;
  try {
    app=await electron.launch({...(process.env.OPENAGENT_E2E_ELECTRON_PATH ? {executablePath:process.env.OPENAGENT_E2E_ELECTRON_PATH} : {}),args:[ROOT,`--user-data-dir=${userData}`],cwd:ROOT,env:{...process.env,NODE_ENV:'test',OPENAGENT_DESKTOP_E2E:'1',OPENAGENT_DESKTOP_E2E_RENDERER_URL:`${gateway.baseUrl}/devices`,OPENAGENT_DESKTOP_E2E_LOOPBACK:JSON.stringify(gateway.loopbackConfig()),ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
    const page=await app.firstWindow();
    if(live)await page.clock.install();
    await page.setViewportSize({width:1440,height:960});
    await page.evaluate(async({port})=>{
      const account={id:'devices-test',name:'Device Test',network:'device-network',handle:'alice',agentHandle:'agent',isLocal:true,createdAt:Date.now()};
      await window.desktop.setItem('openagent:accounts',JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection',JSON.stringify({accountId:account.id,sidecarPort:port}));
    },{port:Number(new URL(gateway.baseUrl).port)});
    await page.reload();
    await page.getByRole('button',{name:'Devices',exact:true}).click();
    await expect(page.getByText('Studio laptop',{exact:true})).toBeVisible();
    await expect(page.getByText('Home desktop',{exact:true})).toBeVisible();
    await expect(page.getByText('Offline',{exact:true})).toBeVisible();
    await page.getByLabel('Open computer Agent host',{exact:true}).click();
    if (live) {
      await expect(page.getByRole('img',{name:'View Agent host',exact:true})).toBeVisible();
      await expect(page.getByText('View only',{exact:true})).toBeVisible();
      await expect(page.getByLabel('Remote keyboard capture',{exact:true})).toHaveCount(0);
    } else {
      await expect(page.getByLabel('Control Agent host. Click and type on the desktop.',{exact:true})).toBeVisible();
    }
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.screenshot({path:join(temporary,'devices-wide.png')});
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByText('Studio laptop',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Refresh devices',{exact:true})).toBeInViewport({ratio:1});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:join(temporary,'devices-narrow.png')});
    await page.setViewportSize({width:1440,height:960});
    await page.getByRole('button',{name:'Local capability E2E',exact:true}).click();
    await expect(page).toHaveURL(/\/chat\?session=e2e-session$/);
    await expect(page.getByText('A shared conversation',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Share session',exact:true})).toHaveCount(0);
    await page.getByLabel('Toggle session details',{exact:true}).click();
    await expect(page.getByText('Participants',{exact:true})).toBeVisible();
    await expect(page.getByText('Session details',{exact:true})).toHaveCount(0);
    await expect(page.getByText('Participated',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Share session',exact:true}).click();
    await page.getByRole('button',{name:'Select bob',exact:true}).click();
    await expect(page.getByLabel('Collaborator username',{exact:true})).toHaveValue('bob');
    await expect(page.getByRole('button',{name:'Select suspended-user',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Share with user',exact:true}).click();
    await expect(page.getByText('Can collaborate',{exact:true})).toBeVisible();
    expect(gateway.members).toEqual([{handle:'bob',permission:'admin'}]);
    await page.setViewportSize({width:390,height:844});
    await expect(page.getByLabel('Collaborator username',{exact:true})).toBeInViewport({ratio:1});
    await expect(page.getByLabel('Close sharing',{exact:true})).toBeInViewport({ratio:1});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Remove bob',exact:true}).click();
    await expect(page.getByText('Can collaborate',{exact:true})).toHaveCount(0);
    expect(gateway.members).toEqual([]);
    await page.getByLabel('Close sharing',{exact:true}).click();
    await page.setViewportSize({width:1440,height:960});

    await page.setViewportSize({width:800,height:600});
    await page.getByPlaceholder('Message OpenAgent...').fill('Responsive composer');
    const send=page.getByLabel('Send message',{exact:true});
    await expect.poll(async()=>send.evaluate(element=>{
      const rect=element.getBoundingClientRect();
      const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return !!hit && (hit===element || element.contains(hit));
    })).toBe(true);
    await page.getByPlaceholder('Message OpenAgent...').fill('');
    await page.setViewportSize({width:1440,height:960});
    if(live)await page.evaluate(()=>{
      const Native=globalThis.VideoDecoder;
      globalThis.VideoDecoder=class extends Native {
        get decodeQueueSize(){if(globalThis.__forceDesktopDecoderOverload){globalThis.__forceDesktopDecoderOverload=false;return 17;}return super.decodeQueueSize;}
      };
    });
    await page.getByLabel('Open computer Agent environment',{exact:true}).click();
    const screen=page.getByLabel('Control Agent environment. Click and type on the desktop.',{exact:true});
    await expect(screen).toBeVisible();
    if(live){
      await expect.poll(()=>page.locator('canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(10,10,1,1).data[3])).toBe(255);
      expect(gateway.calls.filter(c=>c.action==='get_screenshot')).toHaveLength(0);
    }else{
      await page.getByRole('button',{name:'Pause view',exact:true}).click();
      await expect.poll(()=>gateway.calls.filter(c=>c.action==='get_screenshot').length).toBeGreaterThan(0);
    }
    await expect(page.getByRole('button',{name:'Send text',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Right click',exact:true})).toHaveCount(0);
    await screen.click({position:{x:70,y:40}});
    // Reproduce an opening Modal restoring focus after the first pointer
    // event. The user's first characters must still reach the exact computer.
    await page.getByRole('button',{name:'Close',exact:true}).evaluate(element=>element.focus());
    await expect(page.getByLabel('Remote keyboard capture',{exact:true})).toBeFocused();
    await page.keyboard.type('Hello from the viewer');
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='type').map(c=>c.text).join('')).toBe('Hello from the viewer');
    const burstStart=gateway.calls.length;
    const burst='Fast exact desktop input '.repeat(9);
    gateway.inputDelay=150;
    await page.keyboard.type(burst);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(()=>gateway.calls.slice(burstStart).filter(c=>c.action==='type').map(c=>c.text).join('')).toBe(burst);
    await expect.poll(()=>gateway.calls.slice(burstStart).some(c=>c.action==='key'&&c.text==='Left')).toBe(true);
    const burstCalls=gateway.calls.slice(burstStart);
    expect(burstCalls.filter(c=>c.action==='type').length).toBeLessThan(32);
    expect(burstCalls.findIndex(c=>c.action==='key'&&c.text==='Left')).toBeGreaterThan(burstCalls.map(c=>c.action).lastIndexOf('type'));
    gateway.inputDelay=0;
    const clipboardText='Clipboard text Ω\nSecond line';
    await app.evaluate(({clipboard},text)=>clipboard.writeText(text),clipboardText);
    const pasteStart=gateway.calls.length;
    await page.keyboard.press(process.platform==='darwin'?'Meta+v':'Control+v');
    await expect.poll(()=>gateway.calls.slice(pasteStart).filter(c=>c.action==='type').map(c=>c.text).join('')).toBe(clipboardText);
    expect(gateway.calls.slice(pasteStart).some(c=>c.action==='key'&&/^(?:ctrl|super)\+v$/i.test(c.text))).toBe(false);
    for(const modifier of ['ctrlKey','metaKey'])expect(await screen.evaluate((element,modifier)=>{
      const event=new KeyboardEvent('keydown',{key:'v',[modifier]:true,bubbles:true,cancelable:true});
      element.dispatchEvent(event);return event.defaultPrevented;
    },modifier)).toBe(false);
    await screen.click({position:{x:100,y:50}});
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='left_click').length).toBe(2);
    await screen.click({button:'right',position:{x:120,y:70}});
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='right_click').length).toBe(1);
    await screen.dblclick({position:{x:140,y:80}});
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='double_click').length).toBe(1);
    await screen.hover({position:{x:150,y:90}});await page.mouse.wheel(0,180);
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='scroll').length).toBeGreaterThan(0);
    const area=await screen.boundingBox();await page.mouse.move(area.x+30,area.y+30);await page.mouse.down();await page.mouse.move(area.x+90,area.y+80,{steps:4});await page.mouse.up();
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='left_click_drag').length).toBe(1);
    await screen.press('ArrowRight');
    await expect.poll(()=>gateway.calls.some(c=>c.action==='key'&&c.text==='Right')).toBe(true);
    await screen.press('Escape');
    await expect(screen).toBeVisible();
    await expect.poll(()=>gateway.calls.some(c=>c.action==='key'&&c.text==='Escape')).toBe(true);
    await page.keyboard.press('Control+Shift+t');
    await expect.poll(()=>gateway.calls.some(c=>c.action==='key'&&c.text==='ctrl+shift+t')).toBe(true);
    expect(gateway.calls.some(c=>c.action==='key'&&c.text==='ctrl+shift+T')).toBe(false);
    await page.screenshot({path:join(temporary,'computer-wide.png')});
    await page.setViewportSize({width:390,height:844});
    await expect(screen).toBeVisible();
    await expect.poll(async()=>{const bounds=await screen.boundingBox();return bounds.x>=0&&bounds.x+bounds.width<=390;}).toBe(true);
    await page.screenshot({path:join(temporary,'computer-narrow.png')});
    if(live){
      const mutations=gateway.calls.filter(call=>!['get_screenshot','mouse_move'].includes(call.action)).length;
      await page.evaluate(()=>{globalThis.__forceDesktopDecoderOverload=true;});
      await expect.poll(()=>gateway.streamHellos.length).toBe(2);
      expect(gateway.streamHellos.map(hello=>hello.tool_ref)).toEqual(['exact-agent-desktop','exact-agent-desktop']);
      expect(gateway.streamHellos.map(hello=>hello.options.fps)).toEqual([20,10]);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect.poll(()=>page.locator('canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(10,10,1,1).data[3])).toBe(255);
      expect(gateway.calls.filter(call=>!['get_screenshot','mouse_move'].includes(call.action)).length).toBe(mutations);
      await page.clock.fastForward(270_001);
      await expect.poll(()=>gateway.streamHellos.length).toBe(3);
      expect(gateway.streamHellos[2]).toEqual({tool_ref:'exact-agent-desktop',options:{fps:10,max_duration_seconds:300}});
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect.poll(()=>page.locator('canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(10,10,1,1).data[3])).toBe(255);
      expect(gateway.calls.filter(call=>!['get_screenshot','mouse_move'].includes(call.action)).length).toBe(mutations);
    }
    gateway.offline=true;
    await screen.press('Enter');
    await expect(page.getByRole('alert')).toContainText('unavailable');
    const failedCount=gateway.calls.length;
    await page.waitForTimeout(1800);
    expect(gateway.calls.length).toBe(failedCount);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await expect(screen).not.toBeVisible();
    expect(gateway.calls.every(c=>c.tool_ref==='exact-agent-desktop')).toBe(true);
    if(live){await expect.poll(()=>gateway.streamCloses).toBe(3);expect(gateway.calls.some(c=>c.action==='get_screenshot')).toBe(false);}
    await page.setViewportSize({width:1440,height:960});
    await page.getByRole('button',{name:'New session',exact:true}).click();
    await expect(page.getByText('Send the first message to start this session.',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Open computer Agent host',{exact:true})).toBeVisible();
    await expect(page.getByText('Devices used in this session',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Share session',exact:true})).toHaveCount(0);
    await expect(page.getByText('Update the agent server to use connected computers.',{exact:true})).toHaveCount(0);
    expect(gateway.draftRequests).toEqual([]);
    let releaseTurn;
    gateway.heldTurn=new Promise(resolve=>{releaseTurn=resolve;});
    const message='Start this session';
    const bubble=page.getByTestId('oa-user-message').filter({hasText:message});
    await page.getByPlaceholder('Message OpenAgent...').fill(message);
    await page.getByLabel('Send message',{exact:true}).click();
    await expect(bubble).toHaveCount(1);
    await expect(page.getByText('Session started',{exact:true})).toHaveCount(0);
    releaseTurn();
    await expect(page.getByText('Session started',{exact:true})).toBeVisible();
    await expect(bubble).toHaveCount(1);
    await expect(page.getByRole('status',{name:'Agent is working'})).toBeVisible();
    const timeline = page.getByText('Session started', { exact: true })
      .or(page.getByText('Timeline Probe', { exact: true }))
      .or(page.getByText('Check complete', { exact: true }));
    await expect(timeline).toHaveText(['Session started', 'Timeline Probe', 'Check complete']);
    await expect(page.getByText('Send the first message to start this session.',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Share session',exact:true})).toBeVisible();
    await expect(page.getByLabel('Open computer Agent environment',{exact:true})).toBeVisible();
    if (!live) {
      gateway.heldTurn=new Promise(resolve=>{releaseTurn=resolve;});
      await page.getByPlaceholder('Message OpenAgent...').fill(message);
      await page.getByLabel('Send message',{exact:true}).click();
      await expect(bubble).toHaveCount(2);
      await expect(page.getByText('Session started',{exact:true})).toHaveCount(1);
      releaseTurn();
      await expect(page.getByText('Session started',{exact:true})).toHaveCount(2);
      await expect(bubble).toHaveCount(2);
      expect(gateway.receivedTurns.map(turn=>turn.delivery)).toEqual(['steer','steer']);
      expect(new Set(gateway.receivedTurns.map(turn=>turn.request_id)).size).toBe(2);
      await page.getByRole('button',{name:'Scheduled',exact:true}).click();
      await page.getByLabel('Run history for Historical report',{exact:true}).click();
      await page.getByLabel('Open scheduled run 2026-11-01T10:00:00Z',{exact:true}).click();
      await expect(page.getByText('Saved report output',{exact:true})).toBeVisible();
      const agentHost = page.getByRole('button',{name:'Open computer Agent host',exact:true});
      if (!(await agentHost.isVisible())) {
        await page.getByLabel('Toggle session details',{exact:true}).click();
      }
      await agentHost.click();
      await expect(page.getByLabel('Control Agent host. Click and type on the desktop.',{exact:true})).toBeVisible();
    }
    // Screenshots are retained separately by the task; the isolated profile is disposable.
    const {copyFile,mkdir:make}=await import('node:fs/promises');
    const evidence=process.env.OPENAGENT_DEVICE_UI_EVIDENCE;
    if(evidence){await make(evidence,{recursive:true});for(const name of ['devices-wide','devices-narrow','computer-wide','computer-narrow'])await copyFile(join(temporary,name+'.png'),join(evidence,name+'.png'));}
  }finally{if(app)await app.close().catch(()=>{});await gateway.close();await rm(temporary,{recursive:true,force:true});}
});
