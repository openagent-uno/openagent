import {
  IDENTITY_KEY,
  NETWORK_STORE_KEY,
  certKey,
  credentialKey,
  encodeKeyPart,
  isValidSecureStoreKey,
} from '../secure-store-keys';
import { strict as assert } from 'node:assert';

for (const key of [
  IDENTITY_KEY,
  NETWORK_STORE_KEY,
  certKey('net-1'),
  credentialKey('alice@example-network'),
  credentialKey('agent:alice@net/with spaces'),
  credentialKey('ünïcødé'),
  credentialKey(''),
]) {
  assert.ok(isValidSecureStoreKey(key), `invalid SecureStore key: ${key}`);
}

// Readable for plain ids, escaped otherwise.
assert.equal(encodeKeyPart('net-1'), 'net-1');
assert.equal(encodeKeyPart('alice@net'), 'alice_40net');

// Injective: an escaped char and its literal escape sequence differ.
assert.notEqual(credentialKey('a@b'), credentialKey('a_40b'));
assert.notEqual(credentialKey('a.b'), credentialKey('a_b'));
assert.notEqual(certKey('x'), credentialKey('x'));

console.log('secure-store-keys: all tests passed');
