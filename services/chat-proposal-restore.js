'use strict';

/* services/chat-proposal-restore.js - `sessionProposals.confirmRestored` (row 59 checkpoint 5b-3): the
 * user's explicit confirmation of a proposal that a trusted archive restore parked with
 * `restore_requires_confirmation` (see data-lifecycle/coordination-restore-transform). It works on a
 * ChatProposalService instance (`svc`) through that service's own record plumbing.
 *
 * Confirmation binds the displayed revision and a fresh gesture id (the receipt makes a replay
 * idempotent). It is never generic Retry and never consent for anything the user did not see:
 *   - a pending, unexpired Git or session offer clears the flag and stays pending; nothing starts
 *     (a Git offer first re-checks its binding, so drift marks it stale exactly as Commit would);
 *   - a command proposal is inert for good: unsupported_capability / fresh_command_proposal_required;
 *   - an accepted action parked as needs_attention is reconciled with the runtime's existing work or
 *     child receipts: terminal or admitted work becomes its truthful projection and the flag clears.
 *     Nothing is ever dispatched again. The runtime offers no proof that a dispatch key never began
 *     (an absent record in a restored profile proves nothing), so an action without a provable
 *     outcome settles as needs_attention / outcome_unknown (not retryable); the user may open the
 *     child or ask for new work, but confirmation never invents proof or replays an unknown effect.
 * Diagnostics carry reason tokens only, never summaries, paths or commands.
 */

const { PROPOSAL_ERROR_CODES, nextRevision, normalizeProposalRecord, runtimeIdempotencyKey } = require('./backend/chat-proposal-records');
const { proposalGestureReceipt } = require('./backend/coordination-receipts');
const contract = require('./chat-proposal-contract');
const continuation = require('./chat-proposal-continuation');

const { fail, succeed } = contract;
const METHOD = 'confirmRestored';

function safely(fn) {
  try { return fn(); } catch { return null; }
}

const settle = (record, patch) => nextRevision(record, { restore_requires_confirmation: false, last_error: null, ...patch });

// The truthful answer when nothing proves what happened: still needs attention, not retryable.
function unknownOutcome(record) {
  return {
    record: nextRevision(record, {
      action_state: 'needs_attention',
      restore_requires_confirmation: false,
      last_error: { code: PROPOSAL_ERROR_CODES.outcome_unknown, reason: 'outcome_unknown', retryable: false, cause_code: 'restored' },
    }),
  };
}

// Git and session "Do it here": the continuation turn in the source session.
function reconcileContinuation(svc, record) {
  const runtime = svc._getRuntime();
  let current = record;
  for (let pass = 0; pass < 2; pass += 1) {
    const verdict = safely(() => continuation.reconcileVerdict({
      runtime, record: current, completeKnown: (sessionId, turnId) => svc._isTurnCompleteKnown(sessionId, turnId),
    }));
    if (verdict?.verdict === 'ack') {
      current = { ...current, continuation_work_id: verdict.work_id, continuation_turn_id: verdict.turn_id };
      continue; // the runtime holds this key's work: look at what became of it
    }
    if (verdict?.verdict === 'succeeded' || verdict?.verdict === 'cancelled') return { record: settle(current, { action_state: verdict.verdict }) };
    if (verdict?.verdict === 'keep') {
      const work = safely(() => runtime.getApplicationWork(current.continuation_work_id));
      const state = work?.status === 'running' ? 'admitted' : 'queued';
      return { record: settle(current, { action_state: state }), track: { turnId: current.continuation_turn_id, state, role: 'continuation' } };
    }
    break;
  }
  return unknownOutcome(record);
}

// New session: the first turn of a reserved child, else a preparation turn that is still running.
function reconcileNewSession(svc, record) {
  const runtime = svc._getRuntime();
  const find = (sessionId) => {
    const found = safely(() => runtime?.findApplicationSubmission?.(runtimeIdempotencyKey(record.dispatch_key_sha256)));
    return found && found.session_id === sessionId ? found : null;
  };
  if (record.handoff !== null) {
    const found = find(record.child_session_id);
    return found
      ? { record: settle(record, { action_state: 'succeeded', first_turn_work_id: found.work_id, first_turn_turn_id: found.turn_id }) }
      : unknownOutcome(record);
  }
  let current = record;
  if (!current.preparation_work_id) {
    const found = find(record.source_session_id);
    if (found) current = { ...record, preparation_work_id: found.work_id, preparation_turn_id: found.turn_id };
  }
  const work = current.preparation_work_id ? safely(() => runtime?.getApplicationWork?.(current.preparation_work_id)) : null;
  if (!work || !['pending', 'running'].includes(work.status)) return unknownOutcome(record);
  const state = work.status === 'running' ? 'preparing' : 'queued';
  return { record: settle(current, { action_state: state }), track: { turnId: current.preparation_turn_id, state: state === 'preparing' ? 'started' : 'queued', role: 'prep' } };
}

async function confirmRestored(svc, raw) {
  const checked = contract.validateConfirmRestoredRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const req = checked.value;
  const found = svc._find(req.session_id, req.proposal_id);
  if (!found.ok) return fail(found.reason);
  const { record } = found;
  const replay = svc._gestureReplay(METHOD, req, record);
  if (replay) return replay;
  if (record.kind === 'command') {
    return fail('unsupported_capability', { currentRevision: record.revision, detail: 'fresh_command_proposal_required' });
  }
  if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
  if (record.restore_requires_confirmation !== true) return fail('not_pending', { currentRevision: record.revision });

  let outcome;
  if (record.decision_state === 'pending') {
    if (record.kind === 'git') {
      const recheck = await svc._recheck(record);
      if (!recheck.ok) return svc._bindingFailure(req, record, recheck);
    }
    outcome = { record: nextRevision(record, { restore_requires_confirmation: false }) };
  } else if (record.decision_state === 'accepted' && record.action_state === 'needs_attention') {
    const isNew = record.kind === 'session' && record.decision?.choice === 'new_session';
    outcome = isNew ? reconcileNewSession(svc, record) : reconcileContinuation(svc, record);
    if (!normalizeProposalRecord(outcome.record)) outcome = unknownOutcome(record);
  } else {
    return svc._notPending(record);
  }

  const applied = svc._apply(req.session_id, record.proposal_id, (current) => (current.revision === record.revision
    ? { record: outcome.record } : { abort: { reason: 'stale_revision', revision: current.revision } }),
  proposalGestureReceipt(METHOD, req));
  if (!applied.ok || applied.aborted) return applied.failure;
  svc._rememberGesture(METHOD, req);
  if (outcome.track) svc._track(outcome.track.turnId, req.session_id, record.proposal_id, outcome.track.state, outcome.track.role);
  return succeed({ created: true, proposal: svc._project(applied.record) });
}

module.exports = { confirmRestored };
