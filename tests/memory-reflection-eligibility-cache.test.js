'use strict';

// visibleChatPredicate runs per primary send and per directory/conversations
// call: the runtime child scan reuses per-record classifications across store
// revisions, and the lineage inventory is re-read only after a lineage write.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CHILD_WORK_PURPOSE } = require('../services/backend/runtime-child-publication');
const { visibleChatPredicate } = require('../services/backend/memory-reflection-eligibility');
const { RuntimeLineageStore } = require('../services/session-runtime/lineage-store');
const { spawnIdentity } = require('../services/session-runtime/lineage-contracts');

const chat = id => ({ id, session_type: 'chat' });
const visibleIds = (service, ids) => ids.filter(id => visibleChatPredicate(service)(chat(id)));

function runtimeService(works) {
  const state = { revision: 1, gets: 0 };
  const store = {
    getStatus: () => ({ read_only: false, revision: state.revision }),
    listSummaries({ cursor = null } = {}) {
      const offset = cursor ? Number(cursor) : 0;
      const items = works.slice(offset, offset + 2)
        .map(({ work_id, session_id, purpose, revision }) => ({ work_id, session_id, purpose, revision }));
      return { items, next_cursor: offset + 2 < works.length ? String(offset + 2) : null, revision: state.revision };
    },
    get(workId) { state.gets += 1; return works.find(work => work.work_id === workId) || null; },
  };
  return { state, service: { featureFlags: {}, sessionRuntime: { store, lineageStore: null } } };
}

test('a store revision bump re-reads only child-purpose records whose revision changed', () => {
  const works = [
    { work_id: 'w1', session_id: 'root', purpose: 'chat', revision: 1, input: { kind: 'root_chat' } },
    { work_id: 'w2', session_id: 'child_a', purpose: CHILD_WORK_PURPOSE, revision: 1, input: { kind: 'child_chat' } },
    { work_id: 'w3', session_id: 'child_b', purpose: CHILD_WORK_PURPOSE, revision: 1, input: { kind: 'child_chat' } },
    { work_id: 'w4', session_id: 'named_root', purpose: CHILD_WORK_PURPOSE, revision: 1, input: { kind: 'root_chat' } },
  ];
  const { state, service } = runtimeService(works);
  const all = ['root', 'child_a', 'child_b', 'named_root'];
  assert.deepEqual(visibleIds(service, all), ['root', 'named_root']);
  const firstReads = state.gets;
  assert.equal(firstReads, 3);

  // The primary's own turn bumps the store revision and its own record only.
  state.revision += 1;
  works[0] = { ...works[0], revision: 2 };
  assert.deepEqual(visibleIds(service, all), ['root', 'named_root']);
  assert.equal(state.gets, firstReads, 'unchanged child-purpose records are not re-read');

  // A changed child record is re-read (terminal compaction keeps original_kind).
  state.revision += 1;
  works[1] = { ...works[1], revision: 2, input: { kind: 'terminal_tombstone', original_kind: 'child_chat' } };
  assert.deepEqual(visibleIds(service, all), ['root', 'named_root']);
  assert.equal(state.gets, firstReads + 1);

  // A record that left the index is dropped from the classification cache.
  state.revision += 1;
  const [removed] = works.splice(2, 1);
  assert.deepEqual(visibleIds(service, all), ['root', 'child_b', 'named_root']);
  assert.equal(state.gets, firstReads + 1);
  state.revision += 1;
  works.push(removed);
  assert.deepEqual(visibleIds(service, all), ['root', 'named_root']);
  assert.equal(state.gets, firstReads + 2, 'a dropped entry is classified again');
});

function lineageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lineage-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lineageStore = new RuntimeLineageStore(root);
  lineageStore.create({ rootRunId: 'root_1', rootWorkId: 'work_1', rootSessionId: 'session_1',
    rootTurnId: 'turn_1', projectId: 'project_1', providerId: 'ollama', authorityFingerprint: 'a'.repeat(64),
    limits: { descendants: 8, descendant_depth: 2 } });
  const counter = { exports: 0 };
  const exportPortableSnapshot = lineageStore.exportPortableSnapshot.bind(lineageStore);
  lineageStore.exportPortableSnapshot = () => { counter.exports += 1; return exportPortableSnapshot(); };
  return { counter, lineageStore, service: { featureFlags: {}, sessionRuntime: { store: null, lineageStore } } };
}

test('lineage children are re-exported only after a lineage write', t => {
  const { counter, lineageStore, service } = lineageFixture(t);
  const spawn = callId => ({ rootRunId: 'root_1', parentWorkId: 'work_1', parentTurnId: 'turn_1', callId,
    argsSha256: 'b'.repeat(64) });
  const first = spawnIdentity(spawn('spawn_1')).session_id;
  const second = spawnIdentity(spawn('spawn_2')).session_id;
  lineageStore.beginSpawn(spawn('spawn_1'));
  assert.deepEqual(visibleIds(service, ['session_1', first, second]), ['session_1', second]);
  const exports = counter.exports;
  assert.ok(exports >= 1);
  visibleChatPredicate(service);
  visibleChatPredicate(service);
  assert.equal(counter.exports, exports, 'an unchanged lineage store is not re-read');

  lineageStore.beginSpawn(spawn('spawn_2'));
  const afterWrite = counter.exports;
  assert.deepEqual(visibleIds(service, ['session_1', first, second]), ['session_1']);
  assert.ok(counter.exports > afterWrite, 'a write invalidates the cached children');
});

test('a blocked lineage store still fails closed after a cached read', t => {
  const { lineageStore, service } = lineageFixture(t);
  assert.equal(visibleChatPredicate(service)(chat('session_1')), true);
  lineageStore._block(new Error('lineage_directory_changed'));
  assert.equal(visibleChatPredicate(service)(chat('session_1')), false);
});
