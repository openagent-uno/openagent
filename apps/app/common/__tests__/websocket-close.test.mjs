import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConnectionReplacedClose,
  WS_CLOSE_CONNECTION_REPLACED_CODE,
  WS_CLOSE_CONNECTION_REPLACED_REASON,
} from '../websocket-close.ts';

test('same-device replacement has a stable private WebSocket close contract', () => {
  assert.equal(WS_CLOSE_CONNECTION_REPLACED_CODE, 4009);
  assert.equal(WS_CLOSE_CONNECTION_REPLACED_REASON, 'connection_replaced');
  assert.equal(isConnectionReplacedClose(
    WS_CLOSE_CONNECTION_REPLACED_CODE,
    WS_CLOSE_CONNECTION_REPLACED_REASON,
  ), true);
  assert.equal(isConnectionReplacedClose(WS_CLOSE_CONNECTION_REPLACED_CODE, ''), true);
  assert.equal(isConnectionReplacedClose(1000, WS_CLOSE_CONNECTION_REPLACED_REASON), true);
});

test('ordinary and abnormal transport closes retain their reconnect policy', () => {
  for (const code of [0, 1000, 1001, 1006, 1011, 4000, 4010]) {
    assert.equal(isConnectionReplacedClose(code, 'transient_drop'), false, `code ${code}`);
  }
});
