#!/usr/bin/env node
/**
 * electron-builder afterSign guard for pre-signed client capability helpers.
 *
 * The upstream host release signs these Mach-O files before producing the
 * checksum-pinned bundle. Electron must leave them byte-for-byte unchanged so
 * their stable TCC identity and the consumer lock both remain valid.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function afterSignHostTools(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const product = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${product}.app`);
  const root = path.join(app, 'Contents', 'Resources', 'host-tools');
  const consumerManifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(consumerManifestPath)) {
    throw new Error(`Signed app is missing host-tools consumer manifest: ${consumerManifestPath}`);
  }
  const consumerManifest = JSON.parse(fs.readFileSync(consumerManifestPath, 'utf8'));
  const platformKeys = Object.keys(consumerManifest.bundles || {}).filter((key) => key.startsWith('darwin-'));
  if (platformKeys.length !== 1) {
    throw new Error(`Signed app must contain exactly one macOS host-tools bundle; got ${platformKeys}`);
  }

  const outer = signatureMetadata(app);
  if (!outer.team || outer.team === 'not set') {
    throw new Error('The release app has no Developer ID TeamIdentifier');
  }
  for (const key of platformKeys) {
    const locked = consumerManifest.bundles[key];
    const bundle = path.join(root, key);
    const bundleManifestPath = path.join(bundle, 'bundle-manifest.json');
    const bundleManifestBytes = fs.readFileSync(bundleManifestPath);
    if (sha256(bundleManifestBytes) !== locked.bundle_manifest_sha256) {
      throw new Error(`${key} bundle manifest changed during Electron signing`);
    }
    const bundleManifest = JSON.parse(bundleManifestBytes.toString('utf8'));
    verifyBundle(bundle, bundleManifest);

    const host = path.join(bundle, 'openagent-host-tools');
    const node = path.join(bundle, 'node');
    const helperApp = path.join(bundle, 'openagent-computer-control.app');
    const helper = path.join(helperApp, 'Contents', 'MacOS', 'openagent-computer-control');
    verifySignature(host, 'com.openagent.host-tools', outer.team, false);
    verifySignature(node, 'com.openagent.host-tools.node', outer.team, false);
    verifySignature(helper, 'com.openagent.computer-control', outer.team, false);
    verifySignature(helperApp, 'com.openagent.computer-control', outer.team, true);
  }
};

function verifyBundle(root, manifest) {
  if (
    manifest.manifest_version !== 1 ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new Error(`Invalid signed host-tools bundle manifest under ${root}`);
  }
  const actual = new Set(listFiles(root).filter((entry) => entry !== 'bundle-manifest.json'));
  const expected = new Set(Object.keys(manifest.files));
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    throw new Error(`Host-tools file set changed during Electron signing under ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  for (const [relative, metadata] of Object.entries(manifest.files)) {
    if (!safeRelative(relative)) throw new Error(`Unsafe host-tools path: ${relative}`);
    const candidate = path.resolve(root, ...relative.split('/'));
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Host-tools path escapes its bundle: ${relative}`);
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size !== metadata.size || sha256(fs.readFileSync(candidate)) !== metadata.sha256) {
      throw new Error(`Host-tools checksum changed during Electron signing: ${relative}`);
    }
  }
}

function verifySignature(target, expectedIdentifier, expectedTeam, deep) {
  const args = ['--verify', '--strict', '--verbose=2'];
  if (deep) args.splice(1, 0, '--deep');
  run('codesign verification', '/usr/bin/codesign', [...args, target]);
  const metadata = signatureMetadata(target);
  if (metadata.identifier !== expectedIdentifier || metadata.team !== expectedTeam) {
    throw new Error(
      `Unexpected signature on ${target}: identifier=${metadata.identifier}, team=${metadata.team}`,
    );
  }
}

function signatureMetadata(target) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', target], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`codesign metadata failed for ${target}: ${output}`);
  }
  return {
    identifier: /^Identifier=(.+)$/m.exec(output)?.[1]?.trim(),
    team: /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim(),
  };
}

function listFiles(root, directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else throw new Error(`Unsupported host-tools entry: ${absolute}`);
  }
  return files;
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) && path.posix.normalize(relative) === relative &&
    relative !== '..' && !relative.startsWith('../');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function run(label, command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${String(result.status)}`);
}
