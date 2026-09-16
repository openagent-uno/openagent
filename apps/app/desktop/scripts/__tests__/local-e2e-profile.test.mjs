import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLocalE2EProfile,
  desktopRuntimePolicy,
  resolveLocalE2EProfile,
} from '../../dist/local-e2e-profile.js';
import { nodeDiscoveryMode } from '../../dist/network/discovery-config.js';
import { createStorageCallbacks } from '../../dist/services/storage-core.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-desktop-e2e-test-'));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  return { root, profile };
}

test('local E2E profile is opt-in and rejects ambiguous or unsafe paths', () => {
  const { root, profile } = fixture();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-desktop-outside-'));
  const outsideProfile = path.join(outsideRoot, 'profile');
  fs.mkdirSync(outsideProfile);
  const symlink = path.join(root, 'profile-link');
  fs.symlinkSync(profile, symlink);
  try {
    assert.equal(resolveLocalE2EProfile(['electron'], [root]), null);
    assert.throws(
      () => resolveLocalE2EProfile([`--e2e-user-data-dir=${profile}`], [root]),
      /only valid together/,
    );
    assert.throws(
      () => resolveLocalE2EProfile(['--local-e2e'], [root]),
      /requires exactly one/,
    );
    assert.throws(
      () => resolveLocalE2EProfile(['--local-e2e', '--local-e2e', `--e2e-user-data-dir=${profile}`], [root]),
      /only be specified once/,
    );
    assert.throws(
      () => resolveLocalE2EProfile(['--local-e2e', `--e2e-user-data-dir=${root}`], [root]),
      /must be a child/,
    );
    assert.throws(
      () => resolveLocalE2EProfile(['--local-e2e', `--e2e-user-data-dir=${outsideProfile}`], [root]),
      /must be a child/,
    );
    assert.throws(
      () => resolveLocalE2EProfile(['--local-e2e', `--e2e-user-data-dir=${symlink}`], [root]),
      /not a file or symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('local E2E applies an isolated profile before lazy storage is constructed', () => {
  const { root, profile } = fixture();
  const environment = {};
  let selectedUserData = null;
  let constructorCalls = 0;
  const values = new Map();
  const callbacks = createStorageCallbacks(() => {
    constructorCalls += 1;
    assert.equal(selectedUserData, fs.realpathSync(profile));
    return {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => values.set(key, value),
      delete: (key) => values.delete(key),
    };
  });

  try {
    const resolved = resolveLocalE2EProfile(
      ['--local-e2e', `--e2e-user-data-dir=${profile}`],
      [root],
    );
    assert.ok(resolved);
    assert.equal(constructorCalls, 0, 'creating IPC callbacks must not open electron-store');

    applyLocalE2EProfile(resolved, (value) => {
      selectedUserData = value;
    }, environment);
    assert.equal(environment.OPENAGENT_USER_DIR, path.join(fs.realpathSync(profile), 'openagent-user'));
    assert.equal(environment.OPENAGENT_IROH_DISCOVERY, 'none');
    assert.equal(constructorCalls, 0, 'applying app.setPath must still precede store construction');

    assert.equal(callbacks.get(null, 'account'), null);
    assert.equal(constructorCalls, 1);
    callbacks.set(null, 'account', 'fixture-only');
    assert.equal(callbacks.get(null, 'account'), 'fixture-only');
    callbacks.remove(null, 'account');
    assert.equal(callbacks.get(null, 'account'), null);
    assert.equal(constructorCalls, 1, 'all handlers must share one lazily-created store');

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
      assert.equal(fs.statSync(environment.OPENAGENT_USER_DIR).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local E2E refuses persistent-path symlinks that could reach a real profile', () => {
  for (const [relativeTarget, dangling] of [
    ['openagent-user', false],
    ['openagent-desktop.json', false],
    ['openagent-desktop.json', true],
  ]) {
    const { root, profile } = fixture();
    const outside = path.join(root, 'outside');
    if (!dangling && relativeTarget.endsWith('.json')) {
      fs.writeFileSync(outside, '{}');
    } else if (!dangling) {
      fs.mkdirSync(outside);
    }
    fs.symlinkSync(outside, path.join(profile, relativeTarget));
    try {
      const resolved = resolveLocalE2EProfile(
        ['--local-e2e', `--e2e-user-data-dir=${profile}`],
        [root],
      );
      assert.ok(resolved);
      assert.throws(
        () => applyLocalE2EProfile(resolved, () => {}, {}),
        /must not be a symlink/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('runtime policy changes dev behaviour only for explicit local E2E', () => {
  assert.deepEqual(
    desktopRuntimePolicy({ isPackaged: false, packagedSmoke: false, localE2E: false }),
    { useStaticRenderer: false, bypassSingleInstanceLock: false, enableAutoUpdater: false },
  );
  assert.deepEqual(
    desktopRuntimePolicy({ isPackaged: false, packagedSmoke: false, localE2E: true }),
    { useStaticRenderer: true, bypassSingleInstanceLock: true, enableAutoUpdater: false },
  );
  assert.deepEqual(
    desktopRuntimePolicy({ isPackaged: true, packagedSmoke: false, localE2E: false }),
    { useStaticRenderer: true, bypassSingleInstanceLock: false, enableAutoUpdater: true },
  );
  assert.equal(
    desktopRuntimePolicy({ isPackaged: true, packagedSmoke: true, localE2E: false }).bypassSingleInstanceLock,
    true,
  );
});

test('iroh discovery override accepts local-only aliases and otherwise defaults', () => {
  for (const value of ['none', ' NONE ', 'off', 'disabled']) {
    assert.equal(nodeDiscoveryMode(value), 'none');
  }
  for (const value of [undefined, '', 'default', 'unexpected']) {
    assert.equal(nodeDiscoveryMode(value), 'default');
  }
});

test('electron-builder includes the fail-closed NSIS PE extraction fix and noble hashes override', () => {
  const desktopRoot = path.resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package-lock.json'), 'utf8'));
  // electron-builder 26.15.7 contains the v26 backport that forces an
  // install-time-compatible 7z filter for NSIS payloads. Older 26.15.x
  // releases could silently omit PE files, including OpenAgent.exe, on both
  // Windows architectures: https://github.com/electron-userland/electron-builder/pull/9989
  assert.equal(manifest.devDependencies['electron-builder'], '26.15.7');
  assert.equal(manifest.overrides['app-builder-lib']['@noble/hashes'], '1.8.0');
  assert.equal(lock.packages['node_modules/electron-builder'].version, '26.15.7');
  assert.equal(lock.packages['node_modules/app-builder-lib'].version, '26.15.7');
  assert.equal(lock.packages['node_modules/@noble/hashes'].version, '1.8.0');
});
