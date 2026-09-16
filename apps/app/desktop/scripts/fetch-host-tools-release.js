#!/usr/bin/env node
/** Acquire one exact, consumer-pinned host-tools release bundle safely. */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tar = require('tar');

const PLATFORM_RE = /^(darwin|linux|win32)-(arm64|x64)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const desktop = path.resolve(__dirname, '..');
  const lockPath = path.resolve(
    process.env.OPENAGENT_HOST_TOOLS_LOCK || path.join(desktop, 'host-tools.lock.json'),
  );
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const platformKey = process.argv[2];
  const output = path.resolve(process.argv[3] || 'host-tools-dist');
  if (!PLATFORM_RE.test(platformKey || '')) {
    throw new Error(`Invalid host-tools platform key: ${String(platformKey)}`);
  }
  const pinned = validateLock(lock, platformKey);
  if (path.basename(output) !== 'host-tools-dist' || output === path.parse(output).root) {
    throw new Error(`Refusing unsafe host-tools release directory: ${output}`);
  }
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
    throw new Error(`Host-tools release directory is not empty: ${output}`);
  }
  fs.mkdirSync(output, { recursive: true });

  const override = process.env.OPENAGENT_HOST_TOOLS_ARCHIVE?.trim();
  let archive;
  if (override) {
    archive = path.resolve(override);
  } else {
    const download = path.join(path.dirname(output), 'host-tools-download');
    if (fs.existsSync(download) && fs.readdirSync(download).length > 0) {
      throw new Error(`Host-tools download directory is not empty: ${download}`);
    }
    fs.mkdirSync(download, { recursive: true });
    run('GitHub release download', 'gh', [
      'release', 'download', lock.source_ref,
      '--repo', lock.source_repository,
      '--pattern', pinned.asset,
      '--dir', download,
    ]);
    archive = path.join(download, pinned.asset);
  }
  if (!fs.existsSync(archive) || !fs.statSync(archive).isFile()) {
    throw new Error(`Pinned host-tools asset was not found: ${archive}`);
  }
  if (sha256File(archive) !== pinned.archive_sha256) {
    throw new Error('Host-tools archive SHA-256 does not match the consumer lock');
  }

  await tar.x({
    file: archive,
    cwd: output,
    strict: true,
    preserveOwner: false,
    filter: (entryPath, entry) => {
      validateArchiveEntry(entryPath, entry, platformKey);
      return true;
    },
  });
  verifyHostBundle(
    path.join(output, platformKey),
    platformKey,
    lock.version,
    pinned.bundle_manifest_sha256,
  );
  console.log(
    `[host-tools] acquired ${lock.source_repository}@${lock.source_ref} ${pinned.asset}`,
  );
}

function validateLock(lock, platformKey) {
  const entry = lock?.platforms?.[platformKey];
  if (
    lock?.schema !== 1 ||
    typeof lock.version !== 'string' || !lock.version ||
    lock.source_ref !== `v${lock.version}` ||
    typeof lock.source_repository !== 'string' || !lock.source_repository ||
    typeof lock.source_commit !== 'string' || !/^[a-f0-9]{40}$/.test(lock.source_commit) ||
    !entry || typeof entry !== 'object' || Array.isArray(entry) ||
    typeof entry.asset !== 'string' || path.basename(entry.asset) !== entry.asset ||
    !SHA256_RE.test(entry.archive_sha256 || '') ||
    !SHA256_RE.test(entry.bundle_manifest_sha256 || '')
  ) {
    throw new Error('host-tools.lock.json has no immutable platform contract');
  }
  return entry;
}

function validateArchiveEntry(entryPath, entry, platformKey) {
  if (
    typeof entryPath !== 'string' || !entryPath || entryPath.includes('\\') ||
    entryPath.includes('\0')
  ) {
    throw new Error(`Unsafe host-tools archive member: ${String(entryPath)}`);
  }
  const withoutTrailingSlash = entryPath.replace(/\/+$/, '');
  const normalized = path.posix.normalize(withoutTrailingSlash);
  const parts = normalized.split('/');
  if (
    !normalized || normalized === '.' || path.posix.isAbsolute(entryPath) ||
    normalized !== withoutTrailingSlash || parts.includes('..') ||
    parts[0] !== platformKey
  ) {
    throw new Error(`Host-tools archive member escapes ${platformKey}: ${entryPath}`);
  }
  if (!['File', 'OldFile', 'Directory'].includes(entry.type)) {
    throw new Error(`Unsupported host-tools archive entry type ${entry.type}: ${entryPath}`);
  }
}

function verifyHostBundle(root, platformKey, version, expectedManifestSha256) {
  const manifestPath = path.join(root, 'bundle-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Pinned host-tools asset has no ${platformKey}/bundle-manifest.json`);
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  if (sha256Bytes(manifestBytes) !== expectedManifestSha256) {
    throw new Error('Host-tools bundle manifest SHA-256 does not match the consumer lock');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest.manifest_version !== 1 || manifest.version !== version ||
    manifest.platform !== platformKey || !manifest.files ||
    typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
    Object.keys(manifest.files).length === 0
  ) {
    throw new Error('Host-tools bundle identity does not match the consumer lock');
  }
  const actual = new Set(listRegularFiles(root).filter((name) => name !== 'bundle-manifest.json'));
  const declared = new Set(Object.keys(manifest.files));
  if (actual.size !== declared.size || [...actual].some((name) => !declared.has(name))) {
    throw new Error('Host-tools bundle file set does not match its verified manifest');
  }
  const resolvedRoot = fs.realpathSync(root);
  for (const relative of declared) {
    if (!isSafeRelativePath(relative)) {
      throw new Error(`Unsafe path in host-tools bundle manifest: ${relative}`);
    }
    const metadata = manifest.files[relative];
    if (
      !metadata || !Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
      !SHA256_RE.test(metadata.sha256 || '')
    ) {
      throw new Error(`Invalid host-tools bundle metadata: ${relative}`);
    }
    const candidate = path.resolve(root, ...relative.split('/'));
    const stat = fs.lstatSync(candidate);
    const real = fs.realpathSync(candidate);
    if (
      !stat.isFile() || stat.isSymbolicLink() ||
      (real !== resolvedRoot && !real.startsWith(`${resolvedRoot}${path.sep}`)) ||
      stat.size !== metadata.size || sha256File(candidate) !== metadata.sha256
    ) {
      throw new Error(`Host-tools bundle integrity mismatch: ${relative}`);
    }
  }
}

function listRegularFiles(root, directory = root) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listRegularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Unsupported host-tools bundle entry: ${absolute}`);
  }
  return files;
}

function isSafeRelativePath(relative) {
  return typeof relative === 'string' && relative.length > 0 &&
    !relative.includes('\\') && !path.posix.isAbsolute(relative) &&
    path.posix.normalize(relative) === relative && relative !== '..' &&
    !relative.startsWith('../');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function run(label, command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
}
