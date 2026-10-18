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
let siteImpl,refreshImpl,updateImpl,pollImpl,connectImpl,microsoftImpl,bindSiteImpl,bindDriveImpl;let calls,opened;
function resetApi(){opened=[];connectImpl=async()=>({connection,authorization_url:'https://auth.openagent.uno/authorize/'+'a'.repeat(43),expires_at:'2099-01-01T00:00:00Z'});calls={sites:0,refresh:0,update:0,select:0,poll:0,microsoft:[],bindSite:[],bindDrive:[]};microsoftImpl=async()=>({items:[],selected_site_id:null,selected_drive_id:null});bindSiteImpl=async()=>({ok:true,selected_site_id:"site-2",selected_drive_id:null});bindDriveImpl=async()=>({ok:true,selected_site_id:null,selected_drive_id:"drive-2"});siteImpl=async()=>({sites:[{id:'site-A',name:'Old Jira',url:'https://qa.atlassian.net',scopes:['read:jira-work']}],selected_cloud_id:null});refreshImpl=async()=>({status:'connected',connection});updateImpl=async body=>{connection={...connection,...body};return connection};pollImpl=async()=>({status:'pending'});}
const api={microsoftResources:async(id,body)=>{calls.microsoft.push({id,body:JSON.parse(JSON.stringify(body))});return microsoftImpl(id,body)},selectMicrosoftSite:async(id,body)=>{calls.bindSite.push({id,body:JSON.parse(JSON.stringify(body))});return bindSiteImpl(id,body)},selectMicrosoftDrive:async(id,body)=>{calls.bindDrive.push({id,body:JSON.parse(JSON.stringify(body))});return bindDriveImpl(id,body)},catalog:async()=>({available:true,connectors:[connector]}),list:async()=>({available:true,connections:[connection]}),sites:async()=>{calls.sites++;return siteImpl()},refreshToken:async()=>{calls.refresh++;return refreshImpl()},update:async(id,body)=>{calls.update++;return updateImpl(body)},selectSite:async()=>{calls.select++;return {ok:true}},disconnect:async()=>{connection={...connection,status:'disconnected'}},connect:async()=>connectImpl(),poll:async()=>{calls.poll++;return pollImpl()}};
const imports={react:React,'react-native':{ActivityIndicator:host('spinner'),Linking:{openURL:async url=>{opened.push(url)}},Platform:{OS:'linux'},Pressable:host('pressable'),StyleSheet:{create:x=>x},Switch:host('switch'),Text:host('text'),TextInput:host('input'),View:host('view')},'../../services/api':{officialConnectorsAPI:api},'../../theme':{colors:{},radius:{}},'./MarketplaceTile':{default:host('tile')},'./ConnectorLogo':{default:host('logo')},'../Button':{default:host('button')},'./MarketplaceGrid':{default:host('grid')},'../../stores/connection':{useConnection}};
for(const k of ['./MarketplaceTile','./ConnectorLogo','../Button','./MarketplaceGrid'])imports[k].__esModule=true;
const sharedBrandmarkSource=fs.readFileSync(path.join(root,'apps/app/universal/components/mcps/shared-brandmark.ts'),'utf8');
const sharedBrandmarkModule={exports:{}};
const sharedBrandmarkCompile=ts.transpileModule(sharedBrandmarkSource,{reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
assert.equal((sharedBrandmarkCompile.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
new Function('module','exports',sharedBrandmarkCompile.outputText)(sharedBrandmarkModule,sharedBrandmarkModule.exports);
imports['./shared-brandmark']=sharedBrandmarkModule.exports;
const canonicalMark='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#123ABC" d="M0 0h24v24H0z"/></svg>';
assert.equal(sharedBrandmarkModule.exports.safeSharedBrandmark(canonicalMark),canonicalMark);
for(const bad of [null,{},canonicalMark.replace('<path ','<path onload="bad()" '),canonicalMark.replace('<path ','<image href="https://other.example/a"/><path '),canonicalMark.replace('d="M','d="&entity;M'),canonicalMark+'<script/>',canonicalMark+'\n','x'.repeat(32769)])assert.equal(sharedBrandmarkModule.exports.safeSharedBrandmark(bad),undefined);
assert.equal(sharedBrandmarkModule.exports.safeConnectorSetupUrl('https://docs.example.com/api'),'https://docs.example.com/api');
for(const bad of ['javascript:alert(1)','http://docs.example.com/','https://user:secret@docs.example.com/','https://docs.example.com:444/','https://docs.example.com/?token=secret',{}])assert.equal(sharedBrandmarkModule.exports.safeConnectorSetupUrl(bad),undefined);
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
 const allowed=['https://accounts.google.com','https://app.clickup.com','https://platform.postiz.com','https://github.com','https://api.notion.com','https://slack.com','https://auth.atlassian.com','https://login.microsoftonline.com'];
 for(const origin of allowed){await mount();const url=origin+(origin==='https://login.microsoftonline.com'?'/common/oauth2/v2.0/authorize?state=opaque':'/oauth/authorize?state=opaque');connectImpl=async()=>({connection,authorization_mode:'own-app',authorization_url:url,expires_at:'2099-01-01T00:00:00Z'});pollImpl=async()=>({status:'connected'});await fire(presses('Reconnect')[0]);await flush();assert.deepEqual(opened,[url]);assert.equal(calls.poll,1);await unmount();}
 passed.push('own-app-eight-exact-reviewed-origins');
 const rejected=['http://github.com/login/oauth/authorize','https://github.com.evil.example/authorize','https://github.com@evil.example/authorize','https://user@github.com/authorize','https://api.notion.com.evil.example/authorize','https://slack.com.evil.example/authorize','https://auth.atlassian.com.evil.example/authorize','https://unreviewed.example/authorize','https://github.com/login/oauth/authorize#fragment','http://login.microsoftonline.com/common/oauth2/v2.0/authorize','https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/authorize','https://login.microsoftonline.com@evil.example/authorize','https://user@login.microsoftonline.com/authorize','https://login.microsoftonline.com:444/common/oauth2/v2.0/authorize','https://login.microsoftonline.com/common/oauth2/v2.0/authorize#fragment'];
 for(const url of rejected){await mount();connectImpl=async()=>({connection,authorization_mode:'own-app',authorization_url:url,expires_at:'2099-01-01T00:00:00Z'});await fire(presses('Reconnect')[0]);await flush();assert.deepEqual(opened,[]);assert.equal(calls.poll,0);await unmount();}
 passed.push('own-app-fifteen-unsafe-urls-rejected-before-browser-or-poll');
 // Evaluate the actual API object initializer with only transport primitives replaced.
 const apiText=fs.readFileSync(path.join(root,apiFile),'utf8');
 const apiAST=ts.createSourceFile(apiFile,apiText,ts.ScriptTarget.Latest,true);
 let apiInitializer;function findAPI(node){if(ts.isVariableDeclaration(node)&&node.name.getText(apiAST)==='officialConnectorsAPI')apiInitializer=node.initializer.getText(apiAST);ts.forEachChild(node,findAPI)}findAPI(apiAST);assert.ok(apiInitializer);
 const apiObjectJS=ts.transpileModule('const officialConnectorsAPI='+apiInitializer+';', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const transport=[];const capture=method=>(url,body)=>{transport.push({method,url,body});return Promise.resolve({})};
 const realAPI=new Function('get','post','put','del',apiObjectJS+';return officialConnectorsAPI;')(capture('GET'),capture('POST'),capture('PUT'),capture('DELETE'));
 await realAPI.microsoftResources('connection/A',{kind:'sites',query:'Engineering',page_token:'opaque-sites'});
 await realAPI.selectMicrosoftSite('connection/A',{site_id:'site-2',query:'Engineering',page_token:'opaque-sites'});
 await realAPI.selectMicrosoftDrive('connection/A',{drive_id:'drive-2',page_token:'opaque-drives'});
 assert.deepEqual(transport,[{method:'POST',url:'/api/connectors/connection%2FA/microsoft-resources',body:{kind:'sites',query:'Engineering',page_token:'opaque-sites'}},{method:'PUT',url:'/api/connectors/connection%2FA/microsoft-site',body:{site_id:'site-2',query:'Engineering',page_token:'opaque-sites'}},{method:'PUT',url:'/api/connectors/connection%2FA/microsoft-drive',body:{drive_id:'drive-2',page_token:'opaque-drives'}}]);
 passed.push('microsoft-actual-api-object-uses-only-bound-resource-routes-and-typed-payloads');
 async function mountMicrosoft(provider){Object.assign(connector,{id:provider,name:provider==='onedrive'?'OneDrive':'SharePoint',auth:'oauth',provider,capability:'files',available:true,readTools:['files.'+provider+'.drives.list'],agentTools:[]});connection={id:'ms-A',catalog_id:provider,display_name:'Microsoft QA',status:'connected',enabled:true,allow_write:false,created_at:'2026-10-18T00:00:00Z'};await mount()}
 const resourcePage=(items,next,site=null,drive=null)=>({items,next_page_token:next,selected_site_id:site,selected_drive_id:drive});
 await mountMicrosoft('onedrive');let boundDrive=null;
 microsoftImpl=async(id,body)=>body.page_token==='opaque-drive-page2'?resourcePage([{id:'drive-2',name:'Second drive'}],undefined,null,boundDrive):resourcePage([{id:'drive-1',name:'First drive'}],'opaque-drive-page2',null,boundDrive);
 bindDriveImpl=async(id,body)=>{boundDrive=body.drive_id;return {ok:true,selected_site_id:null,selected_drive_id:boundDrive}};
 await fire(buttons('Choose drive')[0]);await flush();assert.deepEqual(calls.microsoft,[{id:'ms-A',body:{kind:'drives'}}]);
 await fire(buttons('Next drives')[0]);await flush();assert.deepEqual(calls.microsoft[1],{id:'ms-A',body:{kind:'drives',page_token:'opaque-drive-page2'}});
 await fire(buttons('Second drive')[0]);await flush();assert.deepEqual(calls.bindDrive,[{id:'ms-A',body:{drive_id:'drive-2',page_token:'opaque-drive-page2'}}]);assert.deepEqual(calls.microsoft[2],{id:'ms-A',body:{kind:'drives'}},'configuration change starts page1 without the invalidated cursor');
 assert.equal(buttons('Choose drive').length,1);assert.equal(buttons('First drive').length,1);await unmount();
 passed.push('onedrive-opaque-drive-paging-and-bind-reset-to-page-one');
 await mountMicrosoft('sharepoint');let boundSite=null;boundDrive=null;
 microsoftImpl=async(id,body)=>body.kind==='sites'?(body.page_token==='opaque-site-page2'?resourcePage([{id:'site-2',name:'Second site'}],undefined,boundSite,boundDrive):resourcePage([{id:'site-1',name:'First site'}],'opaque-site-page2',boundSite,boundDrive)):resourcePage([{id:'drive-1',name:'Site library'}],'opaque-library-page2',boundSite,boundDrive);
 bindSiteImpl=async(id,body)=>{boundSite=body.site_id;boundDrive=null;return {ok:true,selected_site_id:boundSite,selected_drive_id:null}};
 bindDriveImpl=async(id,body)=>{boundDrive=body.drive_id;return {ok:true,selected_site_id:boundSite,selected_drive_id:boundDrive}};
 const queryInput=()=>view.root.findAllByType('input').find(x=>x.props.accessibilityLabel==='SharePoint site search for Microsoft QA');
 assert.equal(buttons('Search sites')[0].props.disabled,true);await fire(buttons('Search sites')[0]);assert.equal(calls.microsoft.length,0);
 await act(async()=>queryInput().props.onChangeText('*'));assert.equal(buttons('Search sites')[0].props.disabled,true);await fire(buttons('Search sites')[0]);assert.equal(calls.microsoft.length,0);
 await act(async()=>queryInput().props.onChangeText(' Engineering '));await fire(buttons('Search sites')[0]);await flush();
 assert.deepEqual(calls.microsoft[0],{id:'ms-A',body:{kind:'sites',query:'Engineering'}});
 await fire(buttons('Next sites')[0]);await flush();assert.deepEqual(calls.microsoft[1],{id:'ms-A',body:{kind:'sites',query:'Engineering',page_token:'opaque-site-page2'}});
 await fire(buttons('Second site')[0]);await flush();assert.deepEqual(calls.bindSite,[{id:'ms-A',body:{site_id:'site-2',query:'Engineering',page_token:'opaque-site-page2'}}]);assert.deepEqual(calls.microsoft[2],{id:'ms-A',body:{kind:'drives'}});
 await fire(buttons('Site library')[0]);await flush();assert.deepEqual(calls.bindDrive,[{id:'ms-A',body:{drive_id:'drive-1'}}]);assert.deepEqual(calls.microsoft[3],{id:'ms-A',body:{kind:'drives'}});
 await act(async()=>queryInput().props.onChangeText('Finance'));assert.equal(buttons('Site library').length,0);assert.equal(buttons('Next drives').length,0);
 await fire(buttons('Search sites')[0]);await flush();assert.deepEqual(calls.microsoft[4],{id:'ms-A',body:{kind:'sites',query:'Finance'}});await unmount();
 passed.push('sharepoint-query-site-bind-then-drive-bind-use-only-current-listing-and-reset-cursors');
 await mountMicrosoft('onedrive');const oldResources=deferred();microsoftImpl=()=>oldResources.promise;const oldChoose=buttons('Choose drive')[0].props.onPress;
 await fire(buttons('Choose drive')[0]);assert.equal(presses('Refresh access')[0].props.disabled,true);await fire(presses('Refresh access')[0]);assert.equal(calls.refresh,0);
 await changeTarget('B');await changeTarget('A');await act(async()=>view.root.findByType('tile').props.onManage());oldResources.resolve(resourcePage([{id:'old','name':'Stale Microsoft drive'}],'stale-cursor'));await flush();
 assert.equal(buttons('Stale Microsoft drive').length,0);assert.equal(buttons('Next drives').length,0);assert.equal(buttons('Choose drive')[0].props.disabled,false);assert.equal(calls.bindDrive.length,0);await act(async()=>oldChoose());assert.equal(calls.microsoft.length,1,'obsolete initial-list callback cannot cross an A-B-A generation');await unmount();
 passed.push('microsoft-roundtrip-target-fence-drops-old-resource-response-and-preserves-global-busy');
 await mountMicrosoft('onedrive');microsoftImpl=async()=>resourcePage([{id:'drive-1',name:'Cached drive'}],'cached-next');await fire(buttons('Choose drive')[0]);await flush();const oldNext=buttons('Next drives')[0].props.onPress;
 await changeTarget('B');await changeTarget('A');await act(async()=>view.root.findByType('tile').props.onManage());await act(async()=>oldNext());assert.equal(calls.microsoft.length,1,'obsolete UI callbacks cannot reuse another generation listing');
 await fire(buttons('Choose drive')[0]);await flush();const refreshing=deferred();refreshImpl=()=>refreshing.promise;await fire(presses('Refresh access')[0]);assert.equal(buttons('Cached drive').length,0);refreshing.resolve({status:'connected',connection});await flush();
 await fire(buttons('Choose drive')[0]);await flush();pollImpl=async()=>({status:'connected'});await fire(presses('Reconnect')[0]);await flush();assert.equal(buttons('Cached drive').length,0);assert.equal(buttons('Choose drive').length,1,'connected Microsoft detail stays open');
 await fire(buttons('Choose drive')[0]);await flush();await fire(presses('Disconnect from this server')[0]);await flush();assert.equal(buttons('Cached drive').length,0);assert.equal(buttons('Choose drive').length,0);await unmount();
 passed.push('microsoft-reconnect-refresh-disconnect-and-obsolete-card-callbacks-clear-bound-resources');
 resetApi();state={config:config('A'),activeAccountId:'account-A'};
 Object.assign(connector,{id:'postman',name:'Postman',auth:'token',provider:'postman',capability:'files',available:true,readTools:['files.postman.workspaces.list'],agentTools:[],logoSvg:canonicalMark,setupUrl:'https://learning.postman.com/api-docs/',setupInstructions:'Use your authorized API token without a header prefix.'});
 let tokenConnected=false;const tokenCreated=[];
 api.catalog=async()=>({available:true,connectors:[connector]});
 api.list=async()=>({available:true,connections:tokenConnected?[connection]:[]});
 api.create=async body=>{tokenCreated.push(JSON.parse(JSON.stringify(body)));tokenConnected=true;connection={id:'token-A',catalog_id:'postman',display_name:'Postman',status:'connected',enabled:true,allow_write:false,app_id:'personal-token',created_at:'2026-10-18T00:00:00Z'};return {connection}};
 await act(async()=>{view=Renderer.create(React.createElement(Pane,{registryResults:[{name:'registry',title:'Registry MCP',description:'QA'}]}))});await flush();
 assert.equal(view.root.findAllByType('tile').length,2);
 const tokenTile=view.root.findAllByType('tile').find(x=>x.props.card.name==='Postman');
 assert.equal(tokenTile.props.icon.props.logoSvg,canonicalMark);
 await act(async()=>tokenTile.props.onInstall());
 assert.equal(view.root.findAllByType('input').length,1);
 assert.equal(view.root.findByType('input').props.secureTextEntry,true);
 assert.ok(view.root.findAllByType('text').some(x=>x.props.children===connector.setupInstructions));
 assert.equal(view.root.findAllByType('pressable').filter(x=>x.props.accessibilityRole==='link').length,1);
 await act(async()=>view.root.findByType('input').props.onChangeText('fixture-api-token'));
 await fire(presses('Connect')[0]);await flush();
 assert.deepEqual(tokenCreated,[{catalog_id:'postman',allow_write:false,config:{},token:'fixture-api-token'}]);
 assert.deepEqual(opened,[]);assert.equal(calls.poll,0);
 await act(async()=>view.root.findAllByType('tile').find(x=>x.props.card.name==='Postman').props.onManage());
 assert.equal(presses('Reconnect').length,0);assert.equal(presses('Refresh access').length,0);
 assert.equal(view.root.findAllByType('switch').length,1,'read-only profile has only its enabled switch');
 await fire(presses('Disconnect from this server')[0]);await flush();
 assert.equal(connection.status,'disconnected');await unmount();
 passed.push('token-profile-shares-grid-and-verified-logo-with-private-setup-and-no-oauth');
 passed.push('shared-vector-and-setup-link-grammar-reject-executable-or-sensitive-input');
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
