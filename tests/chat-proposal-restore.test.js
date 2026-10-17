'use strict';

/* sessionProposals.confirmRestored (row 59 checkpoint 5b-3, slice H2a). Every case drives the real service to
 * the state a proposal had when an archive was taken, runs the real restore transform over the stored
 * container (the trusted-archive path) and then confirms. The fake runtime plays the durable work store. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { normalizeCoordinationFields } = require('../services/backend/session-coordination-records');
const { transformRestoredCoordination } = require('../services/data-lifecycle/coordination-restore-transform');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');

const DAY = 24 * 60 * 60 * 1000;
const keyOf = (record) => R.runtimeIdempotencyKey(record.dispatch_key_sha256);

// The stored container goes through the trusted restore transform, as a restored profile's would.
function park(fx) {
  fx.service._tracked.clear(); // a restored profile starts a fresh process
  const session = fx.store.getSession(fx.sessionId);
  const out = transformRestoredCoordination(
    { session_incarnation: fx.sessionIncarnation, ...normalizeCoordinationFields(session) },
    { restoredSessionIds: [fx.sessionId], now: new Date(fx.clock.ms) },
  );
  assert.equal(out.quarantined, false, out.reason);
  fx.store._updateSessionRecord(fx.sessionId, {
    chat_proposals: out.record.chat_proposals, coordination_revision: out.record.coordination_revision,
  }, { bumpUpdatedAt: false });
}

function rewrite(fx, proposalId, build) {
  const container = fx.store.getSession(fx.sessionId).chat_proposals;
  const records = container.records.map((record) => (record.proposal_id === proposalId ? build(record) : record));
  fx.store._updateSessionRecord(fx.sessionId, { chat_proposals: { ...container, records } }, { bumpUpdatedAt: false });
}

const confirm = (fx, proposal, extra = {}) => fx.gesture('confirmRestored', proposal, extra);

const CHILD_INC = `inc_${'b'.repeat(32)}`;
const accept = (choice) => (record) => S.acceptSessionDecision(record, {
  decisionId: randomUUID(), choice, now: new Date('2026-10-15T10:00:00.000Z'), attemptId: randomUUID(),
});
const handoff = (record) => S.recordHandoff(record, { task: 'Task', background: 'Back', childSessionId: 'sess_child', childIncarnation: CHILD_INC });

// Publishes a session suggestion and walks it through the given record transitions in one write.
async function stage(fx, n, steps) {
  const { proposal } = await fx.publishSession(n, { initiation: 'own_initiative' });
  const wrote = fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
    records: records.map((entry) => (entry.proposal_id !== proposal.proposal_id ? entry : steps.reduce((current, step) => {
      const next = step(current);
      assert.ok(next, 'staging transition refused');
      return next;
    }, entry))),
  }));
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  return proposal.proposal_id;
}

function addWork(fx, workId, turnId, sessionId, status) {
  fx.runtime.works.set(workId, { work_id: workId, turn_id: turnId, session_id: sessionId, status });
}

async function acceptedGit(fx, { mode = 'ok' } = {}) {
  const { proposal } = await fx.publishGit(1);
  fx.runtime.mode = mode;
  const decided = await fx.decide(proposal, 'commit');
  assert.equal(decided.ok, true, JSON.stringify(decided));
  fx.runtime.mode = 'ok';
  return proposal.proposal_id;
}

async function parkedGit(fx, options) {
  const id = await acceptedGit(fx, options);
  park(fx);
  const proposal = await fx.get(id);
  assert.equal(proposal.action_state, 'needs_attention');
  assert.equal(proposal.last_error.reason, 'restored_confirmation_required');
  return { id, proposal, record: fx.record(id) };
}

const workOf = (fx, record) => fx.runtime.works.get(record.continuation_work_id);

test('a pending Git offer is read-only until confirmed; confirming clears the flag back to pending and starts nothing', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishGit(1);
  assert.equal(proposal.actions.confirm_restored, undefined, 'an ordinary record never offers the confirmation');
  park(fx);
  const parked = await fx.get(proposal.proposal_id);
  assert.equal(parked.decision_state, 'pending');
  assert.deepEqual(parked.actions.commit, { available: false, reason: 'authorization_required' });
  assert.deepEqual(parked.actions.test_first, { available: false, reason: 'authorization_required' });
  assert.equal(parked.actions.dismiss.available, true, 'Dismiss is never held back');
  assert.deepEqual(parked.actions.confirm_restored, { available: true, reason: null });
  const blocked = await fx.decide(parked, 'commit');
  assert.deepEqual([blocked.ok, blocked.reason, blocked.error_code], [false, 'authorization_required', CODES.AUTHORIZATION_REQUIRED]);

  const done = await confirm(fx, parked);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.created, true);
  assert.equal(done.proposal.decision_state, 'pending');
  assert.equal(done.proposal.revision, parked.revision + 1);
  assert.equal(done.proposal.actions.confirm_restored, undefined);
  assert.equal(done.proposal.actions.commit.available, true);
  assert.equal(fx.record(proposal.proposal_id).restore_requires_confirmation, false);
  assert.equal(fx.runtime.submits.length, 0, 'confirming a pending offer starts no work');
  assert.ok(R.normalizeProposalRecord(fx.record(proposal.proposal_id)));
});

test('a pending Git offer whose binding drifted goes stale instead of confirming', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishGit(1);
  park(fx);
  fx.recheck = async () => ({ ok: false, cause_code: 'head_changed' });
  const parked = await fx.get(proposal.proposal_id);
  const result = await confirm(fx, parked);
  assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED]);
  assert.equal(fx.record(proposal.proposal_id).decision_state, 'stale');
});

test('a pending session offer confirms back to pending; an expired one stays terminal', async (t) => {
  const fx = createSessionFixture(t);
  const live = (await fx.publishSession(1)).proposal;
  const old = (await fx.publishSession(2)).proposal;
  rewrite(fx, old.proposal_id, (record) => {
    const created = new Date(fx.clock.ms - 6 * DAY).toISOString();
    return { ...record, created_at: created, expires_at: new Date(Date.parse(created) + R.PROPOSAL_LIMITS.expiry_ms).toISOString() };
  });
  park(fx);
  fx.clock.ms += 2 * DAY;
  const parkedLive = await fx.get(live.proposal_id);
  assert.deepEqual(parkedLive.actions.do_it_here, { available: false, reason: 'authorization_required' });
  assert.deepEqual(parkedLive.actions.new_session, { available: false, reason: 'authorization_required' });
  const done = await confirm(fx, parkedLive);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.decision_state, 'pending');
  assert.equal(done.proposal.actions.do_it_here.available, true);
  assert.equal(fx.runtime.submits.length, 0);

  const expired = await confirm(fx, await fx.get(old.proposal_id));
  assert.deepEqual([expired.ok, expired.reason, expired.error_code], [false, 'expired', CODES.EXPIRED]);
  assert.equal(fx.record(old.proposal_id).decision_state, 'expired');
});

test('a restored command is inert for good: unsupported_capability with the fresh-proposal detail, whatever its state', async (t) => {
  const adapter = {
    isSupported: () => true,
    recheck: async () => ({ ok: true }),
    submit: async () => ({ ok: true, created: true, work_id: 'work_a', turn_id: 'turn_a' }),
  };
  const fx = createSessionFixture(t, { commandAdapter: adapter });
  const pending = (await fx.publishCommand(1)).proposal;
  const accepted = (await fx.publishCommand(2)).proposal;
  const ran = await fx.decide(accepted, 'run');
  assert.equal(ran.ok, true, JSON.stringify(ran));
  park(fx);
  for (const id of [pending.proposal_id, accepted.proposal_id]) {
    const parked = await fx.get(id);
    assert.deepEqual(parked.actions.run, { available: false, reason: id === pending.proposal_id ? 'unsupported_capability' : 'accepted' });
    assert.deepEqual(parked.actions.confirm_restored, { available: false, reason: 'unsupported_capability' });
    const before = fx.record(id);
    const result = await confirm(fx, parked);
    assert.deepEqual(result, {
      schema_version: 1, ok: false, error_code: CODES.UNSUPPORTED_CAPABILITY, reason: 'unsupported_capability', retryable: false,
      current_revision: parked.revision, detail: 'fresh_command_proposal_required',
    });
    assert.deepEqual(fx.record(id), before, 'nothing changes');
  }
  assert.equal((await fx.get(accepted.proposal_id)).action_state, 'needs_attention');
});

test('an accepted Git action whose work is still pending or running is adopted as queued or admitted and tracked', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal, record } = await parkedGit(fx);
  assert.equal(proposal.actions.confirm_restored.available, true);
  assert.equal(proposal.actions.retry.available, false, 'generic Retry is never the confirmation');
  const done = await confirm(fx, proposal);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual([done.proposal.decision_state, done.proposal.action_state, done.proposal.last_error], ['accepted', 'queued', null]);
  assert.equal(fx.record(record.proposal_id).restore_requires_confirmation, false);
  assert.equal(fx.runtime.submits.length, 1, 'only the original dispatch ever ran');
  // The turn is tracked again: its terminal event settles the record.
  fx.stream(record.continuation_turn_id, 'complete');
  assert.equal((await fx.get(record.proposal_id)).action_state, 'succeeded');

  const running = createSessionFixture(t);
  const second = await parkedGit(running);
  workOf(running, second.record).status = 'running';
  const admitted = await confirm(running, second.proposal);
  assert.equal(admitted.proposal.action_state, 'admitted');
});

test('terminal work becomes its truthful projection; an unprovable completion does not', async (t) => {
  const cases = [
    ['completed', true, 'succeeded'],
    ['cancelled', false, 'cancelled'],
  ];
  for (const [status, known, expected] of cases) {
    const fx = createSessionFixture(t);
    const { proposal, record } = await parkedGit(fx);
    workOf(fx, record).status = status;
    if (known) fx.completeTurns.add(record.continuation_turn_id);
    const done = await confirm(fx, proposal);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.deepEqual([done.proposal.action_state, done.proposal.last_error], [expected, null], status);
    assert.equal(fx.record(record.proposal_id).restore_requires_confirmation, false);
    assert.equal(fx.runtime.submits.length, 1);
  }
  const fx = createSessionFixture(t);
  const { proposal, record } = await parkedGit(fx);
  workOf(fx, record).status = 'completed'; // the terminal is not durably known to be a normal completion
  const done = await confirm(fx, proposal);
  assert.deepEqual([done.proposal.action_state, done.proposal.last_error.reason, done.proposal.last_error.retryable], ['needs_attention', 'outcome_unknown', false]);
});

test('with no work to find the action stays needs_attention as an unknown outcome and is never redispatched', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal, record } = await parkedGit(fx);
  fx.runtime.works.clear();
  fx.runtime.keys.clear();
  const done = await confirm(fx, proposal);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.action_state, 'needs_attention');
  assert.deepEqual(
    { reason: done.proposal.last_error.reason, retryable: done.proposal.last_error.retryable, cause: done.proposal.last_error.cause_code },
    { reason: 'outcome_unknown', retryable: false, cause: 'restored' },
  );
  assert.equal(done.proposal.actions.retry.available, false);
  assert.equal(done.proposal.actions.confirm_restored, undefined, 'the flag is cleared: the record is settled');
  assert.equal(fx.runtime.submits.length, 1, 'no redispatch');
  assert.ok(R.normalizeProposalRecord(fx.record(record.proposal_id)));
});

test('work the runtime holds under the dispatch key is adopted even when the record never got its acknowledgment', async (t) => {
  const fx = createSessionFixture(t);
  const { id, record } = await (async () => {
    const parkedId = await acceptedGit(fx, { mode: 'lost' });
    const stored = fx.record(parkedId);
    assert.equal(stored.continuation_work_id, null, 'the original submission was never acknowledged');
    fx.runtime._register(keyOf(stored), { sessionId: fx.sessionId });
    park(fx);
    return { id: parkedId, record: stored };
  })();
  const done = await confirm(fx, await fx.get(id));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.action_state, 'queued');
  assert.equal(fx.record(id).continuation_work_id, 'work_1');
  assert.equal(fx.runtime.submits.length, 1);
  assert.equal(record.proposal_id, id);

  const none = createSessionFixture(t);
  const lost = await acceptedGit(none, { mode: 'lost' });
  park(none);
  const result = await confirm(none, await none.get(lost));
  assert.equal(result.proposal.last_error.reason, 'outcome_unknown');
  assert.equal(none.runtime.submits.length, 1, 'a key the runtime does not hold is not proof it never began');
});

test('a "Do it here" continuation reconciles like a Git one', async (t) => {
  const fx = createSessionFixture(t);
  const id = await stage(fx, 1, [accept('do_it_here'), (r) => R.markDispatchAcknowledged(r, { workId: 'work_p', turnId: 'turn_p' })]);
  addWork(fx, 'work_p', 'turn_p', fx.sessionId, 'running');
  park(fx);
  const parked = await fx.get(id);
  assert.equal(parked.action_state, 'needs_attention');
  const done = await confirm(fx, parked);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.action_state, 'admitted');
  assert.equal(fx.runtime.submits.length, 0, 'nothing is dispatched');
  assert.ok(R.normalizeProposalRecord(fx.record(id)));
  fx.stream('turn_p', 'complete');
  assert.equal(fx.record(id).action_state, 'succeeded', 'the continuation turn is tracked again');
});

test('a New session with a reserved child settles as its admitted first turn when the runtime holds the key', async (t) => {
  const fx = createSessionFixture(t);
  const id = await stage(fx, 1, [
    accept('new_session'), (r) => S.markPrepAcknowledged(r, { workId: 'work_prep', turnId: 'turn_prep' }), S.markPreparing, handoff, S.markChildCreated,
  ]);
  const reserved = fx.record(id);
  assert.equal(reserved.action_state, 'child_created');
  const found = fx.runtime._register(keyOf(reserved), { sessionId: 'sess_child' });
  park(fx);
  const parked = await fx.get(id);
  assert.equal(parked.action_state, 'needs_attention');
  const done = await confirm(fx, parked);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.action_state, 'succeeded');
  const stored = fx.record(id);
  assert.equal(stored.first_turn_work_id, found.work_id);
  assert.equal(stored.first_turn_turn_id, found.turn_id);
  assert.equal(stored.child_session_id, 'sess_child', 'the matching child and its handoff proof are preserved');
  assert.equal(stored.restore_requires_confirmation, false);
  assert.ok(R.normalizeProposalRecord(stored));
  assert.equal(fx.runtime.submits.length, 0);
});

test('a New session without a provable first turn or running preparation stays an unknown outcome; nothing restarts', async (t) => {
  const fx = createSessionFixture(t);
  const withChild = await stage(fx, 1, [
    accept('new_session'), (r) => S.markPrepAcknowledged(r, { workId: 'work_prep', turnId: 'turn_prep' }), S.markPreparing, handoff, S.markChildCreated,
  ]);
  const ended = await stage(fx, 2, [accept('new_session'), (r) => S.markPrepAcknowledged(r, { workId: 'work_gone', turnId: 'turn_gone' })]);
  addWork(fx, 'work_gone', 'turn_gone', fx.sessionId, 'completed');
  park(fx);
  for (const id of [withChild, ended]) {
    const done = await confirm(fx, await fx.get(id));
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.deepEqual([done.proposal.action_state, done.proposal.last_error.reason, done.proposal.last_error.retryable], ['needs_attention', 'outcome_unknown', false]);
    assert.ok(R.normalizeProposalRecord(fx.record(id)));
  }
  assert.equal(fx.runtime.submits.length, 0);
});

test('a New session preparation the runtime is still driving is adopted and tracked as preparation', async (t) => {
  const fx = createSessionFixture(t);
  const id = await stage(fx, 1, [accept('new_session'), (r) => S.markPrepAcknowledged(r, { workId: 'work_prep', turnId: 'turn_prep' })]);
  addWork(fx, 'work_prep', 'turn_prep', fx.sessionId, 'running');
  park(fx);
  const done = await confirm(fx, await fx.get(id));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.proposal.action_state, 'preparing');
  assert.equal(fx.service._tracked.get('turn_prep')?.role, 'prep');
  assert.equal(fx.record(id).restore_requires_confirmation, false);
  assert.equal(fx.runtime.submits.length, 0);
});

test('a stale revision fails, an unflagged record is not pending, and a repeated gesture replays', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishGit(1);
  const plain = await confirm(fx, proposal);
  assert.deepEqual([plain.ok, plain.reason, plain.error_code], [false, 'not_pending', CODES.STALE_REVISION]);
  park(fx);
  const parked = await fx.get(proposal.proposal_id);
  const stale = await confirm(fx, { ...parked, revision: parked.revision - 1 });
  assert.deepEqual([stale.ok, stale.reason, stale.current_revision], [false, 'stale_revision', parked.revision]);
  assert.equal(fx.record(proposal.proposal_id).restore_requires_confirmation, true);

  const decisionId = randomUUID();
  const request = fx.request({ proposal_id: parked.proposal_id, expected_revision: parked.revision, decision_id: decisionId });
  const first = await fx.service.confirmRestored(request);
  assert.equal(first.created, true);
  const replay = await fx.service.confirmRestored(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.proposal.revision, first.proposal.revision, 'the replay answers before any revision check');
  const conflict = await fx.service.confirmRestored({ ...request, expected_revision: parked.revision + 7 });
  assert.deepEqual([conflict.ok, conflict.reason, conflict.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  assert.equal(fx.record(proposal.proposal_id).revision, first.proposal.revision);
});

test('the gesture receipt survives a restart: a new service replays the first result', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishGit(1);
  park(fx);
  const parked = await fx.get(proposal.proposal_id);
  const request = fx.request({ proposal_id: parked.proposal_id, expected_revision: parked.revision, decision_id: randomUUID() });
  assert.equal((await fx.service.confirmRestored(request)).created, true);
  fx.service._gestures.clear(); // a restarted process remembers only the durable receipt
  const replay = await fx.service.confirmRestored(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
});

test('confirmRestored validates a closed request', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishGit(1);
  const good = fx.request({ proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: randomUUID() });
  for (const bad of [
    { ...good, extra: 1 }, { ...good, expected_revision: 0 }, { ...good, decision_id: 'x' }, { ...good, proposal_id: 'p' },
    { schema_version: 1, session_id: fx.sessionId }, { ...good, schema_version: 2 }, null, 'x',
  ]) {
    const result = await fx.service.confirmRestored(bad);
    assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'invalid_request', CODES.INVALID_REQUEST], JSON.stringify(bad));
  }
  assert.equal((await fx.service.confirmRestored({ ...good, proposal_id: `proposal_${'0'.repeat(64)}` })).reason, 'not_found');
});
