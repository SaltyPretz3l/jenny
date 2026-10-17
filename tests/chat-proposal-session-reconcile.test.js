'use strict';

/* Startup reconciliation of every session-kind state (row 59 checkpoint 5a-1, spec 1.5): nothing
 * is resumed or resubmitted; each record settles from what the runtime store and the persisted
 * turn prove, and anything unprovable needs attention. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');

const CHILD_INC = `inc_${'b'.repeat(32)}`;
const accept = (choice = 'new_session', waitForSource = false) => (record) => S.acceptSessionDecision(record, {
  decisionId: randomUUID(), choice, now: new Date('2026-10-15T10:00:00.000Z'), attemptId: randomUUID(), waitForSource,
});
const handoff = (record) => S.recordHandoff(record, { task: 'Task', background: 'Back', childSessionId: 'sess_child', childIncarnation: CHILD_INC });

// Publishes a suggestion (or an offer) and walks it through the given transitions in one write.
async function stage(fx, n, steps, { initiation = 'own_initiative' } = {}) {
  const { proposal } = await fx.publishSession(n, { initiation });
  const wrote = fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
    records: records.map((entry) => {
      if (entry.proposal_id !== proposal.proposal_id) return entry;
      return steps.reduce((current, step) => {
        const next = step(current);
        assert.ok(next, 'staging transition refused');
        return next;
      }, entry);
    }),
  }));
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  return proposal.proposal_id;
}

const restart = async (fx) => {
  fx.service.reconcileOnStartup();
  await fx.service.idle();
};
const key = (record) => R.runtimeIdempotencyKey(record.dispatch_key_sha256);

test('a pending ordinary offer survives a restart when its turn reached the boundary, and is withdrawn when it did not', async (t) => {
  const fx = createSessionFixture(t);
  const kept = (await fx.publishSession(1, { turn: 'turn_ok' })).proposal;
  const lost = (await fx.publishSession(2, { turn: 'turn_lost' })).proposal;
  const running = (await fx.publishSession(3, { turn: 'turn_running' })).proposal;
  fx.ctl.settle('turn_ok');
  fx.ctl.settled.set('turn_lost', true); // terminal work, no boundary on record
  fx.ctl.settled.set('turn_running', false);
  fx.service._offerTurns.clear();
  await restart(fx);
  assert.equal(fx.record(kept.proposal_id).decision_state, 'pending');
  assert.equal(fx.record(lost.proposal_id).decision_state, 'withdrawn');
  assert.equal(fx.record(running.proposal_id).decision_state, 'pending');
  assert.deepEqual([...fx.service._offerTurns.keys()].sort(), ['turn_ok', 'turn_running'], 'live offer turns are tracked again');
  fx.stream('turn_running', 'error', { category: 'cancelled' });
  assert.equal(fx.record(running.proposal_id).decision_state, 'withdrawn');
});

test('an offer whose source turn failed before the restart is withdrawn even though the turn has rows (D4)', async (t) => {
  const fx = createSessionFixture(t);
  const failed = (await fx.publishSession(1, { turn: 'turn_failed' })).proposal;
  fx.ctl.settled.set('turn_failed', true);
  fx.ctl.reasons.set('turn_failed', 'failed');
  fx.service._offerTurns.clear();
  await restart(fx);
  assert.equal(fx.record(failed.proposal_id).decision_state, 'withdrawn');
});

test('waiting_for_source: settled releases and dispatches, ended cancels, still running keeps waiting', async (t) => {
  const fx = createSessionFixture(t);
  const a = await stage(fx, 1, [accept('new_session', true)], { initiation: 'offer' });
  const b = await stage(fx, 2, [accept('do_it_here', true)], { initiation: 'offer' });
  const c = await stage(fx, 3, [accept('new_session', true)], { initiation: 'offer' });
  fx.ctl.settle('turn_1');
  fx.ctl.settled.set('turn_2', true); // work terminal, no boundary: ended
  fx.ctl.settled.set('turn_3', false);
  await restart(fx);
  assert.equal(fx.record(a).action_state, 'queued');
  assert.equal(fx.runtime.submits.length, 1, 'only the released choice dispatched');
  assert.ok(fx.runtime.submits[0].request.sessionHandoffPreparation);
  assert.equal(fx.record(b).action_state, 'cancelled');
  assert.equal(fx.record(c).action_state, 'waiting_for_source');
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [250], 'the waiting choice is watched again');
});

test('queued New session: an unacknowledged submission the runtime stored is adopted, one it never stored is dispatch_lost', async (t) => {
  const fx = createSessionFixture(t);
  const stored = await stage(fx, 1, [accept()]);
  const lost = await stage(fx, 2, [accept()]);
  fx.runtime._register(key(fx.record(stored)), { sessionId: fx.sessionId });
  await restart(fx);
  const adopted = fx.record(stored);
  assert.deepEqual([adopted.action_state, adopted.preparation_work_id, adopted.preparation_turn_id], ['queued', 'work_1', 'turn_c1']);
  assert.equal(fx.service._tracked.get('turn_c1').role, 'prep', 'the adopted preparation is followed through its events');
  const dispatchLost = fx.record(lost);
  assert.deepEqual([dispatchLost.action_state, dispatchLost.last_error.reason, dispatchLost.last_error.cause_code], ['needs_attention', 'dispatch_failed', 'dispatch_lost']);
  assert.equal(fx.runtime.submits.length, 0, 'restart never resubmits');
});

test('a preparation turn the runtime still holds is tracked again; one that ended without a handoff needs attention', async (t) => {
  const fx = createSessionFixture(t);
  const ids = {};
  for (const [n, name] of [[1, 'pending'], [2, 'completed'], [3, 'cancelled'], [4, 'failed'], [5, 'missing']]) {
    ids[name] = await stage(fx, n, [accept(), (r) => S.markPrepAcknowledged(r, { workId: `work_${name}`, turnId: `turn_${name}` })]);
    if (name !== 'missing') fx.runtime.works.set(`work_${name}`, { work_id: `work_${name}`, turn_id: `turn_${name}`, session_id: fx.sessionId, status: name === 'pending' ? 'pending' : name });
  }
  ids.preparing = await stage(fx, 6, [accept(), (r) => S.markPrepAcknowledged(r, { workId: 'work_run', turnId: 'turn_run' }), S.markPreparing]);
  fx.runtime.works.set('work_run', { work_id: 'work_run', turn_id: 'turn_run', session_id: fx.sessionId, status: 'running' });
  await restart(fx);
  const cause = (name) => fx.record(ids[name]).last_error?.cause_code;
  assert.equal(fx.record(ids.pending).action_state, 'queued');
  assert.equal(fx.service._tracked.get('turn_pending').role, 'prep');
  assert.equal(fx.service._tracked.get('turn_run').state, 'started');
  assert.deepEqual(['completed', 'cancelled', 'failed', 'missing'].map(cause), ['no_handoff', 'prep_cancelled', 'restart', 'restart']);
  assert.equal(fx.record(ids.completed).action_state, 'needs_attention');
  // A tracked turn works after the restart: its first event marks it preparing and starts the deadline.
  fx.stream('turn_pending', 'tool_use');
  assert.equal(fx.record(ids.pending).action_state, 'preparing');
  assert.equal(fx.runtime.submits.length, 0);
});

test('a reserved child is never resumed on restart: the record needs attention, keeps its proof, and Retry resumes it', async (t) => {
  const fx = createSessionFixture(t);
  const id = await stage(fx, 1, [accept(), (r) => S.markPrepAcknowledged(r, { workId: 'w', turnId: 't' }), S.markPreparing, handoff]);
  const before = fx.record(id);
  assert.equal(before.action_state, 'preparing');
  await restart(fx);
  const after = fx.record(id);
  assert.deepEqual([after.action_state, after.last_error.reason, after.last_error.cause_code, after.last_error.retryable], ['needs_attention', 'dispatch_failed', 'restart', true]);
  assert.deepEqual([after.child_session_id, after.child_creation_hash, after.handoff], [before.child_session_id, before.child_creation_hash, before.handoff]);
  assert.deepEqual(fx.handoff.calls.filter((call) => call[0] === 'resume'), []);
  const retried = await fx.gesture('retry', await fx.get(id));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.deepEqual(fx.handoff.calls.filter((call) => call[0] === 'resume'), [['resume', id]]);
});

test('child_created: the first-turn submission the runtime stored proves admission; none is dispatch_lost and the child is kept', async (t) => {
  const fx = createSessionFixture(t);
  const created = [S.markPreparing, handoff, S.markChildCreated];
  const base = [accept(), (r) => S.markPrepAcknowledged(r, { workId: 'w', turnId: 't' })];
  const admitted = await stage(fx, 1, [...base, ...created]);
  const lost = await stage(fx, 2, [...base, ...created]);
  fx.runtime._register(key(fx.record(admitted)), { sessionId: 'sess_child' });
  const wrongSession = await stage(fx, 3, [...base, ...created]);
  fx.runtime._register(key(fx.record(wrongSession)), { sessionId: 'sess_somewhere_else' });
  await restart(fx);
  const done = fx.record(admitted);
  assert.deepEqual([done.action_state, done.first_turn_work_id, done.first_turn_turn_id], ['succeeded', 'work_1', 'turn_c1']);
  for (const id of [lost, wrongSession]) {
    const record = fx.record(id);
    assert.deepEqual([record.action_state, record.last_error.cause_code, record.child_session_id], ['needs_attention', 'dispatch_lost', 'sess_child']);
  }
  assert.equal(fx.runtime.submits.length, 0);
});

test('Do it here continuations reconcile like Git: completed work with a proven turn succeeds, unproven is outcome_unknown', async (t) => {
  const fx = createSessionFixture(t);
  const proven = await stage(fx, 1, [accept('do_it_here'), (r) => R.markDispatchAcknowledged(r, { workId: 'work_p', turnId: 'turn_p' }), (r) => R.markAdmitted(r, {})]);
  const unproven = await stage(fx, 2, [accept('do_it_here'), (r) => R.markDispatchAcknowledged(r, { workId: 'work_u', turnId: 'turn_u' })]);
  for (const name of ['p', 'u']) fx.runtime.works.set(`work_${name}`, { work_id: `work_${name}`, turn_id: `turn_${name}`, session_id: fx.sessionId, status: 'completed' });
  fx.completeTurns.add('turn_p');
  await restart(fx);
  assert.equal(fx.record(proven).action_state, 'succeeded');
  assert.deepEqual([fx.record(unproven).action_state, fx.record(unproven).last_error.reason], ['needs_attention', 'outcome_unknown']);
});

test('settled, dismissed and already-attended session records are left alone', async (t) => {
  const fx = createSessionFixture(t);
  const dismissed = (await fx.publishSession(1, { initiation: 'own_initiative' })).proposal;
  await fx.decide(dismissed, 'dismiss');
  const cancelled = await stage(fx, 2, [accept('new_session', true), S.cancelWaiting]);
  const revision = fx.proposalStore.read(fx.sessionId).coordination_revision;
  await restart(fx);
  assert.equal(fx.proposalStore.read(fx.sessionId).coordination_revision, revision, 'no write');
  assert.equal(fx.record(cancelled).action_state, 'cancelled');
});
