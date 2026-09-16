import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stageScript = path.join(desktop, 'scripts', 'stage-host-tools.js');
const fetchScript = path.join(desktop, 'scripts', 'fetch-host-tools-release.js');
const mergeMetadataScript = path.join(desktop, 'scripts', 'merge-update-metadata.js');
const require = createRequire(import.meta.url);
const tar = require('tar');

test('committed host-tools lock is the complete immutable public release index', () => {
  const lockPath = path.join(desktop, 'host-tools.lock.json');
  const bytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(bytes.toString('utf8'));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '88efc4b74b89796f1862839f8d8f3ec51f463cc15799f9de40a4502ae2421f08',
  );
  assert.equal(lock.source_commit, 'af6ad6871d4d1208874bf79735710d089f59b959');
  assert.deepEqual(Object.keys(lock.platforms).sort(), [
    'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
    'win32-arm64', 'win32-x64',
  ]);
  assert.equal(
    lock.python_wheel.sha256,
    '22e74b799da2bfacaa3ff7f1e473e1c8205c8b4b8c20764d09211b50f22c31e0',
  );
});

test('CI gates Desktop client tools over the exact real-Iroh server twice', () => {
  const workflow = fs.readFileSync(
    path.resolve(desktop, '..', '.github', 'workflows', 'test.yml'),
    'utf8',
  );
  assert.match(workflow, /desktop-real-iroh-e2e:/);
  assert.match(workflow, /repository: openagent-uno\/openagent-server/);
  assert.match(workflow, /ref: 613461938d848ea3aa62ab7886cb87a13470b5f9/);
  assert.match(workflow, /cmp desktop\/host-tools\.lock\.json \.e2e-deps\/openagent-server\/host-tools\.lock\.json/);
  assert.match(workflow, /OPENAGENT_REAL_DESKTOP_SERVER_ROOT:/);
  assert.match(workflow, /OPENAGENT_REAL_DESKTOP_PYTHON:/);
  assert.match(workflow, /\.\/test\.sh e2e-real-iroh/);
});

test('macOS packaging preserves and re-verifies upstream host-tool signatures', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  assert.equal(pkg.build.afterSign, 'scripts/after-sign-host-tools.js');
  assert.equal(pkg.build.mac.forceCodeSigning, true);
  const ignored = pkg.build.mac.signIgnore.join('\n');
  assert.match(ignored, /openagent-host-tools/);
  assert.match(ignored, /\/node\$/);
  assert.match(ignored, /openagent-computer-control/);
  const hook = fs.readFileSync(path.join(desktop, 'scripts', 'after-sign-host-tools.js'), 'utf8');
  assert.match(hook, /bundle_manifest_sha256/);
  assert.match(hook, /TeamIdentifier/);
  assert.match(hook, /com\.openagent\.computer-control/);
});

test('release matrix selects exactly one architecture per packaged host bundle', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  for (const platform of ['mac', 'win', 'linux']) {
    for (const target of pkg.build[platform].target) {
      assert.equal(
        Object.hasOwn(target, 'arch'),
        false,
        `${platform}/${target.target} must inherit the single CI --arm64/--x64 flag`,
      );
    }
  }
  const workflow = fs.readFileSync(
    path.resolve(desktop, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  for (const platformKey of [
    'darwin-arm64', 'darwin-x64', 'win32-arm64',
    'win32-x64', 'linux-arm64', 'linux-x64',
  ]) {
    assert.match(workflow, new RegExp(`platform_key: ${platformKey}`));
  }
  assert.match(workflow, /arch_flag: --arm64/);
  assert.match(workflow, /arch_flag: --x64/);
  assert.doesNotMatch(workflow, /merge-multiple:\s*true/);
  assert.match(workflow, /merge-update-metadata\.js/);
});

test('release metadata merger preserves both architecture-specific updater files', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-update-metadata-'));
  try {
    const root = path.join(temporary, 'artifacts');
    const output = path.join(root, 'release-metadata');
    const arm = path.join(root, 'desktop-darwin-arm64');
    const x64 = path.join(root, 'desktop-darwin-x64');
    fs.mkdirSync(arm, { recursive: true });
    fs.mkdirSync(x64, { recursive: true });
    fs.writeFileSync(path.join(arm, 'latest-mac.yml'), [
      'version: 0.16.0',
      'files:',
      '  - url: openagent-app-0.16.0-macos-arm64.zip',
      '    sha512: arm-digest',
      'path: openagent-app-0.16.0-macos-arm64.zip',
      'sha512: arm-digest',
      'releaseDate: 2026-08-29T03:00:00.000Z',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(x64, 'latest-mac.yml'), [
      'version: 0.16.0',
      'files:',
      '  - url: openagent-app-0.16.0-macos-x64.zip',
      '    sha512: x64-digest',
      'path: openagent-app-0.16.0-macos-x64.zip',
      'sha512: x64-digest',
      'releaseDate: 2026-08-29T03:00:01.000Z',
      '',
    ].join('\n'));

    const merged = spawnSync(process.execPath, [mergeMetadataScript, root, output], {
      cwd: desktop,
      encoding: 'utf8',
    });
    assert.equal(merged.status, 0, merged.stderr || merged.stdout);
    const result = require('js-yaml').load(
      fs.readFileSync(path.join(output, 'latest-mac.yml'), 'utf8'),
    );
    assert.equal(result.version, '0.16.0');
    assert.equal(result.path, 'openagent-app-0.16.0-macos-x64.zip');
    assert.equal(String(result.releaseDate), '2026-08-29T03:00:01.000Z');
    assert.deepEqual(
      result.files.map((file) => file.url).sort(),
      [
        'openagent-app-0.16.0-macos-arm64.zip',
        'openagent-app-0.16.0-macos-x64.zip',
      ],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release staging verifies the complete consumer-pinned bundle', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-stage-'));
  try {
    const source = path.join(temporary, 'dist');
    const bundle = path.join(source, 'darwin-arm64');
    const target = path.join(temporary, 'stage', 'host-tools');
    const executable = Buffer.from('synthetic frozen host');
    const nodeTool = Buffer.from('synthetic node tool');
    fs.mkdirSync(path.join(bundle, 'node_modules', 'which'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'openagent-host-tools'), executable);
    fs.writeFileSync(path.join(bundle, 'node_modules', 'which', 'node-which'), nodeTool);
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    const manifestPath = path.join(bundle, 'bundle-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      manifest_version: 1,
      version: '0.1.0',
      platform: 'darwin-arm64',
      files: {
        'openagent-host-tools': { size: executable.length, sha256: digest(executable) },
        'node_modules/which/node-which': { size: nodeTool.length, sha256: digest(nodeTool) },
      },
    }));
    const lockPath = writeLock(temporary, manifestPath);

    const result = runStage(source, target, lockPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.host_tools_version, '0.1.0');
    assert.equal(manifest.source.commit, 'a'.repeat(40));
    assert.equal(manifest.bundles['darwin-arm64'].file_count, 2);
    assert.match(manifest.bundles['darwin-arm64'].bundle_manifest_sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('release staging rejects links even if a manifest attempts to pin their target bytes', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-link-'));
  try {
    const source = path.join(temporary, 'dist');
    const bundle = path.join(source, 'darwin-arm64');
    const target = path.join(temporary, 'stage', 'host-tools');
    fs.mkdirSync(path.join(bundle, 'real'), { recursive: true });
    const value = Buffer.from('target');
    fs.writeFileSync(path.join(bundle, 'openagent-host-tools'), value);
    fs.writeFileSync(path.join(bundle, 'real', 'tool'), value);
    fs.symlinkSync('real/tool', path.join(bundle, 'linked-tool'));
    const digest = createHash('sha256').update(value).digest('hex');
    const manifestPath = path.join(bundle, 'bundle-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      manifest_version: 1, version: '0.1.0', platform: 'darwin-arm64',
      files: {
        'openagent-host-tools': { size: value.length, sha256: digest },
        'real/tool': { size: value.length, sha256: digest },
        'linked-tool': { size: value.length, sha256: digest },
      },
    }));
    const result = runStage(source, target, writeLock(temporary, manifestPath));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported bundle entry/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('safe release acquisition verifies archive then manifest before staging', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-fetch-'));
  try {
    const source = path.join(temporary, 'source');
    const bundle = path.join(source, 'darwin-arm64');
    fs.mkdirSync(bundle, { recursive: true });
    const executable = Buffer.from('verified host executable');
    fs.writeFileSync(path.join(bundle, 'openagent-host-tools'), executable);
    const manifestPath = path.join(bundle, 'bundle-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      manifest_version: 1, version: '0.1.0', platform: 'darwin-arm64',
      files: {
        'openagent-host-tools': {
          size: executable.length,
          sha256: createHash('sha256').update(executable).digest('hex'),
        },
      },
    }));
    const archive = path.join(temporary, 'openagent-host-tools-darwin-arm64.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: source }, ['darwin-arm64']);
    const lockPath = writeLock(temporary, manifestPath, archive);
    const output = path.join(temporary, 'verified', 'host-tools-dist');
    const acquired = runFetch(archive, output, lockPath);
    assert.equal(acquired.status, 0, acquired.stderr || acquired.stdout);
    assert.equal(
      fs.readFileSync(path.join(output, 'darwin-arm64', 'openagent-host-tools'), 'utf8'),
      executable.toString(),
    );

    fs.appendFileSync(archive, 'tampered');
    const rejectedOutput = path.join(temporary, 'rejected', 'host-tools-dist');
    const rejected = runFetch(archive, rejectedOutput, lockPath);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /archive SHA-256/i);
    assert.equal(fs.readdirSync(rejectedOutput).length, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('required release staging fails without an exact platform bundle and writes no manifest', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-host-missing-'));
  try {
    const source = path.join(temporary, 'missing-dist');
    const target = path.join(temporary, 'stage', 'host-tools');
    const manifestPath = path.join(temporary, 'missing-manifest');
    fs.writeFileSync(manifestPath, 'missing');
    const result = runStage(source, target, writeLock(temporary, manifestPath));
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(target, 'manifest.json')), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function writeLock(temporary, manifestPath, archive = null) {
  const digestFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const lockPath = path.join(temporary, `host-tools-${Math.random().toString(16).slice(2)}.lock.json`);
  fs.writeFileSync(lockPath, JSON.stringify({
    schema: 1,
    version: '0.1.0',
    source_repository: 'openagent-uno/openagent-host-tools',
    source_ref: 'v0.1.0',
    source_commit: 'a'.repeat(40),
    platforms: {
      'darwin-arm64': {
        asset: 'openagent-host-tools-darwin-arm64.tar.gz',
        archive_sha256: archive ? digestFile(archive) : 'b'.repeat(64),
        bundle_manifest_sha256: digestFile(manifestPath),
      },
    },
  }));
  return lockPath;
}

function runStage(source, target, lockPath) {
  return spawnSync(process.execPath, [stageScript], {
    cwd: desktop,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAGENT_HOST_TOOLS_DIST: source,
      OPENAGENT_HOST_TOOLS_STAGE_DIR: target,
      OPENAGENT_HOST_TOOLS_LOCK: lockPath,
      OPENAGENT_REQUIRE_HOST_TOOLS: '1',
      OPENAGENT_HOST_TOOLS_PLATFORM_KEY: 'darwin-arm64',
    },
  });
}

function runFetch(archive, output, lockPath) {
  return spawnSync(process.execPath, [fetchScript, 'darwin-arm64', output], {
    cwd: desktop,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENAGENT_HOST_TOOLS_ARCHIVE: archive,
      OPENAGENT_HOST_TOOLS_LOCK: lockPath,
    },
  });
}
