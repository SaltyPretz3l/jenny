'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeLineageStore, readPortableLineageSnapshot } = require('../../services/session-runtime/lineage-store');
const { spawnIdentity, validateLineageRecord, validatePortableLineageSnapshot } = require('../../services/session-runtime/lineage-contracts');
const { createRuntimeStoreIO } = require('../../services/session-runtime/store-io');

const rootArgs = () => ({ rootRunId: 'root_1', rootWorkId: 'work_1', rootSessionId: 'session_1',
  rootTurnId: 'turn_1', projectId: 'project_1', providerId: 'ollama', authorityFingerprint: 'a'.repeat(64),
  limits: { descendants: 8, descendant_depth: 2 } });
const spawn = (patch = {}) => ({ rootRunId: 'root_1', parentWorkId: 'work_1', parentTurnId: 'turn_1',
  callId: 'spawn_1', argsSha256: 'b'.repeat(64), ...patch });
function fixture(t, io) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeLineageStore(root, { io });
  store.create(rootArgs());
  return { root, store };
}
function commit(store, child) {
  store.recordSession({ rootRunId: 'root_1', childWorkId: child.work_id, sessionIncarnation: 'incarnation_1' });
  return store.commitSpawn({ rootRunId: 'root_1', childWorkId: child.work_id,
    sessionIncarnation: 'incarnation_1', submissionSha256: 'c'.repeat(64) });
}
function faultIO() {
  const base = createRuntimeStoreIO();
  let fault = null;
  return { ...base, failOnce: value => { fault = value; }, writeJsonAtomic(file, value) {
    const current = fault;
    fault = null;
    if (current === 'before') throw new Error('before');
    base.writeJsonAtomic(file, value);
    if (current === 'after') throw new Error('after');
  } };
}

test('root definition is immutable and creation cannot reset cancellation or children', t => {
  const { store } = fixture(t);
  const first = store.beginSpawn(spawn());
  store.cancelRoot('root_1');
  assert.equal(store.create(rootArgs()).created, false);
  assert.equal(store.get('root_1').cancelled, true);
  assert.deepEqual(store.get('root_1').children, [first.child]);
  assert.throws(() => store.create({ ...rootArgs(), limits: { descendants: 9, descendant_depth: 2 } }),
    { code: 'lineage_root_conflict' });
});

test('spawn identity survives lost acknowledgements and restart without another child', t => {
  const { root, store } = fixture(t);
  const first = store.beginSpawn(spawn());
  assert.equal(first.created, true);
  assert.equal(first.child.state, 'preparing');
  assert.deepEqual(first.child.work_id, spawnIdentity(spawn()).work_id);
  const restarted = new RuntimeLineageStore(root);
  assert.deepEqual(restarted.beginSpawn(spawn()), { created: false, child: first.child });
  assert.throws(() => restarted.beginSpawn(spawn({ argsSha256: 'd'.repeat(64) })), { code: 'lineage_spawn_conflict' });
  assert.equal(restarted.get('root_1').children.length, 1);
  assert.equal(restarted.get('root_1').children[0].read_only, true);
});

test('restart sweeps stale atomic-write temp files without blocking lineage use', t => {
  const { root, store } = fixture(t);
  const created = store.get('root_1');
  const directory = path.join(root, fs.readdirSync(root)[0]);
  const temp = path.join(directory, '.runtime-deadbeefdeadbeefdeadbeef.tmp');
  fs.writeFileSync(temp, 'stale');

  const reopened = new RuntimeLineageStore(root);
  assert.equal(reopened.snapshot().read_only, false);
  assert.deepEqual(reopened.get('root_1'), created);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(reopened.beginSpawn(spawn()).created, true);
});

test('session proof precedes work publication; exact repeats survive restart', t => {
  const { root, store } = fixture(t);
  const { child } = store.beginSpawn(spawn());
  assert.throws(() => store.commitSpawn({ rootRunId: 'root_1', childWorkId: child.work_id,
    sessionIncarnation: 'incarnation_1', submissionSha256: 'c'.repeat(64) }), { code: 'lineage_session_conflict' });
  const completed = commit(store, child);
  const restarted = new RuntimeLineageStore(root);
  assert.deepEqual(commit(restarted, child), completed);
  assert.equal(restarted.get('root_1').revision, 4);
  assert.throws(() => restarted.recordSession({ rootRunId: 'root_1', childWorkId: child.work_id,
    sessionIncarnation: 'other' }), { code: 'lineage_session_conflict' });
});

test('unknown, wrong-turn, uncommitted and over-depth parents cannot spawn', t => {
  const { store } = fixture(t);
  assert.throws(() => store.beginSpawn(spawn({ parentWorkId: 'foreign' })), { code: 'lineage_parent_invalid' });
  assert.throws(() => store.beginSpawn(spawn({ parentTurnId: 'foreign' })), { code: 'lineage_parent_invalid' });
  const { child } = store.beginSpawn(spawn());
  const nested = spawn({ parentWorkId: child.work_id, parentTurnId: child.turn_id, callId: 'nested' });
  assert.throws(() => store.beginSpawn(nested), { code: 'lineage_parent_invalid' });
  commit(store, child);
  const grandchild = store.beginSpawn(nested).child;
  commit(store, grandchild);
  assert.throws(() => store.beginSpawn(spawn({ parentWorkId: grandchild.work_id,
    parentTurnId: grandchild.turn_id })), { code: 'lineage_descendant_capacity' });
});

test('preparing intents consume the captured descendant limit', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 8; i++) store.beginSpawn(spawn({ callId: `spawn_${i}` }));
  assert.throws(() => store.beginSpawn(spawn({ callId: 'overflow' })), { code: 'lineage_descendant_capacity' });
  assert.equal(store.beginSpawn(spawn()).created, false);
});

for (const boundary of ['before', 'after']) {
  test(`uncertain ${boundary}-write spawn remains fenced and recovers exact intent`, t => {
    const io = faultIO();
    const { root, store } = fixture(t, io);
    io.failOnce(boundary);
    assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_write_uncertain' });
    assert.equal(store.snapshot().read_only, true);
    assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_write_uncertain' });
    assert.equal(store.recover().read_only, false);
    assert.equal(store.beginSpawn(spawn()).created, false);
    assert.equal(new RuntimeLineageStore(root).get('root_1').children.length, 1);
  });

  test(`uncertain ${boundary}-write cancellation cannot authorize publication`, t => {
    const io = faultIO();
    const { store } = fixture(t, io);
    const { child } = store.beginSpawn(spawn());
    io.failOnce(boundary);
    assert.throws(() => store.cancelRoot('root_1'), { code: 'lineage_write_uncertain' });
    store.recover();
    assert.throws(() => commit(store, child), { code: 'lineage_root_cancelled' });
    assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_root_cancelled' });
  });
}

test('pre-publication create crash preserves an unresolved directory across restart', t => {
  const { root } = fixture(t);
  const io = faultIO();
  const store = new RuntimeLineageStore(root, { io });
  io.failOnce('before');
  assert.throws(() => store.create({ ...rootArgs(), rootRunId: 'root_2', rootWorkId: 'work_2' }),
    { code: 'lineage_write_uncertain' });
  const restarted = new RuntimeLineageStore(root);
  assert.equal(restarted.snapshot().read_only, true);
  assert.throws(() => readPortableLineageSnapshot(root), { code: 'lineage_entry_unresolved' });
  store.recover();
  assert.equal(new RuntimeLineageStore(root).snapshot().root_record_count, 2);
});

test('readback mismatch blocks publication; recovery refuses conflicting durable bytes', t => {
  const base = createRuntimeStoreIO();
  let corrupt = false;
  const io = { ...base, writeJsonAtomic(file, value) {
    base.writeJsonAtomic(file, corrupt ? { ...value, cancelled: true } : value);
  } };
  const { store } = fixture(t, io);
  corrupt = true;
  assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_write_uncertain' });
  assert.throws(() => store.recover(), { code: 'lineage_recovery_conflict' });
  assert.equal(store.snapshot().read_only, true);
});

test('portable snapshots preserve preparing evidence and reject forged lineage', t => {
  const { root, store } = fixture(t);
  const { child } = store.beginSpawn(spawn());
  const snapshot = store.exportPortableSnapshot();
  assert.deepEqual(readPortableLineageSnapshot(root), snapshot);
  for (const patch of [{ depth: 2 }, { parent_work_id: child.work_id }, { work_id: 'forged' },
    { read_only: false }, { state: 'committed' }, { authority: {} }]) {
    const forged = structuredClone(snapshot);
    Object.assign(forged.records[0].document.children[0], patch);
    assert.throws(() => validatePortableLineageSnapshot(forged));
  }
  const future = { ...snapshot.records[0].document, schema_version: 2 };
  assert.throws(() => validateLineageRecord(future), { code: 'lineage_future_schema' });
});

test('malformed inventory and hardlinked record fail closed without removing evidence', t => {
  const { root, store } = fixture(t);
  const directory = path.join(root, fs.readdirSync(root)[0]);
  const target = path.join(directory, 'record.json');
  const alias = path.join(root, 'linked-record');
  fs.linkSync(target, alias);
  assert.throws(() => store.get('root_1'), { code: 'lineage_record_unreadable' });
  assert.equal(store.snapshot().read_only, true);
  assert.equal(fs.existsSync(alias), true);
  assert.equal(new RuntimeLineageStore(root).snapshot().read_only, true);
});

test('same-path directory replacement invalidates the captured owner', t => {
  const { root, store } = fixture(t);
  const sibling = `${root}-old`;
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  fs.renameSync(root, sibling);
  fs.mkdirSync(root);
  assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_directory_changed' });
  assert.equal(fs.readdirSync(root).length, 0);
});


test('cross-root ownership conflicts are refused before publication without blocking the store', t => {
  const { root, store } = fixture(t);
  const { child } = store.beginSpawn(spawn());
  for (const rootWorkId of ['work_1', child.work_id]) {
    assert.throws(() => store.create({ ...rootArgs(), rootRunId: 'root_2', rootWorkId }),
      { code: 'lineage_snapshot_conflict' });
    assert.equal(store.snapshot().read_only, false);
    assert.equal(fs.readdirSync(root).length, 1);
    assert.equal(new RuntimeLineageStore(root).snapshot().read_only, false);
  }
  assert.equal(store.create({ ...rootArgs(), rootRunId: 'root_2', rootWorkId: 'work_2' }).created, true);
});


test('a future child cannot collide with an already owned root work ID', t => {
  const { root, store } = fixture(t);
  const identity = spawnIdentity(spawn());
  store.create({ ...rootArgs(), rootRunId: 'root_2', rootWorkId: identity.work_id });
  assert.throws(() => store.beginSpawn(spawn()), { code: 'lineage_snapshot_conflict' });
  const restarted = new RuntimeLineageStore(root);
  assert.equal(restarted.snapshot().read_only, false);
  assert.throws(() => restarted.beginSpawn(spawn()), { code: 'lineage_snapshot_conflict' });
  assert.equal(restarted.get('root_1').children.length, 0);
});
