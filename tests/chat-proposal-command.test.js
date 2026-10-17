'use strict';

/* Row 59 checkpoint 3, Batch B (proposal side): the exact-command Run through the real
 * ChatProposalService, the command record helpers and the wiring adapter, against a fake
 * command runtime that stands in for the execution side. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const R = require('../services/backend/chat-proposal-records');
const CR = require('../services/backend/chat-proposal-command-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createCommandAdapter } = require('../services/chat-proposal-wiring');
const { createCommandFixture } = require('./helpers/chat-proposal-command-fixture');

const SECRET_COMMAND = 'npm test -- --secret-flag';

// Publishes a command proposal, runs it and returns the settled-in-queued record plus the fixture.
async function runAccepted(t, options = {}, publish = {}) {
  const fx = createCommandFixture(t, options);
  const proposal = (await fx.publishRun(1, publish)).proposal;
  const confirmed = publish.preconditions?.length ? { confirmed_preconditions: publish.preconditions.map((_p, i) => i) } : {};
  const result = await fx.decide(proposal, 'run', confirmed);
  return { fx, proposal, result, record: () => fx.record(proposal.proposal_id) };
}

test('Run persists accepted/queued with its identity BEFORE the single durable submission (E1 shape)', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  assert.equal(proposal.actions.run.available, true);
  assert.equal(proposal.links.command_tool_call_id, null, 'no run decision yet');
  let seenAtSubmit = null;
  fx.cmd.onSubmit = () => { seenAtSubmit = fx.record(proposal.proposal_id); };

  const result = await fx.decide(proposal, 'run');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.created, true);

  assert.equal(seenAtSubmit.decision_state, 'accepted');
  assert.equal(seenAtSubmit.action_state, 'queued');
  assert.equal(seenAtSubmit.continuation_work_id, null, 'durable identity landed before the runtime acknowledged');
  assert.equal(seenAtSubmit.dispatch_key, `proposal:${proposal.proposal_id}:command`);

  const record = fx.record(proposal.proposal_id);
  assert.equal(record.attempt_number, 1);
  assert.match(record.attempt_id, /^[0-9a-f-]{36}$/);
  assert.match(record.command_operation_id, /^[0-9a-f-]{36}$/);
  assert.equal(record.dispatch_key_sha256, R.sha256Hex(record.dispatch_key));
  assert.deepEqual(record.decision.confirmed_preconditions, null);
  assert.equal(record.execution, null);
  assert.equal(record.continuation_work_id, 'work_c1');
  assert.equal(record.continuation_turn_id, 'turn_c1');
  assert.equal(record.action_state, 'queued');

  assert.equal(fx.cmd.submits.length, 1);
  const [submit] = fx.cmd.submits;
  assert.equal(submit.idempotencyKey, R.runtimeIdempotencyKey(record.dispatch_key_sha256));
  assert.equal(submit.sessionId, fx.sessionId);
  assert.deepEqual(submit.commandProposal, {
    schema_version: 1,
    proposal_id: proposal.proposal_id,
    accepted_revision: record.decision.accepted_revision,
    decision_id: record.decision.decision_id,
    command_operation_id: record.command_operation_id,
    tool_call_id: R.commandToolCallId(proposal.proposal_id, record.decision.decision_id),
    command_sha256: R.sha256Hex('npm test'),
    command_binding: { backend: 'native', shell: '/bin/sh', cwd: '.', root_revision: 1 },
    command_input: {
      command: 'npm test', cwd: '.', timeout_seconds: 30, expected_exit_codes: [0], purpose: 'Run the tests',
    },
  });
  assert.match(submit.commandProposal.tool_call_id, /^pcmd_[0-9a-f]{32}$/);
  assert.equal(fx.runtime.submits.length, 0, 'the Git continuation entry is never used for a command');

  assert.equal(result.proposal.links.command_tool_call_id, submit.commandProposal.tool_call_id);
  assert.equal(result.proposal.actions.cancel.available, true);
  assert.equal(result.proposal.actions.retry.available, false);
  assert.equal(result.proposal.actions.run.available, false);
});

test('the DB6 tool call id is deterministic from the proposal and decision ids', () => {
  const id = R.commandToolCallId('proposal_x', 'decision_y');
  assert.equal(id, `pcmd_${R.sha256Hex('proposal_x:decision_y').slice(0, 32)}`);
  assert.equal(id, R.commandToolCallId('proposal_x', 'decision_y'));
  assert.notEqual(id, R.commandToolCallId('proposal_x', 'decision_z'));
});

test('a replayed Run gesture returns the current projection with one submission; a different payload conflicts', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  const request = fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: randomUUID(), choice: 'run',
  });
  const first = await fx.service.decide(request);
  assert.equal(first.ok, true);
  const replay = await fx.service.decide(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(fx.cmd.submits.length, 1);
  assert.equal(fx.cmd.rechecks.length, 1, 'a replay is answered before any recheck');
  const conflict = await fx.service.decide({ ...request, choice: 'dismiss' });
  assert.deepEqual([conflict.ok, conflict.reason, conflict.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  const other = await fx.service.decide({ ...request, decision_id: randomUUID() });
  assert.equal(other.ok, false);
  assert.equal(fx.cmd.submits.length, 1);
});

test('a stale expected revision is refused without a recheck or a submission', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  const result = await fx.decide({ ...proposal, revision: proposal.revision + 5 }, 'run');
  assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'stale_revision', CODES.STALE_REVISION]);
  assert.equal(fx.cmd.rechecks.length, 0);
  assert.equal(fx.cmd.submits.length, 0);
});

test('Run is unsupported_capability, with Copy untouched, when the command protocol is not negotiated', async (t) => {
  const fx = createCommandFixture(t);
  fx.cmd.supported = false;
  const proposal = (await fx.publishRun(1)).proposal;
  assert.deepEqual(proposal.actions.run, { available: false, reason: 'unsupported_capability' });
  const before = JSON.stringify(fx.record(proposal.proposal_id));
  const result = await fx.decide(proposal, 'run');
  assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'unsupported_capability', CODES.UNSUPPORTED_CAPABILITY]);
  assert.equal(JSON.stringify(fx.record(proposal.proposal_id)), before);
  assert.equal(fx.cmd.rechecks.length + fx.cmd.submits.length, 0);
  fx.cmd.supported = true;
  assert.equal((await fx.get(proposal.proposal_id)).actions.run.available, true);
});

test('a throwing capability probe reads as unsupported', async (t) => {
  const fx = createCommandFixture(t);
  fx.cmd.supported = false;
  const adapter = fx.cmd.adapter;
  adapter.isSupported = () => { throw new Error('probe failed'); };
  fx.service._commandAdapter = adapter;
  const proposal = (await fx.publishRun(1)).proposal;
  assert.equal(proposal.actions.run.reason, 'unsupported_capability');
});

test('Plan mode and a read-only session refuse Run (D6); dismiss stays available', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  const planned = await fx.decide(proposal, 'run');
  assert.deepEqual([planned.ok, planned.reason], [false, 'plan_mode']);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'propose' });
  const readOnly = await fx.decide(proposal, 'run');
  assert.deepEqual([readOnly.ok, readOnly.reason], [false, 'read_only']);
  assert.equal(fx.cmd.submits.length, 0);
  assert.equal((await fx.get(proposal.proposal_id)).actions.dismiss.available, true);
});

test('every precondition must be confirmed: exactly [0..n-1], nothing changes otherwise', async (t) => {
  const fx = createCommandFixture(t);
  const preconditions = [{ kind: 'user_confirmation', text: 'Backed up' }, { kind: 'user_confirmation', text: 'On staging' }];
  const proposal = (await fx.publishRun(1, { preconditions })).proposal;
  assert.deepEqual(proposal.display.preconditions, [{ text: 'Backed up' }, { text: 'On staging' }]);
  const before = JSON.stringify(fx.record(proposal.proposal_id));
  for (const extra of [{}, { confirmed_preconditions: [] }, { confirmed_preconditions: [0] }, { confirmed_preconditions: [1, 0] }, { confirmed_preconditions: [0, 2] }]) {
    const refused = await fx.decide(proposal, 'run', extra);
    assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'invalid_request', CODES.INVALID_REQUEST], JSON.stringify(extra));
  }
  assert.equal(JSON.stringify(fx.record(proposal.proposal_id)), before);
  assert.equal(fx.cmd.rechecks.length, 0);
  const ok = await fx.decide(proposal, 'run', { confirmed_preconditions: [0, 1] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(fx.record(proposal.proposal_id).decision.confirmed_preconditions, [0, 1]);
});

test('a proposal with no preconditions accepts Run with confirmations absent or empty, and refuses extras', async (t) => {
  const fx = createCommandFixture(t);
  const a = (await fx.publishRun(1)).proposal;
  const b = (await fx.publishRun(2, { command: 'ls' })).proposal;
  assert.equal((await fx.decide(a, 'run', { confirmed_preconditions: [] })).ok, true);
  assert.deepEqual(fx.record(a.proposal_id).decision.confirmed_preconditions, []);
  assert.equal((await fx.decide(b, 'run', { confirmed_preconditions: [0] })).reason, 'invalid_request');
});

test('binding drift marks the record stale (D7) and nothing is submitted', async (t) => {
  for (const cause of ['root_changed', 'authority_stale', ...CR.COMMAND_DRIFT_CAUSES]) {
    const fx = createCommandFixture(t);
    const proposal = (await fx.publishRun(1)).proposal;
    fx.cmd.recheckResult = { ok: false, cause_code: cause };
    const result = await fx.decide(proposal, 'run');
    assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED], cause);
    assert.equal(fx.cmd.submits.length, 0);
    const record = fx.record(proposal.proposal_id);
    assert.equal(record.decision_state, 'stale');
    assert.equal(record.action_state, 'none');
    assert.deepEqual(record.last_error, { code: CODES.AUTHORITY_CHANGED, reason: 'authority_changed', retryable: false, cause_code: cause });
    const current = await fx.get(proposal.proposal_id);
    assert.equal(current.actions.run.available, false);
    assert.equal((await fx.decide(current, 'run')).reason, 'authority_changed');
    assert.equal(fx.cmd.submits.length, 0);
  }
});

test('a recapture that could not finish is retryable and leaves the proposal pending', async (t) => {
  for (const [recheckResult, reason] of [
    [{ ok: false, cause_code: 'unavailable' }, 'unavailable'],
    [{ ok: false, cause_code: 'binding_budget' }, 'capacity'],
    [new Error('C:\\secret\\path'), 'unavailable'],
    [null, 'unavailable'],
  ]) {
    const fx = createCommandFixture(t);
    const proposal = (await fx.publishRun(1)).proposal;
    fx.cmd.recheckResult = recheckResult;
    const result = await fx.decide(proposal, 'run');
    assert.deepEqual([result.ok, result.reason, result.retryable], [false, reason, true]);
    assert.doesNotMatch(JSON.stringify(result), /secret/u);
    assert.equal(fx.record(proposal.proposal_id).decision_state, 'pending');
    assert.equal(fx.cmd.submits.length, 0);
  }
});

test('a missing recheck port fails closed as unavailable', async (t) => {
  const fx = createCommandFixture(t);
  const adapter = fx.cmd.adapter;
  delete adapter.recheck;
  fx.service._commandAdapter = adapter;
  const proposal = (await fx.publishRun(1)).proposal;
  const result = await fx.decide(proposal, 'run');
  assert.deepEqual([result.ok, result.reason], [false, 'unavailable']);
  assert.equal(fx.cmd.submits.length, 0);
});

test('runtime refusals become needs_attention with no Retry; the command is never resubmitted', async (t) => {
  for (const [mode, code, reason, cause] of [
    ['closing', CODES.UNAVAILABLE, 'unavailable', 'runtime_closing'],
    ['disabled', CODES.UNAVAILABLE, 'unavailable', 'runtime_disabled'],
    ['capacity', CODES.DISPATCH_FAILED, 'dispatch_failed', 'session_pending_capacity'],
  ]) {
    const fx = createCommandFixture(t);
    fx.cmd.mode = mode;
    const proposal = (await fx.publishRun(1)).proposal;
    const result = await fx.decide(proposal, 'run');
    assert.equal(result.ok, true);
    assert.equal(result.proposal.action_state, 'needs_attention');
    assert.deepEqual(result.proposal.last_error, { code, reason, retryable: false, cause_code: cause });
    assert.equal(result.proposal.actions.retry.available, false);
    assert.equal(result.proposal.actions.cancel.available, false);
    const retry = await fx.gesture('retry', result.proposal);
    assert.equal(retry.ok, false);
    assert.equal(fx.cmd.submits.length, 1);
  }
});

test('an unconfirmed submission is adopted from the runtime store when it was committed, else outcome_unknown', async (t) => {
  const committed = createCommandFixture(t);
  committed.cmd.mode = 'committed-unknown';
  const p1 = (await committed.publishRun(1)).proposal;
  const r1 = await committed.decide(p1, 'run');
  assert.equal(r1.proposal.action_state, 'queued');
  assert.equal(committed.record(p1.proposal_id).continuation_work_id, 'work_c1');

  for (const configure of [(fx) => { fx.cmd.mode = 'unknown'; }, (fx) => { fx.cmd.mode = 'throw'; }, (fx) => { fx.cmd.mode = 'unknown'; fx.cmd.hasFind = false; }]) {
    const fx = createCommandFixture(t);
    configure(fx);
    const proposal = (await fx.publishRun(1)).proposal;
    const result = await fx.decide(proposal, 'run');
    assert.equal(result.proposal.action_state, 'needs_attention');
    assert.deepEqual(result.proposal.last_error, {
      code: CODES.OUTCOME_UNKNOWN, reason: 'outcome_unknown', retryable: false, cause_code: 'dispatch_unconfirmed',
    });
    assert.equal(result.proposal.execution.status, 'interrupted_unknown');
    assert.doesNotMatch(JSON.stringify([result, fx.logs]), /secret/u);
    assert.equal(fx.cmd.submits.length, 1);
  }
});

test('progress and outcome events drive admitted, then each settled state (E3)', async (t) => {
  const cases = [
    ['succeeded', { exit_code: 0, cleanup: 'confirmed' }, 'succeeded', null],
    ['failed', { exit_code: 2, cleanup: 'confirmed' }, 'failed', null],
    ['denied', {}, 'failed', null],
    ['cancelled', { cleanup: 'confirmed' }, 'cancelled', null],
    ['interrupted_unknown', { cleanup: 'uncertain' }, 'needs_attention', 'interrupted'],
    ['succeeded', { exit_code: 0, cleanup: 'uncertain' }, 'needs_attention', 'cleanup_uncertain'],
  ];
  for (const [status, extra, action, cause] of cases) {
    const { fx, record } = await runAccepted(t);
    let current = record();
    fx.progress(current, 'pending_approval');
    current = record();
    assert.equal(current.action_state, 'admitted');
    assert.deepEqual(current.execution, { status: 'pending_approval', exit_code: null, cleanup: null });
    fx.progress(current, 'running');
    assert.deepEqual(record().execution, { status: 'running', exit_code: null, cleanup: null });
    const revision = record().revision;
    fx.progress(record(), 'running');
    assert.equal(record().revision, revision, 'a repeated progress event changes nothing');

    fx.outcome(record(), status, extra);
    const settled = record();
    assert.equal(settled.action_state, action, status);
    assert.deepEqual(settled.execution, {
      status, exit_code: extra.exit_code ?? null, cleanup: extra.cleanup ?? null,
    });
    if (cause) {
      assert.deepEqual(settled.last_error, { code: CODES.OUTCOME_UNKNOWN, reason: 'outcome_unknown', retryable: false, cause_code: cause });
    } else {
      assert.equal(settled.last_error, null);
    }
    const projected = await fx.get(settled.proposal_id);
    assert.equal(projected.actions.cancel.available, false);
    assert.equal(projected.actions.retry.available, false);
    assert.equal(projected.execution.status, status);
    const frozen = JSON.stringify(settled);
    fx.outcome(settled, 'failed', { exit_code: 9 });
    fx.progress(settled, 'running');
    assert.equal(JSON.stringify(record()), frozen, 'a late event after settlement is ignored');
  }
});

test('events before the acknowledgment is persisted still land and adopt the work ids', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  fx.cmd.onSubmit = () => {
    const accepted = fx.record(proposal.proposal_id);
    fx.progress(accepted, 'running', { work_id: 'work_early', turn_id: 'turn_early' });
    fx.outcome(fx.record(proposal.proposal_id), 'succeeded', { exit_code: 0, cleanup: 'confirmed' }, { work_id: 'work_early', turn_id: 'turn_early' });
  };
  const result = await fx.decide(proposal, 'run');
  assert.equal(result.ok, true);
  const record = fx.record(proposal.proposal_id);
  assert.equal(record.action_state, 'succeeded');
  assert.equal(record.continuation_work_id, 'work_early', 'the early event owns the ids; the late ack does not overwrite');
  assert.equal(record.continuation_turn_id, 'turn_early');
});

test('events for another decision, session, shape or status are ignored', async (t) => {
  const { fx, record } = await runAccepted(t);
  const current = record();
  const frozen = JSON.stringify(current);
  const good = {
    schema_version: 1, session_id: fx.sessionId, proposal_id: current.proposal_id, decision_id: current.decision.decision_id, status: 'running',
  };
  for (const bad of [
    { ...good, decision_id: randomUUID() }, { ...good, proposal_id: `proposal_${'0'.repeat(64)}` }, { ...good, session_id: 'nope' },
    { ...good, schema_version: 2 }, { ...good, status: 'exploded' }, { ...good, status: 'succeeded' }, null, 'text', {},
  ]) {
    fx.service.handleCommandProgress(bad);
    assert.equal(JSON.stringify(record()), frozen);
  }
  fx.service.handleCommandOutcome({ ...good, status: 'running' });
  fx.service.handleCommandOutcome(null);
  assert.equal(JSON.stringify(record()), frozen);
  const git = (await fx.publishGit(2)).proposal;
  fx.service.handleCommandProgress({ ...good, proposal_id: git.proposal_id });
  assert.equal(fx.record(git.proposal_id).action_state, 'none');
});

test('every Run transition notifies the renderer and the session rail', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  const before = { rail: fx.rail.length, events: fx.events.length };
  await fx.decide(proposal, 'run');
  assert.ok(fx.rail.length > before.rail);
  const railAfterAccept = fx.rail.length;
  fx.progress(fx.record(proposal.proposal_id), 'running');
  fx.outcome(fx.record(proposal.proposal_id), 'succeeded', { exit_code: 0, cleanup: 'confirmed' });
  assert.ok(fx.rail.length >= railAfterAccept + 2);
});

test('cancel: queued work discarded is cancelled now, running work waits for its outcome event', async (t) => {
  const queued = await runAccepted(t);
  const proposal = (await queued.fx.get(queued.proposal.proposal_id));
  const result = await queued.fx.gesture('cancel', proposal);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(queued.fx.cmd.cancels, ['work_c1']);
  assert.equal(queued.record().action_state, 'cancelled');
  assert.deepEqual(queued.record().execution, { status: 'cancelled', exit_code: null, cleanup: null });
  assert.equal(queued.fx.runtime.cancels.length, 0, 'a command cancel never goes through the Git continuation runtime');

  const running = await runAccepted(t);
  running.fx.cmd.cancelResult = { status: 'requested' };
  running.fx.progress(running.record(), 'running');
  const live = await running.fx.get(running.proposal.proposal_id);
  const requested = await running.fx.gesture('cancel', live);
  assert.equal(requested.ok, true);
  assert.equal(running.record().action_state, 'admitted', 'the turn terminal settles it, not the request');
  running.fx.outcome(running.record(), 'cancelled', { cleanup: 'confirmed' });
  assert.equal(running.record().action_state, 'cancelled');
});

test('cancel edge cases: no work id yet, runtime rejection, a throwing port, replay, wrong state', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  fx.cmd.mode = 'unknown';
  fx.cmd.hasFind = false;
  const pending = (await fx.publishRun(2, { command: 'ls' })).proposal;
  assert.equal((await fx.gesture('cancel', proposal)).reason, 'not_pending', 'a pending proposal has nothing to cancel');
  await fx.decide(pending, 'run');
  assert.equal((await fx.gesture('cancel', await fx.get(pending.proposal_id))).reason, 'not_pending', 'needs_attention has nothing to cancel');

  const ok = createCommandFixture(t);
  const accepted = (await ok.publishRun(1)).proposal;
  await ok.decide(accepted, 'run');
  const live = await ok.get(accepted.proposal_id);
  ok.cmd.cancelResult = { status: 'rejected' };
  assert.equal((await ok.gesture('cancel', live)).reason, 'not_pending');
  ok.cmd.cancelResult = new Error('C:\\secret');
  const thrown = await ok.gesture('cancel', live);
  assert.deepEqual([thrown.ok, thrown.reason, thrown.retryable], [false, 'unavailable', true]);
  ok.cmd.cancelResult = { status: 'cancelled' };
  const request = ok.request({ proposal_id: live.proposal_id, expected_revision: live.revision, decision_id: randomUUID() });
  assert.equal((await ok.service.cancel(request)).created, true);
  const replay = await ok.service.cancel(request);
  assert.equal(replay.created, false);
  assert.equal(ok.cmd.cancels.length, 3);
});

test('startup reconciliation settles every unsettled command from the runtime store and never resubmits', async (t) => {
  const fx = createCommandFixture(t);
  const make = async (n, mode) => {
    fx.cmd.mode = mode;
    const proposal = (await fx.publishRun(n, { command: `echo ${n}` })).proposal;
    await fx.decide(proposal, 'run');
    return proposal.proposal_id;
  };
  const queuedCancelled = await make(1, 'ok');
  const admitted = await make(2, 'ok');
  fx.progress(fx.record(admitted), 'running');
  const completedNoOutcome = await make(3, 'ok');
  const paused = await make(4, 'ok');
  const missing = await make(5, 'ok');
  // Crash between the durable acceptance and the submission: queued, never acknowledged.
  const lostProposal = (await fx.publishRun(6, { command: 'echo 6' })).proposal;
  fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({
    records: records.map((entry) => (entry.proposal_id === lostProposal.proposal_id
      ? CR.acceptCommandDecision(entry, { decisionId: randomUUID(), now: fx.clock.ms }) : entry)),
  }));
  const lostSubmission = lostProposal.proposal_id;
  const done = await make(7, 'ok');
  fx.outcome(fx.record(done), 'succeeded', { exit_code: 0, cleanup: 'confirmed' });

  const setStatus = (proposalId, status) => { fx.runtime.works.set(fx.record(proposalId).continuation_work_id, { work_id: fx.record(proposalId).continuation_work_id, status, session_id: fx.sessionId }); };
  setStatus(queuedCancelled, 'cancelled');
  setStatus(admitted, 'running');
  setStatus(completedNoOutcome, 'completed');
  setStatus(paused, 'restart_paused');
  // `missing` has a work id the runtime store does not know; `lostSubmission` has none at all.
  const submitsBefore = fx.cmd.submits.length;
  fx.service.reconcileOnStartup();

  const state = (id) => fx.record(id);
  assert.equal(state(queuedCancelled).action_state, 'cancelled');
  assert.equal(state(queuedCancelled).execution.status, 'cancelled');
  for (const id of [admitted, completedNoOutcome, paused, missing]) {
    assert.equal(state(id).action_state, 'needs_attention', id);
    assert.deepEqual(state(id).last_error, { code: CODES.OUTCOME_UNKNOWN, reason: 'outcome_unknown', retryable: false, cause_code: 'restart' });
    assert.equal(state(id).execution.status, 'interrupted_unknown');
  }
  assert.equal(state(lostSubmission).action_state, 'needs_attention');
  assert.equal(state(lostSubmission).last_error.cause_code, 'dispatch_lost');
  assert.equal(state(done).action_state, 'succeeded', 'a settled record is untouched');
  assert.equal(fx.cmd.submits.length, submitsBefore, 'restart never resubmits');
  assert.equal(fx.cmd.cancels.length, 0);
});

test('reconciliation with an unreadable runtime still lands on outcome_unknown', async (t) => {
  const fx = createCommandFixture(t);
  const proposal = (await fx.publishRun(1)).proposal;
  await fx.decide(proposal, 'run');
  fx.runtime = null;
  fx.service.reconcileOnStartup();
  assert.equal(fx.record(proposal.proposal_id).action_state, 'needs_attention');
  assert.equal(fx.record(proposal.proposal_id).last_error.code, CODES.OUTCOME_UNKNOWN);
});

test('no log line, error or projection of a failure carries the command, cwd or paths', async (t) => {
  const fx = createCommandFixture(t);
  fx.cmd.mode = 'throw';
  const proposal = (await fx.publishRun(1, { command: SECRET_COMMAND })).proposal;
  const results = [await fx.decide(proposal, 'run')];
  fx.progress(fx.record(proposal.proposal_id), 'running');
  fx.service.handleCommandProgress({ schema_version: 1, session_id: fx.sessionId, proposal_id: proposal.proposal_id, decision_id: randomUUID(), status: 'running' });
  results.push(await fx.get(proposal.proposal_id));
  assert.doesNotMatch(JSON.stringify(fx.logs), /secret-flag|npm test|secret|boom/u);
  assert.doesNotMatch(JSON.stringify(results.map((entry) => entry.last_error ?? entry.error_code ?? null)), /secret-flag|npm test|boom/u);
});

test('Git proposals and the Git continuation are unaffected by the command ports', async (t) => {
  const fx = createCommandFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  const result = await fx.decide(git, 'commit');
  assert.equal(result.ok, true);
  assert.equal(fx.runtime.submits.length, 1);
  assert.equal(fx.cmd.submits.length, 0);
  assert.equal(fx.cmd.rechecks.length, 0);
  const projected = await fx.get(git.proposal_id);
  assert.equal(projected.links.command_tool_call_id, null);
  assert.equal(projected.actions.run, undefined);
});

// ---- command record helpers (pure) ----

function pendingCommand() {
  const input = R.normalizeCommandProposalInput({ command: 'ls', cwd: '.', purpose: 'List' }, { shell: '/bin/sh' }).value;
  const binding = {
    source_project_id: null, workspace_id: 'root_1', root_identity: { root_id: 'root_1', device_id: '1', inode: '2' },
    authority_revision: 4, run_mode: 'agent', restrictions: { read_only: false, plan_mode: false }, model: null, effort: null,
    git: null, command: { backend: 'native', shell: '/bin/sh', cwd: '.', command_sha256: R.sha256Hex('ls') },
  };
  const created = R.createProposalRecord({
    kind: 'command', sessionId: 's1', sessionIncarnation: 'i1', turnId: 't1', toolCallId: 'c1', input, binding, now: Date.parse('2026-10-15T10:00:00.000Z'),
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.record;
}

const NOW = Date.parse('2026-10-15T10:01:00.000Z');

test('acceptCommandDecision builds a normalizable accepted/queued record only from a live pending command', () => {
  const record = pendingCommand();
  const accepted = CR.acceptCommandDecision(record, { decisionId: randomUUID(), now: NOW, confirmedPreconditions: [] });
  assert.equal(accepted.decision_state, 'accepted');
  assert.equal(accepted.action_state, 'queued');
  assert.equal(accepted.revision, record.revision + 1);
  assert.equal(accepted.decision.accepted_revision, accepted.revision);
  assert.equal(accepted.decision.choice, 'run');
  assert.deepEqual(accepted.decision.confirmed_preconditions, []);
  assert.equal(accepted.dispatch_key, CR.buildCommandDispatchKey(record.proposal_id));
  assert.equal(accepted.attempt_number, 1);
  assert.notEqual(R.normalizeProposalRecord(accepted), null);

  assert.equal(CR.acceptCommandDecision(record, { decisionId: 'not-a-uuid', now: NOW }), null);
  assert.equal(CR.acceptCommandDecision(record, { decisionId: randomUUID(), now: NOW + 8 * 24 * 3600 * 1000 }), null, 'expired');
  assert.equal(CR.acceptCommandDecision(accepted, { decisionId: randomUUID(), now: NOW }), null, 'already accepted');
  assert.equal(CR.acceptCommandDecision({ ...record, kind: 'git' }, { decisionId: randomUUID(), now: NOW }), null);
});

test('command transitions only apply from their allowed states', () => {
  const queued = CR.acceptCommandDecision(pendingCommand(), { decisionId: randomUUID(), now: NOW });
  assert.equal(CR.markCommandProgress(pendingCommand(), { status: 'running' }), null);
  assert.equal(CR.markCommandProgress(queued, { status: 'nonsense' }), null);
  assert.equal(CR.markCommandOutcome(queued, { status: 'nonsense' }), null);
  assert.equal(CR.markCommandOutcome(pendingCommand(), { status: 'succeeded' }), null);
  assert.equal(CR.markCommandRefused(pendingCommand()), null);
  assert.equal(CR.markCommandAcknowledged(queued, { workId: 1, turnId: 'x' }), null);

  const acked = CR.markCommandAcknowledged(queued, { workId: 'w1', turnId: 't1' });
  assert.equal(acked.action_state, 'queued');
  assert.equal(CR.markCommandAcknowledged(acked, { workId: 'w2', turnId: 't2' }), null, 'ids are adopted once');
  const refused = CR.markCommandRefused(acked, { runtimeUnavailable: true, causeCode: 'runtime_closing' });
  assert.equal(R.normalizeProposalRecord(refused) !== null, true);
  assert.equal(CR.markCommandOutcome(refused, { status: 'failed' }), null, 'needs_attention takes no outcome');
  const done = CR.markCommandOutcome(acked, { status: 'failed', exitCode: 2, cleanup: 'confirmed' });
  assert.equal(R.normalizeProposalRecord(done) !== null, true);
  assert.equal(CR.markCommandOutcomeUnknown(done), null);
  const unknown = CR.markCommandOutcomeUnknown(acked, { causeCode: 'restart' });
  assert.equal(R.normalizeProposalRecord(unknown) !== null, true);
  assert.equal(unknown.execution.status, 'interrupted_unknown');
});

// ---- wiring adapter ----

test('the wiring adapter resolves the runtime lazily and degrades to unavailable without it', async () => {
  const none = createCommandAdapter({});
  assert.equal(none.isSupported(), false);
  assert.deepEqual(await none.submit({ idempotencyKey: 'k' }), { ok: false, reason: 'runtime_unavailable', acceptance: 'rejected' });
  assert.throws(() => none.cancel('w'), /runtime_unavailable/u);
  assert.equal(none.find('k'), null);

  const calls = [];
  const backendService = {
    sessionRuntime: {
      submitCommandProposal: async (args) => { calls.push(['submit', args]); return { ok: true, work_id: 'w', turn_id: 't' }; },
      cancel: (workId, options) => { calls.push(['cancel', workId, options]); return { status: 'requested' }; },
      findApplicationSubmission: (key) => { calls.push(['find', key]); return { work_id: 'w' }; },
    },
  };
  const live = createCommandAdapter(backendService);
  assert.deepEqual(await live.submit({ idempotencyKey: 'k', sessionId: 's', commandProposal: {} }), { ok: true, work_id: 'w', turn_id: 't' });
  assert.deepEqual(live.cancel('w'), { status: 'requested' });
  assert.deepEqual(live.find('k'), { work_id: 'w' });
  assert.deepEqual(calls, [
    ['submit', { idempotencyKey: 'k', sessionId: 's', commandProposal: {} }],
    ['cancel', 'w', { reason: 'user' }],
    ['find', 'k'],
  ]);
  assert.equal(typeof live.isSupported(), 'boolean');
  assert.equal(typeof live.recheck, 'function');
});
