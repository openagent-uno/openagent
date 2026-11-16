// Rules behind the Models grid tiles: access badge, status line, inputs, quota.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

function load(file, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Date,
    require: (name) => { assert.ok(name in modules, `Unmocked import ${name}`); return modules[name]; },
  });
  return module.exports;
}

const h = load('../models/modelHelpers.ts');
const q = load('../accountQuota.ts', { '../theme': { colors: { error: 'E', warning: 'W', accent: 'A' } } });

test('local endpoints are plain http on this machine or a private network', () => {
  for (const url of [
    'http://localhost:11434/v1', 'http://127.0.0.1:8787', 'http://10.0.0.4', 'http://192.168.1.20:8080',
    'http://172.20.1.1', 'http://100.100.1.1', 'http://box.local:1234', 'http://llm.ai.svc.cluster.local/v1',
  ]) assert.equal(h.isLocalUrl(url), true, url);
  for (const url of [
    'https://localhost:11434', 'http://172.32.0.1', 'http://100.128.0.1', 'https://api.openai.com/v1',
    'http://example.com', null, '',
  ]) assert.equal(h.isLocalUrl(url), false, String(url));
});

test('access: accounts make a subscription, then local, else API', () => {
  const sub = { provider: 'claude', provider_id: 1, accounts: [{ id: 'a', name: 'a', quota: null }] };
  assert.equal(h.accessFor({ base_url: 'http://127.0.0.1:8787' }, sub), 'subscription');
  assert.equal(h.accessFor({ base_url: 'http://127.0.0.1:11434' }, { ...sub, accounts: [] }), 'local');
  assert.equal(h.accessFor({ base_url: null }, null), 'api');
  assert.equal(h.accessFor({ base_url: null }, null, true), 'subscription');
});

test('accounts are matched by provider id before name', () => {
  const list = [{ provider: 'x', provider_id: 2, accounts: [] }, { provider: 'y', provider_id: 1, accounts: [] }];
  assert.equal(h.accountsFor({ id: 1, name: 'x' }, list).provider, 'y');
  assert.equal(h.accountsFor({ id: 9, name: 'z' }, list), null);
});

test('status line order: sign-in, rate limit, reachability, off, role', () => {
  const m = { kind: 'llm', enabled: true, is_classifier: true, metadata: {} };
  const p = { enabled: true };
  assert.equal(h.modelStatus(m, p, { status: 'auth_expired' }, 'subscription').label, 'Sign-in expired');
  assert.equal(h.modelStatus(m, p, { status: 'rate_limited' }, 'subscription').label, 'Rate limited');
  assert.equal(h.modelStatus(m, p, { status: 'unreachable' }, 'local').label, 'Not reachable');
  assert.equal(h.modelStatus(m, p, { status: 'unreachable' }, 'api').label, 'Default');
  assert.equal(h.modelStatus({ ...m, enabled: false }, p, null, 'api').label, 'Off');
  assert.equal(h.modelStatus(m, { enabled: false }, null, 'api').label, 'Off');
  assert.equal(h.modelStatus({ ...m, is_classifier: false, metadata: { fallback_priority: 2 } }, p, null, 'api').label, 'Backup 2');
  assert.equal(h.modelStatus({ kind: 'tts', enabled: true, metadata: { voice_id: 'nova' } }, p, null, 'api').label, 'Voice: nova');
});

test('price keeps both sides per million', () => {
  assert.equal(h.priceLabel({ input_cost_per_million: 3, output_cost_per_million: 15 }), '$3/$15 per M');
  assert.equal(h.priceLabel({ input_cost_per_million: 0.075, output_cost_per_million: null }), '$0.075/$0 per M');
  assert.equal(h.priceLabel({}), null);
});

test('inputs: text always present, source decides auto or manual', () => {
  assert.deepEqual(Array.from(h.normalizeModalities(['file', 'image', 'bogus'])), ['text', 'image', 'file']);
  assert.equal(h.modelModalities({ metadata: { input_modalities: ['text', 'image'], input_modalities_source: 'provider' } }).mode, 'auto');
  assert.equal(h.modelModalities({ metadata: { input_modalities: ['text'] } }).mode, 'manual');
  assert.equal(h.modelModalities({ metadata: {} }).mode, 'auto');
  assert.equal(h.sameModalities(['image', 'text'], ['text', 'image']), true);
});

test('next backup slot follows the highest priority in use', () => {
  assert.equal(h.nextFallbackPriority([]), 0);
  assert.equal(h.nextFallbackPriority([{ metadata: { fallback_priority: 0 } }, { metadata: { fallback_priority: 3 } }, { metadata: {} }]), 4);
});

test('sampling: empty inherits, numbers pin, junk is refused', () => {
  const meta = { temperature: 0.8, voice_id: 'keep' };
  assert.equal(h.applySampling(meta, { temperature: '', top_k: '40.4' }), null);
  assert.equal('temperature' in meta, false);
  assert.equal(meta.top_k, 40);
  assert.equal(meta.voice_id, 'keep');
  assert.match(h.applySampling({}, { top_p: 'abc' }), /Top P/);
});

test('quota: only reported windows, never an invented number', () => {
  assert.deepEqual(Array.from(q.quotaWindows({ quota: null })), []);
  assert.deepEqual(Array.from(q.quotaWindows({ quota: { plan: 'pro' } })), []);
  const [five, week] = q.quotaWindows({ quota: {
    primary_used_percent: 41, primary_window_minutes: 300, primary_reset_after_s: 7800,
    secondary_used_percent: 12, secondary_window_minutes: 10080,
  } });
  assert.equal(q.quotaWindowText(five), '5h window · 41% used · resets in 2h');
  assert.equal(q.quotaWindowText(week), 'Weekly · 12% used');
});

test('serving account: first usable, else the first', () => {
  const limited = { id: 'a', status: 'rate_limited' };
  const ok = { id: 'b', status: 'ok' };
  assert.equal(q.servingAccount({ accounts: [limited, ok] }).id, 'b');
  assert.equal(q.servingAccount({ accounts: [limited] }).id, 'a');
  assert.equal(q.servingAccount(null), null);
  assert.equal(q.accountState({ dead: true }), 'auth_expired');
  assert.equal(q.accountState({ limited: true }), 'rate_limited');
});
