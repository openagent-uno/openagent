import { generateIdentity, identityFromSecret } from '../identity';
import { bytesToHex, hexToBytes } from '../encoding';
import { strict as assert } from 'node:assert';

async function testIdentityGeneration() {
  const id = await generateIdentity();
  assert.equal(id.secret.length, 32, 'secret must be 32 bytes');
  assert.equal(id.publicKey.length, 32, 'publicKey must be 32 bytes');
  assert.equal(id.nodeIdHex.length, 64, 'nodeIdHex must be 64 hex chars');
  assert.equal(id.nodeIdHex, bytesToHex(id.publicKey), 'nodeIdHex == hex(publicKey)');
  console.log('identity: generation ok');
}

async function testIdentityFromSecret() {
  const id1 = await generateIdentity();
  const id2 = await identityFromSecret(id1.secret);
  assert.deepEqual(id2.publicKey, id1.publicKey, 'same secret → same pubkey');
  assert.equal(id2.nodeIdHex, id1.nodeIdHex, 'same secret → same nodeId');
  console.log('identity: deterministic recovery ok');
}

async function main() {
  await testIdentityGeneration();
  await testIdentityFromSecret();
  console.log('identity: all tests passed');
}
main().catch(e => { console.error(e); process.exit(1); });
