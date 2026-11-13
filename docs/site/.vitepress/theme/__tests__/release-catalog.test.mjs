import assert from 'node:assert/strict';
import test from 'node:test';
import {latestMatch,fetchCatalogue,assetLabel,REPOSITORY} from '../release-catalog.ts';
const asset=(tag,name)=>({name,size:1024,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`});
const app=(v,files=['macos-arm64.dmg'])=>({tag_name:'app-v'+v,published_at:'2026-11-01',draft:false,prerelease:true,assets:files.map(f=>asset('app-v'+v,`openagent-app-${v}-${f}`))});
const product=(v,w,targets=['framework','cli'])=>({tag_name:'v'+v,published_at:'2026-11-01',draft:false,prerelease:true,assets:targets.map(t=>asset('v'+v,`openagent_${t}-${w}-py3-none-any.whl`))});

test('independent component versions ignore publication order and unrelated/draft releases',()=>{
 const rows=[product('1.1.9-beta.35','1.1.9b35'),app('1.1.0-beta.9'),app('1.1.0-beta.39'),{...app('99.0.0'),tag_name:'channel-bridges-v99.0.0'},{...app('100.0.0'),draft:true}];
 assert.equal(latestMatch(rows,'desktop').release.tag_name,'app-v1.1.0-beta.39');
 assert.equal(latestMatch(rows,'server').assets[0].name,'openagent_framework-1.1.9b35-py3-none-any.whl');
 assert.equal(latestMatch(rows,'cli').assets[0].name,'openagent_cli-1.1.9b35-py3-none-any.whl');
});
test('numeric prereleases and stable versions follow version precedence',()=>{
 assert.equal(latestMatch([app('1.1.0-beta.9'),app('1.1.0-beta.100')],'desktop').release.tag_name,'app-v1.1.0-beta.100');
 assert.equal(latestMatch([app('1.1.0-beta.100'),app('1.1.0')],'desktop').release.tag_name,'app-v1.1.0');
 assert.equal(latestMatch([app('1.1.0'),app('1.2.0-beta.1')],'desktop').release.tag_name,'app-v1.2.0-beta.1');
});
test('all platform architectures/formats have distinct labels',()=>{
 const files=['macos-arm64.dmg','macos-x64.zip','windows-arm64.exe','windows-x64.msi','linux-x86_64.AppImage','linux-arm64.deb','linux-amd64.tar.gz'];
 const match=latestMatch([app('2.0.0',files)],'desktop');assert.equal(match.assets.length,files.length);
 const labels=match.assets.map(a=>assetLabel(a,'desktop'));
 for(const label of ['macOS · Apple Silicon · dmg','macOS · Intel · zip','Windows · ARM64 · exe','Windows · x64 · msi','Linux · x64 · AppImage','Linux · ARM64 · deb','Linux · x64 · tar.gz'])assert.ok(labels.includes(label),label);
});
test('a partial latest release does not borrow older platform packages',()=>{
 const match=latestMatch([app('2.0.0'),app('1.0.0',['windows-x64.exe','linux-arm64.deb'])],'desktop');
 assert.equal(match.release.tag_name,'app-v2.0.0');assert.equal(match.assets.length,1);
});
test('only exact component/version assets and canonical URLs are offered',()=>{
 const r=app('2.0.0');r.assets.push(asset(r.tag_name,'other-2.0.0-macos-arm64.dmg'),asset(r.tag_name,'openagent-app-1.0.0-macos-x64.dmg'),asset(r.tag_name,'openagent-app-2.0.0-macos-arm64.dmg.blockmap'),{...asset(r.tag_name,'openagent-app-2.0.0-windows-x64.exe'),browser_download_url:'https://other.invalid/file.exe'});
 assert.equal(latestMatch([r],'desktop').assets.length,1);
 const rows=[product('3.0.0','3.0.0',['cli']),product('2.0.0','2.0.0',['framework'])];
 assert.equal(latestMatch(rows,'server').release.tag_name,'v2.0.0');assert.equal(latestMatch(rows,'cli').release.tag_name,'v3.0.0');
});
test('discovery follows later pages and drops drafts/invalid records',async()=>{
 const urls=[];const rows=await fetchCatalogue(async url=>{urls.push(url);return new Response(JSON.stringify(urls.length===1?[app('1.0.0'),{...app('99.0.0'),draft:true},{tag_name:'bad'}]:[app('2.0.0')]),{headers:urls.length===1?{link:'<https://api.github.com/next>; rel="next"'}:{}})});
 assert.equal(urls.length,2);assert.ok(urls[1].endsWith('page=2'));assert.equal(latestMatch(rows,'desktop').release.tag_name,'app-v2.0.0');
});
test('rate limits, invalid responses and incomplete pagination fail explicitly',async()=>{
 await assert.rejects(fetchCatalogue(async()=>new Response('',{status:403})),/403/);
 await assert.rejects(fetchCatalogue(async()=>new Response('{}')),/Invalid/);
 await assert.rejects(fetchCatalogue(async()=>new Response('[]',{headers:{link:'<https://api.github.com/next>; rel="next"'}})),/pagination limit/);
});
