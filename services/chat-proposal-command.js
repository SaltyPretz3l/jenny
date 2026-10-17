'use strict';

/* services/chat-proposal-command.js - the exact-command Run of an inline command proposal
 * (row 59 checkpoint 3, Batch B): the Run decision, its durable submission, the progress and
 * outcome events the runtime emits, and startup reconciliation. It works on a
 * ChatProposalService instance (`svc`) through that service's own record plumbing and a
 * `commandAdapter` of ports injected by the composition root:
 *   isSupported() -> boolean       the sidecar negotiated the command protocol
 *   recheck(record) -> {ok} | {ok:false, cause_code}   binding recapture (D7)
 *   submit({idempotencyKey, sessionId, commandProposal}) -> runtime result envelope
 *   cancel(workId) -> {status}     aborts or discards the command work
 *   find(idempotencyKey) -> work | null   optional, reconciles an unconfirmed submission
 * The Run click is the user's intent, never an approval: the sidecar's command policy still
 * decides (DB1). Nothing here resubmits, retries or resumes, on restart or otherwise (DB7), and
 * no diagnostic carries the command, its cwd or any path.
 */

const CR = require('./backend/chat-proposal-command-records');
const { fail, succeed } = require('./chat-proposal-contract');

const RUNTIME_UNAVAILABLE_REASONS = new Set(['runtime_unavailable', 'runtime_disabled', 'runtime_closing']);

function applyTo(svc, sessionId, proposalId, build) {
  return svc._apply(sessionId, proposalId, (current) => {
    const next = build(current);
    return next ? { record: next } : { abort: { reason: 'noop' } };
  });
}

// Every precondition must be confirmed: exactly [0..n-1] (nothing when there are none).
function confirmationComplete(record, confirmed) {
  const list = confirmed ?? [];
  return list.length === record.normalized_input.preconditions.length && list.every((value, index) => value === index);
}

async function recheck(adapter, record) {
  try {
    const result = await adapter.recheck(record);
    return result && typeof result === 'object' ? result : { ok: false, cause_code: 'unavailable' };
  } catch {
    return { ok: false, cause_code: 'unavailable' };
  }
}

// Submits the accepted/queued record and persists the acknowledgment or the honest outcome.
// A rejection (nothing ran) is needs_attention unavailable | dispatch_failed; an unconfirmed
// acceptance that the runtime store cannot prove is outcome_unknown. Never throws.
async function dispatch(svc, sessionId, record) {
  const adapter = svc._commandAdapter;
  const proposalId = record.proposal_id;
  const key = svc._records.runtimeIdempotencyKey(record.dispatch_key_sha256);
  let result;
  try {
    result = await adapter.submit({
      idempotencyKey: key, sessionId, commandProposal: CR.buildCommandProposal(record),
    });
  } catch {
    result = { ok: false, reason: 'runtime_submission_refused', acceptance: 'unknown' };
  }
  let acked = result?.ok === true && typeof result.work_id === 'string' && typeof result.turn_id === 'string' ? result : null;
  const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
  if (!acked && result?.acceptance !== 'rejected') {
    let found;
    try { found = typeof adapter.find === 'function' ? adapter.find(key) : null; } catch { found = null; }
    if (found && found.session_id === sessionId && typeof found.work_id === 'string' && typeof found.turn_id === 'string') acked = found;
  }
  let applied;
  if (acked) {
    applied = applyTo(svc, sessionId, proposalId, (current) => CR.markCommandAcknowledged(current, { workId: acked.work_id, turnId: acked.turn_id }));
  } else if (result?.acceptance !== 'rejected') {
    applied = applyTo(svc, sessionId, proposalId, (current) => CR.markCommandOutcomeUnknown(current, { causeCode: 'dispatch_unconfirmed' }));
  } else {
    applied = applyTo(svc, sessionId, proposalId, (current) => CR.markCommandRefused(current, {
      runtimeUnavailable: RUNTIME_UNAVAILABLE_REASONS.has(reason), causeCode: reason,
    }));
  }
  if (!applied.ok && !applied.aborted) svc._log('WARN', 'chat_proposal.command_dispatch_not_persisted', { reason: applied.reason });
}

// decide -> run: the caller has already passed replay, revision, expiry and the D6 /
// capability gates. Confirmations, binding recheck (D7), persist-before-submit, then submit.
async function decideRun(svc, req, record) {
  const adapter = svc._commandAdapter;
  if (typeof adapter?.submit !== 'function') return fail('unsupported_capability', { currentRevision: record.revision });
  if (!confirmationComplete(record, req.confirmed_preconditions)) {
    return fail('invalid_request', { currentRevision: record.revision });
  }
  const checked = typeof adapter.recheck === 'function' ? await recheck(adapter, record) : { ok: false, cause_code: 'unavailable' };
  if (!checked.ok) return svc._bindingFailure(req, record, checked);
  const found = svc._find(req.session_id, req.proposal_id);
  if (!found.ok) return fail(found.reason);
  const replay = svc._decisionReplay(found.record, req);
  if (replay) return replay;
  if (found.record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: found.record.revision });
  // Re-read the D6 / lockdown gate after the recheck's await.
  const gate = svc._project(found.record).actions.run;
  if (!gate || gate.available !== true) return fail(gate?.reason || 'unavailable', { currentRevision: found.record.revision });
  const accepted = svc._persistDecision(req, found.record, (current) => CR.acceptCommandDecision(current, {
    decisionId: req.decision_id, now: svc._now(), confirmedPreconditions: req.confirmed_preconditions,
    operationId: svc._createId(), attemptId: svc._createId(),
  }), { envelope: false });
  if (!accepted.ok) return accepted.failure;
  await dispatch(svc, req.session_id, accepted.record);
  return succeed({ created: true, proposal: svc._project(svc._latest(req.session_id, found.record.proposal_id) || accepted.record) });
}

// E3 events are matched on proposal and decision id; an event for anything else is ignored.
function eventTarget(svc, event, statuses) {
  if (!event || typeof event !== 'object' || event.schema_version !== 1) return null;
  const { session_id: sessionId, proposal_id: proposalId, decision_id: decisionId } = event;
  if (![sessionId, proposalId, decisionId].every((value) => typeof value === 'string' && value)) return null;
  if (!statuses.includes(event.status)) return null;
  const record = svc._latest(sessionId, proposalId);
  return record?.kind === 'command' && record.decision?.decision_id === decisionId ? { sessionId, proposalId } : null;
}

function onProgress(svc, event) {
  try {
    const target = eventTarget(svc, event, CR.PROGRESS_STATUSES);
    if (!target) return;
    applyTo(svc, target.sessionId, target.proposalId, (current) => (current.decision?.decision_id === event.decision_id
      ? CR.markCommandProgress(current, { status: event.status, workId: event.work_id, turnId: event.turn_id }) : null));
  } catch {
    svc._log('WARN', 'chat_proposal.command_progress_failed', { reason: 'exception' });
  }
}

function onOutcome(svc, event) {
  try {
    const target = eventTarget(svc, event, CR.OUTCOME_STATUSES);
    if (!target) return;
    applyTo(svc, target.sessionId, target.proposalId, (current) => (current.decision?.decision_id === event.decision_id
      ? CR.markCommandOutcome(current, {
        status: event.status, exitCode: event.exit_code, cleanup: event.cleanup, workId: event.work_id, turnId: event.turn_id,
      }) : null));
  } catch {
    svc._log('WARN', 'chat_proposal.command_outcome_failed', { reason: 'exception' });
  }
}

// Startup (DB7): command work is never resumed or re-run, so every unsettled record is
// settled from what the runtime store proves and nothing else. Work that was cancelled before
// it ever reported progress is `cancelled`; a submission the runtime never stored is
// `dispatch_failed`; everything else (completed without a recorded outcome, paused, failed,
// running, missing, unreadable) is `outcome_unknown`.
function reconcileCommand(svc, sessionId, record) {
  const runtime = svc._getRuntime();
  const proposalId = record.proposal_id;
  const key = svc._records.runtimeIdempotencyKey(record.dispatch_key_sha256);
  const unknown = () => applyTo(svc, sessionId, proposalId, (current) => CR.markCommandOutcomeUnknown(current, { causeCode: 'restart' }));
  let work = null;
  if (record.continuation_work_id) {
    work = typeof runtime?.getApplicationWork === 'function' ? runtime.getApplicationWork(record.continuation_work_id) : null;
  } else if (typeof runtime?.findApplicationSubmission === 'function') {
    work = runtime.findApplicationSubmission(key);
    if (!work || work.session_id !== sessionId) {
      applyTo(svc, sessionId, proposalId, (current) => CR.markCommandRefused(current, { causeCode: 'dispatch_lost' }));
      return;
    }
  }
  if (work && work.status === 'cancelled' && record.execution === null) {
    applyTo(svc, sessionId, proposalId, (current) => CR.markCommandOutcome(current, { status: 'cancelled' }));
    return;
  }
  unknown();
}

module.exports = {
  confirmationComplete,
  decideRun,
  onOutcome,
  onProgress,
  reconcileCommand,
};
