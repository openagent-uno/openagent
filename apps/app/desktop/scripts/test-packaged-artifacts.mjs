#!/usr/bin/env node

/**
 * Fail-closed smoke test for the exact Electron artifacts produced by CI.
 *
 * This deliberately inspects the packaged ASAR and update metadata instead
 * of importing source files from the checkout: a release is useful only when
 * the bytes uploaded to GitHub contain the advertised version and entrypoints.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as asar from '@electron/asar';
import yaml from 'js-yaml';
import {
  canonicalAsarEntry,
  expectedLinuxExecutableName,
  findLinuxPayloadExecutables,
  listTopLevelReleaseFiles,
  verifyEmbeddedBlockMap,
} from './release-artifact-contract.mjs';
import { verifyMacIconPng } from './verify-macos-icon.mjs';

const desktopDir = path.resolve(import.meta.dirname, '..');
const releaseDir = path.join(desktopDir, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
const version = String(pkg.version);
const platformKey = String(process.argv[2] || `${process.platform}-${process.arch}`).toLowerCase();
const platformMatch = /^(darwin|win32|linux)-(arm64|x64)$/.exec(platformKey);
assert(platformMatch, `Unsupported release platform key: ${platformKey}`);
const targetPlatform = platformMatch[1];
const targetArch = platformMatch[2];
assert.equal(process.platform, targetPlatform, `Runner platform is ${process.platform}, expected ${targetPlatform}`);
assert.equal(process.arch, targetArch, `Runner architecture is ${process.arch}, expected ${targetArch}`);
const beta = /-beta\.\d+$/.test(version);
const channel = beta ? 'beta' : 'latest';

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function directories(root, suffix) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(suffix)) found.push(full);
    else found.push(...directories(full, suffix));
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

function validateAsar(archive) {
  const entries = new Set(asar.listPackage(archive).map(canonicalAsarEntry));
  assert(entries.has('/dist/main.js'), `${archive} has no bundled main entrypoint`);
  assert(entries.has('/dist/preload.js'), `${archive} has no bundled preload entrypoint`);
  assert(entries.has('/package.json'), `${archive} has no packaged manifest`);
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(String(packaged.version), version, `${archive} manifest version mismatch`);
  assert.equal(packaged.main, 'dist/main.js', `${archive} has the wrong main entrypoint`);
  assert(
    fs.existsSync(path.join(path.dirname(archive), 'web-build', 'index.html')),
    `${archive} is missing the packaged web application`,
  );
}

function validatePayload(root) {
  const archives = walk(root).filter((file) => path.basename(file) === 'app.asar');
  assert(archives.length > 0, `No packaged app.asar found under ${root}`);
  for (const archive of archives) validateAsar(archive);
  return archives;
}

function smokeExecutable(executable, extraArgs = []) {
  const args = [...extraArgs, '--packaged-smoke', `--expected-version=${version}`];
  const env = {
    ...process.env,
    ELECTRON_DISABLE_GPU: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const result = process.platform === 'linux'
    ? run('xvfb-run', ['-a', executable, '--no-sandbox', ...args], { env })
    : run(executable, args, { env });
  assert(
    `${result.stdout || ''}\n${result.stderr || ''}`.includes(`packaged-smoke ok ${version}`),
    `${executable} exited without the packaged-smoke success marker`,
  );
}

let extractedIconCount = 0;
function validateMacIcon(appBundle, temporaryRoot) {
  const packagedIcon = path.join(appBundle, 'Contents', 'Resources', 'icon.icns');
  assert(fs.existsSync(packagedIcon), `${appBundle} has no packaged icon.icns`);
  const iconSet = path.join(temporaryRoot, `packaged-icon-${extractedIconCount}.iconset`);
  extractedIconCount += 1;
  run('iconutil', ['-c', 'iconset', packagedIcon, '-o', iconSet]);
  verifyMacIconPng(
    path.join(iconSet, 'icon_512x512@2x.png'),
    `${appBundle} packaged macOS icon`,
  );
}

const files = listTopLevelReleaseFiles(releaseDir);
assert(files.length > 0, `No packaged files found in ${releaseDir}`);

let extensions;
let metadataName;
if (targetPlatform === 'darwin') {
  extensions = ['.dmg', '.zip'];
  metadataName = `${channel}-mac.yml`;
} else if (targetPlatform === 'win32') {
  extensions = ['.exe'];
  metadataName = `${channel}.yml`;
} else if (targetPlatform === 'linux') {
  extensions = ['.AppImage', '.deb'];
  metadataName = targetArch === 'arm64'
    ? `${channel}-linux-arm64.yml`
    : `${channel}-linux.yml`;
} else {
  throw new Error(`Unsupported release platform: ${targetPlatform}`);
}

for (const extension of extensions) {
  const matches = files.filter((file) => file.endsWith(extension));
  assert(matches.length > 0, `Missing ${extension} release artifact`);
  for (const file of matches) {
    assert(
      path.basename(file).includes(`-${version}-`),
      `Artifact does not carry the exact source version ${version}: ${file}`,
    );
  }
}

const metadataPath = path.join(releaseDir, metadataName);
assert(fs.existsSync(metadataPath), `Missing ${metadataName}`);
const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
assert.equal(String(metadata.version), version, 'Update metadata version mismatch');
assert(Array.isArray(metadata.files) && metadata.files.length > 0, 'Update metadata has no files');
const expectedMetadataUrls = targetPlatform === 'darwin'
  ? [
      `openagent-app-${version}-macos-${targetArch}.dmg`,
      `openagent-app-${version}-macos-${targetArch}.zip`,
    ]
  : targetPlatform === 'win32'
    ? [`openagent-app-${version}-windows-${targetArch}.exe`]
    : targetArch === 'x64'
      ? [
          `openagent-app-${version}-linux-amd64.deb`,
          `openagent-app-${version}-linux-x86_64.AppImage`,
        ]
      : [
          `openagent-app-${version}-linux-arm64.deb`,
          `openagent-app-${version}-linux-arm64.AppImage`,
        ];
const metadataUrls = metadata.files.map((entry) => entry.url);
assert.equal(new Set(metadataUrls).size, metadataUrls.length, 'Update metadata contains duplicate URLs');
assert.deepEqual([...metadataUrls].sort(), [...expectedMetadataUrls].sort(), 'Update metadata URL set is not exact');
for (const entry of metadata.files) {
  assert.equal(typeof entry.url, 'string', 'Update metadata file has no URL');
  assert.equal(entry.url, path.basename(entry.url), `Update metadata URL is not a basename: ${entry.url}`);
  assert.equal(typeof entry.sha512, 'string', 'Update metadata file has no checksum');
  assert(entry.sha512.length >= 80, 'Update metadata checksum is unexpectedly short');
  assert(Number(entry.size) > 0, 'Update metadata file has no positive size');
  const artifact = path.join(releaseDir, path.basename(entry.url));
  assert(fs.existsSync(artifact), `Metadata points to a missing artifact: ${entry.url}`);
  const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(artifact)).digest('base64');
  assert.equal(actualSha512, entry.sha512, `SHA-512 mismatch for ${entry.url}`);
  assert.equal(fs.statSync(artifact).size, Number(entry.size), `Size mismatch for ${entry.url}`);
  if (Number(entry.blockMapSize) > 0) {
    verifyEmbeddedBlockMap(artifact, entry.blockMapSize, entry.url);
  }
}
const expectedLegacyPath = targetPlatform === 'darwin'
  ? `openagent-app-${version}-macos-${targetArch}.zip`
  : targetPlatform === 'win32'
    ? `openagent-app-${version}-windows-${targetArch}.exe`
    : targetArch === 'x64'
      ? `openagent-app-${version}-linux-x86_64.AppImage`
      : `openagent-app-${version}-linux-arm64.AppImage`;
assert.equal(metadata.path, expectedLegacyPath, 'Legacy update path mismatch');
const legacyEntry = metadata.files.find((entry) => entry.url === metadata.path);
assert(legacyEntry, 'Legacy update path is not present in files[]');
assert.equal(metadata.sha512, legacyEntry.sha512, 'Legacy update checksum mismatch');

const wrongChannel = beta
  ? /^latest(?:-mac|-linux(?:-arm64)?)?\.yml$/
  : /^beta(?:-mac|-linux(?:-arm64)?)?\.yml$/;
assert(
  !files.some((file) => wrongChannel.test(path.basename(file))),
  `Found update metadata for the wrong ${beta ? 'stable' : 'beta'} channel`,
);

validatePayload(releaseDir);

const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-artifact-smoke-'));
try {
  if (targetPlatform === 'darwin') {
    const launchCandidates = [];
    for (const zip of files.filter((file) => file.endsWith('.zip'))) {
      run('unzip', ['-tq', zip]);
      const destination = path.join(extractionRoot, path.basename(zip, '.zip'));
      fs.mkdirSync(destination, { recursive: true });
      run('ditto', ['-x', '-k', zip, destination]);
      const apps = directories(destination, '.app');
      assert.equal(apps.length, 1, `${zip} did not contain exactly one .app`);
      const appBundle = apps[0];
      validatePayload(appBundle);
      validateMacIcon(appBundle, extractionRoot);
      const plist = path.join(appBundle, 'Contents', 'Info.plist');
      const plistVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]).stdout.trim();
      assert.equal(plistVersion, version, `${zip} Info.plist version mismatch`);
      if (process.env.REQUIRE_SIGNED === 'true') {
        run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
      }
      if (path.basename(zip).includes(`-${process.arch}.zip`)) {
        const executables = walk(path.join(appBundle, 'Contents', 'MacOS'));
        assert.equal(executables.length, 1, `${zip} has an unexpected executable set`);
        launchCandidates.push(executables[0]);
      }
    }
    for (const dmg of files.filter((file) => file.endsWith('.dmg'))) {
      run('hdiutil', ['verify', dmg]);
      const mount = path.join(extractionRoot, `mount-${path.basename(dmg, '.dmg')}`);
      fs.mkdirSync(mount, { recursive: true });
      let attached = false;
      try {
        run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
        attached = true;
        const apps = directories(mount, '.app');
        assert.equal(apps.length, 1, `${dmg} did not mount exactly one .app`);
        validatePayload(apps[0]);
        validateMacIcon(apps[0], extractionRoot);
        const plist = path.join(apps[0], 'Contents', 'Info.plist');
        const plistVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]).stdout.trim();
        assert.equal(plistVersion, version, `${dmg} Info.plist version mismatch`);
        if (process.env.REQUIRE_SIGNED === 'true') {
          run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', apps[0]]);
        }
        if (path.basename(dmg).includes(`-${process.arch}.dmg`)) {
          const installed = path.join(extractionRoot, `installed-${process.arch}.app`);
          run('ditto', [apps[0], installed]);
          validatePayload(installed);
          const executables = walk(path.join(installed, 'Contents', 'MacOS'));
          assert.equal(executables.length, 1, `${dmg} has an unexpected executable set`);
          launchCandidates.push(executables[0]);
        }
      } finally {
        if (attached) run('hdiutil', ['detach', mount]);
      }
    }
    assert.equal(launchCandidates.length, 2, `Expected ZIP and DMG launch payloads for macOS ${process.arch}`);
    for (const executable of launchCandidates) smokeExecutable(executable);
  } else if (targetPlatform === 'win32') {
    const installers = files.filter((file) => file.endsWith('.exe'));
    assert.equal(installers.length, 1, 'Windows build must produce exactly one installer');
    const installDir = path.join(extractionRoot, 'installed');
    run(installers[0], ['/S', `/D=${installDir}`]);
    validatePayload(installDir);
    const installedExecutables = walk(installDir).filter((file) => file.toLowerCase().endsWith('.exe'));
    const executables = installedExecutables.filter(
      (file) => path.basename(file).toLowerCase() === 'openagent.exe',
    );
    assert.equal(
      executables.length,
      1,
      `Installed Windows payload has no unique OpenAgent.exe; executable tree: ${
        installedExecutables
          .map((file) => path.relative(installDir, file))
          .sort()
          .join(', ') || '<none>'
      }`,
    );
    smokeExecutable(executables[0]);
  } else if (targetPlatform === 'linux') {
    const appImages = files.filter((file) => file.endsWith('.AppImage'));
    const debs = files.filter((file) => file.endsWith('.deb'));
    assert.equal(appImages.length, 1, 'Linux build must produce exactly one AppImage');
    assert.equal(debs.length, 1, 'Linux build must produce exactly one deb');

    fs.chmodSync(appImages[0], 0o755);
    const appImageDir = path.join(extractionRoot, 'appimage');
    fs.mkdirSync(appImageDir);
    run(appImages[0], ['--appimage-extract'], { cwd: appImageDir });
    const squashfsRoot = path.join(appImageDir, 'squashfs-root');
    validatePayload(squashfsRoot);
    smokeExecutable(path.join(squashfsRoot, 'AppRun'));

    run('dpkg-deb', ['--info', debs[0]]);
    const debVersion = run('dpkg-deb', ['--field', debs[0], 'Version']).stdout.trim();
    assert.equal(debVersion, version, `${debs[0]} package version mismatch`);
    const debRoot = path.join(extractionRoot, 'deb');
    fs.mkdirSync(debRoot);
    run('dpkg-deb', ['--extract', debs[0], debRoot]);
    validatePayload(debRoot);
    const expectedExecutable = expectedLinuxExecutableName(pkg);
    const executables = findLinuxPayloadExecutables(debRoot, expectedExecutable);
    assert.equal(
      executables.length,
      1,
      `Extracted deb has no unique ${expectedExecutable} executable`,
    );
    smokeExecutable(executables[0]);
  }
} finally {
  fs.rmSync(extractionRoot, { recursive: true, force: true });
}

const installers = files.filter((file) => extensions.some((extension) => file.endsWith(extension)));
const sidecars = [];
for (const installer of installers) {
  const basename = path.basename(installer);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const sidecar = `${installer}.sha256`;
  fs.writeFileSync(sidecar, `${digest}  ${basename}\n`, { encoding: 'utf8', mode: 0o600 });
  sidecars.push(sidecar);
}

const blockmaps = files.filter((file) => file.endsWith('.blockmap'));
const manifest = {
  schema: 1,
  version,
  runner: platformKey,
  channel,
  primary: installers.map((file) => path.basename(file)).sort(),
  assets: [metadataPath, ...installers, ...blockmaps, ...sidecars]
    .map((file) => path.basename(file))
    .sort(),
};
fs.writeFileSync(
  path.join(releaseDir, `release-manifest-${platformKey}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

console.log(`packaged-artifact smoke: ${version} ${platformKey} ${channel} ok`);
