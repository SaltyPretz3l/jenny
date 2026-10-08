'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SuggestedChangesService, buildRevisionDigest } = require('../services/backend/suggested-changes-service');
const records = require('../services/backend/suggested-changes-records');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

// Models only the two store methods the seam uses (getSession, _updateSessionRecord).
function fakeStore() {
  const sessions = new Map([['sess_1', { id: 'sess_1', suggested_changes: records.emptySuggestedChanges() }]]);
  return {
    sessions,
    writes: 0,
    getSession(id) {
      const session = sessions.get(id);
      return session ? JSON.parse(JSON.stringify(session)) : null;
    },
    _updateSessionRecord(id, patch, options) {
      assert.deepEqual(Object.keys(patch), ['suggested_changes']);
      assert.equal(options.bumpUpdatedAt, false);
      const session = sessions.get(id);
      if (!session) return null;
      sessions.set(id, { ...session, ...JSON.parse(JSON.stringify(patch)) });
      this.writes += 1;
      return { id };
    },
  };
}

function suggestionMetadata(overrides = {}) {
  return {
    suggested_change: {
      schema_version: 1, path: 'src/a.js', kind: 'replace', old_string: 'one', new_string: 'two',
      title: 'Use two', what: 'It says two.', why: 'Asked.', watch_for: '', revises: null,
      base_hash: HASH_A, diff: null, ...overrides,
    },
  };
}

function makeService({ applyRequest = null, authority = { root_path: 'C:/ws', device_id: '1', inode: '2' } } = {}) {
  const store = fakeStore();
  const events = [];
  let tick = 0;
  const service = new SuggestedChangesService({
    getStore: () => store,
    projectAuthority: { captureSession: () => authority },
    applyRequest,
    emit: (event) => events.push(event),
    now: () => new Date(Date.UTC(2026, 9, 5, 12, 0, tick++)).toISOString(),
  });
  return { service, store, events };
}

function capture(service, overrides = {}, callId = 'call_1') {
  return service.recordToolOutcome({
    toolName: 'propose_change', sessionId: 'sess_1', callId, turnId: 'turn_1',
    result: { isError: false, metadata: suggestionMetadata(overrides) },
  });
}

test('captures only successful propose_change results', () => {
  const { service, events } = makeService();
  assert.equal(service.recordToolOutcome({ toolName: 'edit_file', sessionId: 'sess_1', result: { metadata: suggestionMetadata() } }), null);
  assert.equal(service.recordToolOutcome({ toolName: 'propose_change', sessionId: 'sess_1', result: { isError: true, metadata: suggestionMetadata() } }), null);
  assert.equal(service.recordToolOutcome({ toolName: 'propose_change', sessionId: 'sess_missing', result: { metadata: suggestionMetadata() } }), null);
  const entry = capture(service);
  assert.ok(entry.id.startsWith('sc_'));
  const view = service.list('sess_1');
  assert.equal(view.pending_count, 1);
  assert.equal(view.entries[0].expected_hash, HASH_A);
  assert.deepEqual(events, [{ session_id: 'sess_1', pending_count: 1 }]);
  assert.deepEqual(service.liveContext('sess_1').live.map((item) => item.id), [entry.id]);
});

test('decide and comment write through the store and refuse invalid input', () => {
  const { service } = makeService();
  const entry = capture(service);
  assert.equal(service.decide({ sessionId: 'sess_1', id: entry.id, decision: 'later' }).ok, true);
  assert.equal(service.decide({ sessionId: 'sess_1', id: entry.id, decision: 'later' }).error, 'invalid_transition');
  assert.equal(service.decide({ sessionId: 'sess_x', id: entry.id, decision: 'reject' }).error, 'not_found');
  assert.equal(service.comment({ sessionId: 'sess_1', id: entry.id, text: 'Make it three' }).ok, true);
  assert.equal(service.list('sess_1').unsent_comment_count, 1);
});

test('sendComments returns one revision digest and marks the changes revising', () => {
  const { service } = makeService();
  const first = capture(service);
  const second = capture(service, { path: 'src/b.js', old_string: 'x', title: 'Other change' }, 'call_2');
  const third = capture(service, { path: 'src/c.js', old_string: 'y', title: 'Rejected change' }, 'call_3');
  service.decide({ sessionId: 'sess_1', id: third.id, decision: 'reject' });
  service.comment({ sessionId: 'sess_1', id: first.id, text: 'Make it three' });
  const sent = service.sendComments({ sessionId: 'sess_1' });
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.ids, [first.id]);
  assert.match(sent.message, new RegExp(`## ${first.id}: Use two`));
  assert.match(sent.message, /Original old_string:\n```\none\n```/);
  assert.match(sent.message, /Comment: Make it three/);
  assert.match(sent.message, new RegExp(`Rejected \\(do not suggest again\\):\\n- ${third.id}`));
  assert.match(sent.message, new RegExp(`Still pending \\(do not re-send\\):\\n- ${second.id}`));
  assert.doesNotMatch(sent.message, /Applied \(already in the files\)/);
  assert.equal(service.list('sess_1').entries.find((e) => e.id === first.id).status, 'revising');
  assert.equal(service.sendComments({ sessionId: 'sess_1' }).error, 'nothing_to_send');
});

test('the digest fences old text that itself contains a code fence', () => {
  let state = records.emptySuggestedChanges();
  state = records.recordSuggestion(state, { metadata: suggestionMetadata({ old_string: 'a\n```\nb' }).suggested_change }).state;
  state = records.addComment(state, { id: state.entries[0].id, text: 'hm' }).state;
  const digest = buildRevisionDigest(state, records.unsentComments(state));
  assert.match(digest, /~~~~\na\n```\nb\n~~~~/);
});

test('discardPending rejects everything still pending and applies nothing', () => {
  const { service } = makeService();
  const a = capture(service);
  const b = capture(service, { path: 'src/b.js', old_string: 'x' }, 'call_2');
  service.decide({ sessionId: 'sess_1', id: b.id, decision: 'later' });
  const result = service.discardPending({ sessionId: 'sess_1' });
  assert.deepEqual(result, { ok: true, discarded: 2 });
  const statuses = service.list('sess_1').entries.map((e) => [e.id, e.status]);
  assert.deepEqual(statuses, [[a.id, 'rejected'], [b.id, 'rejected']]);
  assert.equal(service.pendingCount('sess_1'), 0);
});

test('accept sends the expected hash and records the apply receipt', async () => {
  const calls = [];
  const { service } = makeService({
    applyRequest: async (request) => {
      calls.push(request);
      return {
        schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
        items: [{ suggestion_id: request.items[0].suggestion_id, outcome: 'applied', after_hash: HASH_B, diff: { hunks: [] } }],
      };
    },
  });
  const first = capture(service);
  const second = capture(service, { old_string: 'later text', title: 'Second' }, 'call_2');
  const result = await service.accept({ sessionId: 'sess_1', id: first.id, revision: 1 });
  assert.deepEqual(result, {
    ok: true, status: 'applied', outcome: 'applied', reason: '', suggestion_id: first.id, applied_ids: [first.id], receipt_saved: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'sess_1');
  assert.deepEqual(calls[0].authority, { root_path: 'C:/ws', device_id: '1', inode: '2' });
  assert.deepEqual(calls[0].items, [{
    suggestion_id: first.id, path: 'src/a.js', kind: 'replace', old_string: 'one', new_string: 'two', expected_hash: HASH_A,
  }]);
  const view = service.list('sess_1');
  assert.equal(view.entries[0].status, 'applied');
  assert.equal(view.entries[0].applied.change_set_id, 'cs_1');
  // The next change on the same file now expects the hash the apply left behind.
  assert.equal(view.entries.find((e) => e.id === second.id).expected_hash, HASH_B);
  assert.equal((await service.accept({ sessionId: 'sess_1', id: first.id, revision: 1 })).error, 'invalid_transition');
});

test('accept folds moved and out-of-date outcomes and reports the refusal', async () => {
  let outcome = 'moved';
  const { service } = makeService({
    applyRequest: async ({ items }) => ({
      schema_version: 1, status: 'refused', workspace_change_set: null,
      items: [{ suggestion_id: items[0].suggestion_id, outcome, reason: 'file changed', base_hash: HASH_B }],
    }),
  });
  const entry = capture(service);
  const moved = await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  assert.deepEqual(moved, {
    ok: false, status: 'refused', outcome: 'moved', reason: 'file changed', suggestion_id: entry.id, applied_ids: [], receipt_saved: true,
  });
  const afterMove = service.list('sess_1').entries[0];
  assert.equal(afterMove.revision, 2);
  assert.equal(afterMove.status, 'to_review');
  assert.equal(afterMove.expected_hash, HASH_B);
  outcome = 'out_of_date';
  await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 2 });
  assert.equal(service.list('sess_1').entries[0].status, 'out_of_date');
});

test('accept refuses without a workspace, without the apply seam, and when the sidecar throws', async () => {
  const noRoot = makeService({ applyRequest: async () => ({}), authority: { root_path: null } });
  const a = capture(noRoot.service);
  assert.equal((await noRoot.service.accept({ sessionId: 'sess_1', id: a.id, revision: 1 })).error, 'no_workspace');

  const noSeam = makeService();
  const b = capture(noSeam.service);
  assert.equal((await noSeam.service.accept({ sessionId: 'sess_1', id: b.id, revision: 1 })).error, 'apply_unavailable');

  const throws = makeService({ applyRequest: async () => { throw new Error('sidecar gone'); } });
  const c = capture(throws.service);
  assert.equal((await throws.service.accept({ sessionId: 'sess_1', id: c.id, revision: 1 })).error, 'apply_failed');
  assert.equal(throws.service.list('sess_1').entries[0].status, 'to_review');
});

test('a second accept on the same file waits its turn', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = makeService({
    applyRequest: async ({ items }) => {
      await gate;
      return { schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
        items: [{ suggestion_id: items[0].suggestion_id, outcome: 'applied', after_hash: HASH_B }] };
    },
  });
  const first = capture(service);
  const second = capture(service, { old_string: 'other' }, 'call_2');
  const pending = service.accept({ sessionId: 'sess_1', id: first.id, revision: 1 });
  assert.equal((await service.accept({ sessionId: 'sess_1', id: second.id, revision: 1 })).error, 'busy');
  release();
  assert.equal((await pending).ok, true);
});

// Review fixes (Astra W1): decisions wait while a suggestion is being applied,
// a revision captured mid-apply stays up for review, Discard covers revising
// entries, and an unsaved receipt is reported.
function appliedReply(request, hash = HASH_B) {
  return {
    schema_version: 1, status: 'applied', workspace_change_set: { change_set_id: 'cs_1' },
    items: [{ suggestion_id: request.items[0].suggestion_id, outcome: 'applied', after_hash: hash, diff: null }],
  };
}

test('reject and discard wait while the suggestion is being applied', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = makeService({ applyRequest: async (request) => { await gate; return appliedReply(request); } });
  const entry = capture(service);
  const pending = service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  assert.deepEqual(service.decide({ sessionId: 'sess_1', id: entry.id, decision: 'reject' }), { ok: false, error: 'busy' });
  assert.deepEqual(service.discardPending({ sessionId: 'sess_1' }), { ok: true, discarded: 0 });
  release();
  assert.equal((await pending).ok, true);
  assert.equal(service.list('sess_1').entries[0].status, 'applied');
});

test('a revision captured while its earlier revision applies stays up for review', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = makeService({ applyRequest: async (request) => { await gate; return appliedReply(request); } });
  const entry = capture(service);
  const pending = service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  capture(service, { revises: entry.id, new_string: 'three' }, 'call_2');
  release();
  await pending;
  const view = service.list('sess_1');
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].revision, 2);
  assert.equal(view.entries[0].status, 'to_review');
  assert.equal(view.entries[0].new_string, 'three');
  // The disk changed, so the newer revision now expects the applied hash.
  assert.equal(view.entries[0].expected_hash, HASH_B);
});

test('Discard also rejects a suggestion waiting on its revision', () => {
  const { service } = makeService();
  const entry = capture(service);
  service.comment({ sessionId: 'sess_1', id: entry.id, text: 'Make it three' });
  assert.equal(service.sendComments({ sessionId: 'sess_1' }).ok, true);
  assert.equal(service.list('sess_1').entries[0].status, 'revising');
  assert.deepEqual(service.discardPending({ sessionId: 'sess_1' }), { ok: true, discarded: 1 });
  assert.equal(service.list('sess_1').entries[0].status, 'rejected');
});

test('an apply whose receipt cannot be saved says so', async () => {
  const { service, store } = makeService({ applyRequest: async (request) => appliedReply(request) });
  const entry = capture(service);
  store._updateSessionRecord = () => null;
  const result = await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.receipt_saved, false);
});

test('accept refuses a revision the person did not see', async () => {
  const calls = [];
  const { service } = makeService({ applyRequest: async (request) => { calls.push(request); return appliedReply(request); } });
  const entry = capture(service);
  capture(service, { revises: entry.id, new_string: 'three' }, 'call_2');
  assert.deepEqual(await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 1 }), { ok: false, error: 'revision_changed' });
  assert.equal(calls.length, 0);
  assert.equal((await service.accept({ sessionId: 'sess_1', id: entry.id, revision: 2 })).ok, true);
});

test('a revising change returns to review once its run is gone, after the start grace', () => {
  const store = fakeStore();
  let running = false;
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  const service = new SuggestedChangesService({
    getStore: () => store,
    now: () => new Date(clock).toISOString(),
    isSessionRunning: () => running,
  });
  const entry = service.recordToolOutcome({ toolName: 'propose_change', sessionId: 'sess_1', callId: 'call_1', result: { metadata: suggestionMetadata() } });
  service.comment({ sessionId: 'sess_1', id: entry.id, text: 'Shorter' });
  assert.equal(service.sendComments({ sessionId: 'sess_1' }).ok, true);
  assert.equal(service.list('sess_1').entries[0].status, 'revising', 'Send just marked it; its run may not be admitted yet');
  clock += 6000;
  running = true;
  assert.equal(service.list('sess_1').entries[0].status, 'revising', 'the revision run is live');
  running = false;
  assert.equal(service.list('sess_1').entries[0].status, 'to_review');
});

test('accept refuses a call that does not name the revision the person saw', async () => {
  const calls = [];
  const { service } = makeService({ applyRequest: async (request) => { calls.push(request); return null; } });
  const entry = capture(service);
  for (const revision of [undefined, null, '1', 0, 1.5]) {
    assert.deepEqual(await service.accept({ sessionId: 'sess_1', id: entry.id, revision }), { ok: false, error: 'revision_required' });
  }
  assert.equal(calls.length, 0, 'nothing reached the sidecar');
});

test('a digest that could not be sent goes back in the queue', () => {
  const { service } = makeService();
  const entry = capture(service);
  service.comment({ sessionId: 'sess_1', id: entry.id, text: 'Shorter' });
  const sent = service.sendComments({ sessionId: 'sess_1' });
  assert.equal(service.list('sess_1').entries[0].status, 'revising');
  assert.deepEqual(service.sendComments({ sessionId: 'sess_1', undo: { ids: sent.ids, sent_at: sent.sent_at } }), { ok: true, ids: [entry.id] });
  const after = service.list('sess_1');
  assert.equal(after.entries[0].status, 'to_review');
  assert.equal(after.unsent_comment_count, 1);
  assert.equal(service.sendComments({ sessionId: 'sess_1' }).ok, true, 'Send can retry');
});

// Owner dev-profile report (2026-10-05): the same propose_change result reaches
// recordToolOutcome twice (canonical turn event plus the legacy notification).
test('the same propose_change result delivered twice records one suggestion, one write, one event', () => {
  const { service, store, events } = makeService();
  const entry = capture(service);
  const again = capture(service);
  assert.equal(again.id, entry.id);
  assert.equal(store.writes, 1);
  assert.deepEqual(events, [{ session_id: 'sess_1', pending_count: 1 }]);
  assert.equal(service.list('sess_1').entries.length, 1);
  assert.equal(service.pendingCount('sess_1'), 1);
});
