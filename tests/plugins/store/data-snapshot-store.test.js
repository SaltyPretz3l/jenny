'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  MAX_BYTES_GLOBAL,
  MAX_BYTES_PER_PLUGIN,
  MAX_INDEX_ENTRIES,
  MAX_SNAPSHOTS_PER_PLUGIN,
  boundedLimits,
  getDataSnapshot,
  putDataSnapshot,
  readDataSnapshotIndex,
  validateIndex,
} = require('../../../services/plugins/store/data-snapshot-store');

function snapshot(bytes, generationId, createdAt, extra = {}) {
  return {
    publisherId: 'jenny-official', pluginId: 'remote', generationId,
    bytes, createdAt, evidentiary: false, ...extra,
  };
}

test('data snapshots are content-addressed and exact bytes are verified on read', async () => {
  const facade = createMemoryFsFacade();
  const stored = await putDataSnapshot(facade, '', snapshot(
    'snapshot-one', 'gen-one', '2026-08-04T20:00:00Z'
  ));
  assert.equal(stored.ok, true);
  const read = await getDataSnapshot(facade, '', {
    publisherId: 'jenny-official', pluginId: 'remote', digest: stored.digest,
  });
  assert.equal(read.ok, true);
  assert.equal(read.bytes.toString(), 'snapshot-one');
});

test('snapshot identities and retention overrides fail closed at hard limits', async () => {
  const limits = boundedLimits({
    maxPerPlugin: MAX_SNAPSHOTS_PER_PLUGIN + 10,
    maxBytesPerPlugin: MAX_BYTES_PER_PLUGIN + 10,
    maxBytesGlobal: MAX_BYTES_GLOBAL + 10,
  });
  assert.deepEqual(limits, {
    maxPerPlugin: MAX_SNAPSHOTS_PER_PLUGIN,
    maxBytesPerPlugin: MAX_BYTES_PER_PLUGIN,
    maxBytesGlobal: MAX_BYTES_GLOBAL,
  });
  const rejected = await putDataSnapshot(createMemoryFsFacade(), '', {
    ...snapshot('bytes', 'gen-one', '2026-08-04T20:00:00Z'),
    publisherId: 'publisher_with_underscore',
  });
  assert.equal(rejected.reason, 'data_snapshot_invalid');
  const malformedBytes = await putDataSnapshot(createMemoryFsFacade(), '', {
    ...snapshot(null, 'gen-one', '2026-08-04T20:00:00Z'),
  });
  assert.equal(malformedBytes.reason, 'data_snapshot_invalid');
});

test('snapshot indexes reject per-plugin and global structural excess before use', () => {
  const entry = {
    publisher_id: 'jenny-official', plugin_id: 'remote', generation_id: 'gen-one',
    digest: 'a'.repeat(64), size: 1, created_at: '2026-08-04T20:00:00Z',
    leased: false, evidentiary: false,
  };
  const entries = Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_value, index) => ({
    ...entry,
    plugin_id: `remote_${index}`,
    digest: index.toString(16).padStart(64, '0'),
  }));
  assert.equal(validateIndex({
    data_snapshot_index_schema_version: 1,
    entries,
    index_digest: '0'.repeat(64),
  }), false);
  assert.equal(validateIndex({
    data_snapshot_index_schema_version: 1,
    entries: [entry, { ...entry, generation_id: 'gen-two', digest: 'b'.repeat(64) },
      { ...entry, generation_id: 'gen-three', digest: 'c'.repeat(64) }],
    index_digest: '0'.repeat(64),
  }), false);
});

test('third snapshot evicts oldest unleased non-evidentiary state', async () => {
  const facade = createMemoryFsFacade();
  const first = await putDataSnapshot(facade, '', snapshot('one', 'gen-one', '2026-08-04T20:00:00Z'));
  await putDataSnapshot(facade, '', snapshot('two', 'gen-two', '2026-08-04T20:01:00Z'));
  const third = await putDataSnapshot(facade, '', snapshot('three', 'gen-three', '2026-08-04T20:02:00Z'));
  assert.deepEqual(third.evicted, [`jenny-official/remote/${first.digest}`]);
  assert.equal((await readDataSnapshotIndex(facade, '')).index.entries.length, 2);
});

test('global pressure evicts the oldest eligible snapshot across authorities', async () => {
  const facade = createMemoryFsFacade();
  const oldest = await putDataSnapshot(facade, '', snapshot(
    'old', 'gen-old', '2026-08-04T20:00:00Z', { publisherId: 'other-publisher' }
  ));
  await putDataSnapshot(facade, '', snapshot('new', 'gen-new', '2026-08-04T20:01:00Z'));
  const incoming = await putDataSnapshot(
    facade,
    '',
    snapshot('fresh', 'gen-fresh', '2026-08-04T20:02:00Z'),
    { maxBytesPerPlugin: 8, maxBytesGlobal: 8 }
  );
  assert.deepEqual(incoming.evicted, [`other-publisher/remote/${oldest.digest}`]);
});

test('retention fails closed when every candidate is leased or evidentiary', async () => {
  const facade = createMemoryFsFacade();
  await putDataSnapshot(facade, '', snapshot('one', 'gen-one', '2026-08-04T20:00:00Z', { leased: true }));
  await putDataSnapshot(facade, '', snapshot('two', 'gen-two', '2026-08-04T20:01:00Z', { evidentiary: true }));
  const blocked = await putDataSnapshot(facade, '', snapshot('three', 'gen-three', '2026-08-04T20:02:00Z'));
  assert.equal(blocked.reason, 'data_snapshot_capacity_unavailable');
  assert.equal((await readDataSnapshotIndex(facade, '')).index.entries.length, 2);
});

test('malformed snapshot index is a corruption result, never an empty store', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('data-snapshots');
  await facade.writeFile('data-snapshots/index.json', '{');
  assert.equal((await readDataSnapshotIndex(facade, '')).reason, 'data_snapshot_index_corrupted');
});
