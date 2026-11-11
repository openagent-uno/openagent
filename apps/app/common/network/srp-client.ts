/**
 * SRP-6a client — portable edition (no ``node:crypto``).
 *
 * Wire-compatible with the Python coordinator (``srptools``). Uses the
 * Web Crypto ``crypto.getRandomValues`` for secure random bytes, which
 * is available in Electron, browsers, and React Native (Hermes 0.71+).
 *
 * See ``apps/app/desktop/src/network/srp-client.ts`` for the detailed
 * wire-format documentation and compatibility notes.
 */

import { SRPClient } from '@windwalker-io/srp';
import { bytesToHex, hexToBytes } from './encoding';

const PRIME_3072 =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05' +
  '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB' +
  '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
  '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33' +
  'A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864' +
  'D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2' +
  '08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const GENERATOR_5 = '5';
const K_3072_G5 = '081f4874fa543a371b49a670402fda59ecfab53a1b850fc42e1c357cc846111e';

const VERIFIER_LEN = 384;
const PUB_LEN = 384;
const PROOF_LEN = 64;
const DEFAULT_SALT_LEN = 8;
const MAX_SALT_LEN = 64;

export class SrpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SrpError';
  }
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function bigintToBytesPadded(value: bigint, totalBytes: number): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  if (hex.length > totalBytes * 2) {
    throw new SrpError(`bigint is ${hex.length / 2} bytes, exceeds target ${totalBytes}`);
  }
  hex = hex.padStart(totalBytes * 2, '0');
  return hexToBytes(hex);
}

function padPub(value: bigint): Uint8Array {
  return bigintToBytesPadded(value, PUB_LEN);
}

function makeClient(): SRPClient {
  const c = SRPClient.create(PRIME_3072, GENERATOR_5, K_3072_G5);
  c.setHasher('sha256');
  c.setLength(32);
  return c;
}

function proofToWire(proof: bigint): Uint8Array {
  const hex = proof.toString(16).padStart(PROOF_LEN, '0');
  return new TextEncoder().encode(hex);
}

export async function makeRegistrationPayload(
  identity: string,
  password: string,
  saltLenBytes: number = DEFAULT_SALT_LEN,
): Promise<Uint8Array> {
  if (saltLenBytes < 1 || saltLenBytes > MAX_SALT_LEN) {
    throw new SrpError(`salt_len out of range (1..${MAX_SALT_LEN}): ${saltLenBytes}`);
  }
  const saltBytes = randomBytes(saltLenBytes);
  const saltBig = BigInt('0x' + bytesToHex(saltBytes));

  const c = makeClient();
  const x = await c.generatePasswordHash(saltBig, identity, password);
  const verifier = await c.generateVerifier(x);

  const verifierBytes = bigintToBytesPadded(verifier, VERIFIER_LEN);
  const out = new Uint8Array(1 + saltLenBytes + VERIFIER_LEN);
  out[0] = saltLenBytes;
  out.set(saltBytes, 1);
  out.set(verifierBytes, 1 + saltLenBytes);
  return out;
}

export interface SrpClientLogin {
  identity: string;
  password: string;
  secret: bigint;
  ke1: Uint8Array;
  expectedM2?: Uint8Array;
}

export async function startLogin(identity: string, password: string): Promise<SrpClientLogin> {
  const c = makeClient();
  const secret = await c.generateRandomSecret();
  const A = await c.generatePublic(secret);
  const ke1 = padPub(A);
  return { identity, password, secret, ke1 };
}

export async function respondLogin(
  state: SrpClientLogin,
  serverResponse: Uint8Array,
): Promise<Uint8Array> {
  if (serverResponse.length < 1) throw new SrpError('login response truncated');
  const saltLen = serverResponse[0];
  if (saltLen < 1 || saltLen > MAX_SALT_LEN) {
    throw new SrpError(`login response unreasonable salt_len: ${saltLen}`);
  }
  const expected = 1 + saltLen + PUB_LEN;
  if (serverResponse.length !== expected) {
    throw new SrpError(
      `login response length mismatch: expected ${expected}, got ${serverResponse.length}`,
    );
  }
  const salt = serverResponse.subarray(1, 1 + saltLen);
  const B = serverResponse.subarray(1 + saltLen);
  const saltBig = BigInt('0x' + bytesToHex(salt));
  const Bbig = BigInt('0x' + bytesToHex(B));

  const c = makeClient();
  const x = await c.generatePasswordHash(saltBig, state.identity, state.password);
  const Abig = await c.generatePublic(state.secret);

  if (Bbig % c.getPrime() === 0n) {
    throw new SrpError('server returned an invalid public ephemeral B');
  }
  const u = await c.generateCommonSecret(Abig, Bbig);
  const preMaster = await c.generatePreMasterSecret(state.secret, Bbig, x, u);
  const K = await c.hash(preMaster);
  const M1 = await c.generateClientSessionProof(state.identity, saltBig, Abig, Bbig, K);
  const M2 = await c.generateServerSessionProof(Abig, M1, K);

  state.expectedM2 = proofToWire(M2);
  return proofToWire(M1);
}

export function verifyServer(state: SrpClientLogin, m2: Uint8Array): void {
  if (!state.expectedM2) {
    throw new SrpError('verifyServer called before respondLogin');
  }
  if (m2.length !== state.expectedM2.length) {
    throw new SrpError('server proof wrong length');
  }
  for (let i = 0; i < m2.length; i++) {
    if (m2[i] !== state.expectedM2[i]) {
      throw new SrpError('server proof mismatch');
    }
  }
}
