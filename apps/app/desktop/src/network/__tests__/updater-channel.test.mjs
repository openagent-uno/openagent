import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configureAutoUpdater,
  shouldAcceptUpdate,
  updateMetadataChannel,
  updatePolicyForVersion,
} from '../../../dist/update-policy.js';

const stable = updatePolicyForVersion('2.4.0');
assert.deepEqual(stable, {
  channel: 'latest',
  allowPrerelease: false,
  allowDowngrade: false,
  automaticCheck: true,
  installOnQuit: true,
});
assert.equal(shouldAcceptUpdate('2.4.0', '2.5.0-beta.1'), false,
  'a stable installation must not observe a prerelease');
assert.equal(shouldAcceptUpdate('2.4.0', '2.4.1'), true);

const beta = updatePolicyForVersion('2.5.0-beta.1');
assert.deepEqual(beta, {
  channel: 'beta',
  allowPrerelease: true,
  allowDowngrade: false,
  automaticCheck: false,
  installOnQuit: false,
});
assert.equal(shouldAcceptUpdate('2.5.0-beta.1', '2.5.0-beta.2'), true,
  'an installed beta opts into later beta builds');
assert.equal(shouldAcceptUpdate('2.5.0-beta.2', '2.4.9'), false,
  'a beta must not downgrade to an older stable');
assert.equal(shouldAcceptUpdate('2.5.0-beta.2', '2.5.0'), true,
  'a beta may graduate to the newer stable of the same version');
assert.equal(shouldAcceptUpdate('2.5.0-beta.2', '2.6.0'), true,
  'a beta may upgrade to a semantically newer stable');
assert.equal(shouldAcceptUpdate('2.5.0-beta.2', '2.6.0-alpha.1'), false,
  'a beta does not silently cross prerelease channels');
assert.equal(shouldAcceptUpdate('2.5.0-beta.2', '2.5.0-beta.1'), false,
  'beta updates never go backwards');

// The assignment order matters: electron-updater's real channel setter turns
// allowDowngrade back on. This fake reproduces that behavior.
let selectedChannel = null;
const fakeUpdater = {
  allowPrerelease: false,
  allowDowngrade: false,
  get channel() { return selectedChannel; },
  set channel(value) {
    selectedChannel = value;
    this.allowDowngrade = true;
  },
};
configureAutoUpdater(fakeUpdater, '2.5.0-beta.7');
assert.equal(fakeUpdater.channel, 'beta');
assert.equal(fakeUpdater.allowPrerelease, true);
assert.equal(fakeUpdater.allowDowngrade, false);

// electron-builder detects the prerelease component and emits beta*.yml only
// when channel detection remains enabled and publish does not pin `latest`.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.resolve(here, '../../../package.json'), 'utf8'));
assert.equal(packageJson.build.detectUpdateChannel, true);
assert.equal(packageJson.build.publish.channel, undefined);
assert.equal(updateMetadataChannel('2.5.0-beta.7'), 'beta');
assert.equal(updateMetadataChannel('2.5.0'), 'latest');

console.log('updater-channel.test: ok');
