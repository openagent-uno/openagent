import assert from 'node:assert/strict';
import test from 'node:test';
import { PowerActivity } from '../../../dist/services/power-activity.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const active = { active: true };
const idle = { active: false };

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = new Set(), releases = [], states = [], requests = [], bodies = new Map();
  const activity = new PowerActivity(id => {
    held.add(id); return () => { releases.push(id); held.delete(id); };
  }, value => states.push(value), async url => {
    requests.push(url);
    const body = bodies.get(new URL(url).host);
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body || idle };
  });
  t.after(() => activity.dispose());
  return { activity, held, releases, states, requests, bodies };
}

test('active accounts remain awake across agent switches and closed renderer owners', async t => {
  const s = setup(t);
  s.bodies.set('first', active);
  s.activity.add('a', 'http://first'); s.activity.add('b', 'http://second');
  await flush();
  assert.deepEqual([...s.held], ['a']);
  s.activity.report(1, 'a', true);
  s.activity.report(1, 'b', false); // switch to idle agent
  s.activity.releaseOwner(1); // close the window: authoritative remote work remains
  assert.equal(s.states.at(-1), true);
  assert.deepEqual([...s.held], ['a']);
  s.bodies.set('first', idle);
  t.mock.timers.tick(10_000); await flush();
  assert.equal(s.states.at(-1), false);
  assert.equal(s.held.size, 0);
  assert.ok(s.requests.every(url => url.endsWith('/api/history/active')));
});

test('a missing observation does not turn active work into an idle result', async t => {
  const s = setup(t);
  s.bodies.set('first', active); s.activity.add('a', 'http://first'); await flush();
  s.bodies.set('first', new Error('offline'));
  t.mock.timers.tick(10_000); await flush();
  assert.equal(s.states.at(-1), true);
  assert.deepEqual([...s.held], ['a']);
  s.activity.remove('a');
  assert.equal(s.states.at(-1), false);
  s.activity.report(1, 'a', true); // a retired account cannot regain a lease
  assert.equal(s.states.at(-1), false);
});

test('local pending input acquires immediately and multiple windows release independently', async t => {
  const s = setup(t); s.activity.add('a', 'http://first'); await flush();
  s.activity.report(1, 'a', true); s.activity.report(2, 'a', true);
  assert.equal(s.states.at(-1), true);
  s.activity.releaseOwner(1); assert.equal(s.states.at(-1), true);
  s.activity.releaseOwner(2); assert.equal(s.states.at(-1), false);
  s.activity.dispose();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(s.states.at(-1), false);
  assert.equal(s.held.size, 0);
});

test('a late response from a retired loopback cannot update its replacement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = []; let finish;
  const observer = new PowerActivity(() => () => {}, value => states.push(value), url =>
    url.includes('old') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, json: async () => idle }));
  t.after(() => observer.dispose());
  observer.add('a', 'http://old'); observer.add('a', 'http://new'); await flush();
  finish({ ok: true, json: async () => active }); await flush();
  assert.equal(states.at(-1), false);
});


test('legacy full pages cannot erase known active work and shorter idle pages release it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = []; let sessions = [{ _live: true }];
  const activity = new PowerActivity(() => () => {}, value => states.push(value), async url =>
    url.endsWith('/api/history/active') ? { status: 404 } : { ok: true, json: async () => ({ sessions }) });
  t.after(() => activity.dispose());
  activity.add('legacy', 'http://legacy'); await flush();
  assert.equal(states.at(-1), true);
  sessions = Array.from({ length: 200 }, () => ({ _live: false }));
  t.mock.timers.tick(10_000); await flush();
  assert.equal(states.at(-1), true);
  sessions = [];
  t.mock.timers.tick(10_000); await flush();
  assert.equal(states.at(-1), false);
});
