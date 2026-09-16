// Round-trip the network-store through a tempdir and assert
// load/save/add/find/remove all behave like the Python user_store.
// Networks are keyed by (name, handle): two handles can share one
// network name without colliding.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-store-'));
const isolatedUserDir = path.join(tmp, 'network-profile');
process.env.OPENAGENT_USER_DIR = isolatedUserDir;

const ns = await import('../../../dist/network/network-store.js');
assert.equal(ns.userDir(), path.resolve(isolatedUserDir));
assert.equal(ns.storePath(), path.join(path.resolve(isolatedUserDir), 'networks.toml'));

const store = ns.emptyStore();
assert.equal(store.networks.length, 0);
assert.equal(store.activeNetwork, null);

const row = ns.addOrUpdate(store, {
  name: 'home',
  networkId: 'net-uuid-1',
  coordinatorNodeId: 'pkx9...node',
  coordinatorPubkeyHex: 'aa'.repeat(32),
  handle: 'alice',
});
assert.equal(row.name, 'home');
assert.equal(row.handle, 'alice');
assert.equal(store.networks.length, 1);
assert.equal(store.activeNetwork, 'home');

// find by name
const fByName = ns.find(store, 'home');
assert.ok(fByName);
assert.equal(fByName.networkId, 'net-uuid-1');

// find by network id
const fById = ns.find(store, 'net-uuid-1');
assert.ok(fById);
assert.equal(fById.name, 'home');

// find scoped to a handle: matches its own handle, misses others
const fByHandle = ns.find(store, 'home', 'alice');
assert.ok(fByHandle);
assert.equal(fByHandle.handle, 'alice');
assert.equal(ns.find(store, 'home', 'bob'), null);

// not found
assert.equal(ns.find(store, 'nope'), null);

// save + reload
ns.saveStore(store);
const reloaded = ns.loadStore();
assert.equal(reloaded.networks.length, 1);
assert.equal(reloaded.networks[0].name, 'home');
assert.equal(reloaded.networks[0].networkId, 'net-uuid-1');
assert.equal(reloaded.networks[0].handle, 'alice');
assert.equal(reloaded.activeNetwork, 'home');

// cert round-trip
const certBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
ns.writeCert(reloaded.networks[0], certBytes);
const loadedCert = ns.readCert(reloaded.networks[0]);
assert.ok(loadedCert);
assert.equal(loadedCert.length, certBytes.length);
for (let i = 0; i < certBytes.length; i++) assert.equal(loadedCert[i], certBytes[i]);

// removal also unlinks the cert
const certBefore = reloaded.networks[0].certPath;
assert.equal(fs.existsSync(certBefore), true);
const ok = ns.remove(reloaded, 'home');
assert.equal(ok, true);
assert.equal(reloaded.networks.length, 0);
assert.equal(reloaded.activeNetwork, null);
assert.equal(fs.existsSync(certBefore), false);

// idempotent update: same (name, handle) updates the row in place and
// keeps addedAt, bumping the rest.
const s2 = ns.emptyStore();
const r1 = ns.addOrUpdate(s2, {
  name: 'home',
  networkId: 'net1',
  coordinatorNodeId: 'n1',
  coordinatorPubkeyHex: 'aa'.repeat(32),
  handle: 'alice',
});
const addedAt = r1.addedAt;
const r1b = ns.addOrUpdate(s2, {
  name: 'home',
  networkId: 'net1b',
  coordinatorNodeId: 'n1b',
  coordinatorPubkeyHex: 'cc'.repeat(32),
  handle: 'alice',
});
assert.equal(s2.networks.length, 1, 'same (name, handle) updates in place');
assert.equal(r1b.addedAt, addedAt, 'addedAt preserved on update');
assert.equal(r1b.networkId, 'net1b');

// Two handles on ONE network name are distinct rows — a user invite
// redeemed under a new handle must NOT clobber the first handle's row.
const r2 = ns.addOrUpdate(s2, {
  name: 'home',
  networkId: 'net2',
  coordinatorNodeId: 'n2',
  coordinatorPubkeyHex: 'bb'.repeat(32),
  handle: 'bob',
});
assert.equal(s2.networks.length, 2, 'distinct handle => distinct row');
assert.equal(r2.handle, 'bob');

const aliceRow = ns.find(s2, 'home', 'alice');
const bobRow = ns.find(s2, 'home', 'bob');
assert.ok(aliceRow && bobRow, 'both handles resolve to their own row');
assert.equal(aliceRow.networkId, 'net1b');
assert.equal(bobRow.networkId, 'net2');
// handle-less find returns the first matching row (alice joined first)
const firstRow = ns.find(s2, 'home');
assert.ok(firstRow);
assert.equal(firstRow.handle, 'alice');

// remove targets one (name, handle) pair, leaving the other intact
assert.equal(ns.remove(s2, 'home', 'alice'), true);
assert.equal(s2.networks.length, 1);
assert.equal(s2.networks[0].handle, 'bob');

// multi-handle membership survives a save + reload round-trip
const s3 = ns.emptyStore();
ns.addOrUpdate(s3, {
  name: 'shared', networkId: 'sid', coordinatorNodeId: 'sn',
  coordinatorPubkeyHex: 'aa'.repeat(32), handle: 'alice',
});
ns.addOrUpdate(s3, {
  name: 'shared', networkId: 'sid', coordinatorNodeId: 'sn',
  coordinatorPubkeyHex: 'aa'.repeat(32), handle: 'bob',
});
ns.saveStore(s3);
const s3reloaded = ns.loadStore();
assert.equal(s3reloaded.networks.length, 2, 'both handles persist across reload');
assert.ok(ns.find(s3reloaded, 'shared', 'alice'));
assert.ok(ns.find(s3reloaded, 'shared', 'bob'));

// schema-version bump returns empty
fs.writeFileSync(ns.storePath(), 'schema_version = 999\n', 'utf-8');
const future = ns.loadStore();
assert.equal(future.networks.length, 0);

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });

console.log('network-store.test: ok');
