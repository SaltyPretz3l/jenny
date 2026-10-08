'use strict';

/* Suggested changes (row 35 W3): groups and dependencies over the record. */

const test = require('node:test');
const assert = require('node:assert/strict');
const relations = require('../services/backend/suggested-changes-relations');

const NOW = '2026-10-05T12:00:00.000Z';

function entry(id, overrides = {}) {
  return {
    id, status: 'to_review', group_id: null, depends_on: [], turn_id: 't1', tool_call_id: `call_${id}`,
    updated_at: '2026-10-05T11:00:00.000Z', ...overrides,
  };
}

const stateOf = (...entries) => ({ entries });
const statusOf = (state) => Object.fromEntries(state.entries.map((item) => [item.id, item.status]));

test('group ids are scoped to the turn that named them', () => {
  assert.equal(relations.groupIdFor('turn_1', 'rename-api'), 'grp:turn_1:rename-api');
  assert.notEqual(relations.groupIdFor('turn_1', 'api'), relations.groupIdFor('turn_2', 'api'));
  assert.equal(relations.groupIdFor('turn_1', '  '), null);
  assert.equal(relations.groupIdFor('turn_1', null), null);
});

test('references resolve by id, or by tool call id within the same turn', () => {
  const state = stateOf(entry('a'), entry('b', { turn_id: 't0', tool_call_id: 'call_x' }));
  assert.deepEqual(relations.resolveReferences(state, ['a', 'call_a', 'call_x', 'missing'], 't1'), ['a']);
  assert.deepEqual(relations.resolveReferences(state, ['call_x'], 't0'), ['b']);
});

test('leaving a group resets accepted members and dissolves a group of one', () => {
  const g = 'grp:t1:x';
  const three = stateOf(entry('a', { group_id: g, status: 'accepted' }), entry('b', { group_id: g, status: 'accepted' }), entry('c', { group_id: g }));
  const left = relations.leaveGroup(three, 'c', NOW);
  assert.deepEqual(statusOf(left), { a: 'to_review', b: 'to_review', c: 'to_review' });
  assert.deepEqual(left.entries.map((item) => item.group_id), [g, g, null]);
  const two = stateOf(entry('a', { group_id: g, status: 'accepted' }), entry('b', { group_id: g }));
  const dissolved = relations.leaveGroup(two, 'b', NOW);
  assert.deepEqual(dissolved.entries.map((item) => item.group_id), [null, null]);
  assert.equal(dissolved.entries[0].status, 'to_review');
});

test('reject never cascades: dependents wait in Needs attention until it is restored', () => {
  let state = stateOf(
    entry('a', { status: 'rejected' }),
    entry('b', { depends_on: ['a'] }),
    entry('c', { depends_on: ['a'], status: 'applied' }),
    entry('d', { depends_on: ['a'], status: 'later' }),
  );
  state = relations.holdDependents(state, 'a', NOW);
  assert.deepEqual(statusOf(state), { a: 'rejected', b: 'needs_attention', c: 'applied', d: 'needs_attention' });
  state = { entries: state.entries.map((item) => (item.id === 'a' ? { ...item, status: 'to_review' } : item)) };
  state = relations.releaseDependents(state, NOW);
  assert.deepEqual(statusOf(state), { a: 'to_review', b: 'to_review', c: 'applied', d: 'to_review' });
});

test('pending dependencies skip applied, rejected and same-group changes', () => {
  const g = 'grp:t1:x';
  const state = stateOf(
    entry('a'), entry('b', { status: 'applied' }), entry('c', { status: 'rejected' }), entry('d', { group_id: g }),
    entry('e', { depends_on: ['a', 'b', 'c', 'd'], group_id: g }),
  );
  assert.deepEqual(relations.pendingDependencies(state, state.entries[4]).map((item) => item.id), ['a']);
});

test('derived facts: an import of a created file and a newly used name another change adds', () => {
  const base = { kind: 'replace', old_string: '', new_string: '', created_at: '2026-10-05T11:00:00.000Z' };
  const created = entry('c1', { ...base, kind: 'create', path: 'src/util/dates.py', new_string: 'def parse_day(text):\n    return text\n' });
  const jsCreated = entry('c2', { ...base, kind: 'create', path: 'web/lib/format.js', new_string: 'export function fmt(x) { return x; }\n' });
  const definer = entry('d1', { ...base, path: 'src/core.py', old_string: 'def old_name():', new_string: 'def total_cost(items):' });
  const later = { ...base, created_at: '2026-10-05T11:30:00.000Z' };
  const py = entry('p1', { ...later, path: 'src/app.py', old_string: 'import os', new_string: 'import os\nfrom .util.dates import parse_day' });
  const js = entry('j1', { ...later, path: 'web/pages/home.js', old_string: 'const a = 1;', new_string: "import { fmt } from '../lib/format';\nconst a = 1;" });
  const user = entry('u1', { ...later, path: 'src/report.py', old_string: 'x = 1', new_string: 'x = total_cost(rows)' });
  const plain = entry('n1', { ...later, path: 'src/other.py', old_string: 'a = 1', new_string: 'a = 2' });
  const state = stateOf(created, jsCreated, definer, py, js, user, plain);
  assert.deepEqual(relations.deriveRelations(state, py), [{ id: 'c1', kind: 'import', name: 'dates.py' }]);
  assert.deepEqual(relations.deriveRelations(state, js), [{ id: 'c2', kind: 'import', name: 'format.js' }]);
  assert.deepEqual(relations.deriveRelations(state, user), [{ id: 'd1', kind: 'defines', name: 'total_cost' }]);
  assert.deepEqual(relations.deriveRelations(state, plain, ['d1']), [{ id: 'd1', kind: 'declared', name: '' }]);
  assert.deepEqual(relations.deriveRelations(state, definer), [], 'facts only point at earlier changes');
});
