'use strict';

/* Session-kind ChatProposalService (row 59 checkpoint 5a-1): publish of the offer and the
 * unsolicited suggestion, the group and per-source caps, decide (Do it here / New session /
 * dismiss) with waiting_for_source, source-turn withdrawal, the preparation turn and its 60 s
 * deadline, retry and cancel. Launch grants live in chat-proposal-launch-grants.test.js, startup
 * reconciliation in chat-proposal-session-reconcile.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const S = require('../services/backend/chat-proposal-session-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');

const settleAll = (fx) => fx.service.idle();

test('an ordinary offer publishes pending with the source defaults and registers its turn', async (t) => {
  const fx = createSessionFixture(t);
  const first = await fx.publishSession(1, { description: 'Why it matters.' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const { proposal } = first;
  assert.deepEqual([proposal.kind, proposal.decision_state, proposal.action_state, proposal.revision], ['session', 'pending', 'none', 1]);
  assert.deepEqual(proposal.display, { title: 'Fix the build', description: 'Why it matters.', initiation: 'offer', authorization_required: false });
  assert.deepEqual(proposal.options, { destination_project_id: 'proj_1', preferred_model: null, reasoning_effort: null, run_mode: 'agent' });
  assert.equal(proposal.options_editable, true);
  assert.equal(proposal.group_id, null);
  assert.deepEqual(Object.keys(proposal.actions).sort(), ['cancel', 'dismiss', 'do_it_here', 'new_session', 'retry']);
  assert.equal(proposal.actions.new_session.available, true);
  assert.deepEqual(fx.rail, [fx.sessionId]);
  assert.equal(JSON.stringify(proposal).includes('binding'), false);

  const again = await fx.publishSession(1, { description: 'Why it matters.' });
  assert.equal(again.created, false);
  assert.equal(fx.rail.length, 1, 'a replay is not a mutation');
  const changed = await fx.publishSession(1, { title: 'Something else' });
  assert.deepEqual([changed.ok, changed.reason, changed.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
});

test('a Plan source defaults the options to plan and carries its model and effort', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { binding: { run_mode: 'plan', restrictions: { read_only: true, plan_mode: true }, model: 'model_a', effort: 'high' } });
  assert.deepEqual(proposal.options, { destination_project_id: 'proj_1', preferred_model: 'model_a', reasoning_effort: 'high', run_mode: 'plan' });
});

test('a bad binding or an unknown session is refused without writing', async (t) => {
  const fx = createSessionFixture(t);
  const input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 'T' }).value;
  const base = { kind: 'session', sessionId: fx.sessionId, sessionIncarnation: fx.sessionIncarnation, turnId: 't', toolCallId: 'c', input };
  assert.equal((await fx.service.publish({ ...base, binding: {} })).reason, 'invalid_request');
  assert.equal((await fx.service.publish({ ...base, binding: null })).reason, 'invalid_request');
  assert.equal((await fx.service.publish({ ...base, sessionId: 'sess_missing', binding: {} })).ok, false);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 0);
});

test('a group holds at most ten suggestions; another group and ungrouped rows are independent', async (t) => {
  const fx = createSessionFixture(t);
  for (let n = 1; n <= 10; n += 1) {
    const done = await fx.publishSession(n, { initiation: 'own_initiative', title: `Task ${n}`, group_key: 'followups', turn: 'turn_g' });
    assert.equal(done.ok, true, `suggestion ${n}`);
    assert.match(done.proposal.group_id, /^group_[0-9a-f]{64}$/u);
  }
  const over = await fx.publishSession(11, { initiation: 'own_initiative', title: 'Task 11', group_key: 'followups', turn: 'turn_g' });
  assert.deepEqual([over.ok, over.reason, over.error_code], [false, 'capacity', CODES.CAPACITY]);
  assert.equal((await fx.publishSession(12, { initiation: 'own_initiative', title: 'Other', group_key: 'other', turn: 'turn_g' })).ok, true);
  assert.equal((await fx.publishSession(13, { initiation: 'own_initiative', title: 'Loose' })).ok, true);
});

test('twenty unresolved proposals per source session; the 21st is capacity', async (t) => {
  const fx = createSessionFixture(t);
  for (let n = 1; n <= 20; n += 1) assert.equal((await fx.publishSession(n)).ok, true, `offer ${n}`);
  const over = await fx.publishSession(21);
  assert.deepEqual([over.ok, over.reason], [false, 'capacity']);
});

test('user_asked without a grant becomes an offer that says authorization was required', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.deepEqual(proposal.display, { title: 'Fix the build', description: null, initiation: 'offer', authorization_required: true });
  assert.equal(proposal.decision_state, 'pending');
  const other = await fx.publishSession(2, { initiation: 'user_asked', authorization_ref: randomUUID() });
  assert.equal(other.proposal.display.authorization_required, true, 'an unknown ref is not a grant');
});

test('Do it here on an unsolicited suggestion queues at once and submits the source-mode continuation', async (t) => {
  const fx = createSessionFixture(t);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative', title: 'Add tests' });
  const done = await fx.decide(proposal, 'do_it_here');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(fx.runtime.submits.length, 1);
  const { request, idempotencyKey } = fx.runtime.submits[0];
  assert.equal(request.sessionId, fx.sessionId);
  assert.equal(request.planMode, true, 'the Plan trap: the continuation stays in Plan');
  assert.match(request.prompt, /Add tests/u);
  assert.deepEqual(request.proposalDecision, {
    proposal_id: proposal.proposal_id, decision_id: fx.record(proposal.proposal_id).decision.decision_id, accepted_revision: 2, choice: 'do_it_here',
  });
  assert.match(idempotencyKey, /^pdk_[0-9a-f]{64}$/u);
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.decision_state, record.action_state, record.continuation_work_id], ['accepted', 'queued', 'work_1']);
  assert.equal(record.decision.options, null);
  assert.equal(record.dispatch_key, `proposal:${record.proposal_id}:${record.decision.decision_id}:local`);

  fx.stream('turn_c1', 'tool_use');
  assert.equal(fx.record(proposal.proposal_id).action_state, 'admitted');
  fx.stream('turn_c1', 'complete', { completionReason: 'awaiting_proposal', proposalId: `proposal_${'1'.repeat(64)}` });
  assert.equal(fx.record(proposal.proposal_id).action_state, 'succeeded', 'a boundary complete is still a completion');
});

test('Do it here keeps agent mode and the approval mode of the source', async (t) => {
  const fx = createSessionFixture(t);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'auto' });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  await fx.decide(proposal, 'do_it_here');
  assert.deepEqual([fx.runtime.submits[0].request.planMode, fx.runtime.submits[0].request.approvalMode], [false, 'auto_run']);
});

test('New session on an unsolicited suggestion snapshots the options and submits the preparation turn', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const decisionId = randomUUID();
  const done = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: 1, decision_id: decisionId, choice: 'new_session',
  }));
  assert.equal(done.ok, true, JSON.stringify(done));
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.decision_state, record.action_state, record.attempt_number], ['accepted', 'queued', 1]);
  assert.deepEqual(record.decision.options, proposal.options);
  assert.equal(record.dispatch_key, `proposal:${record.proposal_id}:${decisionId}:prepare:1`);
  assert.equal(fx.runtime.submits.length, 1);
  assert.deepEqual(fx.runtime.submits[0].request.sessionHandoffPreparation, { proposal_id: record.proposal_id, attempt_id: record.attempt_id });
  assert.deepEqual([record.preparation_work_id, record.preparation_turn_id], ['work_1', 'turn_c1']);
  assert.equal(done.proposal.options_editable, false, 'options are locked once accepted');

  const replay = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: 1, decision_id: decisionId, choice: 'new_session',
  }));
  assert.equal(replay.created, false);
  assert.equal(fx.runtime.submits.length, 1, 'a replay submits nothing');
  const conflict = await fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: 1, decision_id: decisionId, choice: 'do_it_here',
  }));
  assert.equal(conflict.reason, 'idempotency_conflict');
  const stale = await fx.decide(proposal, 'do_it_here');
  assert.equal(stale.reason, 'stale_revision');
});

test('the preparation turn: first event starts the 60 s deadline, a clean end without a handoff needs attention', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  await fx.decide(proposal, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  const preparing = fx.record(proposal.proposal_id);
  assert.equal(preparing.action_state, 'preparing');
  assert.deepEqual(fx.handoff.calls.filter((call) => call[0] === 'start_deadline'), [['start_deadline', preparing.proposal_id, preparing.attempt_id]]);
  assert.equal(fx.ctl.liveTimers().filter((timer) => timer.ms === 60000).length, 1);
  fx.stream('turn_c1', 'tool_use');
  assert.equal(fx.handoff.calls.filter((call) => call[0] === 'start_deadline').length, 1, 'started once');

  fx.stream('turn_c1', 'complete', { completionReason: 'session_handoff_completed' });
  const failed = fx.record(proposal.proposal_id);
  assert.deepEqual([failed.action_state, failed.last_error.reason, failed.last_error.cause_code, failed.last_error.retryable], ['needs_attention', 'preparation_failed', 'no_handoff', true]);
  assert.equal(fx.ctl.liveTimers().length, 0, 'the deadline is cleared on the terminal');
  const projected = await fx.get(proposal.proposal_id);
  assert.equal(projected.actions.retry.available, true);
  assert.equal(JSON.stringify(projected).includes('no_handoff'), true);
});

test('a preparation terminal after a handoff whose first turn was never recorded leaves the record retryable', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  await fx.decide(proposal, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  // The handoff and child were recorded, then the final write failed: still child_created.
  const wrote = fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
    records: [S.markChildCreated(S.recordHandoff(records[0], {
      task: 'Do it', background: 'Context', childSessionId: 'sess_child', childIncarnation: `inc_${'a'.repeat(32)}`,
    }))],
  }));
  assert.equal(wrote.ok, true);
  fx.stream('turn_c1', 'complete', { completionReason: 'session_handoff_completed' });
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.action_state, record.last_error.cause_code], ['needs_attention', 'prep_terminal']);
  assert.equal((await fx.get(proposal.proposal_id)).actions.retry.available, true);
});

test('a preparation turn that errors, or runs past 60 s, fails the preparation and the deadline cancels its work', async (t) => {
  const fx = createSessionFixture(t);
  const a = (await fx.publishSession(1, { initiation: 'own_initiative' })).proposal;
  const b = (await fx.publishSession(2, { initiation: 'own_initiative' })).proposal;
  await fx.decide(a, 'new_session');
  await fx.decide(b, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  fx.stream('turn_c2', 'tool_use');
  fx.stream('turn_c1', 'error', { category: 'provider' });
  assert.equal(fx.record(a.proposal_id).last_error.cause_code, 'prep_error');
  await fx.fireTimers(60000);
  const timedOut = fx.record(b.proposal_id);
  assert.deepEqual([timedOut.action_state, timedOut.last_error.cause_code], ['needs_attention', 'deadline']);
  assert.deepEqual(fx.runtime.cancels, [['work_2', { reason: 'deadline' }]]);
});

test('retry before any child starts a fresh preparation attempt with a new key; a refused submission is dispatch_failed', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  fx.runtime.mode = 'disabled';
  await fx.decide(proposal, 'new_session');
  const refused = fx.record(proposal.proposal_id);
  assert.deepEqual([refused.action_state, refused.last_error.reason, refused.last_error.retryable], ['needs_attention', 'unavailable', true]);
  assert.equal(fx.runtime.submits.length, 1, 'no fallback path ran');

  fx.runtime.mode = 'ok';
  const retried = await fx.gesture('retry', await fx.get(proposal.proposal_id));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.action_state, record.attempt_number, record.handoff], ['queued', 2, null]);
  assert.equal(record.dispatch_key, `proposal:${record.proposal_id}:${record.decision.decision_id}:prepare:2`);
  assert.equal(fx.runtime.submits.length, 2);
  assert.notEqual(fx.runtime.submits[0].idempotencyKey, fx.runtime.submits[1].idempotencyKey);
});

test('retry with a reserved child resumes the same child through S6 and never rebuilds the brief', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  await fx.decide(proposal, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  const wrote = fx.proposalStore.mutate(fx.sessionId, ({ records }) => {
    const current = records[0];
    const withHandoff = S.recordHandoff(current, { task: 'Do it', background: 'Context', childSessionId: 'sess_child', childIncarnation: `inc_${'a'.repeat(32)}` });
    return { records: [S.markFirstTurnRefused(withHandoff, { causeCode: 'dispatch_lost' })] };
  });
  assert.equal(wrote.ok, true);
  fx.handoff.calls.length = 0;
  const retried = await fx.gesture('retry', await fx.get(proposal.proposal_id));
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const record = fx.record(proposal.proposal_id);
  assert.equal(record.action_state, 'preparing', 'back to preparing with the same proof');
  assert.equal(record.child_session_id, 'sess_child');
  assert.deepEqual(fx.handoff.calls, [['resume', proposal.proposal_id]]);
  assert.equal(fx.runtime.submits.length, 1, 'no second preparation turn');

  fx.handoff.resumeResult = { ok: false };
  const failed = await fx.gesture('retry', Object.assign(await fx.get(proposal.proposal_id), {}));
  assert.equal(failed.ok, false, 'a record in preparing cannot be retried');
});

test('an ordinary offer clicked before its turn settled waits, then dispatches once the work is terminal', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1);
  const waiting = await fx.decide(proposal, 'do_it_here');
  assert.equal(waiting.ok, true);
  assert.equal(waiting.proposal.action_state, 'waiting_for_source');
  assert.equal(fx.runtime.submits.length, 0, 'nothing dispatches while the source turn runs');
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [250]);

  // The chat-stream terminal arrives first; the runtime work settles later.
  fx.stream('turn_1', 'complete', { completionReason: 'awaiting_proposal' });
  assert.equal(fx.record(proposal.proposal_id).action_state, 'waiting_for_source', 'a terminal alone is not settlement');
  assert.equal(fx.runtime.submits.length, 0);
  await fx.fireTimers(250);
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [1000], 'rechecks back off 250 ms, 1 s, 4 s, 16 s');
  await fx.fireTimers(1000);
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [4000]);
  await fx.fireTimers(4000);
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [16000]);

  fx.ctl.settle('turn_1');
  await fx.fireTimers(16000);
  assert.equal(fx.runtime.submits.length, 1);
  assert.equal(fx.record(proposal.proposal_id).action_state, 'queued');
  assert.equal(fx.record(proposal.proposal_id).continuation_work_id, 'work_1');
});

test('completing the source turn restarts the fast rechecks of a choice already at the steady poll', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1);
  await fx.decide(proposal, 'do_it_here');
  for (const ms of [250, 1000, 4000, 16000]) await fx.fireTimers(ms);
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [30000]);
  fx.stream('turn_1', 'complete', { completionReason: 'awaiting_proposal' });
  assert.deepEqual(fx.ctl.liveTimers().map((timer) => timer.ms), [250]);
});

test('the terminal of the source turn kicks a waiting choice immediately when the work is already terminal', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1);
  await fx.decide(proposal, 'new_session');
  fx.ctl.settle('turn_1');
  fx.stream('turn_1', 'complete', { completionReason: 'awaiting_proposal' });
  await settleAll(fx);
  assert.equal(fx.record(proposal.proposal_id).action_state, 'queued');
  assert.equal(fx.runtime.submits.length, 1);
  assert.ok(fx.runtime.submits[0].request.sessionHandoffPreparation);
});

test('a settled offer decides immediately; an offer after a restart settles from the persisted boundary', async (t) => {
  const fx = createSessionFixture(t);
  fx.ctl.settle('turn_1');
  const { proposal } = await fx.publishSession(1);
  const done = await fx.decide(proposal, 'do_it_here');
  assert.equal(done.proposal.action_state, 'queued');
  assert.equal(fx.runtime.submits.length, 1);
});

test('a failed or cancelled source turn withdraws its pending offers and cancels waiting choices; suggestions stay', async (t) => {
  const fx = createSessionFixture(t);
  const offer = (await fx.publishSession(1, { turn: 'turn_x' })).proposal;
  const waited = (await fx.publishSession(2, { turn: 'turn_x' })).proposal;
  const suggestion = (await fx.publishSession(3, { initiation: 'own_initiative', turn: 'turn_x' })).proposal;
  await fx.decide(waited, 'new_session');
  assert.equal(fx.record(waited.proposal_id).action_state, 'waiting_for_source');

  fx.stream('turn_x', 'error', { category: 'cancelled', terminal_status: 'cancelled' });
  assert.deepEqual([fx.record(offer.proposal_id).decision_state, fx.record(offer.proposal_id).action_state], ['withdrawn', 'none']);
  assert.deepEqual([fx.record(waited.proposal_id).decision_state, fx.record(waited.proposal_id).action_state], ['accepted', 'cancelled']);
  assert.equal(fx.record(suggestion.proposal_id).decision_state, 'pending', 'an unsolicited suggestion is independent');
  const refused = await fx.decide(await fx.get(offer.proposal_id), 'do_it_here');
  assert.equal(refused.reason, 'not_pending');
  assert.equal(fx.runtime.submits.length, 0);
  assert.equal(fx.ctl.liveTimers().length, 0, 'the waiting watcher is gone');
  const queued = await fx.decide(await fx.get(suggestion.proposal_id), 'do_it_here');
  assert.equal(queued.proposal.action_state, 'queued');
});

test('a session_busy error of a source turn says nothing about it', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1);
  fx.stream('turn_1', 'error', { error_code: 'session_busy' });
  assert.equal(fx.record(proposal.proposal_id).decision_state, 'pending');
});

test('dismiss starts nothing and replays; Plan, read-only and lockdown never refuse a session choice', async (t) => {
  const fx = createSessionFixture(t, { isOfflineLockdown: () => true });
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'propose' });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  assert.equal(proposal.actions.do_it_here.available, true);
  assert.equal(proposal.actions.new_session.available, true);
  const dismissed = await fx.decide(proposal, 'dismiss');
  assert.deepEqual([dismissed.proposal.decision_state, dismissed.proposal.action_state], ['dismissed', 'none']);
  assert.equal(fx.record(proposal.proposal_id).decision.options, null);
  assert.equal(fx.runtime.submits.length, 0);
});

test('without a negotiated handoff context New session is unsupported_capability and Do it here still works', async (t) => {
  const fx = createSessionFixture(t);
  fx.ctl.handoffSupported = false;
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  assert.deepEqual([proposal.actions.new_session.available, proposal.actions.new_session.reason], [false, 'unsupported_capability']);
  const refused = await fx.decide(proposal, 'new_session');
  assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'unsupported_capability', CODES.UNSUPPORTED_CAPABILITY]);
  assert.equal(fx.record(proposal.proposal_id).decision_state, 'pending');
  assert.equal((await fx.decide(proposal, 'do_it_here')).ok, true);
});

test('a choice of another kind is invalid_request', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  for (const choice of ['commit', 'test_first', 'run']) {
    assert.equal((await fx.decide(proposal, choice)).reason, 'invalid_request', choice);
  }
  const git = (await fx.publishGit(2)).proposal;
  assert.equal((await fx.decide(git, 'new_session')).reason, 'invalid_request');
  assert.equal((await fx.decide(git, 'do_it_here')).reason, 'invalid_request');
});

test('a missing runtime is needs_attention/unavailable with no fallback; Retry works once it is back', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  const runtime = fx.runtime;
  fx.runtime = null;
  const done = await fx.decide(proposal, 'do_it_here');
  assert.equal(done.ok, true);
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.action_state, record.last_error.reason, record.last_error.retryable], ['needs_attention', 'unavailable', true]);
  fx.runtime = runtime;
  const retried = await fx.gesture('retry', await fx.get(proposal.proposal_id));
  assert.equal(retried.ok, true);
  assert.equal(fx.record(proposal.proposal_id).action_state, 'queued');
  assert.equal(runtime.submits.length, 1);
});

test('a reserved child takes no other turn until its first turn is admitted or the proposal is cancelled', async (t) => {
  let origin = null;
  const fx = createSessionFixture(t, { serviceOptions: { readSpawnedFrom: (id) => (id === 'sess_child' ? origin : null) } });
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative' });
  await fx.decide(proposal, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  origin = { parent_session_id: fx.sessionId, proposal_id: proposal.proposal_id };
  fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({ records: [S.markChildCreated(S.recordHandoff(records[0], {
    task: 'Do it', background: 'Context', childSessionId: 'sess_child', childIncarnation: `inc_${'a'.repeat(32)}`,
  }))] }));
  const firstTurnKey = fx.service._records.runtimeIdempotencyKey(fx.record(proposal.proposal_id).dispatch_key_sha256);
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child'), 'linked_first_turn_pending', 'admission in flight');
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child', firstTurnKey), null, 'the first turn itself passes');
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child', 'pdk_other'), 'linked_first_turn_pending');
  assert.equal(fx.service.linkedFirstTurnBlock(fx.sessionId), null, 'an ordinary chat is never fenced');
  const inFlight = await fx.get(proposal.proposal_id);
  assert.equal(inFlight.actions.cancel.available, false, 'an in-flight first turn is not cancelled from the card');

  fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({ records: [S.markFirstTurnRefused(records[0], { causeCode: 'busy' })] }));
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child'), 'linked_first_turn_pending', 'a refused first turn still fences');
  const refused = await fx.get(proposal.proposal_id);
  assert.deepEqual([refused.actions.cancel.available, refused.actions.retry.available], [true, true]);
  const cancels = fx.runtime.cancels.length;
  const cancelled = await fx.gesture('cancel', refused);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(fx.record(proposal.proposal_id).action_state, 'cancelled');
  assert.equal(fx.runtime.cancels.length, cancels, 'nothing runs, so nothing is cancelled in the runtime');
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child'), null, 'the cancel lifts the fence');

  origin = { parent_session_id: fx.sessionId, proposal_id: `proposal_${'f'.repeat(64)}` };
  assert.equal(fx.service.linkedFirstTurnBlock('sess_child'), null, 'an unknown proposal never fences');
});

test('cancel: a waiting choice cancels with no runtime call; a preparing turn is cancelled through the runtime', async (t) => {
  const fx = createSessionFixture(t);
  const offer = (await fx.publishSession(1)).proposal;
  await fx.decide(offer, 'new_session');
  const waiting = await fx.get(offer.proposal_id);
  assert.equal(waiting.actions.cancel.available, true);
  const cancelled = await fx.gesture('cancel', waiting);
  assert.equal(cancelled.ok, true);
  assert.equal(fx.record(offer.proposal_id).action_state, 'cancelled');
  assert.equal(fx.runtime.cancels.length, 0);
  assert.equal(fx.ctl.liveTimers().length, 0);

  const suggestion = (await fx.publishSession(2, { initiation: 'own_initiative' })).proposal;
  await fx.decide(suggestion, 'new_session');
  fx.stream('turn_c1', 'tool_use');
  const preparing = await fx.get(suggestion.proposal_id);
  assert.equal(preparing.action_state, 'preparing');
  const stopped = await fx.gesture('cancel', preparing);
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.deepEqual(fx.runtime.cancels, [['work_1', { reason: 'user' }]]);
  assert.equal(fx.record(suggestion.proposal_id).action_state, 'cancelled');
  assert.equal(fx.ctl.liveTimers().length, 0, 'the deadline was cleared');
  fx.stream('turn_c1', 'error', { category: 'cancelled' });
  assert.equal(fx.record(suggestion.proposal_id).action_state, 'cancelled', 'the late terminal does not fail a cancelled preparation');
});

test('cancel of a Do it here continuation uses the runtime like Git; a queued preparation without work is submission_pending', async (t) => {
  const fx = createSessionFixture(t);
  const a = (await fx.publishSession(1, { initiation: 'own_initiative' })).proposal;
  await fx.decide(a, 'do_it_here');
  const queued = await fx.get(a.proposal_id);
  assert.equal((await fx.gesture('cancel', queued)).ok, true);
  assert.equal(fx.record(a.proposal_id).action_state, 'cancelled');

  const b = (await fx.publishSession(2, { initiation: 'own_initiative' })).proposal;
  // Accepted and persisted, the submission not yet acknowledged.
  fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
    records: records.map((entry) => (entry.proposal_id === b.proposal_id ? S.acceptSessionDecision(entry, {
      decisionId: randomUUID(), choice: 'new_session', now: new Date(fx.clock.ms), attemptId: randomUUID(),
    }) : entry)),
  }));
  const noWork = fx.record(b.proposal_id);
  assert.equal(noWork.action_state, 'queued');
  assert.equal(noWork.preparation_work_id, null);
  const pending = await fx.gesture('cancel', await fx.get(b.proposal_id));
  assert.equal(pending.reason, 'submission_pending');
});

test('completeHandoff delegates to S6 with the ports object and never throws', async (t) => {
  const fx = createSessionFixture(t);
  fx.handoff.completeResult = { ok: true, proposal_id: 'proposal_x', child_session_id: 'sess_c' };
  const args = { sessionId: fx.sessionId, proposalId: 'p', attemptId: 'a', task: 'T', background: '' };
  assert.deepEqual(await fx.service.completeHandoff(args), fx.handoff.completeResult);
  fx.handoff.completeSessionHandoff = async () => { throw new Error('C:\\secret'); };
  const failed = await fx.service.completeHandoff(args);
  assert.deepEqual([failed.ok, failed.reason], [false, 'unavailable']);
  assert.doesNotMatch(JSON.stringify(fx.logs), /secret/u);
  const none = createSessionFixture(t, { serviceOptions: { sessionHandoff: {} } });
  assert.equal((await none.service.completeHandoff(args)).reason, 'unsupported_capability');
});

test('the ports object handed to S6 carries the frozen keys', async (t) => {
  const fx = createSessionFixture(t);
  let seen;
  fx.handoff.completeSessionHandoff = async (ports) => { seen = ports; return { ok: true }; };
  await fx.service.completeHandoff({});
  assert.deepEqual(Object.keys(seen).sort(), [
    'clearTimer', 'createId', 'createLinkedChildSession', 'deadlines', 'getRuntime', 'getSessionSummary', 'log', 'notify',
    'now', 'readSpawnedFrom', 'records', 'sessionExists', 'setTimer', 'store',
  ]);
  assert.ok(seen.deadlines instanceof Map);
  assert.equal(seen.store, fx.service._store);
});

test('diagnostics never carry titles, descriptions or tasks', async (t) => {
  const fx = createSessionFixture(t);
  const { proposal } = await fx.publishSession(1, { initiation: 'own_initiative', title: 'TOPSECRET-TITLE', description: 'TOPSECRET-DESC' });
  fx.runtime = null;
  await fx.decide(proposal, 'new_session');
  assert.doesNotMatch(JSON.stringify(fx.logs), /TOPSECRET/u);
});
