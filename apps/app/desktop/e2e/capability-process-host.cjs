// Owned qualification host. The test server supplies the certificate-ingress seam.
const {CapabilitySocket}=require('../dist/capabilities/capability-socket');
const {ComputerExecutor,nativeHelper}=require('@openagent/desktop-tools');
const [url,device]=process.argv.slice(2);
const executor=new ComputerExecutor(nativeHelper().command);
let socket;
(async()=>{
 await executor.start();
 socket=new CapabilitySocket({accountId:'fixture',trustedAccountId:'network',trustedDeviceId:device,
  url,clientInstanceId:'process',deviceLabel:device,reconnect:false,
  getOffer:()=>({generation:1,servers:[{name:'shell',tools:[{name:'exec',classification:'mutating',input_schema:{type:'object',properties:{command:{type:'string'}},required:['command']}}]}]}),
  invoke:async(call,signal)=>({content:[{type:'text',text:JSON.stringify(await executor.invoke({tool:'shell',args:call.args},signal))}]})});
 socket.start();
})().catch(()=>{executor.stop();process.exit(1);});
process.on('SIGTERM',()=>{socket?.stop();executor.stop();process.exit(0);});
