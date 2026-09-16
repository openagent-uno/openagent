/**
 * Per-install device identity — the ed25519 keypair OpenAgent uses to
 * sign device-cert challenges and to derive the iroh NodeId.
 *
 * Mirrors openagent/network/identity.py: the secret is stored as 32
 * raw bytes (no PEM, no encoding), 0600, written atomically through a
 * tempfile + rename in the same directory so a crash mid-write can
 * never leave a corrupt key on disk.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ed25519 from '@noble/ed25519';

// noble-ed25519 v3's async API uses ``crypto.subtle.digest`` for
// SHA-512 — no extra hash dependency needed in Electron's main
// process. We only call ``*Async`` methods.

export const SECRET_KEY_LEN = 32;
export const PUBLIC_KEY_LEN = 32;

export interface Identity {
  /** 32 raw bytes — the ed25519 secret seed. */
  readonly secret: Uint8Array;
  /** 32 raw bytes — the matching ed25519 public key. */
  readonly publicKey: Uint8Array;
  /** Lowercase hex of the public key — the iroh NodeId. */
  readonly nodeIdHex: string;
}

export async function generateIdentity(): Promise<Identity> {
  const secret = new Uint8Array(randomBytes(SECRET_KEY_LEN));
  return identityFromSecret(secret);
}

export async function identityFromSecret(secret: Uint8Array): Promise<Identity> {
  if (secret.length !== SECRET_KEY_LEN) {
    throw new Error(`identity secret must be ${SECRET_KEY_LEN} bytes, got ${secret.length}`);
  }
  const publicKey = await ed25519.getPublicKeyAsync(secret);
  const nodeIdHex = Buffer.from(publicKey).toString('hex');
  return { secret, publicKey, nodeIdHex };
}

/**
 * Read an identity from a 32-byte raw file, or generate a fresh one
 * and persist it (0600) atomically if the file is missing. The caller
 * passes the desired path; we mkdir -p its parent.
 */
export async function loadOrCreateIdentity(filePath: string): Promise<Identity> {
  try {
    return await readIdentity(filePath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }

  const identity = await generateIdentity();
  if (publishNewIdentity(filePath, identity)) return identity;

  // Another Desktop/CLI process won first creation. Never return our
  // discarded candidate: Iroh must use the identity persisted by the winner.
  return readIdentity(filePath);
}

async function readIdentity(filePath: string): Promise<Identity> {
  const raw = fs.readFileSync(filePath);
  if (raw.length !== SECRET_KEY_LEN) {
    throw new Error(
      `identity file ${filePath} is ${raw.length} bytes; expected ${SECRET_KEY_LEN}`,
    );
  }
  return identityFromSecret(new Uint8Array(raw));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Publish a fully-written identity only while ``filePath`` is absent.
 *
 * A rename would overwrite another process's winner. Linking a unique,
 * fsynced tempfile into place is atomic and no-replace on every supported
 * local filesystem: exactly one Desktop/CLI process succeeds, and losers
 * re-read the complete winning inode.
 */
function publishNewIdentity(filePath: string, identity: Identity): boolean {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(identity.secret));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // chmod again because some umask configurations strip the write bits.
    fs.chmodSync(tmp, 0o600);
    try {
      fs.linkSync(tmp, filePath);
      return true;
    } catch (error: unknown) {
      if (hasErrorCode(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }
}

/**
 * Derive a deterministic short fingerprint for logging. Mirrors what
 * iroh-py prints in its node-id banner — first 12 hex chars of sha256
 * of the public key. NOT cryptographically meaningful on its own.
 */
export function shortFingerprint(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 12);
}
