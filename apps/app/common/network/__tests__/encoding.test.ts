import { bytesToHex, hexToBytes, bytesToBase64, base64ToBytes } from '../encoding';
import { strict as assert } from 'node:assert';

const hex = 'deadbeef01020304';
const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);

assert.equal(bytesToHex(bytes), hex);
assert.deepEqual(hexToBytes(hex), bytes);

const b64 = bytesToBase64(bytes);
assert.deepEqual(base64ToBytes(b64), bytes);

assert.equal(bytesToHex(new Uint8Array(0)), '');
assert.deepEqual(hexToBytes(''), new Uint8Array(0));

console.log('encoding: all tests passed');
