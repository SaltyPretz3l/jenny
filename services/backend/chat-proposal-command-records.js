'use strict';

// Pure state helpers for the exact-command Run of an inline command proposal (row 59
// checkpoint 3, Batch B). They extend the Git helpers in ./chat-proposal-records and follow
// the same rules: each returns the next record (revision + 1) or null when the transition is
// not allowed from the current state, and none performs IO. The command is submitted once,
// is never retried and is never resumed or resubmitted after a restart (DB7).

const crypto = require('crypto');
const R = require('./chat-proposal-records');

const { PROPOSAL_ERROR_CODES: CODES } = R;
const PROGRESS_STATUSES = Object.freeze(['pending_approval', 'running']);
const OUTCOME_STATUSES = Object.freeze(['succeeded', 'failed', 'denied', 'cancelled', 'interrupted_unknown']);
const SETTLED_BY_STATUS = Object.freeze({
  succeeded: 'succeeded', failed: 'failed', denied: 'failed', cancelled: 'cancelled',
});
// Command binding drift causes (D7) on top of the shared root/authority ones.
const COMMAND_DRIFT_CAUSES = Object.freeze([
  'backend_changed', 'shell_changed', 'cwd_changed', 'command_changed',
]);

const buildCommandDispatchKey = (proposalId) => `proposal:${proposalId}:command`;

function isCommandQueued(record) {
  return record?.kind === 'command' && record.decision_state === 'accepted' && record.action_state === 'queued';
}

// Accepted/queued with the decision, attempt 1, dispatch identity and operation id
// persisted BEFORE the submission. `confirmedPreconditions` is stored exactly as sent.
function acceptCommandDecision(record, {
  decisionId, now, confirmedPreconditions = null, operationId = crypto.randomUUID(), attemptId = crypto.randomUUID(),
}) {
  if (record?.kind !== 'command' || !R.pendingLive(record, now) || !R.isUuid(decisionId)) return null;
  if (!R.isUuid(operationId) || !R.isUuid(attemptId)) return null;
  const dispatchKey = buildCommandDispatchKey(record.proposal_id);
  return R.nextRevision(record, {
    decision_state: 'accepted',
    action_state: 'queued',
    decision: {
      ...R.decisionFor(record, { decisionId, choice: 'run', now }),
      confirmed_preconditions: confirmedPreconditions === null ? null : [...confirmedPreconditions],
    },
    attempt_id: attemptId,
    attempt_number: record.attempt_number + 1,
    dispatch_key: dispatchKey,
    dispatch_key_sha256: R.sha256Hex(dispatchKey),
    command_operation_id: operationId,
    last_error: null,
    execution: null,
  });
}

// The runtime's work and turn ids. Adopted once, in any accepted state: a progress event
// can land before the submit acknowledgment is persisted.
function markCommandAcknowledged(record, { workId, turnId } = {}) {
  if (record?.kind !== 'command' || record.decision_state !== 'accepted' || record.continuation_work_id) return null;
  if (typeof workId !== 'string' || typeof turnId !== 'string') return null;
  return R.nextRevision(record, { continuation_work_id: workId, continuation_turn_id: turnId });
}

// Submission refused before the runtime accepted it: nothing ran. No Retry for commands, so
// the error is not retryable.
function markCommandRefused(record, { runtimeUnavailable = false, causeCode = null } = {}) {
  if (!isCommandQueued(record)) return null;
  const lastError = runtimeUnavailable
    ? { code: CODES.unavailable, reason: 'unavailable', retryable: false, cause_code: causeCode || 'runtime_unavailable' }
    : { code: CODES.dispatch_failed, reason: 'dispatch_failed', retryable: false, cause_code: causeCode };
  return R.nextRevision(record, { action_state: 'needs_attention', last_error: lastError });
}

function adoptIds(record, { workId, turnId }) {
  return {
    continuation_work_id: record.continuation_work_id ?? (typeof workId === 'string' ? workId : null),
    continuation_turn_id: record.continuation_turn_id ?? (typeof turnId === 'string' ? turnId : null),
  };
}

// E3 progress: pending_approval | running. queued|admitted -> admitted with the live status.
function markCommandProgress(record, { status, workId, turnId } = {}) {
  if (record?.kind !== 'command' || record.decision_state !== 'accepted' || !PROGRESS_STATUSES.includes(status)) return null;
  if (!['queued', 'admitted'].includes(record.action_state)) return null;
  if (record.action_state === 'admitted' && record.execution?.status === status) return null;
  return R.nextRevision(record, {
    action_state: 'admitted',
    execution: { status, exit_code: null, cleanup: null },
    ...adoptIds(record, { workId, turnId }),
  });
}

function outcomeUnknownError(causeCode) {
  return { code: CODES.outcome_unknown, reason: 'outcome_unknown', retryable: false, cause_code: causeCode };
}

// E3 outcome. interrupted_unknown, or any outcome whose cleanup is uncertain, is
// needs_attention (0012); otherwise succeeded | failed (failed, denied) | cancelled.
function markCommandOutcome(record, { status, exitCode = null, cleanup = null, workId, turnId } = {}) {
  if (record?.kind !== 'command' || record.decision_state !== 'accepted' || !OUTCOME_STATUSES.includes(status)) return null;
  if (!['queued', 'admitted'].includes(record.action_state)) return null;
  const execution = {
    status,
    exit_code: Number.isSafeInteger(exitCode) ? exitCode : null,
    cleanup: cleanup === 'confirmed' || cleanup === 'uncertain' ? cleanup : null,
  };
  const ids = adoptIds(record, { workId, turnId });
  if (status === 'interrupted_unknown' || execution.cleanup === 'uncertain') {
    return R.nextRevision(record, {
      action_state: 'needs_attention', execution, last_error: outcomeUnknownError(status === 'interrupted_unknown' ? 'interrupted' : 'cleanup_uncertain'), ...ids,
    });
  }
  return R.nextRevision(record, { action_state: SETTLED_BY_STATUS[status], execution, ...ids });
}

// Startup reconciliation or an unconfirmed acknowledgment: the outcome cannot be proven.
function markCommandOutcomeUnknown(record, { causeCode = 'restart' } = {}) {
  if (record?.kind !== 'command' || record.decision_state !== 'accepted') return null;
  if (!['queued', 'admitted'].includes(record.action_state)) return null;
  return R.nextRevision(record, {
    action_state: 'needs_attention',
    execution: { status: 'interrupted_unknown', exit_code: null, cleanup: record.execution?.cleanup ?? null },
    last_error: outcomeUnknownError(causeCode),
  });
}

// The E1 `commandProposal` for an accepted/queued record. Command, cwd and limits come from
// the validated normalized input; the binding supplies backend, shell and the root revision.
function buildCommandProposal(record) {
  const { decision, normalized_input: input, binding } = record;
  return {
    schema_version: 1,
    proposal_id: record.proposal_id,
    accepted_revision: decision.accepted_revision,
    decision_id: decision.decision_id,
    command_operation_id: record.command_operation_id,
    tool_call_id: R.commandToolCallId(record.proposal_id, decision.decision_id),
    command_sha256: binding.command.command_sha256,
    command_binding: {
      backend: binding.command.backend,
      shell: binding.command.shell,
      cwd: binding.command.cwd,
      root_revision: binding.authority_revision,
    },
    command_input: {
      command: input.command,
      cwd: input.cwd,
      timeout_seconds: input.timeout_seconds,
      expected_exit_codes: [...input.expected_exit_codes],
      purpose: input.purpose,
    },
  };
}

module.exports = {
  COMMAND_DRIFT_CAUSES,
  OUTCOME_STATUSES,
  PROGRESS_STATUSES,
  acceptCommandDecision,
  buildCommandDispatchKey,
  buildCommandProposal,
  isCommandQueued,
  markCommandAcknowledged,
  markCommandOutcome,
  markCommandOutcomeUnknown,
  markCommandProgress,
  markCommandRefused,
};
