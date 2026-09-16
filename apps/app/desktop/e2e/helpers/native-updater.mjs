import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';

/** Main-process integration harness; it never alters the signed application. */
export class NativeUpdaterApp extends EventEmitter {
  static async launch({executablePath,args,env,timeout=30_000}) {
    const instance = new NativeUpdaterApp();
    instance.pending = new Map();
    instance.sequence = 0;
    instance.stderr = "";
    instance.child = spawn(executablePath,['--inspect=0',...args],{env,stdio:['ignore','ignore','pipe']});
    instance.child.once('exit',()=>{
      for(const pending of instance.pending.values()){
        clearTimeout(pending.timer);pending.reject(new Error('Native updater process exited'));
      }
      instance.pending.clear();instance.emit('close');
    });
    instance.exit = once(instance.child,'exit');
    try {
    const endpoint = await new Promise((resolve,reject)=>{
      let output='';
      const timer=setTimeout(()=>reject(new Error('Native updater inspector did not start')),timeout);
      instance.child.stderr.on('data',chunk=>{
        output=(output+chunk).slice(-16_384);
        instance.stderr = output;
        const match=/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(output);
        if(match){clearTimeout(timer);resolve(match[1]);}
      });
      instance.child.once('error',error=>{clearTimeout(timer);reject(error);});
      instance.child.once('exit',()=>{clearTimeout(timer);reject(new Error('Native updater exited before inspector startup'));});
    });
    instance.socket = new WebSocket(endpoint);
    instance.socket.addEventListener('message',event=>{
      const response=JSON.parse(String(event.data));
      const pending=instance.pending.get(response.id);
      if(!pending)return;
      instance.pending.delete(response.id);clearTimeout(pending.timer);
      if(response.error)pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
    await new Promise((resolve,reject)=>{
      instance.socket.addEventListener('open',resolve,{once:true});
      instance.socket.addEventListener('error',reject,{once:true});
    });
    await instance.send('Runtime.enable',{});
    return instance;
    } catch (error) {
      instance.socket?.close();
      if(instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGTERM');
      throw error;
    }
  }

  send(method,params) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Native updater ${method} deadline exceeded`));},180_000);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }

  async evaluate(callback,argument) {
    const expression=`(async()=>{const require=process.getBuiltinModule('node:module').createRequire(process.execPath); const electron=require('electron'); await electron.app.whenReady(); return (${callback.toString()})(electron,${JSON.stringify(argument)});})()`;
    const response=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }

  waitForEvent(event) {
    if(event!=='close')throw new Error('Only application close is supported');
    // Electron waits for the Node inspector to detach during process exit.
    const socket=this.socket;
    const timer=setTimeout(()=>socket.close(),500);
    return this.exit.finally(()=>clearTimeout(timer));
  }

  async close() {
    if(this.child.exitCode!==null || this.child.signalCode!==null)return;
    try { await this.evaluate(({app})=>{setTimeout(()=>app.quit(),25);}); } catch {}
    this.socket?.close();
    const timer=setTimeout(()=>this.child.kill('SIGTERM'),5000);
    const hard=setTimeout(()=>this.child.kill('SIGKILL'),10_000);
    try { await this.exit; } finally {clearTimeout(timer);clearTimeout(hard);}
  }
}
