import assert from 'node:assert/strict';
import test from 'node:test';

import { canUseUnifiedHistoryCache, searchPresentation } from '../search-request-policy.ts';

test('never mistakes the activity feed for definition/tool/view search', () => {
  assert.equal(canUseUnifiedHistoryCache('', 'all', [], false, 'any'), false);
  assert.equal(canUseUnifiedHistoryCache('', 'workflows', [], false, 'any'), false);
  assert.equal(canUseUnifiedHistoryCache('', 'all', ['failed'], false, 'any'), false);
  assert.equal(canUseUnifiedHistoryCache('', 'all', [], true, 'any'), false);
  assert.equal(canUseUnifiedHistoryCache('', 'all', [], false, '24h'), false);
  assert.equal(canUseUnifiedHistoryCache('needle', 'all', [], false, 'any'), false);
});

test('requests independently pageable matches for empty and text search', () => {
  assert.deepEqual(searchPresentation('needle'), { sort: 'relevance', grouping: 'match' });
  assert.deepEqual(searchPresentation(''), { sort: 'recent', grouping: 'match' });
});
