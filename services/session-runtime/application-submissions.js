'use strict';

/* Application-authored durable submissions (row 59 checkpoint 3), split from
 * service.js: the inline-proposal continuation turn and the exact-command Run.
 * Internal only (no IPC or hosted route); each entry never throws and answers
 * `{ok:false, reason, acceptance}` on refusal. The runtime methods delegate here. */

const { validId } = require('./contracts');

function runtimeId(prefix, createId) {
  return `${prefix}_${createId()}`;
}

// Reasons an application-authored submission reports verbatim; anything else
// stays the opaque refusal so raw failure text never leaves the runtime.
const APPLICATION_REFUSAL_REASONS = new Set([
  'runtime_closing', 'runtime_disabled', 'runtime_submission_capacity', 'host_pending_capacity',
  'project_pending_capacity', 'session_pending_capacity', 'pending_input_capacity',
  'runtime_transcript_cache_pressure', 'session_busy', 'gpu_busy_plugin',
  'command_proposal_invalid', 'command_proposal_read_only', 'command_proposal_authority_changed',
  'command_sandbox_transition', 'command_proposal_lockdown', 'linked_first_turn_pending',
]);

function applicationRefusalReason(error) {
  for (const value of [error?.code, error?.message]) {
    if (typeof value === 'string' && APPLICATION_REFUSAL_REASONS.has(value)) return value;
  }
  return 'runtime_submission_refused';
}

function applicationIdentity(work, created) {
  return Object.freeze({ ok: true, created, work_id: work.work_id, turn_id: work.turn_id,
    session_id: work.session_id, project_id: work.project_id, revision: work.revision, status: work.status });
}

// Durable admission for a turn the application itself authored (inline
// proposals, row 59 checkpoint 3). Internal only: main-process code builds
// `request`; it is on no IPC or hosted route, so a renderer cannot forge the
// fields it carries. It is `submit` (prepareSubmission -> store.submit ->
// the scheduler's per-session serialization), never `startImmediate` or any
// non-durable start. A replayed key returns the existing work unchanged and
// never prepares again. Never throws: `{ok:false, reason, acceptance}`.
async function submitApplicationTurn(runtime, request, { idempotencyKey } = {}) {
  const refused = (reason, acceptance) => Object.freeze({ ok: false, reason, acceptance });
  if (!validId(idempotencyKey) || !request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.sessionId !== 'string' || !request.sessionId
    || typeof request.prompt !== 'string' || !request.prompt.trim()) {
    return refused('runtime_submission_request_invalid', 'rejected');
  }
  const replay = () => {
    const existing = runtime.store.findSubmission(idempotencyKey);
    if (!existing) return null;
    return existing.session_id === request.sessionId
      ? applicationIdentity(existing, false) : refused('idempotency_conflict', 'unknown');
  };
  try {
    const existing = replay();
    if (existing) return existing;
    return await runtime.submit(request, { idempotencyKey });
  } catch (error) {
    if (error?.code === 'idempotency_conflict') {
      try { return replay() || refused('idempotency_conflict', 'unknown'); }
      catch (_replayError) { return refused('idempotency_conflict', 'unknown'); }
    }
    return refused(applicationRefusalReason(error),
      error?.submissionOutcome === 'rejected' ? 'rejected' : 'unknown');
  }
}

// Durable admission for the exact-command Run (row 59 checkpoint 3, Batch B).
// Internal only, like submitApplicationTurn: it is on no IPC or hosted route and
// never falls back to chat.send. `commandProposal` is the closed E1 record; the
// durable input kind is `command_proposal` on the synthetic command route.
// Replays of one key return the existing work. Never throws.
async function submitCommandProposal(runtime, { idempotencyKey, sessionId, commandProposal } = {}) {
  const refused = (reason, acceptance) => Object.freeze({ ok: false, reason, acceptance });
  if (!runtime.commandAdapter) return refused('runtime_unavailable', 'rejected');
  if (!validId(idempotencyKey) || typeof sessionId !== 'string' || !sessionId) {
    return refused('runtime_submission_request_invalid', 'rejected');
  }
  const replay = () => {
    const existing = runtime.store.findSubmission(idempotencyKey);
    if (!existing) return null;
    return existing.session_id === sessionId ? applicationIdentity(existing, false) : refused('idempotency_conflict', 'unknown');
  };
  try {
    const existing = replay();
    if (existing) return existing;
    runtime._assertSubmissionOpen();
    runtime.maintainTerminalDetail?.();
    if (runtime.pendingSubmissions.size >= 256) throw new Error('runtime_submission_capacity');
    const submission = { sessionId, current: true };
    runtime.pendingSubmissions.add(submission);
    try { return submitCommand(runtime, { idempotencyKey, sessionId, commandProposal }, submission); }
    finally { runtime.pendingSubmissions.delete(submission); }
  } catch (error) {
    if (error?.code === 'idempotency_conflict') {
      try { return replay() || refused('idempotency_conflict', 'unknown'); }
      catch (_replayError) { return refused('idempotency_conflict', 'unknown'); }
    }
    return refused(applicationRefusalReason(error), error?.submissionOutcome === 'unknown' ? 'unknown' : 'rejected');
  }
}

function submitCommand(runtime, { idempotencyKey, sessionId, commandProposal }, submission) {
  const workId = runtimeId('work', runtime.createId);
  const turnId = runtimeId('turn', runtime.createId);
  const adapter = runtime.commandAdapter;
  const prepared = adapter.prepareSubmission(sessionId, commandProposal, { workId, turnId });
  let submitted;
  try {
    runtime._assertSubmissionOpen();
    if (!submission.current) throw new Error('runtime_submission_controlled');
    adapter.validateSubmission(prepared);
    submitted = runtime.store.submit({ idempotencyKey, projectId: prepared.authority.project_id,
      sessionId: prepared.sessionId, purpose: 'Run proposed command', authority: prepared.authority,
      input: JSON.parse(JSON.stringify(prepared.input)), workId, turnId });
    if (submitted.created) {
      prepared.awaitingAcknowledgement = true;
      adapter.register(workId, prepared);
    } else adapter.discard(prepared);
  } catch (error) {
    if (submitted) error.submissionOutcome = 'unknown';
    adapter.discard(prepared);
    throw error;
  }
  // The caller has durable identity before any producer or stream can start.
  if (submitted.created) setImmediate(() => {
    prepared.awaitingAcknowledgement = false;
    runtime.scheduler.notifyLaneAvailability();
  });
  return applicationIdentity(submitted.record, submitted.created);
}

// Content-free view of one durable work for proposal reconciliation: the
// prompt and request never leave the store. Null when absent or unreadable.
function getApplicationWork(runtime, workId) {
  try {
    const work = validId(workId) ? runtime.store.get(workId) : null;
    if (!work) return null;
    return Object.freeze({ work_id: work.work_id, turn_id: work.turn_id, session_id: work.session_id,
      status: work.status, revision: work.revision, recovery_kind: work.recovery?.kind || null,
      previous_status: work.recovery?.previous_status || null });
  } catch (_error) { return null; }
}

function findApplicationSubmission(runtime, idempotencyKey) {
  try {
    const work = validId(idempotencyKey) ? runtime.store.findSubmission(idempotencyKey) : null;
    return work ? getApplicationWork(runtime, work.work_id) : null;
  } catch (_error) { return null; }
}

module.exports = {
  APPLICATION_REFUSAL_REASONS,
  findApplicationSubmission,
  getApplicationWork,
  submitApplicationTurn,
  submitCommandProposal,
};
