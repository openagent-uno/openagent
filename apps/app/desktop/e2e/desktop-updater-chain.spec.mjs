import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { NativeUpdaterApp } from './helpers/native-updater.mjs';

const manifestPath = process.env.OPENAGENT_UPDATE_CHAIN_MANIFEST;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const version = app => execFileSync('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')], {encoding:'utf8'}).trim();

test('signed macOS updater installs the transition and subsequent distributions on an isolated copy', async () => {
  test.skip(!manifestPath, 'set OPENAGENT_UPDATE_CHAIN_MANIFEST to verified local signed artifacts');
  test.setTimeout(600_000);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.publication).toBe(false);
  const completeChain = manifest.qualification !== 'transition-only-probe';
  expect(manifest.steps).toHaveLength(completeChain ? 3 : 1);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openagent-updater-chain-')));
  const application = join(root,'Applications/OpenAgent.app');
  const home = join(root,'home');
  const profile = join(root,'tmp/profile');
  await mkdir(dirname(application),{recursive:true});
  await mkdir(home,{recursive:true});
  await mkdir(profile,{recursive:true});
  const temp = join(root, 'tmp');
  await mkdir(temp,{recursive:true});
  // The launched application and child processes receive this write policy.
  // Native privileged installation helpers may run outside it; the target is
  // an isolated copy, and the real installation is verified after every run.
  const policy=join(root,'writes.sb');
  const systemTemp=await realpath(tmpdir());
  // Chromium uses confstr(DARWIN_USER_TEMP_DIR), ignoring TMPDIR, for random
  // shared-memory IPC files. Allow only new files with its exact bundle prefix;
  // every pre-existing matching path remains explicitly read-only.
  const existingIpc=(await readdir(systemTemp)).filter(name=>name.startsWith('.ai.openagent.desktop.'));
  const temporaryItems=join(systemTemp,'TemporaryItems');
  const existingInstalls=(await readdir(temporaryItems).catch(()=>[])).filter(name=>name.startsWith('NSIRD_OpenAgent_'));
  const escapedTemp=systemTemp.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const ipcPattern=`^${escapedTemp}/\\.ai\\.openagent\\.desktop\\.[A-Za-z0-9]+$`;
  const installPattern=`^${escapedTemp}/TemporaryItems/NSIRD_OpenAgent_[A-Za-z0-9]+(/.*)?$`;
  const protectedPaths=[...existingIpc.map(name=>join(systemTemp,name)),...existingInstalls.map(name=>join(temporaryItems,name))];
  await writeFile(policy,`(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null") (regex ${JSON.stringify(ipcPattern)}) (regex ${JSON.stringify(installPattern)})) ${protectedPaths.map(path=>`(deny file-write* (subpath ${JSON.stringify(path)}))`).join(' ')}`);
  const launcher=join(root,'launch-app');
  const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher,`#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(policy)} ${quote(join(application,'Contents/MacOS/OpenAgent'))} "$@"\n`);
  await chmod(launcher,0o700);
  const originalAsar = join(manifest.installed_app,'Contents/Resources/app.asar');
  const originalDigest = sha256(await readFile(originalAsar));
  execFileSync('/usr/bin/ditto',[manifest.installed_app,application]);
  let step;
  const requests = [];
  const receipt = {qualification:completeChain ? 'signed-local-squirrel-installation' : 'transition-only-probe',complete_chain:completeChain,publication:false,source_versions_are_fixture:manifest.source_versions_are_fixture,steps:[]};
  const server = createServer(async (request,response) => {
    try {
      const path = new URL(request.url,'http://127.0.0.1').pathname;
      requests.push(path);
      const prefix = `/${step.feed_namespace}/`;
      if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      if (path.endsWith('.yml')) {
        const contents = await readFile(step.archive);
        const digest = createHash('sha512').update(contents).digest('base64');
        const name = basename(step.archive);
        const body = JSON.stringify({version:step.version,files:[{url:name,sha512:digest,size:contents.length}],path:name,sha512:digest,releaseDate:'2026-09-16T00:00:00.000Z'});
        response.writeHead(200,{'Content-Type':'application/yaml','Content-Length':Buffer.byteLength(body)});
        response.end(body); return;
      }
      if (path !== prefix + basename(step.archive)) { response.writeHead(404); response.end(); return; }
      const info = await stat(step.archive);
      response.writeHead(200,{'Content-Type':'application/zip','Content-Length':info.size});
      createReadStream(step.archive).pipe(response);
    } catch(error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let app;
  let success=false;
  try {
    expect(version(application)).toBe(manifest.installed_version);
    for (step of manifest.steps) {
      const previous = version(application);
      const archiveHash = sha256(await readFile(step.archive));
      expect(archiveHash).toBe(step.sha256);
      execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',application]);
      app = await NativeUpdaterApp.launch({
        timeout:30_000,
        executablePath:launcher,
        // Chromium cannot initialize its nested Seatbelt sandbox inside the
        // inherited test policy. This updater-only fixture uses an outer OS
        // policy for the application; production launch flags remain unchanged.
        args:['--no-sandbox','--disable-gpu','--use-mock-keychain','--local-e2e',`--e2e-user-data-dir=${profile}`],
        env:{...process.env,HOME:home,USERPROFILE:home,CFFIXED_USER_HOME:home,TMPDIR:temp,XDG_CONFIG_HOME:join(home,'.config'),XDG_CACHE_HOME:join(home,'.cache')},
      });
      console.log(`Updater launched ${previous} in the isolated profile`);
      const selected = await app.evaluate(async ({app,autoUpdater}, options) => {
        const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
        const path = require('node:path');
        const os = require('node:os');
        if (!app.getPath('userData').startsWith(options.root + path.sep) || os.homedir() !== options.home) throw new Error('Updater profile is not isolated');
        const updater = require(path.join(app.getAppPath(),'node_modules/electron-updater')).autoUpdater;
        globalThis.updateProbe = {updater,ready:false,errors:[],log:[]};
        const state = globalThis.updateProbe;
        updater.logger = {info:value=>state.log.push(String(value)),warn:value=>state.log.push(String(value)),error:value=>state.log.push(String(value)),debug:()=>{}};
        updater.on('error',error=>state.errors.push(String(error)));
        autoUpdater.once('update-downloaded',()=>{state.ready=true;});
        updater.autoDownload=false;
        updater.autoInstallOnAppQuit=true;
        updater.autoRunAppAfterInstall=false;
        updater.disableDifferentialDownload=true;
        updater.channel='latest'; updater.allowPrerelease=false; updater.allowDowngrade=false;
        updater.setFeedURL({provider:'generic',url:options.url,useMultipleRangeRequest:false});
        const result=await updater.checkForUpdates();
        if (result.updateInfo.version !== options.version) throw new Error('Wrong version selected');
        await updater.downloadUpdate();
        return {version:result.updateInfo.version,installed:app.getVersion(),cache:updater.app.baseCachePath};
      },{root,home,url:`${base}/${step.feed_namespace}/`,version:step.version});
      expect(selected.installed).toBe(previous);
      console.log(`Updater downloaded ${selected.version}`);
      expect(selected.cache.startsWith(home)).toBe(true);
      await expect.poll(async()=>{
        const state=await app.evaluate(()=>({ready:globalThis.updateProbe.ready,errors:globalThis.updateProbe.errors}));
        if(state.errors.length)throw new Error(state.errors.join('\n'));
        return state.ready;
      },{timeout:120_000}).toBe(true);
      const close = app.waitForEvent('close');
      await app.evaluate(()=>{setTimeout(()=>globalThis.updateProbe.updater.quitAndInstall(),100);});
      await close;
      console.log(`Updater application closed for ${step.version}`);
      app = null;
      await expect.poll(()=>version(application),{timeout:90_000}).toBe(step.version);
      execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',application]);
      execFileSync('/usr/sbin/spctl',['--assess','--type','execute',application]);
      receipt.steps.push({from:previous,to:step.version,feed_namespace:step.feed_namespace,archive_sha256:archiveHash,installed_asar_sha256:sha256(await readFile(join(application,'Contents/Resources/app.asar'))),signature:'verified',gatekeeper:'accepted'});
    }
    expect(sha256(await readFile(originalAsar))).toBe(originalDigest);
    receipt.original_installation_unchanged=true;
    receipt.request_paths=requests;
    success=true;
  } catch(error) {
    if(app) {
      error.message += '\nNative stderr: '+app.stderr;
      try { error.message += '\nUpdater: '+JSON.stringify(await app.evaluate(()=>({ready:globalThis.updateProbe?.ready,errors:globalThis.updateProbe?.errors,log:globalThis.updateProbe?.log}))); } catch {}
    }
    throw error;
  } finally {
    if(app) {
      try { await app.evaluate(()=>{if(globalThis.updateProbe)globalThis.updateProbe.updater.autoInstallOnAppQuit=false;}); } catch {}
      await app.close().catch(()=>{});
    }
    await new Promise(resolve=>server.close(resolve));
    expect(sha256(await readFile(originalAsar))).toBe(originalDigest);
    if(success){
      // Native ShipIt may install as root. Preserve the verified installed
      // result as an artifact instead of requesting privileges to erase it.
      const retained=resolve(dirname(manifestPath),`installed-${completeChain?'chain':'transition'}-${Date.now()}`);
      await rename(root,retained);
      receipt.installed_copy=join(retained,'Applications/OpenAgent.app');
      receipt.cleanup='Native processes closed; synthetic profile and installed copy retained as qualification artifacts';
      const output=resolve(dirname(manifestPath),completeChain?'updater-chain-verification.json':'updater-transition-probe.json');
      await writeFile(output,JSON.stringify(receipt,null,2)+'\n');
      await test.info().attach('Signed updater installation receipt',{path:output,contentType:'application/json'});
    }else{
      try{await rm(root,{recursive:true,force:true});}
      catch(error){
        if(error.code!=='EACCES')throw error;
        await rename(root,resolve(dirname(manifestPath),`failed-native-install-${Date.now()}`));
      }
    }
  }
});
