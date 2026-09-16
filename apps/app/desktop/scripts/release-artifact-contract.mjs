import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Public release assets are files directly under electron-builder's output
 * directory. Recursive payload files (for example win-unpacked/OpenAgent.exe)
 * are implementation details and must never be mistaken for installers. */
export function listTopLevelReleaseFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

/** Mirror electron-builder's Linux executable-name contract. An explicit
 * build executableName wins; otherwise LinuxPackager lowercases the sanitized
 * package name. OpenAgent's package/config names are already safe basenames,
 * and this verifier rejects an ambiguous path instead of guessing. */
export function expectedLinuxExecutableName(packageManifest) {
  const configured = packageManifest?.build?.linux?.executableName
    ?? packageManifest?.build?.executableName;
  const value = configured == null
    ? String(packageManifest?.name || '').toLowerCase()
    : String(configured);
  assert(value.length > 0, 'Linux executable contract has no package/config name');
  assert(
    /^[a-zA-Z0-9._+-]+$/.test(value),
    `Linux executable contract is not an exact portable basename: ${value}`,
  );
  return value;
}

/** Locate the real executable payload in an extracted Linux package. Links are
 * excluded so a package cannot satisfy the smoke test with only a launcher
 * alias whose target is absent. */
export function findLinuxPayloadExecutables(root, expectedName) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (
        entry.isFile()
        && entry.name === expectedName
        && (fs.statSync(full).mode & 0o111) !== 0
      ) {
        found.push(full);
      }
    }
  };
  visit(root);
  return found.sort();
}

/** @electron/asar builds listPackage() entries with node:path, so Windows
 * runners return backslash-delimited names while POSIX runners return forward
 * slashes. Canonicalize only for archive-entry comparison; extraction retains
 * the library's native path handling. */
export function canonicalAsarEntry(entry) {
  const normalized = String(entry).replaceAll('\\', '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Verify an electron-builder blockmap that is embedded at the end of an
 * installer. AppImage update metadata exposes its compressed byte length as
 * `blockMapSize`; unlike ZIP/DMG/NSIS blockmaps, there is deliberately no
 * sibling `.blockmap` file to upload.
 */
export function verifyEmbeddedBlockMap(file, declaredSize, label = file) {
  const blockMapSize = Number(declaredSize);
  assert(
    Number.isSafeInteger(blockMapSize) && blockMapSize > 0,
    `${label} has an invalid embedded blockmap size`,
  );

  const fileSize = fs.statSync(file).size;
  assert(fileSize > blockMapSize + 4, `${label} is too small for its embedded blockmap`);

  const descriptor = fs.openSync(file, 'r');
  try {
    const compressed = Buffer.allocUnsafe(blockMapSize);
    const trailer = Buffer.allocUnsafe(4);
    const compressedOffset = fileSize - blockMapSize - trailer.length;
    assert.equal(
      fs.readSync(descriptor, compressed, 0, compressed.length, compressedOffset),
      compressed.length,
      `${label} embedded blockmap is truncated`,
    );
    assert.equal(
      fs.readSync(descriptor, trailer, 0, trailer.length, fileSize - trailer.length),
      trailer.length,
      `${label} embedded blockmap trailer is truncated`,
    );
    assert.equal(
      trailer.readUInt32BE(0),
      blockMapSize,
      `${label} embedded blockmap trailer size mismatch`,
    );

    const blockMap = JSON.parse(zlib.inflateRawSync(compressed).toString('utf8'));
    assert.equal(blockMap.version, '2', `${label} has an unsupported embedded blockmap schema`);
    assert(Array.isArray(blockMap.files) && blockMap.files.length > 0, `${label} embedded blockmap has no files`);
    for (const mappedFile of blockMap.files) {
      assert(Array.isArray(mappedFile.checksums), `${label} embedded blockmap has no checksums`);
      assert(Array.isArray(mappedFile.sizes), `${label} embedded blockmap has no chunk sizes`);
      assert.equal(
        mappedFile.checksums.length,
        mappedFile.sizes.length,
        `${label} embedded blockmap chunk arrays differ`,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
