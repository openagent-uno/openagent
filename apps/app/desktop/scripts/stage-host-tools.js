#!/usr/bin/env node
/** Stage all available OS/arch host-tool bundles for electron-builder. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const desktop = path.resolve(__dirname, '..');
const lockPath = path.resolve(
  process.env.OPENAGENT_HOST_TOOLS_LOCK || path.join(desktop, 'host-tools.lock.json'),
);
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (
  lock.schema !== 1 ||
  typeof lock.version !== 'string' || !lock.version ||
  lock.source_ref !== `v${lock.version}` ||
  typeof lock.source_commit !== 'string' ||
  !/^[a-f0-9]{40}$/.test(lock.source_commit) ||
  !lock.platforms || typeof lock.platforms !== 'object'
) {
  throw new Error('desktop/host-tools.lock.json is invalid');
}
const source = process.env.OPENAGENT_HOST_TOOLS_DIST
  ? path.resolve(process.env.OPENAGENT_HOST_TOOLS_DIST)
  : path.resolve(desktop, '..', '..', 'openagent-host-tools', 'dist');
const target = process.env.OPENAGENT_HOST_TOOLS_STAGE_DIR
  ? path.resolve(process.env.OPENAGENT_HOST_TOOLS_STAGE_DIR)
  : path.join(desktop, 'resources', 'host-tools');
if (path.basename(target) !== 'host-tools' || target === path.parse(target).root) {
  throw new Error(`Refusing unsafe host-tools staging directory: ${target}`);
}
fs.mkdirSync(target, { recursive: true });
const appManifestPath = path.join(target, 'manifest.json');
if (fs.existsSync(appManifestPath)) fs.rmSync(appManifestPath, { force: true });

// Never let a bundle left by another build/architecture leak into a release.
// Only generated platform directories are cleared; checked-in docs/guards stay.
for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
  if (entry.isDirectory() && /^(darwin|linux|win32)-(arm64|x64)$/.test(entry.name)) {
    fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
}

let copied = 0;
const bundles = {};
if (fs.existsSync(source)) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(darwin|linux|win32)-(arm64|x64)$/.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const platformLock = lock.platforms[entry.name];
    if (!platformLock || typeof platformLock !== 'object') {
      throw new Error(`[host-tools] ${entry.name} is not present in the consumer lock`);
    }
    const verifiedSource = verifyHostBundle(
      from, entry.name, lock.version, platformLock.bundle_manifest_sha256,
    );
    fs.cpSync(from, to, { recursive: true, force: true });
    const verified = verifyHostBundle(
      to, entry.name, lock.version, platformLock.bundle_manifest_sha256,
    );
    if (verified.bundleManifestSha256 !== verifiedSource.bundleManifestSha256) {
      throw new Error(`[host-tools] ${entry.name} changed while it was staged`);
    }
    const executableName = entry.name.startsWith('win32-')
      ? 'openagent-host-tools.exe'
      : 'openagent-host-tools';
    const executable = path.join(to, executableName);
    const executableEntry = verified.files[executableName];
    if (!executableEntry || !fs.existsSync(executable)) {
      throw new Error(`[host-tools] ${entry.name} manifest has no ${executableName}`);
    }
    bundles[entry.name] = {
      executable: `${entry.name}/${executableName}`,
      size: executableEntry.size,
      sha256: executableEntry.sha256,
      host_tools_version: verified.version,
      bundle_manifest: `${entry.name}/bundle-manifest.json`,
      bundle_manifest_sha256: verified.bundleManifestSha256,
      file_count: Object.keys(verified.files).length,
    };
    copied += 1;
    console.log(`[host-tools] staged ${entry.name}`);
  }
}

const required = process.env.OPENAGENT_REQUIRE_HOST_TOOLS === '1' || process.argv.includes('--require');
const requiredKey = process.env.OPENAGENT_HOST_TOOLS_PLATFORM_KEY
  || `${process.platform}-${process.arch}`;
if (copied === 0 || (required && !bundles[requiredKey])) {
  const message = copied === 0
    ? `No stand-alone host-tools bundles found under ${source}`
    : `Required host-tools bundle ${requiredKey} was not staged from ${source}`;
  if (required) {
    console.error(`[host-tools] ${message}`);
    process.exit(1);
  }
  console.warn(`[host-tools] ${message}; packaged local tools will report unavailable`);
}

fs.writeFileSync(
  appManifestPath,
  JSON.stringify({
    version: 2,
    host_tools_version: lock.version,
    source: {
      repository: lock.source_repository,
      ref: lock.source_ref,
      commit: lock.source_commit,
    },
    bundles,
  }, null, 2) + '\n',
);

function verifyHostBundle(root, key, expectedVersion, expectedManifestSha256) {
  const manifestPath = path.join(root, 'bundle-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[host-tools] ${key} has no bundle-manifest.json`);
  }
  const bytes = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`[host-tools] ${key} bundle manifest is invalid JSON: ${error.message}`);
  }
  if (
    manifest.manifest_version !== 1 ||
    manifest.version !== expectedVersion ||
    manifest.platform !== key ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files) ||
    Object.keys(manifest.files).length === 0
  ) {
    throw new Error(`[host-tools] ${key} bundle manifest/version does not match the app lock`);
  }
  const bundleManifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (
    typeof expectedManifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ||
    bundleManifestSha256 !== expectedManifestSha256
  ) {
    throw new Error(`[host-tools] ${key} bundle manifest digest does not match the app lock`);
  }

  const actualFiles = new Set(listFiles(root).filter((relative) => relative !== 'bundle-manifest.json'));
  const declaredFiles = new Set(Object.keys(manifest.files));
  for (const relative of declaredFiles) {
    if (!isSafeRelativePath(relative)) {
      throw new Error(`[host-tools] ${key} has an unsafe manifest path: ${relative}`);
    }
    const metadata = manifest.files[relative];
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      typeof metadata.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)
    ) {
      throw new Error(`[host-tools] ${key} has invalid metadata for ${relative}`);
    }
    const candidate = path.resolve(root, ...relative.split('/'));
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`[host-tools] ${key} manifest escapes its bundle: ${relative}`);
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size !== metadata.size) {
      throw new Error(`[host-tools] ${key} size mismatch: ${relative}`);
    }
    const digest = sha256File(candidate);
    if (digest !== metadata.sha256) {
      throw new Error(`[host-tools] ${key} SHA-256 mismatch: ${relative}`);
    }
  }
  for (const relative of actualFiles) {
    if (!declaredFiles.has(relative)) {
      throw new Error(`[host-tools] ${key} contains an unpinned file: ${relative}`);
    }
  }
  for (const relative of declaredFiles) {
    if (!actualFiles.has(relative)) {
      throw new Error(`[host-tools] ${key} is missing a pinned file: ${relative}`);
    }
  }
  return {
    version: manifest.version,
    files: manifest.files,
    bundleManifestSha256,
  };
}

function listFiles(root, directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else {
      throw new Error(`[host-tools] unsupported bundle entry: ${absolute}`);
    }
  }
  return files;
}

function isSafeRelativePath(relative) {
  return typeof relative === 'string' &&
    relative.length > 0 &&
    !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) &&
    path.posix.normalize(relative) === relative &&
    relative !== '..' &&
    !relative.startsWith('../');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
