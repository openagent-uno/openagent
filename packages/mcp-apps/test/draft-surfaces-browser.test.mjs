/** Real adopter draft components in an owned composer fixture; no authenticated chat send. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import http from 'node:http';
import path from 'node:path';
const require=createRequire(new URL('../../../apps/app/desktop/package.json',import.meta.url));
const {build}=require('esbuild'),{chromium}=require('playwright');
const products=[
 {name:'standalone',root:new URL('../../../apps/app/universal/',import.meta.url).pathname,bridge:'desktop'},
 {name:'glasspalace',root:process.env.OPENAGENT_TEST_GLASSPALACE_ROOT&&path.join(process.env.OPENAGENT_TEST_GLASSPALACE_ROOT,'client/universal'),bridge:'glasspalaceDesktop'},
 {name:'ics',root:process.env.OPENAGENT_TEST_ICS_ROOT&&path.join(process.env.OPENAGENT_TEST_ICS_ROOT,'client/universal'),bridge:'icsDesktop'},
];
for(const product of products)test('actual '+product.name+' draft review preserves user text and exact current scope',{skip:!product.root,timeout:30000},async()=>{
 const scope=product.name==='standalone'?{accountId:'account-one',sessionId:'session-one'}:{workspaceId:'workspace-one',agentId:'agent-one',sessionId:'session-one',actorUserId:'alice'};
 const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import Review from ${JSON.stringify(path.join(product.root,'components/McpAppDraftReview.tsx'))};
 let listener;window[${JSON.stringify(product.bridge)}]={mcpApps:{onDraft:callback=>{listener=callback;return()=>{if(listener===callback)listener=undefined}}}};window.emitDraft=value=>listener?.(value);window.sends=0;
 function App({scope,key_}){const[value,setValue]=useState('Existing user draft');return <><Review scope={scope} scopeKey={key_} onInsert={text=>setValue(current=>current+'\\n\\n'+text)}/><textarea id='composer' value={value} onChange={event=>setValue(event.target.value)}/><button id='normal-send' onClick={()=>window.sends++}>Send</button></>}
 const root=createRoot(document.getElementById('root'));window.setScope=(scope,key_)=>root.render(<App scope={scope} key_={key_}/>);window.setScope(${JSON.stringify(scope)},'owner-one');`;
 const alias={react:path.join(product.root,'node_modules/react'),'react-dom':path.join(product.root,'node_modules/react-dom'),'react-native':path.join(product.root,'node_modules/react-native-web')};
 if(product.name!=='standalone')alias['@'+product.name+'/common/theme']=path.join(product.root,'../common/theme.ts');
 const bundle=await build({stdin:{contents:entry,resolveDir:product.root,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias,nodePaths:[path.join(product.root,'node_modules')],define:{'process.env.NODE_ENV':'"test"','__DEV__':'false'},logLevel:'silent'});
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/bundle.js'?'text/javascript':'text/html');response.end(request.url==='/bundle.js'?bundle.outputFiles[0].contents:'<div id="root"></div><script src="/bundle.js"></script>')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.OPENAGENT_TEST_CHROMIUM_PATH?{executablePath:process.env.OPENAGENT_TEST_CHROMIUM_PATH}:{})});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#composer').waitFor();
  const draft={...scope,draftId:'owned-draft',sourceName:'Owned interactive tool',sourceId:'source-one',text:'Review suggested text'};
  await page.evaluate(draft=>window.emitDraft({...draft,sessionId:'wrong-session'}),draft);assert.equal(await page.getByTestId('mcp-app-draft-review').count(),0);
  await page.evaluate(draft=>window.emitDraft(draft),draft);await page.getByText('Draft suggested by Owned interactive tool').waitFor();assert.equal(await page.locator('#composer').inputValue(),'Existing user draft');assert.equal(await page.evaluate(()=>window.sends),0);
  await page.getByRole('button',{name:'Insert suggested draft into composer'}).click();assert.equal(await page.locator('#composer').inputValue(),'Existing user draft\n\nReview suggested text');assert.equal(await page.evaluate(()=>window.sends),0);
  await page.evaluate(draft=>window.emitDraft({...draft,draftId:'second'}),draft);await page.getByTestId('mcp-app-draft-review').waitFor();
  const next=product.name==='standalone'?{...scope,accountId:'other-account'}:{...scope,actorUserId:'bob'};await page.evaluate(scope=>window.setScope(scope,'owner-two'),next);await page.getByTestId('mcp-app-draft-review').waitFor({state:'detached'});
  await page.evaluate(draft=>window.emitDraft({...draft,draftId:'late-old-owner'}),draft);assert.equal(await page.getByTestId('mcp-app-draft-review').count(),0);
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
