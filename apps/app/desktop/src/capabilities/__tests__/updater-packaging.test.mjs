import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);
const {verifyUpdaterMetadata}=require('../../../scripts/after-sign-host-tools.js');

test('release signing refuses an app that cannot find its next updater cache',()=>{
  const root=mkdtempSync(join(tmpdir(),'openagent-update-metadata-'));
  const resources=join(root,'Contents/Resources');mkdirSync(resources,{recursive:true});
  try{
    assert.throws(()=>verifyUpdaterMetadata(root),/missing app-update.yml/);
    writeFileSync(join(resources,'app-update.yml'),'provider: github\nupdaterCacheDirName: other-app\n');
    assert.throws(()=>verifyUpdaterMetadata(root),/existing cache identity/);
    writeFileSync(join(resources,'app-update.yml'),'provider: github\nowner: openagent-uno\nrepo: openagent-app\nupdaterCacheDirName: openagent-desktop-updater\n');
    assert.doesNotThrow(()=>verifyUpdaterMetadata(root));
  }finally{rmSync(root,{recursive:true,force:true});}
});
