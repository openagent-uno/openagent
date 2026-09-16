import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-identity-race-'));
const identityPath = path.join(tmp, 'identity.key');
const barrierDir = path.join(tmp, 'barrier');
const workerPath = path.join(tmp, 'worker.mjs');
const identityModule = path.resolve('dist/network/identity.js');
const workerCount = 12;

fs.mkdirSync(barrierDir);
fs.writeFileSync(workerPath, String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const [identityModule, identityPath, barrierDir, countText] = process.argv.slice(2);
const expected = Number(countText);
const originalReadFileSync = fs.readFileSync.bind(fs);

// Hold every process immediately after it observed ENOENT. This makes the
// first-creation race deterministic instead of relying on scheduler timing.
fs.readFileSync = function coordinatedRead(candidate, ...args) {
  try {
    return originalReadFileSync(candidate, ...args);
  } catch (error) {
    if (error?.code !== 'ENOENT' || String(candidate) !== identityPath) throw error;
    fs.writeFileSync(
      fs.realpathSync(barrierDir) + '/' + process.pid,
      '',
      { flag: 'wx' },
    );
    const deadline = Date.now() + 15_000;
    while (fs.readdirSync(barrierDir).length < expected) {
      if (Date.now() >= deadline) throw new Error('identity race barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    throw error;
  }
};

const identity = await import(pathToFileURL(identityModule).href);
const loaded = await identity.loadOrCreateIdentity(identityPath);
process.stdout.write(loaded.nodeIdHex + '\n');
`);

try {
  const workers = Array.from({ length: workerCount }, () => spawn(
    process.execPath,
    [workerPath, identityModule, identityPath, barrierDir, String(workerCount)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ));

  const nodeIds = await Promise.all(workers.map((child) => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('identity worker timed out'));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`identity worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  })));

  assert.equal(new Set(nodeIds).size, 1, 'every process returns the persisted winner');
  assert.equal(fs.readFileSync(identityPath).length, 32);
  assert.equal(
    fs.readdirSync(tmp).filter((name) => name.startsWith('.identity.key.') && name.endsWith('.tmp')).length,
    0,
    'unique identity tempfiles are cleaned up',
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('identity.test: ok');
