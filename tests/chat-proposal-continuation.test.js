'use strict';

/* Git Commit / Test-first continuation (row 59 checkpoint 3): the persisted
 * decision before submission, the durable-only dispatch, acknowledgment and
 * refusal handling, retry with the same key, cancel, chat-stream outcome
 * tracking and startup reconciliation (read-only, never resume or resubmit). */

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const continuation = require('../services/chat-proposal-continuation');
const { createFixture } = require('./helpers/chat-proposal-service-fixture');

async function accepted(fx, choice = 'commit', n = 1) {
  const { proposal } = await fx.publishGit(n, { paths: ['src/a.js', 'docs/readme.md'], summary: 'Tightened the parser.' });
  const result = await fx.decide(proposal, choice);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.proposal;
}

test('commit persists the decision, submits once through the durable entry and records the acknowledgment', async (t) => {
  const fx = createFixture(t);
  const proposal = await accepted(fx);
  assert.deepEqual([proposal.decision_state, proposal.action_state], ['accepted', 'queued']);
  assert.equal(fx.runtime.submits.length, 1);
  const { request, idempotencyKey } = fx.runtime.submits[0];
  const record = fx.record(proposal.proposal_id);
  assert.equal(idempotencyKey, R.runtimeIdempotencyKey(record.dispatch_key_sha256));
  assert.match(idempotencyKey, /^pdk_[0-9a-f]{64}$/u);
  assert.equal(record.dispatch_key, `proposal:${record.proposal_id}:${record.decision.decision_id}:local`);
  assert.equal(record.attempt_number, 1);
  assert.deepEqual([record.continuation_work_id, record.continuation_turn_id], ['work_1', 'turn_c1']);
  assert.deepEqual(proposal.links, { continuation_turn_id: 'turn_c1', continuation_work_id: 'work_1', command_tool_call_id: null },
    'the envelope returned from decide already carries the acknowledgment');

  assert.equal(request.sessionId, fx.sessionId);
  assert.equal(request.visiblePrompt, 'Commit the proposed changes');
  assert.equal(request.planMode, false);
  assert.deepEqual(request.proposalDecision, {
    proposal_id: record.proposal_id, decision_id: record.decision.decision_id, accepted_revision: 2, choice: 'commit',
  });
  assert.match(request.prompt, /Tightened the parser\./u);
  assert.match(request.prompt, /- docs\/readme\.md\n- src\/a\.js/u, 'exact paths, in the stored (sorted) order');
  assert.match(request.prompt, /Never push, merge, rebase, amend, reset or force/u);
  assert.match(request.prompt, /Commit only the listed paths/u);
  assert.equal(fx.rail.length >= 3, true, 'publish, accept and ack each invalidate the rail');
});

test('test_first asks for results and forbids committing', async (t) => {
  const fx = createFixture(t);
  const proposal = await accepted(fx, 'test_first');
  const { request } = fx.runtime.submits[0];
  assert.equal(request.visiblePrompt, 'Test the proposed changes first');
  assert.match(request.prompt, /run the checks relevant/u);
  assert.match(request.prompt, /Do not commit, stage, push or merge/u);
  assert.equal(request.proposalDecision.choice, 'test_first');
  assert.equal(proposal.decision.choice, 'test_first');
});

test('the request follows the session settings like a normal send', async (t) => {
  const fx = createFixture(t);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'auto', preferred_model: 'model-x', reasoning_effort: 'high' });
  await accepted(fx);
  const { request } = fx.runtime.submits[0];
  assert.equal(request.approvalMode, 'auto_run');
  assert.equal(request.preferredModel, 'model-x');
  assert.equal(request.reasoningEffort, 'high');
});

test('an absent, disabled or closing runtime is needs_attention/unavailable and never another path', async (t) => {
  for (const mode of ['absent', 'disabled', 'closing']) {
    const fx = createFixture(t, mode === 'absent' ? { runtime: null } : {});
    if (mode !== 'absent') fx.runtime.mode = mode;
    const proposal = await accepted(fx);
    assert.deepEqual([proposal.decision_state, proposal.action_state], ['accepted', 'needs_attention'], mode);
    assert.equal(proposal.last_error.code, CODES.UNAVAILABLE, mode);
    assert.equal(proposal.last_error.retryable, true, mode);
    assert.equal(proposal.last_error.cause_code, mode === 'absent' ? 'runtime_unavailable' : `runtime_${mode}`);
    assert.equal(proposal.actions.retry.available, true, mode);
    const record = fx.record(proposal.proposal_id);
    assert.equal(record.decision.choice, 'commit', 'the decision stays persisted');
    assert.equal(record.continuation_work_id, null);
  }
});

test('another refusal is needs_attention/dispatch_failed and retry resubmits the SAME key', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'capacity';
  const proposal = await accepted(fx);
  assert.equal(proposal.action_state, 'needs_attention');
  assert.deepEqual([proposal.last_error.code, proposal.last_error.reason, proposal.last_error.cause_code],
    [CODES.DISPATCH_FAILED, 'dispatch_failed', 'session_pending_capacity']);
  const firstKey = fx.runtime.submits[0].idempotencyKey;

  fx.runtime.mode = 'ok';
  const retried = await fx.gesture('retry', proposal);
  assert.equal(retried.ok, true);
  assert.equal(retried.created, true);
  assert.equal(fx.runtime.submits.length, 2);
  assert.equal(fx.runtime.submits[1].idempotencyKey, firstKey, 'same dispatch key, so the runtime stays idempotent');
  const record = fx.record(proposal.proposal_id);
  assert.deepEqual([record.action_state, record.attempt_number, record.last_error], ['queued', 2, null]);
  assert.equal(record.continuation_work_id, 'work_1');
  assert.notEqual(record.attempt_id, null);
});

test('retry is refused unless the failure was a retryable pre-admission one', async (t) => {
  const fx = createFixture(t);
  const proposal = await accepted(fx);
  assert.equal(proposal.actions.retry.available, false);
  const queued = await fx.get(proposal.proposal_id);
  const refused = await fx.gesture('retry', queued);
  assert.deepEqual([refused.ok, refused.reason], [false, 'not_pending']);
  const pending = (await fx.publishGit(2)).proposal;
  assert.equal((await fx.gesture('retry', pending)).ok, false);
  const stale = await fx.service.retry(fx.request({
    proposal_id: proposal.proposal_id, expected_revision: 1, decision_id: '22222222-2222-4222-8222-222222222222',
  }));
  assert.equal(stale.reason, 'stale_revision');
});

test('retry replays by gesture id and conflicts on a different revision', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'lost';
  const proposal = await accepted(fx);
  assert.equal(proposal.last_error.reason, 'dispatch_failed');
  fx.runtime.mode = 'ok';
  const request = fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal((await fx.service.retry(request)).created, true);
  const replay = await fx.service.retry(request);
  assert.equal(replay.created, false);
  assert.equal(fx.runtime.submits.length, 2, 'a replay submits nothing');
  const conflict = await fx.service.retry({ ...request, expected_revision: proposal.revision + 5 });
  assert.equal(conflict.reason, 'idempotency_conflict');
});

test('an unproven acknowledgment is reconciled through the runtime store by the same key', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'committed-unknown';
  const proposal = await accepted(fx);
  assert.equal(proposal.action_state, 'queued', 'adopted, not refused');
  const record = fx.record(proposal.proposal_id);
  assert.equal(record.continuation_work_id, 'work_1');
  assert.equal(fx.runtime.submits.length, 1);
});

test('chat-stream events drive queued -> admitted -> succeeded and ignore other turns', async (t) => {
  const fx = createFixture(t);
  const proposal = await accepted(fx);
  const id = proposal.proposal_id;
  fx.stream('turn_other', 'complete');
  fx.stream('turn_c1', 'error', { error_code: 'session_busy', category: 'session_busy', status: 'runtime_error' });
  assert.equal(fx.record(id).action_state, 'queued', 'a busy rejection means it never started');
  fx.stream('turn_c1', 'started');
  assert.equal(fx.record(id).action_state, 'admitted');
  const revision = fx.record(id).revision;
  fx.stream('turn_c1', 'tool_call');
  assert.equal(fx.record(id).revision, revision, 'repeated live events write nothing');
  fx.stream('turn_c1', 'complete');
  assert.equal(fx.record(id).action_state, 'succeeded');
  assert.equal((await fx.get(id)).actions.cancel.available, false);
  fx.stream('turn_c1', 'error', { status: 'runtime_error' });
  assert.equal(fx.record(id).action_state, 'succeeded', 'a settled outcome is final');
  assert.equal(fx.record(id).last_error, null, 'a failed turn carries no dispatch error');
});

test('error and cancelled terminals settle failed and cancelled; a turn awaiting the user finished', async (t) => {
  const cases = [
    ['error', { status: 'runtime_error', error_code: 'X' }, 'failed'],
    ['error', { terminal_status: 'timeout' }, 'failed'],
    ['error', { terminal_status: 'denied' }, 'failed'],
    ['error', { terminal_status: 'cancelled' }, 'cancelled'],
    ['error', { category: 'cancelled' }, 'cancelled'],
    ['question_batch', {}, 'succeeded'],
    ['plan_proposal', {}, 'succeeded'],
  ];
  for (const [type, extra, expected] of cases) {
    const fx = createFixture(t);
    const proposal = await accepted(fx);
    fx.stream('turn_c1', type, extra);
    assert.equal(fx.record(proposal.proposal_id).action_state, expected, `${type} ${JSON.stringify(extra)}`);
  }
});

test('cancel: queued work cancels at once, running work waits for its terminal event', async (t) => {
  const fx = createFixture(t);
  const queued = await fx.get((await accepted(fx)).proposal_id);
  assert.equal(queued.actions.cancel.available, true);
  const cancelled = await fx.gesture('cancel', queued);
  assert.equal(cancelled.ok, true);
  assert.deepEqual(fx.runtime.cancels, [['work_1', { reason: 'user' }]]);
  assert.equal(cancelled.proposal.action_state, 'cancelled');

  const live = createFixture(t);
  live.runtime.cancelResult = { status: 'requested' };
  const proposal = await live.get((await accepted(live)).proposal_id);
  live.stream('turn_c1', 'started');
  const current = await live.get(proposal.proposal_id);
  const requested = await live.gesture('cancel', current);
  assert.equal(requested.proposal.action_state, 'admitted', 'the abort is not the outcome');
  live.stream('turn_c1', 'error', { terminal_status: 'cancelled' });
  assert.equal(live.record(proposal.proposal_id).action_state, 'cancelled');
});

test('cancel replays by gesture id, refuses a settled record and a submission without an acknowledgment', async (t) => {
  const fx = createFixture(t);
  const proposal = await fx.get((await accepted(fx)).proposal_id);
  const request = fx.request({ proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: '44444444-4444-4444-8444-444444444444' });
  assert.equal((await fx.service.cancel(request)).created, true);
  assert.equal((await fx.service.cancel(request)).created, false);
  assert.equal(fx.runtime.cancels.length, 1);
  const settled = await fx.gesture('cancel', await fx.get(proposal.proposal_id));
  assert.deepEqual([settled.ok, settled.reason], [false, 'not_pending']);

  const unacked = createFixture(t);
  unacked.runtime.mode = 'lost';
  const pending = await unacked.get((await accepted(unacked)).proposal_id);
  assert.equal(pending.actions.cancel.available, false, 'nothing to cancel while needs_attention');

  const stale = createFixture(t);
  const live = await stale.get((await accepted(stale)).proposal_id);
  const wrong = await stale.service.cancel(stale.request({
    proposal_id: live.proposal_id, expected_revision: live.revision + 3, decision_id: '55555555-5555-4555-8555-555555555555',
  }));
  assert.equal(wrong.reason, 'stale_revision');
});

// ---- startup reconciliation ---------------------------------------------------

function reconcileSetup(t, workStatus, { complete = false, recovery = null } = {}) {
  return (async () => {
    const fx = createFixture(t);
    const proposal = await accepted(fx);
    const work = fx.runtime.works.get('work_1');
    work.status = workStatus;
    work.recovery_kind = recovery;
    if (complete) fx.completeTurns.add(work.turn_id);
    const submitsBefore = fx.runtime.submits.length;
    fx.service.reconcileOnStartup();
    return { fx, id: proposal.proposal_id, submitsBefore, record: () => fx.record(proposal.proposal_id) };
  })();
}

test('reconcile: completed work is succeeded only when its turn is known complete', async (t) => {
  const known = await reconcileSetup(t, 'completed', { complete: true });
  assert.equal(known.record().action_state, 'succeeded');
  const unknown = await reconcileSetup(t, 'completed');
  assert.equal(unknown.record().action_state, 'needs_attention');
  assert.deepEqual([unknown.record().last_error.code, unknown.record().last_error.reason, unknown.record().last_error.retryable],
    [CODES.OUTCOME_UNKNOWN, 'outcome_unknown', false]);
});

test('reconcile: paused, failed and missing work are outcome_unknown; cancelled work is cancelled', async (t) => {
  for (const [status, recovery] of [['paused', 'restart_paused'], ['failed', null], ['needs_attention', null]]) {
    const setup = await reconcileSetup(t, status, { recovery });
    assert.equal(setup.record().action_state, 'needs_attention', status);
    assert.equal(setup.record().last_error.reason, 'outcome_unknown', status);
    assert.equal((await setup.fx.get(setup.id)).actions.retry.available, false, 'unknown outcomes are never retried');
  }
  const cancelled = await reconcileSetup(t, 'cancelled');
  assert.equal(cancelled.record().action_state, 'cancelled');
  const fx = createFixture(t);
  const proposal = await accepted(fx);
  fx.runtime.works.clear();
  fx.service.reconcileOnStartup();
  assert.equal(fx.record(proposal.proposal_id).last_error.reason, 'outcome_unknown');
});

test('reconcile never resumes, resubmits or cancels; running work keeps tracking its stream', async (t) => {
  const setup = await reconcileSetup(t, 'paused', { recovery: 'restart_paused' });
  assert.equal(setup.fx.runtime.submits.length, setup.submitsBefore);
  assert.equal(setup.fx.runtime.cancels.length, 0);

  const running = await reconcileSetup(t, 'running');
  assert.equal(running.record().action_state, 'queued', 'left alone');
  running.fx.stream('turn_c1', 'started');
  running.fx.stream('turn_c1', 'complete');
  assert.equal(running.record().action_state, 'succeeded');
});

function queuedWithoutAck(fx, n = 1) {
  return fx.publishGit(n).then(({ proposal }) => {
    const decisionId = '66666666-6666-4666-8666-666666666666';
    const result = fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
      records: records.map((record) => (record.proposal_id === proposal.proposal_id
        ? R.acceptGitDecision(record, { decisionId, choice: 'commit', now: new Date(fx.clock.ms) }) : record)),
    }));
    assert.equal(result.ok, true);
    return fx.record(proposal.proposal_id);
  });
}

test('reconcile: a lost acknowledgment is adopted from the runtime store when the runtime has the submission', async (t) => {
  const fx = createFixture(t);
  const queued = await queuedWithoutAck(fx);
  assert.equal(queued.continuation_work_id, null);
  fx.runtime._register(R.runtimeIdempotencyKey(queued.dispatch_key_sha256), { sessionId: fx.sessionId });
  fx.service.reconcileOnStartup();
  const record = fx.record(queued.proposal_id);
  assert.deepEqual([record.action_state, record.continuation_work_id, record.continuation_turn_id], ['queued', 'work_1', 'turn_c1']);
  assert.equal(fx.runtime.submits.length, 0, 'adopted, never resubmitted');
  fx.stream('turn_c1', 'complete');
  assert.equal(fx.record(queued.proposal_id).action_state, 'succeeded');
});

test('reconcile: a lost acknowledgment with no submission is retryable needs_attention, resubmitted only by the user', async (t) => {
  const fx = createFixture(t);
  const queued = await queuedWithoutAck(fx);
  fx.service.reconcileOnStartup();
  const record = fx.record(queued.proposal_id);
  assert.deepEqual([record.action_state, record.last_error.code, record.last_error.cause_code],
    ['needs_attention', CODES.DISPATCH_FAILED, 'dispatch_lost']);
  assert.equal(fx.runtime.submits.length, 0, 'restart never submits');
  const retried = await fx.gesture('retry', await fx.get(queued.proposal_id));
  assert.equal(retried.ok, true);
  assert.equal(fx.runtime.submits.length, 1);
  assert.equal(fx.runtime.submits[0].idempotencyKey, R.runtimeIdempotencyKey(queued.dispatch_key_sha256));
});

test('startup also expires due pending proposals and ignores unrelated records', async (t) => {
  const fx = createFixture(t);
  const pending = (await fx.publishGit(1)).proposal;
  const dismissed = (await fx.publishGit(2)).proposal;
  await fx.decide(dismissed, 'dismiss');
  fx.advanceDays(8);
  fx.service.reconcileOnStartup();
  assert.equal(fx.record(pending.proposal_id).decision_state, 'expired');
  assert.equal(fx.record(dismissed.proposal_id).decision_state, 'dismissed');
  assert.equal(fx.runtime.submits.length, 0);
});

test('classifyStreamEvent maps the chat-stream vocabulary', () => {
  const cases = [
    [{ type: 'started' }, 'admitted'], [{ type: 'tool_result' }, 'admitted'], [{ type: 'complete' }, 'succeeded'],
    [{ type: 'question_batch' }, 'succeeded'], [{ type: 'error', status: 'cancelled' }, 'cancelled'],
    [{ type: 'error', terminal_status: 'unknown' }, 'failed'], [{ type: 'error', category: 'session_busy' }, null],
    [{}, null], [null, null], [{ type: 5 }, null],
  ];
  for (const [event, expected] of cases) assert.equal(continuation.classifyStreamEvent(event), expected, JSON.stringify(event));
});

test('streamTerminal separates the source turn terminal from the closed completion reason', () => {
  const cases = [
    [{ type: 'complete' }, { terminal: 'complete', completionReason: null }],
    [{ type: 'complete', completionReason: 'awaiting_proposal' }, { terminal: 'complete', completionReason: 'awaiting_proposal' }],
    [{ type: 'complete', completionReason: 7 }, { terminal: 'complete', completionReason: null }],
    [{ type: 'error', status: 'cancelled' }, { terminal: 'cancelled', completionReason: null }],
    [{ type: 'error' }, { terminal: 'failed', completionReason: null }],
    [{ type: 'error', category: 'session_busy' }, { terminal: null, completionReason: null }],
    [{ type: 'started', completionReason: 'awaiting_proposal' }, { terminal: null, completionReason: null }],
    [null, { terminal: null, completionReason: null }],
  ];
  for (const [event, expected] of cases) assert.deepEqual(continuation.streamTerminal(event), expected, JSON.stringify(event));
  assert.equal(continuation.classifyStreamEvent({ type: 'complete', completionReason: 'awaiting_proposal' }), 'succeeded');
});

test('the Do it here request keeps the source mode: Plan stays Plan, auto maps to auto_run, and the choice is do_it_here', () => {
  const record = {
    proposal_id: 'prop_1', source_session_id: 'sess_a', normalized_input: { title: 'Fix it', description: 'Details' },
    decision: { decision_id: 'dec_1', accepted_revision: 2 },
  };
  const plan = continuation.buildLocalContinuationRequest(record, { run_mode: 'plan', preferred_model: 'm1', reasoning_effort: 'high' });
  assert.deepEqual([plan.planMode, plan.approvalMode, plan.preferredModel, plan.reasoningEffort], [true, 'prompt', 'm1', 'high']);
  assert.equal(plan.visiblePrompt, 'Continue in this chat');
  assert.deepEqual(plan.proposalDecision, { proposal_id: 'prop_1', decision_id: 'dec_1', accepted_revision: 2, choice: 'do_it_here' });
  assert.match(plan.prompt, /Fix it\n\nDetails$/u);
  const auto = continuation.buildLocalContinuationRequest(record, { run_mode: 'auto' });
  assert.deepEqual([auto.planMode, auto.approvalMode, auto.preferredModel, auto.reasoningEffort], [false, 'auto_run', '', undefined]);
  assert.equal(continuation.buildLocalContinuationRequest(record, { plan_mode: true }).planMode, true);
  const viaDispatch = continuation.buildContinuationRequest({ ...record, kind: 'session' }, { run_mode: 'plan' });
  assert.equal(viaDispatch.planMode, true);
});

test('submitContinuation uses an injected request builder and the record key', async () => {
  const submits = [];
  const runtime = { submitApplicationTurn: async (request, options) => { submits.push([request, options]); return { ok: true, work_id: 'w1', turn_id: 't1' }; } };
  const record = { source_session_id: 'sess_a', dispatch_key_sha256: 'a'.repeat(64) };
  const result = await continuation.submitContinuation({ runtime, record, session: { x: 1 }, build: (r, s) => ({ built: [r.source_session_id, s.x] }) });
  assert.deepEqual(result, { outcome: 'ack', work_id: 'w1', turn_id: 't1' });
  assert.deepEqual(submits[0][0], { built: ['sess_a', 1] });
  assert.equal(submits[0][1].idempotencyKey, R.runtimeIdempotencyKey('a'.repeat(64)));
});
