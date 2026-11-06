import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { VideoCanvasDecoder } from '@openagent/desktop-tools/video';
import type { ComputerFrame, ComputerTarget } from '../../common/devices';
import { recoverDesktopMedia, type DesktopMediaRecovery } from '../../common/desktop-media-recovery';
import { apiUrl } from '../services/api';
import ComputerSurface, { type ComputerSurfaceProps } from './ComputerSurface';
import { colors } from '../theme';

type Props = { sessionId:string;target:ComputerTarget;width:number;paused:boolean;send:ComputerSurfaceProps['send'];onFrame:(frame:ComputerFrame)=>void;onError:(message:string)=>void };
export default function ComputerMedia({sessionId,target,width,paused,send,onFrame,onError}:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const [geometry,setGeometry]=useState<ComputerFrame|null>(null);
  const recovery=useRef<DesktopMediaRecovery>({fps:20,generation:0,restarts:[]});
  const [generation,setGeneration]=useState(0);
  useEffect(()=>{
    if(paused)return;
    let alive=true,queued=0,tail=Promise.resolve();
    const url=new URL(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/computer-stream`),window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(url.href);
    let decoder:VideoCanvasDecoder;
    const fail=(message:string)=>{
      if(!alive)return;
      alive=false;ws.close();decoder?.close();
      const next=recoverDesktopMedia(recovery.current,performance.now(),message);
      if(next){recovery.current=next;setGeneration(next.generation);}
      else onError(message);
    };
    decoder=new VideoCanvasDecoder(()=>canvas.current,packet=>{
      const frame={uri:'',width:packet.width,height:packet.height,input_width:packet.input_width,input_height:packet.input_height};
      setGeometry(frame);onFrame(frame);
    },fail);
    ws.onopen=()=>{if(alive)ws.send(JSON.stringify({tool_ref:target.tool_ref,options:{fps:recovery.current.fps,max_duration_seconds:300}}));};
    ws.onmessage=event=>{
      if(!alive)return;
      if(typeof event.data!=='string'||event.data.length>2*1024*1024){fail('Invalid desktop video packet. Reopen the view.');return;}
      if(++queued>16){fail('The desktop connection is too slow. Reopen the view.');return;}
      tail=tail.then(async()=>{
        if(!alive)return;
        const raw=JSON.parse(event.data);if(raw.type==='error')throw new Error(raw.message||'Desktop unavailable');
        await decoder.accept(raw);
      }).catch(error=>fail(error instanceof Error?error.message:'Desktop unavailable')).finally(()=>{queued--;});
    };
    ws.onerror=()=>fail('Desktop connection unavailable.');
    ws.onclose=()=>{if(alive)onError('Desktop disconnected. Reopen or resume the view.');};
    return()=>{alive=false;ws.close();decoder.close();};
  },[sessionId,target.tool_ref,paused,onFrame,onError,generation]);
  if(!geometry)return <Text style={{color:colors.textMuted,padding:32}}>Connecting to desktop…</Text>;
  return <ComputerSurface frame={geometry} width={width} label={target.label} send={send}>
    <canvas ref={canvas} style={{display:'block',width:'100%',height:'100%',pointerEvents:'none'}} />
  </ComputerSurface>;
}
