'use strict';

// A19-F2: applying a re-anchored proposal must not hand its sibling on the same
// file the post-drift head as a trusted hash; the sibling keeps its own base, so
// the sidecar answers `moved` and asks for fresh consent on the relocated text.

const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../services/backend/suggested-changes-records');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

let counter = 0;
function recorded(state, overrides) {
  counter += 1;
  return records.recordSuggestion(state, {
    metadata: {
      schema_version: 1, path: 'config.ini', kind: 'replace', old_string: 'x', new_string: 'y',
      title: 't', what: 'w', why: 'y', watch_for: '', revises: null, base_hash: HASH_A, diff: { hunks: [] },
      ...overrides,
    },
    toolCallId: `call_${counter}`,
    turnId: 'turn_1',
    now: '2026-10-05T10:00:00.000Z',
    createId: () => `sc_re${counter}`,
  });
}

test('a re-anchored apply leaves its stale sibling on its own base', () => {
  let state = recorded(records.emptySuggestedChanges(), { old_string: 'title = a', new_string: 'title = b' }).state;
  state = recorded(state, { old_string: 'enabled=false', new_string: 'enabled=true' }).state;
  const [a, b] = state.entries;

  // An external edit moved the file to HASH_C: A's Accept re-anchors A.
  state = records.applyReceipt(state, {
    result: { status: 'refused', items: [{ suggestion_id: a.id, outcome: 'moved', base_hash: HASH_C, diff: { hunks: [1] } }] },
  }).state;
  assert.equal(state.entries[0].revision, 2);

  // The re-anchored revision applies over the external edit.
  state = records.applyReceipt(state, {
    result: {
      status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
      items: [{ suggestion_id: a.id, outcome: 'applied', after_hash: HASH_B, diff: { hunks: [1] } }],
    },
    revisions: { [a.id]: 2 },
  }).state;

  const sibling = state.entries.find((entry) => entry.id === b.id);
  assert.equal(sibling.revision, 1);
  assert.equal(records.expectedHashFor(state, sibling), HASH_A, 'B never inherits the post-drift head');
  // A suggestion on the same chain as the applied one still advances.
  const later = recorded(state, { old_string: 'later', base_hash: HASH_B });
  assert.equal(records.expectedHashFor(later.state, later.entry), HASH_B);
});

test('siblings on the same base still chain on the applied head', () => {
  let state = recorded(records.emptySuggestedChanges(), { old_string: 'one' }).state;
  state = recorded(state, { old_string: 'two' }).state;
  const [first, second] = state.entries;
  state = records.applyReceipt(state, {
    result: {
      status: 'applied', workspace_change_set: { change_set_id: 'cs_2' },
      items: [{ suggestion_id: first.id, outcome: 'applied', after_hash: HASH_B }],
    },
  }).state;
  assert.equal(records.expectedHashFor(state, state.entries.find((entry) => entry.id === second.id)), HASH_B);
});
