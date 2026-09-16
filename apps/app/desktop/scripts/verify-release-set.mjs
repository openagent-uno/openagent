#!/usr/bin/env node

/** Verify the complete, merged GitHub Release asset set before publication. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { verifyEmbeddedBlockMap } from './release-artifact-contract.mjs';

const desktopDir = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.resolve(process.argv[2] || path.join(desktopDir, 'release'));
const metadataRoot = path.join(artifactRoot, 'release-metadata');
const version = String(JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')).version);
const beta = /-beta\.\d+$/.test(version);
const channel = beta ? 'beta' : 'latest';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function booleanArgument(name) {
  const value = argument(name);
  if (value === undefined) return undefined;
  assert(value === 'true' || value === 'false', `${name} must be true or false`);
  return value === 'true';
}

function walk(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const allFiles = walk(artifactRoot);
const byName = new Map();
for (const file of allFiles) {
  const name = path.basename(file);
  // Each architecture job uploads its own identically named updater YAML.
  // Only the separately verified merger output is a public release asset.
  if (/\.ya?ml$/i.test(name) && path.dirname(file) !== metadataRoot) continue;
  assert(!byName.has(name), `Duplicate merged asset name: ${name}`);
  byName.set(name, file);
}

const runners = [
  'darwin-arm64',
  'darwin-x64',
  'win32-arm64',
  'win32-x64',
  'linux-arm64',
  'linux-x64',
];
const manifests = runners.map((runner) => {
  const file = byName.get(`release-manifest-${runner}.json`);
  assert(file, `Missing release manifest for ${runner}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.schema, 1, `Unsupported ${runner} manifest schema`);
  assert.equal(manifest.version, version, `${runner} manifest version mismatch`);
  assert.equal(manifest.runner, runner, `${runner} manifest runner mismatch`);
  assert.equal(manifest.channel, channel, `${runner} manifest channel mismatch`);
  return manifest;
});

const expectedPrimary = [
  `openagent-app-${version}-macos-arm64.dmg`,
  `openagent-app-${version}-macos-arm64.zip`,
  `openagent-app-${version}-macos-x64.dmg`,
  `openagent-app-${version}-macos-x64.zip`,
  `openagent-app-${version}-windows-arm64.exe`,
  `openagent-app-${version}-windows-x64.exe`,
  `openagent-app-${version}-linux-arm64.deb`,
  `openagent-app-${version}-linux-arm64.AppImage`,
  `openagent-app-${version}-linux-amd64.deb`,
  `openagent-app-${version}-linux-x86_64.AppImage`,
].sort();
const actualPrimary = manifests.flatMap((manifest) => manifest.primary).sort();
assert.deepEqual(actualPrimary, expectedPrimary, 'Packaged installer union is not exact');

const expectedAssets = new Set(manifests.flatMap((manifest) => manifest.assets));
const manifestNames = new Set(runners.map((runner) => `release-manifest-${runner}.json`));
const actualAssets = [...byName.keys()].filter((name) => !manifestNames.has(name));
assert.deepEqual(actualAssets.sort(), [...expectedAssets].sort(), 'Merged release asset union is not exact');

const expectedMetadata = new Set([
  `${channel}-mac.yml`,
  `${channel}.yml`,
  `${channel}-linux.yml`,
  `${channel}-linux-arm64.yml`,
]);
assert.deepEqual(
  actualAssets.filter((name) => name.endsWith('.yml')).sort(),
  [...expectedMetadata].sort(),
  'Update metadata set is not exact',
);

for (const installer of expectedPrimary) {
  const file = byName.get(installer);
  const sidecar = byName.get(`${installer}.sha256`);
  assert(file && sidecar, `Missing installer or SHA-256 sidecar for ${installer}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const line = fs.readFileSync(sidecar, 'utf8').trim();
  assert.equal(line, `${actual}  ${installer}`, `SHA-256 sidecar mismatch for ${installer}`);
}

for (const metadataName of expectedMetadata) {
  const metadata = yaml.load(fs.readFileSync(byName.get(metadataName), 'utf8'));
  assert.equal(String(metadata.version), version, `${metadataName} version mismatch`);
  assert(Array.isArray(metadata.files) && metadata.files.length > 0, `${metadataName} has no files`);
  const expectedUrls = metadataName.endsWith('-mac.yml')
    ? [
        `openagent-app-${version}-macos-arm64.dmg`,
        `openagent-app-${version}-macos-arm64.zip`,
        `openagent-app-${version}-macos-x64.dmg`,
        `openagent-app-${version}-macos-x64.zip`,
      ]
    : metadataName.endsWith('-linux-arm64.yml')
      ? [
          `openagent-app-${version}-linux-arm64.deb`,
          `openagent-app-${version}-linux-arm64.AppImage`,
        ]
      : metadataName.endsWith('-linux.yml')
        ? [
            `openagent-app-${version}-linux-amd64.deb`,
            `openagent-app-${version}-linux-x86_64.AppImage`,
          ]
        : [
            `openagent-app-${version}-windows-arm64.exe`,
            `openagent-app-${version}-windows-x64.exe`,
          ];
  const urls = metadata.files.map((entry) => entry.url);
  assert.equal(new Set(urls).size, urls.length, `${metadataName} has duplicate URLs`);
  assert.deepEqual([...urls].sort(), [...expectedUrls].sort(), `${metadataName} URL set is not exact`);
  for (const entry of metadata.files) {
    assert.equal(entry.url, path.basename(entry.url), `${metadataName} URL is not a basename`);
    const name = entry.url;
    const file = byName.get(name);
    assert(file, `${metadataName} points to missing ${name}`);
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
    assert.equal(sha512, entry.sha512, `${metadataName} SHA-512 mismatch for ${name}`);
    assert.equal(fs.statSync(file).size, Number(entry.size), `${metadataName} size mismatch for ${name}`);
    if (Number(entry.blockMapSize) > 0) {
      verifyEmbeddedBlockMap(file, entry.blockMapSize, `${metadataName}:${name}`);
    }
  }
  const expectedLegacyPath = metadataName.endsWith('-mac.yml')
    ? `openagent-app-${version}-macos-x64.zip`
    : metadataName.endsWith('-linux-arm64.yml')
      ? `openagent-app-${version}-linux-arm64.AppImage`
      : metadataName.endsWith('-linux.yml')
        ? `openagent-app-${version}-linux-x86_64.AppImage`
        : `openagent-app-${version}-windows-x64.exe`;
  assert.equal(metadata.path, expectedLegacyPath, `${metadataName} legacy path mismatch`);
  const legacyEntry = metadata.files.find((entry) => entry.url === metadata.path);
  assert(legacyEntry, `${metadataName} legacy path is absent from files[]`);
  assert.equal(metadata.sha512, legacyEntry.sha512, `${metadataName} legacy checksum mismatch`);
}

const releaseJsonPath = argument('--release-json');
if (releaseJsonPath) {
  const release = JSON.parse(fs.readFileSync(releaseJsonPath, 'utf8'));
  const expectDraft = booleanArgument('--expect-draft');
  const expectPrerelease = booleanArgument('--expect-prerelease');
  if (expectDraft !== undefined) assert.equal(release.draft, expectDraft, 'GitHub draft state mismatch');
  if (expectPrerelease !== undefined) {
    assert.equal(release.prerelease, expectPrerelease, 'GitHub prerelease state mismatch');
  }
  const remote = new Map();
  for (const asset of release.assets || []) {
    assert(!remote.has(asset.name), `Duplicate uploaded asset: ${asset.name}`);
    remote.set(asset.name, asset);
  }
  assert.deepEqual([...remote.keys()].sort(), [...byName.keys()].sort(), 'Uploaded release asset union is not exact');
  for (const [name, file] of byName) {
    const asset = remote.get(name);
    assert.equal(Number(asset.size), fs.statSync(file).size, `Uploaded size mismatch for ${name}`);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(asset.digest, `sha256:${sha256}`, `Uploaded digest mismatch for ${name}`);
  }
}

console.log(`release-set smoke: ${version} ${channel} ${actualAssets.length} assets ok`);
