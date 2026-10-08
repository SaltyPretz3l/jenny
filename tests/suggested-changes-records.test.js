'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../services/backend/suggested-changes-records');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function metadata(overrides = {}) {
  return {
    schema_version: 1,
    path: 'src/app.js',
    kind: 'replace',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
    title: 'Raise the starting value',
    what: 'The app starts counting at two.',
    why: 'You asked for it.',
    watch_for: '',
    revises: null,
    base_hash: HASH_A,
    diff: { hunks: [] },
    ...overrides,
  };
}

let counter = 0;
const createId = () => `sc_test${(counter += 1)}`;

// Every call is a fresh tool call unless the test names one: the recorder is
// idempotent per call id, as a result delivered twice is one suggestion.
let callCounter = 0;
function recorded(state = records.emptySuggestedChanges(), overrides = {}, toolCallId = `call_${(callCounter += 1)}`) {
  return records.recordSuggestion(state, {
    metadata: metadata(overrides),
    toolCallId,
    turnId: 'turn_1',
    now: '2026-10-05T10:00:00.000Z',
    createId,
  });
}

test('normalize fails closed to an empty record for unknown versions and junk', () => {
  assert.deepEqual(records.normalizeSuggestedChanges(null), records.emptySuggestedChanges());
  assert.deepEqual(records.normalizeSuggestedChanges({ schema_version: 2, entries: [{}] }), records.emptySuggestedChanges());
  const state = records.normalizeSuggestedChanges({
    schema_version: 1,
    entries: [
      { id: 'sc_ok', path: 'a.js', kind: 'replace', old_string: 'x', new_string: 'y' },
      { id: 'sc_ok', path: 'dup.js', kind: 'replace', old_string: 'x', new_string: 'y' },
      { id: 'bad id!', path: 'a.js', kind: 'replace', old_string: 'x', new_string: 'y' },
      { id: 'sc_noold', path: 'a.js', kind: 'replace', old_string: '', new_string: 'y' },
      { id: 'sc_kind', path: 'a.js', kind: 'delete', old_string: 'x', new_string: '' },
      { id: 'sc_big', path: 'a.js', kind: 'replace', old_string: 'x'.repeat(records.MAX_CHANGE_STRING_CHARS + 1), new_string: 'y' },
    ],
  });
  assert.deepEqual(state.entries.map((e) => e.id), ['sc_ok']);
  assert.equal(state.entries[0].status, 'to_review');
});

test('an applied status without a receipt is not trusted', () => {
  const state = records.normalizeSuggestedChanges({
    schema_version: 1,
    entries: [{ id: 'sc_1', path: 'a.js', kind: 'replace', old_string: 'x', new_string: 'y', status: 'applied' }],
  });
  assert.equal(state.entries[0].status, 'to_review');
});

test('recordSuggestion appends a new entry with trimmed plain-words text', () => {
  const long = 'word '.repeat(40);
  const { state, entry, revised } = recorded(undefined, { title: long }, 'call_1');
  assert.equal(revised, false);
  assert.equal(state.entries.length, 1);
  assert.equal(entry.status, 'to_review');
  assert.equal(entry.revision, 1);
  assert.equal(entry.base_hash, HASH_A);
  assert.ok(entry.title.length <= 80);
  assert.ok(entry.title.endsWith('…'));
  assert.equal(entry.tool_call_id, 'call_1');
});

test('create suggestions carry no old text and no base hash', () => {
  const { entry } = recorded(undefined, { kind: 'create', old_string: 'ignored', base_hash: HASH_A });
  assert.equal(entry.kind, 'create');
  assert.equal(entry.old_string, '');
  assert.equal(entry.base_hash, null);
});

test('invalid metadata records nothing', () => {
  const empty = records.emptySuggestedChanges();
  for (const bad of [null, { schema_version: 2 }, metadata({ kind: 'delete' }), metadata({ path: '' }), metadata({ old_string: '' })]) {
    const result = records.recordSuggestion(empty, { metadata: bad, createId });
    assert.equal(result.entry, null);
    assert.equal(result.state, empty);
  }
});

test('a revision keeps the id, bumps the revision and resets consent', () => {
  const first = recorded();
  const id = first.entry.id;
  const commented = records.addComment(first.state, { id, text: 'Use three instead', now: '2026-10-05T10:01:00.000Z', createId });
  const sent = records.markCommentsSent(commented.state, { now: '2026-10-05T10:02:00.000Z' });
  assert.deepEqual(sent.ids, [id]);
  assert.equal(sent.state.entries[0].status, 'revising');
  const revision = recorded(sent.state, { revises: id, new_string: 'const a = 3;', base_hash: HASH_B });
  assert.equal(revision.revised, true);
  assert.equal(revision.state.entries.length, 1);
  assert.equal(revision.entry.id, id);
  assert.equal(revision.entry.revision, 2);
  assert.equal(revision.entry.status, 'to_review');
  assert.equal(revision.entry.new_string, 'const a = 3;');
  assert.equal(revision.entry.comments.length, 1);
  assert.ok(revision.entry.comments[0].sent_at);
});

test('revising an applied change or an unknown id records a new entry', () => {
  const first = recorded();
  const unknown = recorded(first.state, { revises: 'sc_missing' });
  assert.equal(unknown.revised, false);
  assert.equal(unknown.state.entries.length, 2);
});

test('decisions follow the status machine', () => {
  const { state, entry } = recorded();
  const later = records.decideSuggestion(state, { id: entry.id, decision: 'later' });
  assert.equal(later.entry.status, 'later');
  const restored = records.decideSuggestion(later.state, { id: entry.id, decision: 'restore' });
  assert.equal(restored.entry.status, 'to_review');
  const rejected = records.decideSuggestion(restored.state, { id: entry.id, decision: 'reject', reason: 'Not needed' });
  assert.equal(rejected.entry.status, 'rejected');
  assert.equal(rejected.entry.reject_reason, 'Not needed');
  assert.equal(records.decideSuggestion(rejected.state, { id: entry.id, decision: 'later' }).error, 'invalid_transition');
  assert.equal(records.decideSuggestion(rejected.state, { id: 'sc_nope', decision: 'reject' }).error, 'not_found');
  assert.equal(records.decideSuggestion(rejected.state, { id: entry.id, decision: 'accept' }).error, 'not_found');
});

test('comments on terminal changes are refused and empty comments ignored', () => {
  const { state, entry } = recorded();
  assert.equal(records.addComment(state, { id: entry.id, text: '   ' }).error, 'empty');
  const rejected = records.decideSuggestion(state, { id: entry.id, decision: 'reject' }).state;
  assert.equal(records.addComment(rejected, { id: entry.id, text: 'hi' }).error, 'invalid_transition');
});

test('pending count and live context exclude applied and rejected changes', () => {
  let state = recorded().state;
  state = recorded(state, { old_string: 'b', path: 'src/b.js' }).state;
  state = recorded(state, { old_string: 'c', path: 'src/c.js' }).state;
  const [a, b, c] = state.entries;
  state = records.decideSuggestion(state, { id: b.id, decision: 'reject' }).state;
  state = records.decideSuggestion(state, { id: c.id, decision: 'later' }).state;
  assert.equal(records.pendingCount(state), 1);
  const context = records.liveSuggestionContext(state);
  assert.equal(context.schema_version, 1);
  assert.deepEqual(context.live.map((item) => item.id), [a.id, c.id]);
  assert.deepEqual(Object.keys(context.live[0]).sort(), ['id', 'kind', 'old_string', 'path']);
});

test('apply receipts mark applied, advance the file head and fold moved and out-of-date items', () => {
  let state = recorded().state;
  state = recorded(state, { old_string: 'second', new_string: 'SECOND' }).state;
  state = recorded(state, { old_string: 'third', new_string: 'THIRD', path: 'src/other.js' }).state;
  const [first, second, third] = state.entries;
  assert.equal(records.expectedHashFor(state, first), HASH_A);
  const applied = records.applyReceipt(state, {
    result: {
      status: 'applied',
      workspace_change_set: { change_set_id: 'cs_1' },
      items: [{ suggestion_id: first.id, outcome: 'applied', after_hash: HASH_B, diff: { hunks: [1] } }],
    },
    now: '2026-10-05T11:00:00.000Z',
  });
  assert.deepEqual(applied.changed, [first.id]);
  const appliedFirst = applied.state.entries[0];
  assert.equal(appliedFirst.status, 'applied');
  assert.equal(appliedFirst.applied.change_set_id, 'cs_1');
  assert.equal(appliedFirst.applied.after_hash, HASH_B);
  // The second change on the same file now expects the hash the first apply left.
  assert.equal(records.expectedHashFor(applied.state, applied.state.entries[1]), HASH_B);
  // A suggestion made after the write keeps its own base.
  const later = recorded(applied.state, { old_string: 'fourth', base_hash: HASH_C });
  assert.equal(records.expectedHashFor(later.state, later.entry), HASH_C);

  const folded = records.applyReceipt(applied.state, {
    result: {
      status: 'refused',
      items: [
        { suggestion_id: second.id, outcome: 'moved', base_hash: HASH_C, diff: { hunks: [2] } },
        { suggestion_id: third.id, outcome: 'out_of_date' },
      ],
    },
  });
  const movedSecond = folded.state.entries.find((e) => e.id === second.id);
  assert.equal(movedSecond.revision, 2);
  assert.equal(movedSecond.status, 'to_review');
  assert.equal(movedSecond.base_hash, HASH_C);
  assert.equal(records.expectedHashFor(folded.state, movedSecond), HASH_C);
  assert.equal(folded.state.entries.find((e) => e.id === third.id).status, 'out_of_date');
});

test('an applied outcome inside a refused or rolled-back call applies nothing', () => {
  const { state, entry } = recorded();
  for (const status of ['refused', 'rolled_back']) {
    const result = records.applyReceipt(state, {
      result: { status, items: [{ suggestion_id: entry.id, outcome: 'applied', after_hash: HASH_B }] },
    });
    assert.equal(result.state.entries[0].status, 'to_review');
    assert.deepEqual(result.state.file_heads, {});
  }
});

test('restart recovery never abandons a suggestion', () => {
  let state = recorded().state;
  const id = state.entries[0].id;
  state = records.addComment(state, { id, text: 'please', createId }).state;
  state = records.markCommentsSent(state).state;
  assert.equal(state.entries[0].status, 'revising');
  const settled = records.settleSuggestedChangesAfterRestart(state);
  assert.equal(settled.changed, true);
  assert.equal(settled.state.entries[0].status, 'to_review');
  assert.equal(records.settleSuggestedChangesAfterRestart(settled.state).changed, false);
});

test('the entry bound evicts the oldest terminal entries only', () => {
  const entries = [];
  for (let i = 0; i < records.MAX_ENTRIES + 5; i += 1) {
    entries.push({
      id: `sc_${i}`, path: `f${i}.js`, kind: 'replace', old_string: 'x', new_string: 'y',
      status: i < 10 ? 'rejected' : 'to_review',
      updated_at: new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString(),
    });
  }
  const state = records.normalizeSuggestedChanges({ schema_version: 1, entries });
  assert.equal(state.entries.length, records.MAX_ENTRIES);
  assert.equal(state.entries.some((e) => e.id === 'sc_0'), false);
  assert.equal(state.entries.some((e) => e.id === 'sc_5'), true);
  assert.equal(state.entries.filter((e) => e.status === 'to_review').length, records.MAX_ENTRIES - 5);
});

test('normalize round-trips a populated record through JSON', () => {
  let state = recorded().state;
  state = records.addComment(state, { id: state.entries[0].id, text: 'note', createId }).state;
  const again = records.normalizeSuggestedChanges(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(again, state);
});

test('a same-turn revise names the earlier call id and resolves to its entry', () => {
  const first = recorded(undefined, {}, 'call_1');
  const second = records.recordSuggestion(first.state, {
    metadata: metadata({ revises: 'call_1', new_string: 'const a = 5;', base_hash: HASH_A }),
    toolCallId: 'call_2', turnId: 'turn_1', now: '2026-10-05T10:00:05.000Z', createId,
  });
  assert.equal(second.revised, true);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.tool_call_id, 'call_2');
  // A call id from another turn does not resolve: it records a new entry.
  const other = records.recordSuggestion(second.state, {
    metadata: metadata({ revises: 'call_2', old_string: 'let b;', new_string: 'let b = 1;' }),
    toolCallId: 'call_9', turnId: 'turn_2', now: '2026-10-05T10:01:00.000Z', createId,
  });
  assert.equal(other.revised, false);
  assert.equal(other.state.entries.length, 2);
});

test('new suggestions are refused once every slot holds a live one', () => {
  let state = records.emptySuggestedChanges();
  for (let index = 0; index < records.MAX_ENTRIES; index += 1) {
    state = recorded(state, { old_string: `line ${index}` }).state;
  }
  assert.equal(state.entries.length, records.MAX_ENTRIES);
  const full = recorded(state, { old_string: 'one more' });
  assert.equal(full.entry, null);
  assert.equal(full.refused, 'full');
  assert.equal(full.state, state);
  // A terminal entry makes room again.
  const rejected = records.decideSuggestion(state, { id: state.entries[0].id, decision: 'reject' }).state;
  const roomy = recorded(rejected, { old_string: 'one more' });
  assert.ok(roomy.entry);
  assert.equal(roomy.state.entries.length, records.MAX_ENTRIES);
});

// Owner dev-profile report (2026-10-05): every suggested change was listed
// twice. One tool result reaches the recorder twice (canonical turn event plus
// the legacy tool.result notification); the second delivery is the same entry.
test('a tool result delivered twice records one entry and leaves the state untouched', () => {
  const first = recorded(undefined, {}, 'call_1');
  const again = records.recordSuggestion(first.state, {
    metadata: metadata(), toolCallId: 'call_1', turnId: 'turn_1', now: '2026-10-05T10:00:01.000Z', createId,
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.revised, false);
  assert.equal(again.entry, first.entry);
  assert.equal(again.state, first.state, 'the same state object: nothing to persist');
  assert.equal(first.state.entries.length, 1);
  // A different call in the same turn is a new suggestion.
  const second = records.recordSuggestion(first.state, {
    metadata: metadata({ title: 'Another change' }), toolCallId: 'call_2', turnId: 'turn_1', createId,
  });
  assert.equal(second.duplicate, undefined);
  assert.equal(second.state.entries.length, 2);
  // A revise delivered twice bumps the revision once.
  const revised = records.recordSuggestion(second.state, {
    metadata: metadata({ title: 'Revised', revises: first.entry.id }), toolCallId: 'call_3', turnId: 'turn_2', createId,
  });
  assert.equal(revised.entry.revision, 2);
  const revisedAgain = records.recordSuggestion(revised.state, {
    metadata: metadata({ title: 'Revised', revises: first.entry.id }), toolCallId: 'call_3', turnId: 'turn_2', createId,
  });
  assert.equal(revisedAgain.duplicate, true);
  assert.equal(revisedAgain.entry.revision, 2);
  assert.equal(revisedAgain.state, revised.state);
});
