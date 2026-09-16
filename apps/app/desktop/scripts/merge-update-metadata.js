#!/usr/bin/env node
/** Merge per-architecture electron-builder update metadata without overwrite. */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const artifactRoot = path.resolve(process.argv[2] || 'artifacts');
const outputDir = path.resolve(process.argv[3] || path.join(artifactRoot, 'release-metadata'));

if (outputDir === artifactRoot || !outputDir.startsWith(`${artifactRoot}${path.sep}`)) {
  throw new Error('metadata output must be a child of the artifact root');
}
if (!fs.statSync(artifactRoot).isDirectory()) {
  throw new Error(`artifact root is not a directory: ${artifactRoot}`);
}
if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
  throw new Error(`metadata output is not empty: ${outputDir}`);
}

const byName = new Map();
for (const file of walk(artifactRoot)) {
  if (!/^(?:latest|beta)(?:-mac|-linux(?:-arm64)?)?\.ya?ml$/i.test(path.basename(file))) continue;
  const name = path.basename(file);
  const records = byName.get(name) || [];
  records.push({ file, value: yaml.load(fs.readFileSync(file, 'utf8')) });
  byName.set(name, records);
}
if (byName.size === 0) {
  throw new Error(`no electron-builder update metadata found below ${artifactRoot}`);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const [name, records] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
  const merged = records.length === 1
    ? records[0].value
    : mergeMetadata(records, name);
  fs.writeFileSync(
    path.join(outputDir, name),
    yaml.dump(merged, { lineWidth: -1, noRefs: true }),
    'utf8',
  );
  process.stdout.write(`merged ${records.length} source(s) -> ${name}\n`);
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (path.resolve(item) === outputDir) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`artifact trees may not contain links: ${item}`);
    }
    if (entry.isDirectory()) yield* walk(item);
    else if (entry.isFile()) yield item;
  }
}

function mergeMetadata(records, name) {
  for (const record of records) {
    if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
      throw new Error(`${record.file} is not an update metadata object`);
    }
  }
  const versions = new Set(records.map(({ value }) => String(value.version || '')));
  if (versions.size !== 1 || versions.has('')) {
    throw new Error(`${name} sources do not carry one exact version`);
  }

  const preferred = [...records].sort((a, b) => {
    const ax64 = /(?:^|[-_/])x64(?:[-_/]|$)/i.test(a.file) ? 0 : 1;
    const bx64 = /(?:^|[-_/])x64(?:[-_/]|$)/i.test(b.file) ? 0 : 1;
    return ax64 - bx64 || a.file.localeCompare(b.file);
  })[0];
  const result = { ...preferred.value };
  assertSharedFields(records, name);

  const files = new Map();
  for (const record of records) {
    for (const item of fileEntries(record)) {
      const url = String(item.url || '');
      if (!url) throw new Error(`${record.file} contains an update file without a URL`);
      const existing = files.get(url);
      if (existing && stable(existing) !== stable(item)) {
        throw new Error(`${name} contains conflicting metadata for ${url}`);
      }
      files.set(url, item);
    }
  }
  result.files = [...files.values()].sort((a, b) => String(a.url).localeCompare(String(b.url)));

  const preferredPath = String(preferred.value.path || '');
  const legacy = result.files.find((item) => String(item.url) === preferredPath) || result.files[0];
  result.path = String(legacy.url);
  if (legacy.sha512) result.sha512 = legacy.sha512;
  if (legacy.sha2) result.sha2 = legacy.sha2;

  const dates = records
    .map(({ value }) => isoDate(value.releaseDate))
    .filter(Boolean)
    .sort();
  if (dates.length) result.releaseDate = dates.at(-1);

  const packages = mergePackages(records, name);
  if (packages) result.packages = packages;
  return result;
}

function fileEntries({ file, value }) {
  if (Array.isArray(value.files) && value.files.length) return value.files;
  if (value.path && value.sha512) {
    return [{ url: value.path, sha512: value.sha512 }];
  }
  throw new Error(`${file} has neither files[] nor legacy path/sha512 metadata`);
}

function assertSharedFields(records, name) {
  const perArch = new Set(['files', 'packages', 'path', 'sha512', 'sha2', 'releaseDate']);
  const keys = new Set(records.flatMap(({ value }) => Object.keys(value)));
  for (const key of keys) {
    if (perArch.has(key)) continue;
    const values = records.map(({ value }) => stable(value[key]));
    if (new Set(values).size !== 1) {
      throw new Error(`${name} sources disagree on shared field ${key}`);
    }
  }
}

function mergePackages(records, name) {
  const out = {};
  let seen = false;
  for (const { file, value } of records) {
    if (value.packages == null) continue;
    if (typeof value.packages !== 'object' || Array.isArray(value.packages)) {
      throw new Error(`${file} contains invalid packages metadata`);
    }
    seen = true;
    for (const [arch, metadata] of Object.entries(value.packages)) {
      if (Object.hasOwn(out, arch) && stable(out[arch]) !== stable(metadata)) {
        throw new Error(`${name} contains conflicting package metadata for ${arch}`);
      }
      out[arch] = metadata;
    }
  }
  return seen ? out : null;
}

function stable(value) {
  if (value === undefined) return '<undefined>';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${key}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? '' : String(value);
}
