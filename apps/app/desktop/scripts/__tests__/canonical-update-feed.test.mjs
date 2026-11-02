import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const {canonicalMetadata} = createRequire(import.meta.url)('../canonical-update-feed.js');
const bytes = Buffer.from('immutable signed installer');
const name = 'openagent-app-1.2.0-beta.4-macos-arm64.zip';
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const metadata = () => ({version:'1.2.0-beta.4',path:name,sha512,files:[{url:name,size:bytes.length,sha512}]});
test('canonical feed points to immutable release assets and retains their digest', () => {
  const value = canonicalMetadata(metadata(), 'app-v1.2.0-beta.4', () => bytes);
  assert.equal(value.path, `https://github.com/openagent-uno/openagent/releases/download/app-v1.2.0-beta.4/${name}`);
  assert.equal(value.files[0].url, value.path);
  assert.equal(value.files[0].sha512, sha512);
});
test('wrong version, changed bytes, missing primary and path traversal fail closed', () => {
  assert.throws(() => canonicalMetadata(metadata(), 'app-v1.2.0', () => bytes));
  assert.throws(() => canonicalMetadata(metadata(), 'app-v1.2.0-beta.4', () => Buffer.from('changed')));
  assert.throws(() => canonicalMetadata({...metadata(),path:'missing.zip'}, 'app-v1.2.0-beta.4', () => bytes));
  const unsafe = metadata(); unsafe.files[0].url = '../' + name;
  assert.throws(() => canonicalMetadata(unsafe, 'app-v1.2.0-beta.4', () => bytes));
});
