'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../services/session-handoff-preparation');
const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { NOW, DECISION, ATTEMPT, identity } = require('./helpers/chat-proposal-records-fixture');

function fixture({ background = 'Earlier context', queued = false, sourceMode = 'plan' } = {}) {
  const plan = sourceMode === 'plan';
  const binding = {
    source_project_id: 'project_source', workspace_id: null, root_identity: null, authority_revision: 3,
    run_mode: plan ? 'plan' : 'agent', restrictions: { read_only: plan, plan_mode: plan }, model: 'source_model', effort: 'low',
    git: null, command: null, session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null,
      source_run_mode: sourceMode, lockdown: plan,
    },
  };
  let record = R.createProposalRecord({
    kind: 'session', ...identity(), binding,
    input: S.normalizeSessionProposalInput({ title: 'Linked task', initiation: 'offer' }).value,
    options: S.defaultOptions({ sourceProjectId: 'project_dest', model: 'child_model', effort: 'high', planMode: plan }),
  }).record;
  record = S.acceptSessionDecision(record, { decisionId: DECISION, choice: 'new_session', now: NOW, attemptId: ATTEMPT });
  record = S.markPrepAcknowledged(record, { workId: 'work_p', turnId: 'turn_p' });
  if (!queued) record = S.markPreparing(record);
  const children = new Map();
  const submissions = [];
  const notifications = [];
  const runtime = {
    async submitApplicationTurn(request, options) {
      submissions.push({ request, options });
      return { ok: true, work_id: 'work_first', turn_id: 'turn_first' };
    },
  };
  const ports = {
    records: R, now: () => NOW, createId: () => ATTEMPT, log() {},
    store: {
      read: () => ({ ok: true, records: [record], session_incarnation: 'inc_a' }),
      mutate(id, fn) {
        assert.equal(id, 'sess_a');
        const next = fn({ records: [structuredClone(record)] });
        if (next.abort) return { ok: true, aborted: true, value: next.abort };
        assert.deepEqual(R.normalizeProposalRecord(next.records[0]), next.records[0]);
        [record] = next.records;
        return { ok: true, records: [record] };
      },
    },
    notify: (id) => notifications.push(id), getRuntime: () => runtime,
    getSessionSummary: () => ({ run_mode: 'plan', preferred_model: 'source_model', reasoning_effort: 'low' }),
    createLinkedChildSession(spec) { children.set(spec.childSessionId, spec); return { ok: true, session_id: spec.childSessionId }; },
    sessionExists: (id) => children.has(id), readSpawnedFrom: (id) => children.get(id)?.spawnedFrom,
    deadlines: new Map(), setTimer: () => 1, clearTimer() {},
  };
  const args = { sessionId: 'sess_a', sessionIncarnation: 'inc_a', turnId: 'turn_p', toolCallId: 'call_h',
    proposalId: record.proposal_id, attemptId: ATTEMPT, task: 'Implement the task', background };
  return { ports, args, children, submissions, notifications, runtime, record: () => record };
}

test('preparation request binds the accepted attempt and preserves source preferences and Plan', () => {
  const f = fixture();
  const request = H.buildPreparationRequest(f.record(), f.ports.getSessionSummary());
  assert.deepEqual(request.sessionHandoffPreparation, { proposal_id: f.args.proposalId, attempt_id: ATTEMPT });
  assert.equal(request.sessionId, 'sess_a');
  assert.equal(request.planMode, true);
  assert.equal(request.preferredModel, 'source_model');
  assert.equal(request.reasoningEffort, 'low');
  assert.equal(request.approvalMode, 'prompt');
  assert.match(request.prompt, /complete_session_handoff exactly once/);
  assert.match(request.prompt, /Do not start the work/);
  assert.deepEqual(request.attachments, []);
  assert.equal(H.buildPreparationRequest(f.record(), { run_mode: 'auto' }).approvalMode, 'auto_run');
});

test('handoff completes from queued, replays without effects and rejects changed text', async () => {
  const f = fixture({ queued: true });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.ok, true);
  assert.equal(result.admission_state, 'queued');
  assert.equal(f.record().action_state, 'succeeded');
  assert.equal(f.children.size, 1);
  assert.equal(f.submissions.length, 1);
  const spec = [...f.children.values()][0];
  assert.match(spec.childSessionId, /^sess_[0-9]+_[0-9a-f]{12}$/);
  assert.match(spec.childIncarnation, /^inc_[0-9a-f]{32}$/);
  assert.equal(spec.spawnedFrom.child_creation_hash, f.record().child_creation_hash);
  assert.equal(spec.preferences.run_mode, 'plan');
  assert.equal(spec.lockdown, true);
  const count = f.notifications.length;
  assert.deepEqual(await H.completeSessionHandoff(f.ports, f.args), result);
  assert.equal(f.notifications.length, count);
  assert.equal(f.submissions.length, 1);
  assert.equal((await H.completeSessionHandoff(f.ports, { ...f.args, task: 'Changed task' })).reason, 'idempotency_conflict');
});

test('wrong attempt, incarnation or preparation turn is unauthorized; invalid text identifies its field', async () => {
  const f = fixture();
  for (const patch of [{ attemptId: DECISION }, { sessionIncarnation: 'other' }, { turnId: 'other' }]) {
    assert.equal((await H.completeSessionHandoff(f.ports, { ...f.args, ...patch })).reason, 'authorization_required');
  }
  for (const patch of [{ task: '' }, { background: String.fromCodePoint(0x202e) }]) {
    const result = await H.completeSessionHandoff(f.ports, { ...f.args, ...patch });
    assert.equal(result.reason, 'invalid_request');
    assert.equal(result.cause_code, patch.task === '' ? 'field_task' : 'field_background');
  }
  assert.equal(f.children.size, 0);
});

test('failed reservation flush creates no child and submits nothing', async () => {
  const f = fixture();
  f.ports.store.mutate = () => ({ ok: false, reason: 'io_failed' });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.reason, 'preparation_failed');
  assert.equal(f.record().handoff, null);
  assert.equal(f.children.size, 0);
  assert.equal(f.submissions.length, 0);
});

test('failed child flush marks retryable attention and retry reuses the reserved proof', async () => {
  const f = fixture();
  const create = f.ports.createLinkedChildSession;
  f.ports.createLinkedChildSession = () => ({ ok: false, code: 'flush_failed' });
  assert.equal((await H.completeSessionHandoff(f.ports, f.args)).reason, 'preparation_failed');
  assert.equal(f.record().action_state, 'needs_attention');
  const proof = f.record().child_creation_hash;
  f.ports.store.mutate('sess_a', ({ records }) => ({ records: [S.prepareSessionRetry(records[0], { attemptId: DECISION })] }));
  f.ports.createLinkedChildSession = create;
  const result = await H.resumeChildCreation(f.ports, f.args);
  assert.equal(result.ok, true);
  assert.equal(f.record().child_creation_hash, proof);
  assert.equal(f.children.size, 1);
});

test('existing child with another proof is refused without creating or submitting', async () => {
  const f = fixture();
  f.ports.sessionExists = () => true;
  f.ports.readSpawnedFrom = () => ({ child_creation_hash: 'wrong' });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.reason, 'preparation_failed');
  assert.equal(f.record().last_error.cause_code, 'proof_mismatch');
  assert.equal(f.record().action_state, 'needs_attention');
  assert.equal(f.children.size, 0);
  assert.equal(f.submissions.length, 0);
});

test('first-turn refusal keeps child, empty background omits context, retry keeps key and child', async () => {
  const f = fixture({ background: '' });
  const submit = f.runtime.submitApplicationTurn;
  f.runtime.submitApplicationTurn = async (request, options) => {
    f.submissions.push({ request, options });
    return { ok: false, acceptance: 'rejected', reason: 'runtime_closing' };
  };
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.admission_state, 'needs_attention');
  assert.equal(f.record().last_error.reason, 'unavailable');
  assert.equal(f.children.size, 1);
  assert.equal(Object.hasOwn(f.submissions[0].request, 'sessionHandoff'), false);
  assert.deepEqual(await H.completeSessionHandoff(f.ports, f.args), result);
  f.ports.store.mutate('sess_a', ({ records }) => ({ records: [S.prepareSessionRetry(records[0], { attemptId: DECISION })] }));
  f.runtime.submitApplicationTurn = submit;
  assert.equal((await H.resumeChildCreation(f.ports, f.args)).ok, true);
  assert.equal(f.children.size, 1);
  assert.deepEqual(f.submissions[0].options, f.submissions[1].options);
});

test('unproven submission reconciles by child session and exact first-turn key', async () => {
  const f = fixture();
  f.runtime.submitApplicationTurn = async () => { throw new Error('lost receipt'); };
  f.runtime.findApplicationSubmission = (key) => {
    assert.equal(key, R.runtimeIdempotencyKey(R.sha256Hex(`proposal:${f.args.proposalId}:first_turn`)));
    return { session_id: f.record().child_session_id, work_id: 'reconciled_work', turn_id: 'reconciled_turn' };
  };
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.first_turn_work_id, 'reconciled_work');
  assert.equal(result.first_turn_turn_id, 'reconciled_turn');
});

test('a Plan snapshot keeps the child in Plan with prompted approval even when the source later runs auto', async () => {
  const f = fixture();
  f.ports.getSessionSummary = () => ({ run_mode: 'auto', preferred_model: 'changed', reasoning_effort: 'low' });
  await H.completeSessionHandoff(f.ports, f.args);
  const { request } = f.submissions[0];
  assert.equal(request.approvalMode, 'prompt');
  assert.equal(request.planMode, true);
  assert.equal(request.preferredModel, 'child_model');
  assert.equal(request.reasoningEffort, 'high');
  const [spec] = f.children.values();
  assert.equal(spec.preferences.run_mode, 'plan');
  assert.equal(spec.lockdown, true);
});

test('the child takes the stricter of the publish-time and current source authority (D10)', async () => {
  const auto = fixture({ sourceMode: 'auto' });
  auto.ports.getSessionSummary = () => ({ run_mode: 'auto' });
  await H.completeSessionHandoff(auto.ports, auto.args);
  assert.equal(auto.submissions[0].request.approvalMode, 'auto_run');
  assert.equal([...auto.children.values()][0].preferences.run_mode, 'auto');

  for (const [summary, mode, lockdown] of [
    [{ run_mode: 'propose' }, 'propose', false],
    [{ run_mode: 'auto', plan_mode: true }, 'plan', false],
    [{ run_mode: 'ask', lockdown: true }, 'ask', true],
    [null, 'ask', false],
  ]) {
    const f = fixture({ sourceMode: 'auto' });
    f.ports.getSessionSummary = () => summary;
    await H.completeSessionHandoff(f.ports, f.args);
    const [spec] = f.children.values();
    assert.equal(spec.preferences.run_mode, mode, JSON.stringify(summary));
    assert.equal(spec.lockdown, lockdown, JSON.stringify(summary));
    assert.equal(f.submissions[0].request.approvalMode, 'prompt');
    assert.equal(f.submissions[0].request.planMode, mode === 'plan');
  }
});

test('a failed write of the admitted first turn leaves the record retryable, not stuck at Starting', async () => {
  const f = fixture();
  const mutate = f.ports.store.mutate;
  let failed = false;
  f.ports.store.mutate = (id, fn) => mutate(id, (state) => {
    const next = fn(state);
    if (!failed && next.records?.[0]?.action_state === 'succeeded') {
      failed = true;
      return { abort: 'io_failed' };
    }
    return next;
  });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.ok, false);
  assert.equal(f.record().action_state, 'needs_attention');
  assert.equal(S.canRetrySession(f.record()), true);
});

test('runtime unavailable retains the created child and marks retryable attention', async () => {
  const f = fixture();
  f.ports.getRuntime = () => null;
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.admission_state, 'needs_attention');
  assert.equal(f.children.size, 1);
  assert.equal(f.record().last_error.reason, 'unavailable');
  assert.equal(f.submissions.length, 0);
});

test('unproven acknowledgment from another child cannot establish admission', async () => {
  const f = fixture();
  f.runtime.submitApplicationTurn = async () => ({ ok: true });
  f.runtime.findApplicationSubmission = () => ({ session_id: 'other_child', work_id: 'other_work', turn_id: 'other_turn' });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.admission_state, 'needs_attention');
  assert.equal(f.record().first_turn_work_id, null);
});

test('deadline start and clear are idempotent and successful reservation clears the timer', async () => {
  const f = fixture();
  let callback; let starts = 0; let clears = 0; let expired = 0;
  f.ports.setTimer = (fn, delay) => { callback = fn; starts += 1; assert.equal(delay, 60000); return 7; };
  f.ports.clearTimer = (handle) => { clears += 1; assert.equal(handle, 7); };
  const args = { ...f.args, stage: 'output', onExpire: () => { expired += 1; } };
  H.startPreparationDeadline(f.ports, args);
  H.startPreparationDeadline(f.ports, args);
  assert.equal(starts, 1);
  H.clearPreparationDeadline(f.ports, args);
  H.clearPreparationDeadline(f.ports, args);
  assert.equal(clears, 1);
  H.startPreparationDeadline(f.ports, args);
  callback();
  assert.equal(expired, 1);
  assert.equal(f.ports.deadlines.size, 0);
  H.startPreparationDeadline(f.ports, args);
  await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(clears, 2);
  assert.equal(f.ports.deadlines.size, 0);
});

test('admission arms the first-output limit; the first output swaps it for the 60 s deadline exactly once', () => {
  const f = fixture();
  const timers = [];
  f.ports.setTimer = (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; };
  f.ports.clearTimer = (timer) => { timer.cleared = true; };
  const args = { ...f.args, onExpire() {} };
  H.startPreparationDeadline(f.ports, { ...args, stage: 'admitted' });
  assert.deepEqual(timers.map((timer) => [timer.delay, timer.cleared]), [[H.PREPARATION_FIRST_OUTPUT_LIMIT_MS, false]]);
  H.startPreparationDeadline(f.ports, { ...args, stage: 'output' });
  H.startPreparationDeadline(f.ports, { ...args, stage: 'output' });
  H.startPreparationDeadline(f.ports, { ...args, stage: 'admitted' });
  assert.deepEqual(timers.map((timer) => [timer.delay, timer.cleared]),
    [[H.PREPARATION_FIRST_OUTPUT_LIMIT_MS, true], [H.PREPARATION_DEADLINE_MS, false]],
    'a late admission event never re-arms the first-output limit');
  H.clearPreparationDeadline(f.ports, args);
  assert.equal(timers[1].cleared, true);
  assert.equal(f.ports.deadlines.size, 0);
});

test('a whitespace-only Background sends no handoff row instead of failing the child first turn', async () => {
  const f = fixture({ background: ' \n\t ' });
  const result = await H.completeSessionHandoff(f.ports, f.args);
  assert.equal(result.ok, true);
  assert.equal(f.children.size, 1);
  assert.equal(Object.hasOwn(f.submissions[0].request, 'sessionHandoff'), false);
});
