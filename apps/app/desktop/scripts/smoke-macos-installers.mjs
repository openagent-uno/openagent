#!/usr/bin/env node

/** Launch both macOS installer formats on a runner of the advertised arch. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as asar from '@electron/asar';
const desktopDir = path.resolve(import.meta.dirname, '..');
const version = String(JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version);
const artifactRoot = path.resolve(process.argv[2] || path.join(desktopDir, 'release'));
const expectedArch = String(process.argv[3] || process.arch);
assert.equal(process.arch, expectedArch, `Runner is ${process.arch}, expected ${expectedArch}`);

function walk(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function appBundles(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name.endsWith('.app')) found.push(full);
    else found.push(...appBundles(full));
  }
  return found;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 180_000,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\n${result.stdout || ''}\n${result.stderr || ''}`,
  );
  return result;
}

function verifyChecksum(file) {
  const sidecar = `${file}.sha256`;
  assert(fs.existsSync(sidecar), `Missing ${path.basename(sidecar)}`);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(fs.readFileSync(sidecar, 'utf8').trim(), `${digest}  ${path.basename(file)}`);
}

function validateAndLaunch(appBundle) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  const plistVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]).stdout.trim();
  assert.equal(plistVersion, version, `${appBundle} Info.plist version mismatch`);

  const archive = path.join(appBundle, 'Contents', 'Resources', 'app.asar');
  assert(fs.existsSync(archive), `${appBundle} has no app.asar`);
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(String(packaged.version), version, `${appBundle} packaged version mismatch`);
  assert(fs.existsSync(path.join(path.dirname(archive), 'web-build', 'index.html')), `${appBundle} has no web build`);

  const executables = walk(path.join(appBundle, 'Contents', 'MacOS'));
  assert.equal(executables.length, 1, `${appBundle} has an unexpected executable set`);
  const result = run(executables[0], ['--packaged-smoke', `--expected-version=${version}`], {
    env: { ...process.env, ELECTRON_DISABLE_GPU: '1', ELECTRON_ENABLE_LOGGING: '1' },
  });
  assert(`${result.stdout}\n${result.stderr}`.includes(`packaged-smoke ok ${version}`));
}

const all = walk(artifactRoot);
const prefix = `openagent-app-${version}-macos-${expectedArch}`;
const zip = all.find((file) => path.basename(file) === `${prefix}.zip`);
const dmg = all.find((file) => path.basename(file) === `${prefix}.dmg`);
assert(zip && dmg, `Missing ${expectedArch} ZIP or DMG`);
verifyChecksum(zip);
verifyChecksum(dmg);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `openagent-macos-${expectedArch}-`));
try {
  run('unzip', ['-tq', zip]);
  const zipRoot = path.join(temporary, 'zip');
  fs.mkdirSync(zipRoot);
  run('ditto', ['-x', '-k', zip, zipRoot]);
  const zipApps = appBundles(zipRoot);
  assert.equal(zipApps.length, 1, 'ZIP did not contain exactly one outer app');
  validateAndLaunch(zipApps[0]);

  run('hdiutil', ['verify', dmg]);
  const mount = path.join(temporary, 'mount');
  fs.mkdirSync(mount);
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    attached = true;
    const dmgApps = appBundles(mount);
    assert.equal(dmgApps.length, 1, 'DMG did not contain exactly one outer app');
    const installed = path.join(temporary, 'installed.app');
    run('ditto', [dmgApps[0], installed]);
    validateAndLaunch(installed);
  } finally {
    if (attached) run('hdiutil', ['detach', mount]);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`macOS installer smoke: ${version} ${expectedArch} ZIP+DMG ok`);
