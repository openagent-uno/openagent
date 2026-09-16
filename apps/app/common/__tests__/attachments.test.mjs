import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachmentContentRef,
  attachmentsForSend,
  normalizeAttachmentRefs,
} from '../attachments.ts';

test('normalized history hydration retains every canonical CAS field', () => {
  const [attachment] = normalizeAttachmentRefs([{
    artifact_id: 'art-history',
    artifact_link_id: 'alink-message',
    kind: 'image',
    filename: 'screen.png',
    mime_type: 'image/png',
    size_bytes: 1234,
    sha256: 'deadbeef',
    url: '/api/artifacts/art-history/content',
  }]);

  assert.deepEqual(attachment, {
    type: 'image',
    filename: 'screen.png',
    artifact_id: 'art-history',
    artifact_link_id: 'alink-message',
    url: '/api/artifacts/art-history/content',
    mime_type: 'image/png',
    size_bytes: 1234,
    sha256: 'deadbeef',
  });
  assert.equal(attachmentContentRef(attachment), '/api/artifacts/art-history/content');
  assert.equal('path' in attachment, false);
});

test('edit resend and regenerate send opaque artifact ids, never CAS URLs as paths', () => {
  const hydrated = normalizeAttachmentRefs([{
    artifact_id: 'art-resend',
    artifact_link_id: 'alink-resend',
    type: 'file',
    filename: 'report.pdf',
    mime_type: 'application/pdf',
    size_bytes: 987,
    sha256: 'cafebabe',
    url: '/api/artifacts/art-resend/content',
    path: '/private/cas/internal-copy',
  }]);

  // Both edit-and-resend and regenerate call this shared serializer before
  // handing their original message attachments to WSClient.
  const wire = attachmentsForSend(hydrated);
  assert.deepEqual(wire, [{
    type: 'file',
    filename: 'report.pdf',
    mime_type: 'application/pdf',
    size_bytes: 987,
    sha256: 'cafebabe',
    artifact_id: 'art-resend',
    artifact_link_id: 'alink-resend',
  }]);
  assert.equal('path' in wire[0], false);
  assert.equal('url' in wire[0], false);
});

test('path-only stable history remains resendable during beta compatibility', () => {
  assert.deepEqual(attachmentsForSend([{
    type: 'file', filename: 'legacy.txt', path: '/tmp/legacy.txt',
  }]), [{
    type: 'file', filename: 'legacy.txt', path: '/tmp/legacy.txt',
  }]);
});

test('a CAS id always derives its ACL endpoint and ignores a supplied URL', () => {
  const [attachment] = normalizeAttachmentRefs([{
    type: 'image', filename: 'safe.png', artifact_id: 'canonical-id',
    url: 'https://attacker.invalid/tracker.png',
  }]);
  assert.equal(attachment.url, '/api/artifacts/canonical-id/content');
  assert.equal(attachmentContentRef({
    type: 'image', filename: 'safe.png', artifact_id: 'canonical-id',
    url: 'http://127.0.0.1:1/wrong',
  }), '/api/artifacts/canonical-id/content');
});

test('URL-only attachment refs are confined to authenticated gateway routes', () => {
  assert.deepEqual(normalizeAttachmentRefs([
    { type: 'image', filename: 'tracker.png', url: 'https://attacker.invalid/pixel' },
    { type: 'file', filename: 'admin', url: 'http://127.0.0.1:9999/admin' },
  ]), []);
  assert.deepEqual(normalizeAttachmentRefs([{
    type: 'file', filename: 'legacy.txt',
    url: 'http://127.0.0.1:9999/admin', path: '/tmp/legacy.txt',
  }]), [{ type: 'file', filename: 'legacy.txt', path: '/tmp/legacy.txt' }]);
  assert.deepEqual(normalizeAttachmentRefs([{
    type: 'file', filename: 'safe.bin', url: '/api/artifacts/safe/content',
  }]), [{ type: 'file', filename: 'safe.bin', url: '/api/artifacts/safe/content' }]);
});
