import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const entry = fileURLToPath(new URL('../../universal/stores/attachmentDrafts.ts', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
const { attachmentDraftKey, updateDraftFiles, discardDraftFiles } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('closing one account or conversation releases only its own attachment drafts', () => {
  const cancelled = [];
  function add(account, session, id) {
    const key = attachmentDraftKey(account, session);
    updateDraftFiles(key, files => [...files, { id, filename: id, kind: 'file', abort: () => cancelled.push(id) }]);
    return key;
  }
  const first = add('account-a', 'shared-id', 'first');
  const second = add('account-b', 'shared-id', 'second');
  add('account-b', 'other-chat', 'third');
  discardDraftFiles('account-a', 'shared-id');
  assert.deepEqual(cancelled, ['first']);
  // A late completion for the retired chip cannot recreate its draft.
  updateDraftFiles(first, files => {
    assert.equal(files.length, 0);
    return files.map(file => ({ ...file, uploading: false }));
  });
  updateDraftFiles(second, files => { assert.equal(files[0].id, 'second'); return files; });
  discardDraftFiles('account-b');
  assert.deepEqual(cancelled, ['first', 'second', 'third']);
});
