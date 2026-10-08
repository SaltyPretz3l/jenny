'use strict';

/* Suggested changes W3 (row 35; UI spec §4.2): groups apply as one unit once
 * every member is accepted, dependencies apply first, reject never cascades,
 * and a moved change is re-anchored for fresh consent. Records plus service. */

const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../services/backend/suggested-changes-records');
const { SuggestedChangesService, buildRevisionDigest } = require('../services/backend/suggested-changes-service');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function memoryStore() {
  let record = records.emptySuggestedChanges();
  return {
    getSession: (id) => (id === 'sess_1' ? JSON.parse(JSON.stringify({ id, suggested_changes: record })) : null),
    _updateSessionRecord: (id, patch) => {
      record = JSON.parse(JSON.stringify(patch.suggested_changes));
      return { id };
    },
  };
}

function makeService(applyRequest = null) {
  const store = memoryStore();
  let tick = 0;
  const calls = [];
  const service = new SuggestedChangesService({
    getStore: () => store,
    projectAuthority: { captureSession: () => ({ root_path: 'C:/ws', device_id: '1', inode: '2' }) },
    applyRequest: async (request) => {
      calls.push(request);
      return applyRequest ? applyRequest(request) : appliedAll(request);
    },
    now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)).toISOString(),
  });
  return { service, calls };
}

function appliedAll({ items }) {
  return {
    schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
    items: items.map((item) => ({ suggestion_id: item.suggestion_id, outcome: 'applied', after_hash: HASH_C, diff: null })),
  };
}

function propose(service, callId, overrides = {}) {
  return service.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId, turnId: 'turn_1',
    result: {
      isError: false,
      metadata: {
        suggested_change: {
          schema_version: 1, path: `src/${callId}.js`, kind: 'replace', old_string: 'one', new_string: 'two',
          title: callId, what: 'w', why: 'y', watch_for: '', revises: null, base_hash: HASH_A, diff: null, ...overrides,
        },
      },
    },
  });
}

const entries = (service) => service.list('sess_1').entries;
const statusOf = (service) => Object.fromEntries(entries(service).map((item) => [item.title, item.status]));
const accept = (service, entry, extra = {}) => service.accept({ sessionId: 'sess_1', id: entry.id, revision: entry.revision, ...extra });

test('a group applies as one change set once every member is accepted', async () => {
  const { service, calls } = makeService();
  const a = propose(service, 'a', { group: 'rename' });
  const b = propose(service, 'b', { group: 'rename' });
  const solo = propose(service, 'solo');
  assert.equal(a.group_id, 'grp:turn_1:rename');
  assert.equal(b.group_id, a.group_id);
  assert.equal(solo.group_id, null);

  const first = await accept(service, b);
  assert.deepEqual(first, { ok: true, status: 'accepted', outcome: 'accepted', waiting: 1 });
  assert.equal(calls.length, 0, 'nothing is written until the whole group is accepted');
  assert.equal(statusOf(service).b, 'accepted');

  const last = await accept(service, a);
  assert.equal(last.ok, true);
  assert.deepEqual(last.applied_ids, [a.id, b.id]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map((item) => item.suggestion_id), [a.id, b.id], 'record order');
  assert.deepEqual(statusOf(service), { a: 'applied', b: 'applied', solo: 'to_review' });
  assert.equal(entries(service)[0].applied.before_hash, HASH_A);
});

test('a group refused by one member re-anchors that member and keeps the others accepted', async () => {
  const { service } = makeService(({ items }) => ({
    schema_version: 1, status: 'refused', workspace_change_set: null,
    items: items.map((item, index) => (index === 1
      ? { suggestion_id: item.suggestion_id, outcome: 'moved', reason: 'hash_changed', base_hash: HASH_B }
      : { suggestion_id: item.suggestion_id, outcome: 'refused', reason: 'group_refused' })),
  }));
  const a = propose(service, 'a', { group: 'g' });
  const b = propose(service, 'b', { group: 'g' });
  await accept(service, a);
  const result = await accept(service, b);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'moved');
  assert.equal(result.suggestion_id, b.id);
  const [storedA, storedB] = entries(service);
  assert.equal(storedA.status, 'accepted');
  assert.equal(storedB.status, 'to_review');
  assert.equal(storedB.revision, 2);
  assert.equal(storedB.reanchored, true, 'the bar says the change was moved onto the current file');
  assert.equal(storedB.expected_hash, HASH_B);
});

test('a revision clears the re-anchored flag and keeps the group unless a new one is named', () => {
  let state = records.emptySuggestedChanges();
  const meta = (extra) => ({ schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'one', new_string: 'two', base_hash: HASH_A, ...extra });
  const made = records.recordSuggestion(state, { metadata: meta({ group: 'g' }), toolCallId: 'c1', turnId: 't1' });
  state = { ...made.state, entries: made.state.entries.map((item) => ({ ...item, reanchored: true })) };
  const revised = records.recordSuggestion(state, { metadata: meta({ revises: made.entry.id, new_string: 'three' }), toolCallId: 'c2', turnId: 't2' });
  assert.equal(revised.entry.reanchored, false);
  assert.equal(revised.entry.group_id, 'grp:t1:g');
  const moved = records.recordSuggestion(revised.state, { metadata: meta({ revises: made.entry.id, group: 'h' }), toolCallId: 'c3', turnId: 't3' });
  assert.equal(moved.entry.group_id, 'grp:t3:h');
});

test('dependencies apply first; derived and declared ones are recorded with their kind', async () => {
  const { service, calls } = makeService();
  const helper = propose(service, 'helper', {
    path: 'src/util/dates.py', kind: 'create', old_string: '', base_hash: null, new_string: 'def parse_day(t):\n    return t\n',
  });
  const user = propose(service, 'user', {
    path: 'src/app.py', old_string: 'import os', new_string: 'import os\nfrom .util.dates import parse_day',
  });
  const declared = propose(service, 'declared', { depends_on: ['call_unknown', 'user'] });
  assert.deepEqual(user.relations, [{ id: helper.id, kind: 'import', name: 'dates.py' }]);
  assert.deepEqual(user.depends_on, [helper.id]);
  assert.deepEqual(declared.relations, [{ id: user.id, kind: 'declared', name: '' }], 'same-turn tool call ids resolve; unknown ids drop');

  const blocked = await accept(service, user);
  assert.deepEqual(blocked, { ok: false, error: 'dependency_pending', depends_on: [helper.id] });
  assert.equal(calls.length, 0);
  assert.equal((await accept(service, helper)).ok, true);
  assert.equal((await accept(service, user)).ok, true);
});

test('reject never cascades: dependents need attention, Apply anyway needs a confirm, restore releases them', async () => {
  const { service } = makeService();
  const base = propose(service, 'base', { group: 'g' });
  const partner = propose(service, 'partner', { group: 'g' });
  const dependent = propose(service, 'dependent', { depends_on: ['base'] });
  await accept(service, partner);

  assert.equal(service.decide({ sessionId: 'sess_1', id: base.id, decision: 'reject' }).ok, true);
  const stored = Object.fromEntries(entries(service).map((item) => [item.title, item]));
  assert.equal(stored.dependent.status, 'needs_attention');
  assert.equal(stored.partner.status, 'to_review', 'consent for the group is asked again');
  assert.equal(stored.partner.group_id, null, 'a group of one dissolves');
  assert.equal(stored.base.group_id, null);

  const digest = buildRevisionDigest(records.normalizeSuggestedChanges(service._read('sess_1')), []);
  assert.match(digest, /Needs attention \(depends on a rejected change\):\n- .*dependent/);

  assert.equal((await accept(service, dependent)).error, 'needs_confirmation');
  assert.equal(service.decide({ sessionId: 'sess_1', id: base.id, decision: 'restore' }).ok, true);
  assert.equal(statusOf(service).dependent, 'to_review');

  service.decide({ sessionId: 'sess_1', id: base.id, decision: 'reject' });
  const forced = await accept(service, dependent, { force: true });
  assert.equal(forced.ok, true, 'Apply anyway applies without the rejected change');
});

test('Ungroup takes one change out; Later withdraws an early accept', async () => {
  const { service } = makeService();
  const a = propose(service, 'a', { group: 'g' });
  const b = propose(service, 'b', { group: 'g' });
  const c = propose(service, 'c', { group: 'g' });
  await accept(service, a);
  assert.equal(service.decide({ sessionId: 'sess_1', id: a.id, decision: 'later' }).ok, true);
  assert.equal(statusOf(service).a, 'later');
  const ungrouped = service.decide({ sessionId: 'sess_1', id: c.id, decision: 'ungroup' });
  assert.equal(ungrouped.ok, true);
  assert.equal(ungrouped.entry.group_id, null);
  assert.deepEqual(entries(service).map((item) => item.group_id), [a.group_id, b.group_id, null]);
  assert.equal(service.decide({ sessionId: 'sess_1', id: c.id, decision: 'ungroup' }).error, 'invalid_transition');
});

test('relations survive normalization and junk relations are dropped', () => {
  const state = records.normalizeSuggestedChanges({
    schema_version: 1, seq: 1, file_heads: {},
    entries: [{
      id: 'sc_1', path: 'a.js', kind: 'create', new_string: 'x', reanchored: true,
      relations: [{ id: 'sc_0', kind: 'import', name: 'b.js' }, { id: 'sc_0', kind: 'defines' }, { id: 'bad id', kind: 'import' }, { id: 'sc_2', kind: 'guess' }],
      applied: null,
    }],
  });
  assert.deepEqual(state.entries[0].relations, [{ id: 'sc_0', kind: 'import', name: 'b.js' }]);
  assert.equal(state.entries[0].reanchored, true);
});

test('the sidecar’s import facts are kept, bounded and checked', () => {
  const recorded = records.recordSuggestion(records.emptySuggestedChanges(), {
    metadata: {
      schema_version: 1, path: 'src/app.py', kind: 'replace', old_string: 'one', new_string: 'two', base_hash: HASH_A,
      facts: [
        { kind: 'import_missing', name: '.util.money', target: 'src/util/money' },
        { kind: 'import_removed', name: '.legacy' },
        { kind: 'guess', name: 'x' },
        { kind: 'import_missing', name: '' },
      ],
    },
    toolCallId: 'c1', turnId: 't1',
  });
  assert.deepEqual(recorded.entry.facts, [
    { kind: 'import_missing', name: '.util.money', target: 'src/util/money' },
    { kind: 'import_removed', name: '.legacy', target: '' },
  ]);
});

test('a rejected dependency asks first whatever the dependent’s status', async () => {
  const { service, calls } = makeService();
  const base = propose(service, 'base');
  const dependent = propose(service, 'dependent', { depends_on: ['base'] });
  service.decide({ sessionId: 'sess_1', id: base.id, decision: 'reject' });
  assert.equal(service.decide({ sessionId: 'sess_1', id: dependent.id, decision: 'later' }).ok, true);
  assert.equal((await accept(service, dependent)).error, 'needs_confirmation', 'Later does not drop the confirm');
  assert.equal(service.decide({ sessionId: 'sess_1', id: dependent.id, decision: 'restore' }).ok, true);
  assert.equal((await accept(service, dependent)).error, 'needs_confirmation', 'nor does Restore');

  const late = propose(service, 'late', { depends_on: [base.id] });
  assert.equal(late.status, 'needs_attention', 'a new change declared on a rejected one starts on hold');
  assert.equal((await accept(service, late)).error, 'needs_confirmation');
  assert.equal(calls.length, 0);
  assert.equal((await accept(service, late, { force: true })).ok, true);
});

test('a member revised into another group leaves the old one', () => {
  let state = records.emptySuggestedChanges();
  const meta = (extra) => ({ schema_version: 1, path: `src/${extra.p}.js`, kind: 'replace', old_string: 'one', new_string: 'two', base_hash: HASH_A, ...extra });
  const a = records.recordSuggestion(state, { metadata: meta({ p: 'a', group: 'g' }), toolCallId: 'a', turnId: 't1' });
  const b = records.recordSuggestion(a.state, { metadata: meta({ p: 'b', group: 'g' }), toolCallId: 'b', turnId: 't1' });
  state = { ...b.state, entries: b.state.entries.map((item) => (item.id === a.entry.id ? { ...item, status: 'accepted' } : item)) };
  const moved = records.recordSuggestion(state, { metadata: meta({ p: 'b', group: 'h', revises: b.entry.id }), toolCallId: 'b2', turnId: 't2' });
  const stored = Object.fromEntries(moved.state.entries.map((item) => [item.id, item]));
  assert.equal(stored[b.entry.id].group_id, 'grp:t2:h');
  assert.equal(stored[a.entry.id].status, 'to_review', 'the accepted member no longer waits for a member that left');
  assert.equal(stored[a.entry.id].group_id, null, 'and its group of one dissolves');
});

test('a revision cannot declare a dependency that closes a cycle', () => {
  const meta = (extra) => ({ schema_version: 1, path: `src/${extra.p}.js`, kind: 'replace', old_string: 'one', new_string: 'two', base_hash: HASH_A, ...extra });
  const a = records.recordSuggestion(records.emptySuggestedChanges(), { metadata: meta({ p: 'a' }), toolCallId: 'a', turnId: 't1' });
  const b = records.recordSuggestion(a.state, { metadata: meta({ p: 'b', depends_on: [a.entry.id] }), toolCallId: 'b', turnId: 't1' });
  const c = records.recordSuggestion(b.state, { metadata: meta({ p: 'c', depends_on: [b.entry.id] }), toolCallId: 'c', turnId: 't1' });
  const revised = records.recordSuggestion(c.state, { metadata: meta({ p: 'a', revises: a.entry.id, depends_on: [c.entry.id] }), toolCallId: 'a2', turnId: 't2' });
  assert.deepEqual(revised.entry.depends_on, [], 'a -> c -> b -> a is refused');
  assert.deepEqual(revised.entry.relations, []);
});

test('a read never saves the revising recovery; a mutation does', () => {
  const store = memoryStore();
  let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  const service = new SuggestedChangesService({ getStore: () => store, now: () => new Date(clock).toISOString() });
  const entry = propose(service, 'a');
  service.comment({ sessionId: 'sess_1', id: entry.id, text: 'smaller' });
  assert.equal(service.sendComments({ sessionId: 'sess_1' }).ok, true);
  clock += 60000;
  assert.equal(service.list('sess_1', { persist: false }).entries[0].status, 'to_review');
  assert.equal(service._read('sess_1').entries[0].status, 'revising', 'nothing was written');
  service.releaseFinishedRevisions('sess_1');
  assert.equal(service._read('sess_1').entries[0].status, 'to_review');
});
