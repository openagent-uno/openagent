import { digest } from '../web-crypto-digest';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';

async function main() {
  const input = new TextEncoder().encode('openagent srp digest check');
  for (const [web, node] of [
    ['SHA-1', 'sha1'],
    ['SHA-256', 'sha256'],
    ['SHA-384', 'sha384'],
    ['SHA-512', 'sha512'],
  ] as const) {
    const ours = Buffer.from(await digest(web, input)).toString('hex');
    const ref = createHash(node).update(input).digest('hex');
    assert.equal(ours, ref, `${web} mismatch`);
  }
  // Algorithm object form and ArrayBuffer input, as SubtleCrypto accepts.
  const viaObject = Buffer.from(await digest({ name: 'sha-256' }, input.buffer.slice(0))).toString('hex');
  assert.equal(viaObject, createHash('sha256').update(input).digest('hex'));
  await assert.rejects(digest('MD5', input), /Unsupported digest/);
  console.log('web-crypto-digest: all tests passed');
}

void main();
