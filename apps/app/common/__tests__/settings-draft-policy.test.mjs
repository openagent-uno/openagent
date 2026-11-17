import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundle = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: { contents: "export * from './common/settings-draft-policy';", resolveDir: root },
});
const { settingsDraftValues, reconcileSettingsDraft, acceptedSettingsField, ownedSettingsValue } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const config = {
  name: 'Agent A', system_prompt: 'Server prompt',
  dream_mode: { enabled: true, time: '4:15' },
  auto_update: { enabled: true, mode: 'notify', check_interval: '0 */8 * * *' },
  channels: {
    telegram: { token: 'fixture-token', allowed_users: ['one'], model: 'fixture-text' },
    discord: { token: 'fixture-discord', allowed_users: ['two'] },
    webhook: { enabled: true, host: 'localhost', port: 9000, public_url: 'https://example.test/hook' },
  },
};
const first = () => {
  const incoming = settingsDraftValues(config);
  return reconcileSettingsDraft(null, 'account-a:1', settingsDraftValues(null), incoming);
};

test('first load fills every editable field using server values and input units', () => {
  const state = first();
  assert.deepEqual(state.values, settingsDraftValues(config));
  assert.equal(state.values.whPort, '9000');
  assert.equal(state.values.tgUsers, 'one');
  assert.equal(state.values.autoUpdateMode, 'notify');
});

test('identity broadcasts refresh untouched fields without discarding any other draft', () => {
  const state = first();
  const current = { ...state.values, name: 'Local name', tgUsers: 'one, three', dcToken: 'Local token' };
  const incoming = settingsDraftValues({ ...config, name: 'Remote name', system_prompt: 'Remote prompt' });
  const next = reconcileSettingsDraft(state.baseline, 'account-a:1', current, incoming);
  assert.equal(next.values.name, 'Local name');
  assert.equal(next.values.tgUsers, 'one, three');
  assert.equal(next.values.dcToken, 'Local token');
  assert.equal(next.values.systemPrompt, 'Remote prompt');
  assert.equal(next.baseline.values.name, 'Remote name');
});

test('saving another section preserves channel drafts while rehydrating its confirmed values', () => {
  const state = first();
  const current = { ...state.values, tgUsers: 'one, three' };
  const incoming = settingsDraftValues({ ...config, dream_mode: { enabled: false, time: '5:00' } });
  const next = reconcileSettingsDraft(state.baseline, 'account-a:1', current, incoming);
  assert.equal(next.values.tgUsers, 'one, three');
  assert.equal(next.values.dreamEnabled, false);
  assert.equal(next.values.dreamTime, '5:00');
});

test('multiple remote revisions keep local changes until they match the authoritative value', () => {
  const state = first();
  const current = { ...state.values, name: 'Local name' };
  const second = reconcileSettingsDraft(state.baseline, 'account-a:1', current,
    { ...state.values, name: 'Remote two' });
  const third = reconcileSettingsDraft(second.baseline, 'account-a:1', second.values,
    { ...state.values, name: 'Local name' });
  const fourth = reconcileSettingsDraft(third.baseline, 'account-a:1', third.values,
    { ...state.values, name: 'Remote four' });
  assert.equal(second.values.name, 'Local name');
  assert.equal(fourth.values.name, 'Remote four');
});

test('switching accounts discards every old draft, including fields with equal defaults', () => {
  const state = first();
  const current = { ...state.values, name: 'Local name', tgToken: 'Local token', whPort: '9999' };
  const incoming = settingsDraftValues({ name: 'Agent B', channels: {} });
  const next = reconcileSettingsDraft(state.baseline, 'account-b:2', current, incoming);
  assert.deepEqual(next.values, incoming);
  assert.equal(next.values.tgToken, '');
  assert.equal(next.values.whPort, '8899');
});

test('disconnect cancels old drafts and a new session for the same account starts clean', () => {
  const state = first();
  const current = { ...state.values, name: 'Unsaved name', dcUsers: 'Local user' };
  const disconnected = reconcileSettingsDraft(state.baseline, ':2', current, settingsDraftValues(null));
  assert.deepEqual(disconnected.values, settingsDraftValues(null));
  const reconnected = reconcileSettingsDraft(disconnected.baseline, 'account-a:3', disconnected.values, state.values);
  assert.deepEqual(reconnected.values, state.values);
});

test('an explicit draft reset adopts the authoritative values', () => {
  const state = first();
  const local = { ...state.values, name: 'Cancelled name', dcUsers: 'Cancelled users' };
  const reset = reconcileSettingsDraft(null, 'account-a:1', local, state.values);
  assert.deepEqual(reset.values, state.values);
});

test('a save receipt adopts normalization only when the user has not typed again', () => {
  assert.equal(acceptedSettingsField('  Name  ', '  Name  ', 'Name'), 'Name');
  assert.equal(acceptedSettingsField('Newer typing', '  Name  ', 'Name'), 'Newer typing');
  assert.equal(acceptedSettingsField(false, true, true), false);
});

test('conflict reconciliation retains local identity fields against the newer server baseline', () => {
  const state = first();
  const local = { ...state.values, name: 'Local conflicting name', systemPrompt: 'Local prompt' };
  const latest = { ...state.values, name: 'Other editor name', systemPrompt: 'Other editor prompt' };
  const conflict = reconcileSettingsDraft(state.baseline, 'account-a:1', local, latest);
  assert.equal(conflict.values.name, 'Local conflicting name');
  assert.equal(conflict.values.systemPrompt, 'Local prompt');
  assert.deepEqual(conflict.baseline.values, latest);
});

test('thumbnail edits and removal belong only to the account scope that owns them', () => {
  assert.equal(ownedSettingsValue('account-a:1', 'account-a:1', 'fixture-image-a'), 'fixture-image-a');
  assert.equal(ownedSettingsValue('account-a:1', 'account-b:2', 'fixture-image-a'), undefined);
  assert.equal(ownedSettingsValue('account-a:1', 'account-b:2', null), undefined);
  assert.equal(ownedSettingsValue('account-a:1', 'account-a:1', null), null);
});

test('confirming an older thumbnail save does not erase a newer selection', () => {
  assert.equal(acceptedSettingsField('second-image', 'first-image', undefined), 'second-image');
  assert.equal(acceptedSettingsField('first-image', 'first-image', undefined), undefined);
  assert.equal(acceptedSettingsField(null, 'first-image', undefined), null);
});
