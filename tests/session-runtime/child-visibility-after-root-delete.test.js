'use strict';

// Row 58 W3 limit C: a child chat stays a child after its root is deleted.
// Deleting the root retires the lineage record, so the child is recognized
// from its own runtime work record (kind `child_chat`, kept through terminal
// compaction as `original_kind`), which session deletion never removes.

const assert = require('node:assert/strict');
const test = require('node:test');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { deleteSessionWithQuiescence } = require('../../services/backend/backend-session-delete-lifecycle');
const { CHILD_WORK_PURPOSE } = require('../../services/backend/runtime-child-publication');
const {
  sessionIneligibility,
  visibleChatPredicate,
} = require('../../services/backend/memory-reflection-eligibility');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a spawned child chat stays hidden and ineligible after its root chat is deleted', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child starts');
  h.starts[1].complete();
  await waitFor(() => h.runtime.store.get(child.child_work_id).status === 'completed', 'child finishes');
  await tick();
  const childSession = () => h.service.sessionStore.getSession(child.session_id);
  assert.equal(visibleChatPredicate(h.service)(childSession()), false, 'hidden while the root exists');

  assert.equal((await deleteSessionWithQuiescence(h.service, h.sessionId)).deleted, true);
  assert.equal(h.runtime.lineageStore.snapshot().root_record_count, 0, 'the root lineage is retired');
  assert.ok(childSession(), 'the child chat itself survives');

  assert.equal(visibleChatPredicate(h.service)(childSession()), false);
  assert.equal(sessionIneligibility(h.service, childSession()), 'child_session');
});

function fakeService(works, { status = { read_only: false, revision: 1 } } = {}) {
  const store = {
    getStatus: () => status,
    listSummaries({ cursor = null } = {}) {
      const offset = cursor ? Number(cursor) : 0;
      const items = works.slice(offset, offset + 2).map(({ work_id, session_id, purpose }) => ({ work_id, session_id, purpose }));
      return { items, next_cursor: offset + 2 < works.length ? String(offset + 2) : null, revision: status.revision };
    },
    gets: 0,
    get(workId) { store.gets += 1; return works.find(work => work.work_id === workId) || null; },
  };
  return {
    featureFlags: {},
    sessionRuntime: { store, lineageStore: { snapshot: () => ({ read_only: false, root_record_count: 0 }) } },
  };
}

const chat = id => ({ id, session_type: 'chat' });

test('runtime child records: compacted tombstones count, a look-alike purpose does not, only candidates are read', () => {
  const service = fakeService([
    { work_id: 'w1', session_id: 'root', purpose: 'chat', input: { kind: 'root_chat' } },
    { work_id: 'w2', session_id: 'live_child', purpose: CHILD_WORK_PURPOSE, input: { kind: 'child_chat' } },
    { work_id: 'w3', session_id: 'old_child', purpose: CHILD_WORK_PURPOSE,
      input: { kind: 'terminal_tombstone', original_kind: 'child_chat' } },
    { work_id: 'w4', session_id: 'named_root', purpose: CHILD_WORK_PURPOSE, input: { kind: 'root_chat' } },
    { work_id: 'w5', session_id: 'plain', purpose: 'chat', input: { kind: 'immediate_chat' } },
  ]);
  const visible = visibleChatPredicate(service);
  assert.deepEqual(['root', 'live_child', 'old_child', 'named_root', 'plain'].filter(id => visible(chat(id))),
    ['root', 'named_root', 'plain']);
  assert.equal(service.sessionRuntime.store.gets, 3, 'only child-purpose records are read from disk');
  assert.equal(sessionIneligibility(service, chat('old_child')), 'child_session');
  assert.equal(sessionIneligibility(service, chat('plain')), null);
});

test('an unreadable runtime store fails closed like an unreadable lineage store', () => {
  const service = fakeService([], { status: { read_only: true, reason: 'runtime_store_corrupt', revision: 0 } });
  assert.equal(visibleChatPredicate(service)(chat('plain')), false);
  assert.equal(sessionIneligibility(service, chat('plain')), 'lineage_unavailable');
  const throwing = fakeService([]);
  throwing.sessionRuntime.store.listSummaries = () => { throw new Error('io'); };
  assert.equal(visibleChatPredicate(throwing)(chat('plain')), false);
});
