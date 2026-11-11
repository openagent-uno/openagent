import { startLogin, makeRegistrationPayload } from '../srp-client';
import { strict as assert } from 'node:assert';

async function testRegistration() {
  const payload = await makeRegistrationPayload('alice', 'password123');
  assert.ok(payload instanceof Uint8Array, 'payload must be Uint8Array');
  const saltLen = payload[0]!;
  assert.ok(saltLen >= 1 && saltLen <= 64, 'salt length byte must be 1..64');
  assert.equal(payload.length, 1 + saltLen + 384, 'payload = 1 + saltLen + verifier(384)');
  console.log('srp: registration payload ok');
}

async function testLoginRoundtrip() {
  const state = await startLogin('bob', 'secret');
  assert.ok(state.ke1 instanceof Uint8Array, 'ke1 must be Uint8Array');
  assert.ok(state.ke1.length > 0, 'ke1 must be non-empty');
  assert.ok(typeof state.secret === 'bigint', 'secret must be bigint');
  console.log('srp: login step1 ok');
}

async function main() {
  await testRegistration();
  await testLoginRoundtrip();
  console.log('srp-client: all tests passed');
}
main().catch(e => { console.error(e); process.exit(1); });
