/**
 * Device identity — portable ed25519 keypair management.
 *
 * Platform-specific persistence (file on desktop, Keychain on iOS) is
 * handled by the caller. This module only deals with key generation and
 * derivation using ``@noble/ed25519`` (pure JS, no ``node:crypto``).
 */

import * as ed25519 from '@noble/ed25519';
import { bytesToHex } from './encoding';

export const SECRET_KEY_LEN = 32;
export const PUBLIC_KEY_LEN = 32;

export interface Identity {
  readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly nodeIdHex: string;
}

export async function generateIdentity(): Promise<Identity> {
  const secret = new Uint8Array(SECRET_KEY_LEN);
  crypto.getRandomValues(secret);
  return identityFromSecret(secret);
}

export async function identityFromSecret(secret: Uint8Array): Promise<Identity> {
  if (secret.length !== SECRET_KEY_LEN) {
    throw new Error(`identity secret must be ${SECRET_KEY_LEN} bytes, got ${secret.length}`);
  }
  const publicKey = await ed25519.getPublicKeyAsync(secret);
  const nodeIdHex = bytesToHex(publicKey);
  return { secret, publicKey, nodeIdHex };
}
