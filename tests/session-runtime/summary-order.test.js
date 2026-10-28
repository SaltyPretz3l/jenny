'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { attempt, harness, submission } = require('../helpers/runtime-store-fixture');
const { summariesByRecency } = require('../../services/session-runtime/summary-order');

// listSummaries is paged on hot paths (session directory, child-chat scan);
// the full sort is reused while the index summaries are unchanged.
function countingLocaleCompare(t) {
  const original = String.prototype.localeCompare;
  const counter = { calls: 0 };
  String.prototype.localeCompare = function counted(...args) {
    counter.calls += 1;
    return original.apply(this, args);
  };
  t.after(() => { String.prototype.localeCompare = original; });
  return counter;
}

function reference(store, { projectId = null } = {}) {
  return store.index.summaries.filter(entry => projectId === null || entry.project_id === projectId)
    .map(entry => ({ ...entry }))
    .sort((left, right) => (right.updated_at < left.updated_at ? -1 : right.updated_at > left.updated_at ? 1 : 0)
      || (left.work_id < right.work_id ? -1 : left.work_id > right.work_id ? 1 : 0))
    .map(entry => entry.work_id);
}

function seed(store, count) {
  for (let index = 0; index < count; index += 1) {
    store.submit(submission({ idempotencyKey: `submit_${index}`, workId: `work_${index}`,
      turnId: `turn_${index}`, sessionId: index % 2 ? 'session_odd' : 'session_even' }));
  }
}

function pageAll(store, options = {}) {
  const ids = [];
  let cursor = null;
  do {
    const page = store.listSummaries({ limit: 2, cursor, ...options });
    ids.push(...page.items.map(entry => entry.work_id));
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

test('summary paging sorts once per index state and re-sorts after a mutation', t => {
  const { store } = harness();
  seed(store, 6);
  const counter = countingLocaleCompare(t);
  const first = store.listSummaries({ limit: 2 });
  assert.ok(counter.calls > 0, 'the first page sorts');
  counter.calls = 0;
  const second = store.listSummaries({ limit: 2, cursor: first.next_cursor });
  const third = store.listSummaries({ limit: 2, cursor: second.next_cursor });
  assert.equal(counter.calls, 0, 'later pages at one revision reuse the sort');
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(entry => entry.work_id), reference(store));
  assert.equal(third.next_cursor, null);
  assert.ok(Object.isFrozen(first.items) && Object.isFrozen(first));

  const paused = store.get('work_0');
  store.transition('work_0', { expectedRevision: paused.revision, to: 'running', reason: 'start',
    attempt: attempt(1) });
  assert.throws(() => store.listSummaries({ limit: 2, cursor: first.next_cursor }), { code: 'stale_cursor' });
  counter.calls = 0;
  const after = store.listSummaries({ limit: 100 });
  assert.ok(counter.calls > 0, 'a mutation invalidates the cached order');
  assert.equal(after.items[0].work_id, 'work_0', 'the updated item leads');
  assert.deepEqual(after.items.map(entry => entry.work_id), reference(store));
});

test('scoped pages keep the cached order, scope checks and returned copies', t => {
  const { store } = harness();
  seed(store, 5);
  store.listSummaries({ limit: 1 });
  const counter = countingLocaleCompare(t);
  assert.deepEqual(pageAll(store, { sessionId: 'session_odd' }),
    reference(store).filter(id => Number(id.slice(5)) % 2 === 1));
  assert.deepEqual(pageAll(store, { projectId: 'project_alpha' }), reference(store, { projectId: 'project_alpha' }));
  assert.equal(counter.calls, 0);
  const page = store.listSummaries({ limit: 1, sessionId: 'session_even' });
  assert.throws(() => store.listSummaries({ limit: 1, cursor: page.next_cursor }), { code: 'cursor_scope_mismatch' });
  // Returned items are clones, never the cached index entries.
  assert.notEqual(page.items[0], store.index.summaries.find(entry => entry.work_id === page.items[0].work_id));
});

test('the order is keyed by the frozen summaries array, never by its contents', () => {
  const row = (workId, updatedAt) => Object.freeze({ work_id: workId, updated_at: updatedAt });
  const first = Object.freeze([row('work_b', '2026-09-09T00:00:01.000Z'), row('work_a', '2026-09-09T00:00:01.000Z'),
    row('work_c', '2026-09-09T00:00:02.000Z')]);
  const sorted = summariesByRecency(first);
  assert.deepEqual(sorted.map(entry => entry.work_id), ['work_c', 'work_a', 'work_b']);
  assert.ok(Object.isFrozen(sorted));
  assert.equal(summariesByRecency(first), sorted);
  const replaced = Object.freeze([first[0], first[1]]);
  assert.deepEqual(summariesByRecency(replaced).map(entry => entry.work_id), ['work_a', 'work_b']);
  const mutable = [...first];
  const once = summariesByRecency(mutable);
  assert.notEqual(summariesByRecency(mutable), once, 'an unfrozen array is never cached');
});
