import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  CapabilityProtocolError,
  parseCapabilityServerFrame,
} from '../../../dist/capabilities/protocol.js';
import { prepareToolResultArtifacts } from '../../../dist/capabilities/capability-socket.js';

test('capability protocol accepts a nullable session id and rejects malformed calls', () => {
  const frame = parseCapabilityServerFrame(JSON.stringify({
    type: 'client_tool_call', call_id: 'call-1', generation: 2,
    server: 'filesystem', tool: 'read', args: {}, session_id: null,
    account_id: 'network-1',
    idempotency_key: 'idem-1', deadline_ms: 1000,
    arguments_sha256: '0'.repeat(64),
  }));
  assert.equal(frame.type, 'client_tool_call');
  assert.equal(frame.session_id, null);

  assert.throws(
    () => parseCapabilityServerFrame(JSON.stringify({ type: 'client_tool_call' })),
    (error) => error instanceof CapabilityProtocolError && error.code === 'invalid_frame',
  );

  assert.throws(
    () => parseCapabilityServerFrame(JSON.stringify({
      type: 'client_tool_call', call_id: 'missing-account', generation: 2,
      server: 'filesystem', tool: 'read', args: {},
      idempotency_key: 'idem-missing-account', arguments_sha256: '0'.repeat(64),
    })),
    (error) => error instanceof CapabilityProtocolError &&
      error.code === 'invalid_frame' && /account_id/.test(error.message),
  );
});

test('large media blocks are extracted into digest-pinned artifact refs', () => {
  const bytes = Buffer.alloc(300 * 1024, 0x5a);
  const prepared = prepareToolResultArtifacts({
    content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
    isError: false,
  }, { call_id: 'media-call' });

  assert.equal(prepared.artifacts.length, 1);
  assert.deepEqual(prepared.result.content, [{
    type: 'artifact_ref', transfer_id: prepared.artifacts[0].transferId,
    artifact_template: { type: 'image', mimeType: 'image/png' },
    artifact_insert_path: ['data'],
  }]);
  assert.equal(prepared.artifacts[0].data.length, bytes.length);
  assert.equal(
    prepared.artifacts[0].sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
});

test('large embedded resources retain their MCP resource envelope', () => {
  const bytes = Buffer.alloc(300 * 1024, 0x4f);
  const prepared = prepareToolResultArtifacts({
    content: [{
      type: 'resource',
      resource: {
        uri: 'client-local:///capture.bin',
        mimeType: 'application/octet-stream',
        blob: bytes.toString('base64'),
        _meta: { source: 'client' },
      },
    }],
  }, { call_id: 'embedded-resource' });

  assert.equal(prepared.artifacts.length, 1);
  assert.equal(prepared.artifacts[0].mimeType, 'application/octet-stream');
  assert.deepEqual(prepared.result.content[0].artifact_insert_path, ['resource', 'blob']);
  assert.deepEqual(prepared.result.content[0].artifact_template, {
    type: 'resource',
    resource: {
      uri: 'client-local:///capture.bin',
      mimeType: 'application/octet-stream',
      _meta: { source: 'client' },
    },
  });
});

test('small media blocks stay inline', () => {
  const data = Buffer.from('small').toString('base64');
  const result = { content: [{ type: 'audio', data, mimeType: 'audio/wav' }] };
  const prepared = prepareToolResultArtifacts(result, { call_id: 'small-call' });
  assert.equal(prepared.artifacts.length, 0);
  assert.equal(prepared.result, result);
});

test('nested video and file blocks are chunked without flattening the MCP envelope', () => {
  const video = Buffer.alloc(280 * 1024, 0x31);
  const file = Buffer.alloc(290 * 1024, 0x32);
  const prepared = prepareToolResultArtifacts({
    content: [{ type: 'text', text: 'kept' }],
    structuredContent: {
      media: [{ type: 'video', data: video.toString('base64'), mimeType: 'video/mp4' }],
    },
    files: [{ type: 'file', data: file.toString('base64'), mimeType: 'application/pdf' }],
    isError: false,
    _meta: { vendor: 'test' },
  }, { call_id: 'nested-media' });

  assert.equal(prepared.artifacts.length, 2);
  assert.equal(prepared.result.content[0].text, 'kept');
  assert.equal(prepared.result.structuredContent.media[0].type, 'artifact_ref');
  assert.equal(prepared.result.files[0].type, 'artifact_ref');
  assert.deepEqual(prepared.result._meta, { vendor: 'test' });
});

test('artifact transfer count is rejected locally before the Gateway limit', () => {
  const data = Buffer.alloc(256 * 1024, 0x3a).toString('base64');
  assert.throws(
    () => prepareToolResultArtifacts({
      content: Array.from({ length: 65 }, () => ({
        type: 'image', data, mimeType: 'image/png',
      })),
    }, { call_id: 'too-many-artifacts' }),
    (error) => error instanceof CapabilityProtocolError && error.code === 'too_many_artifacts',
  );
});
