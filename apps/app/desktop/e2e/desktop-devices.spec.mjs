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
  calls=[]; offline=false; live=false; streamCloses=0; members=[];
  async start(){
    await super.start();const original=this.server.listeners('upgrade');this.server.removeAllListeners('upgrade');
    this.videoServer=new WebSocketServer({noServer:true});
    this.collaborationServer=new WebSocketServer({noServer:true});
    this.server.on('upgrade',(request,socket,head)=>{
      if(new URL(request.url,this.baseUrl).pathname==='/ws/collaboration'){
        this.collaborationServer.handleUpgrade(request,socket,head,ws=>ws.send(JSON.stringify({type:'auth_ok',shared:true})));return;
      }
      if(new URL(request.url,this.baseUrl).pathname==='/api/sessions/e2e-session/computer-stream'){
        this.videoServer.handleUpgrade(request,socket,head,ws=>{
          let timer;ws.once('message',raw=>{const hello=JSON.parse(raw);if(hello.tool_ref!=='exact-agent-desktop'){ws.close();return;}
            ws.send(JSON.stringify(VIDEO.config));let seq=0;timer=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'frame',seq:seq++,timestamp_us:seq*50000,key:true,data:VIDEO.data}));},50);});
          ws.on('close',()=>{clearInterval(timer);this.streamCloses++;});
        });return;
      }
      for(const listener of original)listener(request,socket,head);
    });return this;
  }
  async close(){for(const server of [this.videoServer,this.collaborationServer]){for(const socket of server?.clients||[])socket.terminate();server?.close();}await super.close();}
  async handleHttp(request,response) {
    const path=new URL(request.url,'http://fixture').pathname;
    const reply=(value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));};
    if(path==='/api/collaboration')return reply({version:1});
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
    if(path==='/api/sessions/e2e-session/devices')return reply({devices:[{device_id:'one',client_instance_id:'a',label:'Studio laptop',first_used_at:1700000000,last_used_at:1700000001}]});
    if(path==='/api/sessions/e2e-session/participants')return reply({participants:[{id:'alice',handle:'alice',display:'Alice'}]});
    if(path==='/api/sessions/e2e-session/computer-targets')return reply({targets:[{tool_ref:'exact-agent-desktop',label:'Agent environment',...(this.live?{live_media:'openagent-video/1'}:{})}]});
    if(path==='/api/sessions/e2e-session/computer') {
      let body='';for await(const chunk of request)body+=chunk;
      const call=JSON.parse(body);this.calls.push(call);
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
    await page.setViewportSize({width:1440,height:960});
    await page.evaluate(async({port})=>{
      const account={id:'devices-test',name:'Device Test',network:'device-network',handle:'alice',agentHandle:'agent',isLocal:true,createdAt:Date.now()};
      await window.desktop.setItem('openagent:accounts',JSON.stringify([account]));
      await window.desktop.setItem('openagent:activeConnection',JSON.stringify({accountId:account.id,sidecarPort:port}));
    },{port:Number(new URL(gateway.baseUrl).port)});
    await page.reload();
    await expect(page.getByText('Studio laptop',{exact:true})).toBeVisible();
    await expect(page.getByText('Home desktop',{exact:true})).toBeVisible();
    await expect(page.getByText('Offline',{exact:true})).toBeVisible();
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
    await page.keyboard.type('Hello from the viewer');
    await expect.poll(()=>gateway.calls.filter(c=>c.action==='type').map(c=>c.text).join('')).toBe('Hello from the viewer');
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
    await expect.poll(()=>gateway.calls.find(c=>c.action==='key')?.text).toBe('Right');
    await page.screenshot({path:join(temporary,'computer-wide.png')});
    await page.setViewportSize({width:390,height:844});
    await expect(screen).toBeVisible();
    await expect.poll(async()=>{const bounds=await screen.boundingBox();return bounds.x>=0&&bounds.x+bounds.width<=390;}).toBe(true);
    await page.screenshot({path:join(temporary,'computer-narrow.png')});
    gateway.offline=true;
    await screen.press('Enter');
    await expect(page.getByRole('alert')).toContainText('unavailable');
    const failedCount=gateway.calls.length;
    await page.waitForTimeout(1800);
    expect(gateway.calls.length).toBe(failedCount);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await expect(screen).not.toBeVisible();
    expect(gateway.calls.every(c=>c.tool_ref==='exact-agent-desktop')).toBe(true);
    if(live){await expect.poll(()=>gateway.streamCloses).toBe(1);expect(gateway.calls.some(c=>c.action==='get_screenshot')).toBe(false);}
    // Screenshots are retained separately by the task; the isolated profile is disposable.
    const {copyFile,mkdir:make}=await import('node:fs/promises');
    const evidence=process.env.OPENAGENT_DEVICE_UI_EVIDENCE;
    if(evidence){await make(evidence,{recursive:true});for(const name of ['devices-wide','devices-narrow','computer-wide','computer-narrow'])await copyFile(join(temporary,name+'.png'),join(evidence,name+'.png'));}
  }finally{if(app)await app.close().catch(()=>{});await gateway.close();await rm(temporary,{recursive:true,force:true});}
});
