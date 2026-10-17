// Actual component source with mocked transport/UI primitives: source-unit evidence only.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),ts=require('typescript');
const React=require('react'),Renderer=require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true;
const {act}=Renderer;
const root=path.resolve(process.argv[2]||path.join(__dirname,'../..'));
const receiptFile=process.argv[3]?path.resolve(process.argv[3]):null;
function writeReceipt(value){if(receiptFile)fs.writeFileSync(receiptFile,JSON.stringify(value,null,2)+'\n');}
const component='apps/app/universal/components/mcps/OfficialConnectorsPane.tsx';
const apiFile='apps/app/universal/services/api.ts';
for(const file of [component,apiFile]) {
 const result=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,reportDiagnostics:true,compilerOptions:{jsx:ts.JsxEmit.React,esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
 assert.equal((result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,'TS syntax diagnostic');
}
const config=id=>({sidecarPort:id==='A'?51001:51002,network:id,handle:'owner',agentHandle:'agent'});
let state={config:config('A'),activeAccountId:'account-A'};const listeners=new Set();
function useConnection(selector) {return React.useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>selector(state));}
useConnection.getState=()=>state;
function host(name){return props=>React.createElement(name,props,props.children)}
const connector={id:'atlassian',name:'Atlassian',description:'QA',auth:'oauth',category:'Productivity',provider:'atlassian',capability:'files',available:true,readTools:['files.atlassian.resources.list'],agentTools:['files.atlassian.issues.update']};
let connection={id:'conn-A',catalog_id:'atlassian',display_name:'QA connection',status:'connected',enabled:true,allow_write:false,created_at:'2026-10-16T00:00:00Z'};
let siteImpl,refreshImpl,updateImpl,pollImpl,connectImpl;let calls,opened;
function resetApi(){opened=[];connectImpl=async()=>({connection,authorization_url:'https://auth.openagent.uno/authorize/'+'a'.repeat(43),expires_at:'2099-01-01T00:00:00Z'});calls={sites:0,refresh:0,update:0,select:0,poll:0};siteImpl=async()=>({sites:[{id:'site-A',name:'Old Jira',url:'https://qa.atlassian.net',scopes:['read:jira-work']}],selected_cloud_id:null});refreshImpl=async()=>({status:'connected',connection});updateImpl=async body=>{connection={...connection,...body};return connection};pollImpl=async()=>({status:'pending'});}
const api={catalog:async()=>({available:true,connectors:[connector]}),list:async()=>({available:true,connections:[connection]}),sites:async()=>{calls.sites++;return siteImpl()},refreshToken:async()=>{calls.refresh++;return refreshImpl()},update:async(id,body)=>{calls.update++;return updateImpl(body)},selectSite:async()=>{calls.select++;return {ok:true}},disconnect:async()=>{connection={...connection,status:'disconnected'}},connect:async()=>connectImpl(),poll:async()=>{calls.poll++;return pollImpl()}};
const imports={react:React,'react-native':{ActivityIndicator:host('spinner'),Linking:{openURL:async url=>{opened.push(url)}},Platform:{OS:'linux'},Pressable:host('pressable'),StyleSheet:{create:x=>x},Switch:host('switch'),Text:host('text'),TextInput:host('input'),View:host('view')},'../../services/api':{officialConnectorsAPI:api},'../../theme':{colors:{},radius:{}},'./MarketplaceTile':{default:host('tile')},'./ConnectorLogo':{default:host('logo')},'../Button':{default:host('button')},'./MarketplaceGrid':{default:host('grid')},'../../stores/connection':{useConnection}};
for(const k of ['./MarketplaceTile','./ConnectorLogo','../Button','./MarketplaceGrid'])imports[k].__esModule=true;
const compiled=ts.transpileModule(fs.readFileSync(path.join(root,component),'utf8'),{fileName:component,compilerOptions:{jsx:ts.JsxEmit.React,esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};new Function('require','module','exports',compiled)(name=>{assert.ok(name in imports,'Unexpected dependency '+name);return imports[name]},mod,mod.exports);
const Pane=mod.exports.default;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
let view;
async function flush(){await act(async()=>{await new Promise(setImmediate)})}
async function mount(){resetApi();state={config:config('A'),activeAccountId:'account-A'};connection={...connection,status:'connected',allow_write:false};await act(async()=>{view=Renderer.create(React.createElement(Pane))});await flush();await act(async()=>{view.root.findByType('tile').props.onManage()});}
const buttons=label=>view.root.findAllByType('button').filter(x=>x.props.label===label);
const presses=label=>view.root.findAllByType('pressable').filter(x=>x.findAllByType('text').some(t=>t.props.children===label));
async function fire(node){await act(async()=>{node.props.onPress();await Promise.resolve()})}
async function changeTarget(id){await act(async()=>{state={config:config(id),activeAccountId:'account-'+id};for(const listener of listeners)listener()});await flush()}
async function unmount(){await act(async()=>view.unmount())}
const passed=[];
(async()=>{
 await mount();const pending=deferred();siteImpl=()=>pending.promise;await fire(buttons('Choose Jira site')[0]);
 assert.equal(calls.sites,1);assert.equal(presses('Refresh access')[0].props.disabled,true);assert.ok(view.root.findAllByType('switch').every(x=>x.props.disabled===true));
 await fire(presses('Refresh access')[0]);assert.equal(calls.refresh,0,'busy owner must reject another action even before re-render');
 pending.resolve({sites:[{id:'site-A',name:'Old Jira',url:'https://qa.atlassian.net',scopes:[]}],selected_cloud_id:null});await flush();assert.equal(buttons('Old Jira').length,1);assert.equal(presses('Refresh access')[0].props.disabled,false);
 passed.push('site-read-serializes-other-management-actions');
 const changed=deferred();updateImpl=()=>changed.promise;await act(async()=>{view.root.findAllByType('switch').find(x=>x.props.accessibilityLabel.startsWith('Allow changes')).props.onValueChange(true)});assert.equal(buttons('Old Jira').length,0,'permission change must clear old selectable sites');changed.resolve(connection);await flush();passed.push('permission-change-invalidates-site-cache');await unmount();
 await mount();const stale=deferred();siteImpl=()=>stale.promise;await fire(buttons('Choose Jira site')[0]);await changeTarget('B');await changeTarget('A');await act(async()=>view.root.findByType('tile').props.onManage());stale.resolve({sites:[{id:'stale',name:'Stale Jira',url:'https://qa.atlassian.net',scopes:[]}],selected_cloud_id:null});await flush();assert.equal(buttons('Stale Jira').length,0);assert.equal(presses('Refresh access')[0].props.disabled,false);passed.push('roundtrip-target-switch-drops-old-sites-response');await unmount();
 await mount();const oldPoll=deferred();pollImpl=()=>oldPoll.promise;await fire(presses('Reconnect')[0]);assert.equal(calls.poll,1);assert.equal(presses('Stop waiting').length,1);await fire(presses('Stop waiting')[0]);const fresh=deferred();refreshImpl=()=>fresh.promise;await fire(presses('Refresh access')[0]);assert.equal(calls.refresh,1);assert.equal(presses('Refresh access')[0].props.disabled,true);oldPoll.resolve({status:'connected'});await flush();assert.equal(presses('Refresh access')[0].props.disabled,true,'obsolete OAuth finally must not release new action');fresh.resolve({status:'connected',connection});await flush();assert.equal(presses('Refresh access')[0].props.disabled,false);passed.push('stop-waiting-preserves-new-operation-busy-owner');await unmount();
 const allowed=['https://accounts.google.com','https://app.clickup.com','https://platform.postiz.com','https://github.com','https://api.notion.com','https://slack.com','https://auth.atlassian.com'];
 for(const origin of allowed){await mount();const url=origin+'/oauth/authorize?state=opaque';connectImpl=async()=>({connection,authorization_mode:'own-app',authorization_url:url,expires_at:'2099-01-01T00:00:00Z'});pollImpl=async()=>({status:'connected'});await fire(presses('Reconnect')[0]);await flush();assert.deepEqual(opened,[url]);assert.equal(calls.poll,1);await unmount();}
 passed.push('own-app-seven-exact-reviewed-origins');
 const rejected=['http://github.com/login/oauth/authorize','https://github.com.evil.example/authorize','https://github.com@evil.example/authorize','https://user@github.com/authorize','https://api.notion.com.evil.example/authorize','https://slack.com.evil.example/authorize','https://auth.atlassian.com.evil.example/authorize','https://unreviewed.example/authorize','https://github.com/login/oauth/authorize#fragment'];
 for(const url of rejected){await mount();connectImpl=async()=>({connection,authorization_mode:'own-app',authorization_url:url,expires_at:'2099-01-01T00:00:00Z'});await fire(presses('Reconnect')[0]);await flush();assert.deepEqual(opened,[]);assert.equal(calls.poll,0);await unmount();}
 passed.push('own-app-nine-unsafe-urls-rejected-before-browser-or-poll');
 for(const provider of ['exa','firecrawl','parallel-search','context7','coingecko']){
  resetApi();state={config:config('A'),activeAccountId:'account-A'};
  Object.assign(connector,{id:provider,name:provider,auth:'none',provider:provider==='parallel-search'?'parallel_search':provider,capability:'files',readTools:[({exa:'files.exa.search',firecrawl:'files.firecrawl.search','parallel-search':'files.parallel.search',context7:'files.context7.query_docs',coingecko:'files.coingecko.global'})[provider]],agentTools:[]});
  let connected=false;const created=[];
  api.catalog=async()=>({available:true,connectors:[connector]});
  api.list=async()=>({available:true,connections:connected?[connection]:[]});
  api.create=async body=>{created.push(JSON.parse(JSON.stringify(body)));connected=true;connection={id:'keyless-A',catalog_id:provider,display_name:provider,status:'connected',enabled:true,allow_write:false,app_id:null,created_at:'2026-10-17T00:00:00Z'};return {connection}};
  await act(async()=>{view=Renderer.create(React.createElement(Pane,{registryResults:[{name:'public-registry-mcp',title:'Registry MCP',description:'QA'}]}))});await flush();
  const tiles=view.root.findAllByType('tile');assert.equal(tiles.length,2,'keyless official and registry cards use the same MarketplaceTile');
  await act(async()=>tiles.find(x=>x.props.card.name===provider).props.onInstall());
  assert.equal(view.root.findAllByType('input').length,0,'keyless setup has no token/account form');
  await fire(presses('Connect')[0]);await flush();
  assert.deepEqual(created,[{catalog_id:provider,allow_write:false,config:{}}]);
  assert.deepEqual(opened,[]);assert.equal(calls.poll,0,'keyless connection never starts OAuth');
  assert.equal(view.root.findAllByType('tile').find(x=>x.props.card.name===provider).props.installed,true);
  await act(async()=>view.root.findAllByType('tile').find(x=>x.props.card.name===provider).props.onManage());
  assert.equal(presses('Reconnect').length,0);assert.equal(presses('Refresh access').length,0);
  assert.equal(buttons('Add another connection').length,1);
  await act(async()=>view.root.findAllByType('switch')[0].props.onValueChange(false));await flush();
  assert.equal(calls.update,1);assert.equal(connection.enabled,false);
  await fire(presses('Disconnect from this server')[0]);await flush();assert.equal(connection.status,'disconnected');
  await unmount();
 }
 passed.push('five-keyless-connectors-reuse-marketplace-without-credentials-or-oauth');
 const marks=JSON.parse(fs.readFileSync(path.join(root,'apps/app/universal/assets/connectors/sources.json'),'utf8'));
 const logo=fs.readFileSync(path.join(root,'apps/app/universal/components/mcps/ConnectorLogo.tsx'),'utf8');
 const vectors=fs.readFileSync(path.join(root,'apps/app/universal/components/mcps/connector-vectors.ts'),'utf8');
 const origins={exa:'https://exa.ai/',firecrawl:'https://www.firecrawl.dev/','parallel-search':'https://parallel.ai/',context7:'https://context7.com/',coingecko:'https://static.coingecko.com/'};
 for(const provider of Object.keys(origins)){
  const mark=marks.find(x=>x.id===provider);assert.ok(mark);assert.ok(mark.source.startsWith(origins[provider]));
  const bytes=fs.readFileSync(path.join(root,'apps/app/universal/assets/connectors',mark.file));
  assert.equal(require('crypto').createHash('sha256').update(bytes).digest('hex'),mark.sha256);
  if(mark.file.endsWith('.png'))assert.ok(logo.includes(`require('../../assets/connectors/${provider}.png')`));
  else assert.ok(vectors.includes(JSON.stringify(bytes.toString('utf8'))));
 }
 passed.push('five-keyless-provider-marks-match-official-provenance');
 const receipt={status:'PASS',scope:'actual TS/TSX syntax transpile and actual React component with mocked RN/transport; not native/GUI/provider acceptance',tests:passed,transpiled_files:[component,apiFile],react:require('react/package.json').version,typescript:ts.version};writeReceipt(receipt);console.log(JSON.stringify({status:'PASS',component_tests:passed.length}));
})().catch(async error=>{writeReceipt({status:'FAIL',failure_class:error.constructor.name,scope:'source component test; no native acceptance'});console.error(error);process.exitCode=1});
