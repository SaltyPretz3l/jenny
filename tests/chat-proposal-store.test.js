'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');

const NOW = new Date('2026-10-15T10:00:00.000Z');
const DECISION = '11111111-1111-4111-8111-111111111111';

function tempProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-proposal-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openStore(root) {
  return new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
}

function makeRecord(n, kind = 'git', now = NOW) {
  const binding = {
    source_project_id: null, workspace_id: 'root_1', root_identity: { root_id: 'root_1', device_id: '1', inode: '2' },
    authority_revision: 1, run_mode: 'agent', restrictions: { read_only: false, plan_mode: false },
    model: null, effort: null, git: null, command: null,
  };
  let input;
  if (kind === 'session') {
    input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build' }).value;
    binding.workspace_id = null;
    binding.root_identity = null;
    binding.session = {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false,
    };
  } else if (kind === 'git') {
    input = R.normalizeGitProposalInput({ summary: 'S', question: 'Q', paths: ['a.js'] }).value;
    binding.git = {
      ref: null, head: null, fingerprint: 'a'.repeat(64),
      paths: [{
        path: 'a.js', orig_path: null, index_status: '?', worktree_status: '?',
        head_oid: null, index_oid: null, worktree_oid: 'c'.repeat(40), worktree_kind: 'file',
      }],
    };
  } else {
    input = R.normalizeCommandProposalInput({ command: 'ls', cwd: '.', purpose: 'p' }).value;
    binding.command = { backend: 'native', shell: '/bin/sh', cwd: '.', command_sha256: R.sha256Hex('ls') };
  }
  const made = R.createProposalRecord({
    kind, sessionId: 'sess_a', sessionIncarnation: 'inc_a', turnId: `turn_${n}`, toolCallId: `call_${n}`, input, binding, now,
    options: kind === 'session' ? S.defaultOptions({ sourceProjectId: 'proj_1' }) : undefined,
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

// A store double with the dedicated record writer; `failFlush` models a disk error.
function createFakeStore(initial, { failFlush = false, failWrite = false, newerSchema = false, sessions } = {}) {
  const records = new Map(Object.entries(sessions || { sess_a: initial }));
  const calls = [];
  for (const [key, value] of records) records.set(key, structuredClone(value));
  return {
    calls,
    records,
    peekSession: (id) => records.get(id) || null,
    getSessionIds: () => [...records.keys()],
    hasNewerSchema: () => newerSchema,
    _updateSessionRecord(id, patch, options) {
      calls.push({ op: 'update', id, patch: structuredClone(patch), options });
      if (failWrite || !records.has(id)) return null;
      records.set(id, { ...records.get(id), ...structuredClone(patch) });
      return { id };
    },
    flushSession(id) {
      calls.push({ op: 'flush', id });
      return !failFlush;
    },
  };
}

const base = (extra = {}) => ({
  session_incarnation: 'inc_a',
  coordination_revision: 4,
  chat_proposals: { schema_version: 1, records: [], launch_grants: [] },
  ...extra,
});

test('read reports a missing session and the empty default', () => {
  const store = createChatProposalStore(createFakeStore(base()));
  assert.deepEqual(store.read('sess_missing'), { ok: false, reason: 'not_found' });
  assert.deepEqual(store.read(''), { ok: false, reason: 'not_found' });
  assert.deepEqual(store.read('sess_a'), {
    ok: true, session_incarnation: 'inc_a', coordination_revision: 4, records: [], launch_grants: [], coordination_receipts: [], frozen: false,
  });
  assert.deepEqual(createChatProposalStore(createFakeStore({ session_incarnation: 'i' })).read('sess_a').records, []);
});

test('mutate writes records and coordination_revision+1 in ONE update, then flushes', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  const record = makeRecord(1);
  const result = store.mutate('sess_a', (draft) => {
    assert.deepEqual(draft, { records: [], launch_grants: [], coordination_receipts: [], coordination_revision: 4 });
    return { records: [record] };
  });
  assert.deepEqual(result, { ok: true, records: [record], coordination_revision: 5 });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].op, 'update');
  assert.deepEqual(fake.calls[0].options, { bumpUpdatedAt: false });
  assert.deepEqual(Object.keys(fake.calls[0].patch).sort(), ['chat_proposals', 'coordination_revision']);
  assert.equal(fake.calls[0].patch.coordination_revision, 5);
  assert.deepEqual(fake.calls[0].patch.chat_proposals, { schema_version: 1, records: [record], launch_grants: [] });
  assert.deepEqual(fake.calls[1], { op: 'flush', id: 'sess_a' });
  const read = store.read('sess_a');
  assert.deepEqual(read.records, [record]);
  assert.equal(read.coordination_revision, 5);
});

test('mutate hands the callback a deep copy: mutating it does not touch the store', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  store.mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  const result = store.mutate('sess_a', (draft) => {
    draft.records[0].normalized_input.summary = 'tampered';
    draft.records.length = 0;
    return { abort: 'nothing' };
  });
  assert.deepEqual(result, { ok: true, aborted: true, value: 'nothing' });
  assert.equal(store.read('sess_a').records[0].normalized_input.summary, 'S');
  assert.equal(fake.records.get('sess_a').coordination_revision, 5, 'abort does not write');
});

test('an unchanged result writes nothing and keeps the revision', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  store.mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  fake.calls.length = 0;
  const result = store.mutate('sess_a', (draft) => ({ records: draft.records }));
  assert.equal(result.ok, true);
  assert.equal(result.coordination_revision, 5);
  assert.equal(fake.calls.length, 0);
});

test('transitions persist through the state machine and bump the revision once per mutation', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  const record = makeRecord(1);
  store.mutate('sess_a', () => ({ records: [record] }));
  const accepted = store.mutate('sess_a', ({ records }) => ({
    records: [R.acceptGitDecision(records[0], { decisionId: DECISION, choice: 'commit', now: NOW })],
  }));
  assert.equal(accepted.coordination_revision, 6);
  assert.equal(accepted.records[0].action_state, 'queued');
  assert.equal(accepted.records[0].revision, 2);
  assert.equal(store.read('sess_a').records[0].dispatch_key_sha256, accepted.records[0].dispatch_key_sha256);
});

test('a flush failure rolls back memory with persist:false and reports io_failed at the old revision', () => {
  const fake = createFakeStore(base(), { failFlush: true });
  const store = createChatProposalStore(fake);
  const result = store.mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  assert.deepEqual(result, { ok: false, reason: 'io_failed', retryable: true, current_revision: 4 });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls[2].options, { bumpUpdatedAt: false, persist: false });
  assert.equal(fake.calls[2].patch.coordination_revision, 4);
  assert.deepEqual(fake.calls[2].patch.chat_proposals.records, []);
  const read = store.read('sess_a');
  assert.equal(read.coordination_revision, 4);
  assert.deepEqual(read.records, []);
});

test('a refused write reports io_failed, or unavailable on a newer-schema store, without a rollback write', () => {
  const failing = createFakeStore(base(), { failWrite: true });
  assert.deepEqual(
    createChatProposalStore(failing).mutate('sess_a', () => ({ records: [makeRecord(1)] })),
    { ok: false, reason: 'io_failed', retryable: true, current_revision: 4 },
  );
  assert.equal(failing.calls.length, 1);
  const newer = createFakeStore(base(), { newerSchema: true });
  assert.deepEqual(
    createChatProposalStore(newer).mutate('sess_a', () => ({ records: [makeRecord(1)] })),
    { ok: false, reason: 'unavailable', retryable: false, current_revision: 4 },
  );
  assert.equal(newer.calls.length, 0);
  const throwing = createFakeStore(base());
  throwing.flushSession = () => { throw new Error('disk'); };
  const result = createChatProposalStore(throwing).mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  assert.equal(result.reason, 'io_failed');
});

test('a frozen future-schema container is readable as empty, never written', () => {
  const future = { schema_version: 2, records: [{ anything: true }], launch_grants: [], extra: 1 };
  const fake = createFakeStore(base({ chat_proposals: future }));
  const store = createChatProposalStore(fake);
  const read = store.read('sess_a');
  assert.equal(read.frozen, true);
  assert.deepEqual(read.records, []);
  let called = false;
  const result = store.mutate('sess_a', () => { called = true; return { records: [makeRecord(1)] }; });
  assert.deepEqual(result, { ok: false, reason: 'unavailable', retryable: false, current_revision: 4 });
  assert.equal(called, false);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fake.records.get('sess_a').chat_proposals, future);
});

test('unreadable entries are dropped from reads but preserved verbatim on every write', () => {
  const valid = makeRecord(1);
  const futureEntry = { schema_version: 2, proposal_id: 'proposal_future', payload: { keep: 'me' } };
  const relabelled = { ...makeRecord(2), kind: 'session' };
  const duplicate = structuredClone(valid);
  const fake = createFakeStore(base({
    chat_proposals: { schema_version: 1, records: [futureEntry, valid, relabelled, duplicate], launch_grants: [] },
  }));
  const store = createChatProposalStore(fake);
  assert.deepEqual(store.read('sess_a').records, [valid]);
  const result = store.mutate('sess_a', ({ records }) => ({
    records: [...records, makeRecord(3)],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);
  const stored = fake.records.get('sess_a').chat_proposals.records;
  assert.equal(stored.length, 5);
  assert.deepEqual(stored.slice(2), [futureEntry, relabelled, duplicate], 'opaque entries are kept as stored');
  assert.deepEqual(store.read('sess_a').records.map((r) => r.proposal_id), [valid.proposal_id, makeRecord(3).proposal_id]);
});

test('a session-kind record is a readable record and round-trips through the store', () => {
  const record = makeRecord(1, 'session');
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  const result = store.mutate('sess_a', () => ({ records: [record] }));
  assert.equal(result.ok, true);
  assert.deepEqual(store.read('sess_a').records, [record]);
  assert.equal(R.isUnresolved(store.read('sess_a').records[0]), true);
  assert.deepEqual(fake.records.get('sess_a').chat_proposals.records, [record]);
});

const GRANT_REF = '33333333-3333-4333-8333-333333333333';
const GRANT_REF_2 = '55555555-5555-4555-8555-555555555555';

function makeGrant(ref = GRANT_REF, extra = {}) {
  return {
    schema_version: 1, authorization_ref: ref, source_session_incarnation: 'inc_a', source_user_message_id: 'msg_1', source_turn_id: 'turn_1',
    action_id: '44444444-4444-4444-8444-444444444444', destination_project_ids: ['proj_1', null],
    restrictions: { read_only: false, plan_mode: false, lockdown: false },
    created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 3600 * 1000).toISOString(), max_children: 3, remaining: 3, revoked_at: null,
    ...extra,
  };
}

test('valid launch grants are read; invalid and duplicate entries are dropped from reads but kept on every write', () => {
  const grant = makeGrant();
  const bogus = { grant_id: 'g1', remaining: 1 };
  const future = { ...makeGrant(GRANT_REF_2), schema_version: 2 };
  const duplicate = { ...makeGrant(), remaining: 1 };
  const fake = createFakeStore(base({ chat_proposals: { schema_version: 1, records: [], launch_grants: [bogus, grant, future, duplicate] } }));
  const store = createChatProposalStore(fake);
  assert.deepEqual(store.read('sess_a').launch_grants, [grant]);
  const result = store.mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'launch_grants'), false, 'grants are echoed only when the callback wrote them');
  assert.deepEqual(fake.records.get('sess_a').chat_proposals.launch_grants, [grant, bogus, future, duplicate]);
});

test('mutate hands the callback the grants and writes records and grants in the same flushed update', () => {
  const grant = makeGrant();
  const fake = createFakeStore(base({ chat_proposals: { schema_version: 1, records: [], launch_grants: [grant] } }));
  const store = createChatProposalStore(fake);
  const record = makeRecord(1, 'session');
  const result = store.mutate('sess_a', (draft) => {
    assert.deepEqual(draft.launch_grants, [grant]);
    draft.launch_grants[0].remaining = 99; // a copy: the store is untouched until the callback returns it
    return { records: [record], launch_grants: [{ ...grant, remaining: 2 }] };
  });
  assert.deepEqual(result, { ok: true, records: [record], launch_grants: [{ ...grant, remaining: 2 }], coordination_revision: 5 });
  assert.equal(fake.calls.length, 2, 'one update and one flush');
  assert.deepEqual(fake.calls[0].patch.chat_proposals, { schema_version: 1, records: [record], launch_grants: [{ ...grant, remaining: 2 }] });
  assert.equal(fake.calls[0].patch.coordination_revision, 5);
  assert.equal(store.read('sess_a').launch_grants[0].remaining, 2);
});

test('a grant-only change writes; an unchanged grant list is a no-op; a flush failure restores both lists', () => {
  const grant = makeGrant();
  const fake = createFakeStore(base({ chat_proposals: { schema_version: 1, records: [], launch_grants: [grant] } }));
  const store = createChatProposalStore(fake);
  const same = store.mutate('sess_a', () => ({ records: [], launch_grants: [structuredClone(grant)] }));
  assert.deepEqual(same, { ok: true, records: [], launch_grants: [grant], coordination_revision: 4 });
  assert.equal(fake.calls.length, 0, 'no write for an unchanged state');
  const changed = store.mutate('sess_a', () => ({ records: [], launch_grants: [{ ...grant, remaining: 0 }] }));
  assert.equal(changed.coordination_revision, 5);
  assert.equal(fake.calls.length, 2);
  const failing = createFakeStore(base({ chat_proposals: { schema_version: 1, records: [], launch_grants: [grant] } }), { failFlush: true });
  const failed = createChatProposalStore(failing).mutate('sess_a', () => ({ records: [makeRecord(1, 'session')], launch_grants: [] }));
  assert.equal(failed.reason, 'io_failed');
  assert.deepEqual(failing.records.get('sess_a').chat_proposals.launch_grants, [grant], 'memory restored');
  assert.equal(failing.records.get('sess_a').coordination_revision, 4);
});

test('mutate refuses invalid or duplicate grants without writing', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  const run = (launch_grants) => store.mutate('sess_a', () => ({ records: [], launch_grants })).reason;
  assert.equal(run([{ grant_id: 'g1' }]), 'invalid_record');
  assert.equal(run('x'), 'invalid_record');
  assert.equal(run([makeGrant(), makeGrant()]), 'invalid_record');
  assert.equal(run([makeGrant(GRANT_REF, { remaining: 4 })]), 'invalid_record');
  assert.equal(fake.calls.length, 0);
});

test('mutate rejects invalid callback results without writing', () => {
  const fake = createFakeStore(base());
  const store = createChatProposalStore(fake);
  assert.equal(store.mutate('sess_missing', () => ({ records: [] })).reason, 'not_found');
  assert.equal(store.mutate('sess_a', () => undefined).reason, 'invalid_request');
  assert.equal(store.mutate('sess_a', () => ({ records: 'x' })).reason, 'invalid_request');
  const broken = { ...makeRecord(1), revision: 0 };
  assert.equal(store.mutate('sess_a', () => ({ records: [broken] })).reason, 'invalid_record');
  const a = makeRecord(2);
  assert.equal(store.mutate('sess_a', () => ({ records: [a, a] })).reason, 'invalid_record', 'duplicate ids refused');
  assert.equal(fake.calls.length, 0);
});

test('a revision at the safe-integer ceiling is unavailable', () => {
  const fake = createFakeStore(base({ coordination_revision: Number.MAX_SAFE_INTEGER }));
  const result = createChatProposalStore(fake).mutate('sess_a', () => ({ records: [makeRecord(1)] }));
  assert.equal(result.reason, 'unavailable');
});

test('countUnresolvedAcrossProfile counts pending and unsettled-accepted across sessions', () => {
  const pending = makeRecord(1);
  const queued = R.acceptGitDecision(makeRecord(2), { decisionId: DECISION, choice: 'commit', now: NOW });
  const succeeded = R.markContinuationOutcome(queued, 'succeeded');
  const dismissed = R.dismissProposal(makeRecord(3), { decisionId: DECISION, now: NOW });
  const sessionWith = (records, extra = {}) => base({ chat_proposals: { schema_version: 1, records, launch_grants: [] }, ...extra });
  const fake = createFakeStore(null, {
    sessions: {
      s1: sessionWith([pending, queued]),
      s2: sessionWith([succeeded, dismissed, makeRecord(4, 'command')]),
      s3: sessionWith([], {}),
      s4: base({ chat_proposals: { schema_version: 3, records: [makeRecord(5)], launch_grants: [] } }),
    },
  });
  assert.equal(createChatProposalStore(fake).countUnresolvedAcrossProfile(), 3);
  const viaList = createChatProposalStore({ ...fake, getSessionIds: undefined, listSessions: () => [{ id: 's1' }] });
  assert.equal(viaList.countUnresolvedAcrossProfile(), 2);
  assert.equal(createChatProposalStore({}).countUnresolvedAcrossProfile(), 0);
});

test('real ElectronSessionStore: write is durable, flushed, does not bump recency and survives a reopen', (t) => {
  const root = tempProfile(t);
  const sessions = openStore(root);
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Proposals' });
  const updatedBefore = sessions.getSession(created.id).updated_at;
  const flushed = [];
  const realFlush = sessions.flushSession.bind(sessions);
  sessions.flushSession = (id) => { flushed.push(id); return realFlush(id); };
  const store = createChatProposalStore(sessions);

  const read = store.read(created.id);
  assert.equal(read.ok, true);
  assert.match(read.session_incarnation, /^inc_/);
  assert.equal(read.coordination_revision, 0);

  const record = makeRecord(1);
  const written = store.mutate(created.id, () => ({ records: [record] }));
  assert.deepEqual(written, { ok: true, records: [record], coordination_revision: 1 });
  const accepted = store.mutate(created.id, ({ records }) => ({
    records: [R.acceptGitDecision(records[0], { decisionId: DECISION, choice: 'test_first', now: NOW })],
  }));
  assert.equal(accepted.coordination_revision, 2);
  assert.deepEqual(flushed, [created.id, created.id]);
  assert.equal(sessions.getSession(created.id).updated_at, updatedBefore);
  assert.equal(store.countUnresolvedAcrossProfile(), 1);

  const reopened = openStore(root);
  t.after(() => reopened.dispose());
  const persisted = reopened.getSession(created.id);
  assert.equal(persisted.coordination_revision, 2);
  assert.equal(persisted.chat_proposals.records.length, 1);
  assert.deepEqual(createChatProposalStore(reopened).read(created.id).records, accepted.records);
  assert.equal(createChatProposalStore(reopened).countUnresolvedAcrossProfile(), 1);
});

test('real ElectronSessionStore: a failed flush leaves the in-memory record at the old revision', (t) => {
  const sessions = openStore(tempProfile(t));
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Rollback' });
  sessions.flushSession = () => false;
  const store = createChatProposalStore(sessions);
  const result = store.mutate(created.id, () => ({ records: [makeRecord(1)] }));
  assert.deepEqual(result, { ok: false, reason: 'io_failed', retryable: true, current_revision: 0 });
  const read = store.read(created.id);
  assert.equal(read.coordination_revision, 0);
  assert.deepEqual(read.records, []);
});

test('real ElectronSessionStore: generic session patches cannot reach chat_proposals', (t) => {
  const sessions = openStore(tempProfile(t));
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Guard' });
  const store = createChatProposalStore(sessions);
  store.mutate(created.id, () => ({ records: [makeRecord(1)] }));
  sessions.updateSession?.(created.id, { chat_proposals: { schema_version: 1, records: [], launch_grants: [] }, coordination_revision: 99 });
  const read = store.read(created.id);
  assert.equal(read.records.length, 1);
  assert.equal(read.coordination_revision, 1);
});
