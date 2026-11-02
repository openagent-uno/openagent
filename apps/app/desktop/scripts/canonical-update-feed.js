#!/usr/bin/env node
/** Build channel metadata only after checking immutable payloads locally. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function canonicalMetadata(metadata, tag, readPayload) {
  if (!/^app-v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag) || tag !== `app-v${metadata.version}`) {
    throw new Error('Metadata version and canonical release tag differ');
  }
  if (!Array.isArray(metadata.files) || !metadata.files.length || metadata.packages) {
    throw new Error('Unsupported or empty update metadata');
  }
  const files = new Map();
  const base = `https://github.com/openagent-uno/openagent/releases/download/${encodeURIComponent(tag)}/`;
  for (const file of metadata.files) {
    if (typeof file.url !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(file.url) || !file.url.includes(`-${metadata.version}-`) || files.has(file.url)) {
      throw new Error('Unsafe, duplicate or wrong-version update filename');
    }
    const bytes = readPayload(file.url);
    if (bytes.length !== file.size || crypto.createHash('sha512').update(bytes).digest('base64') !== file.sha512) {
      throw new Error('Update payload differs from its metadata');
    }
    files.set(file.url, {...file, url: base + encodeURIComponent(file.url)});
  }
  const primary = files.get(metadata.path);
  if (!primary || primary.sha512 !== metadata.sha512) throw new Error('Invalid primary update payload');
  return {...metadata, files: [...files.values()], path: primary.url};
}

function main() {
  const [rootArg, metadataArg, outputArg, tag] = process.argv.slice(2);
  if (!tag) throw new Error('Usage: canonical-update-feed.js PAYLOAD_ROOT MERGED_METADATA EMPTY_OUTPUT app-vVERSION');
  const root = path.resolve(rootArg), metadataDir = path.resolve(metadataArg), output = path.resolve(outputArg);
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Feed output must be empty');
  const payloads = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Payload trees cannot contain links');
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:zip|dmg|exe|AppImage|deb)$/.test(entry.name)) {
        if (payloads.has(entry.name)) throw new Error('Duplicate payload filename');
        payloads.set(entry.name, file);
      }
    }
  }
  walk(root);
  const channel = tag.includes('-beta.') ? 'beta' : 'latest';
  const expected = [`${channel}.yml`, `${channel}-mac.yml`, `${channel}-linux.yml`, `${channel}-linux-arm64.yml`];
  const actual = fs.readdirSync(metadataDir).filter(name => name.endsWith('.yml')).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Complete six-platform channel metadata is required');
  const results = expected.map(name => {
    const value = yaml.load(fs.readFileSync(path.join(metadataDir, name), 'utf8'));
    const feed = canonicalMetadata(value, tag, name => {
      if (!payloads.has(name)) throw new Error('Update payload is missing');
      return fs.readFileSync(payloads.get(name));
    });
    return [name, feed];
  });
  // Write nothing until all metadata/payload checks pass.
  fs.mkdirSync(output, {recursive: true});
  for (const [name, feed] of results) fs.writeFileSync(path.join(output, name), yaml.dump(feed, {lineWidth: -1, noRefs: true}));
  console.log(`Verified complete ${tag} channel metadata and immutable payload checksums`);
}

module.exports = {canonicalMetadata};
if (require.main === module) main();
