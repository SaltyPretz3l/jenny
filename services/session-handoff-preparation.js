'use strict';

const crypto = require('crypto');
const R = require('./backend/chat-proposal-records');
const S = require('./backend/chat-proposal-session-records');
const { createSessionId } = require('./backend/electron-session-store');
const { buildSessionHandoff } = require('./backend/session-handoff-context');
const { RUNTIME_UNAVAILABLE_REASONS } = require('./chat-proposal-continuation');

const PREPARATION_DEADLINE_MS = 60000;
const failure = (reason, retryable = false, cause) => ({
  ok: false, code: R.PROPOSAL_ERROR_CODES[reason], reason, retryable,
  ...(cause ? { cause_code: cause } : {}),
});

function buildPreparationRequest(record, sourceSummary) {
  const mode = liveRunMode(sourceSummary);
  return {
    sessionId: record.source_session_id,
    prompt: [
      'Prepare a handoff for the new chat the user accepted. Do not start the work.',
      `Title: ${JSON.stringify(record.normalized_input.title)}`,
      ...(record.normalized_input.description ? [`Description: ${JSON.stringify(record.normalized_input.description)}`] : []),
      'Call complete_session_handoff exactly once with the proposal_id and attempt_id below, a task for the new chat, and background context.',
      `proposal_id: ${record.proposal_id}`,
      `attempt_id: ${record.attempt_id}`,
    ].join('\n'),
    visiblePrompt: 'Preparing a new chat',
    attachments: [],
    preferredModel: typeof sourceSummary?.preferred_model === 'string' ? sourceSummary.preferred_model : '',
    reasoningEffort: typeof sourceSummary?.reasoning_effort === 'string' ? sourceSummary.reasoning_effort : undefined,
    planMode: mode === 'plan',
    approvalMode: mode === 'auto' ? 'auto_run' : 'prompt',
    sessionHandoffPreparation: { proposal_id: record.proposal_id, attempt_id: record.attempt_id },
  };
}

const deadlineKey = ({ proposalId, attemptId }) => `${proposalId}:${attemptId}`;

function startPreparationDeadline(ports, args) {
  const key = deadlineKey(args);
  if (ports.deadlines.has(key)) return;
  const handle = ports.setTimer(() => {
    ports.deadlines.delete(key);
    args.onExpire();
  }, PREPARATION_DEADLINE_MS);
  ports.deadlines.set(key, handle);
}

function clearPreparationDeadline(ports, args) {
  const key = deadlineKey(args);
  if (!ports.deadlines.has(key)) return;
  ports.clearTimer(ports.deadlines.get(key));
  ports.deadlines.delete(key);
}

function readProposal(ports, sessionId, proposalId) {
  const read = ports.store.read(sessionId);
  return { read, record: read.ok ? read.records.find((r) => r.proposal_id === proposalId) : null };
}

function change(ports, record, transition) {
  const result = ports.store.mutate(record.source_session_id, ({ records }) => {
    const current = records.find((r) => r.proposal_id === record.proposal_id);
    if (!current || current.revision !== record.revision) return { abort: 'stale_revision' };
    const next = transition(current);
    if (!next) return { abort: 'authorization_required' };
    return { records: records.map((r) => r.proposal_id === next.proposal_id ? next : r) };
  });
  if (!result.ok) return { error: failure('preparation_failed', true, result.reason) };
  if (result.aborted) return { error: failure(result.value) };
  return { record: result.records.find((r) => r.proposal_id === record.proposal_id) };
}

function storedResult(record) {
  return {
    ok: true, proposal_id: record.proposal_id, revision: record.revision,
    child_session_id: record.child_session_id,
    first_turn_work_id: record.first_turn_work_id, first_turn_turn_id: record.first_turn_turn_id,
    admission_state: record.action_state === 'needs_attention' ? 'needs_attention' : 'queued',
  };
}

// D10: the child never gets more authority than its source has NOW. The publish-time snapshot, the
// accepted options and the source's current mode are intersected; the strictest wins. An unreadable
// source summary counts as at least `ask`.
const MODE_ORDER = ['auto', 'ask', 'propose', 'plan'];
function liveRunMode(summary) {
  if (!summary) return 'ask';
  const mode = String(summary.run_mode || '').toLowerCase();
  if (summary.plan_mode === true || mode === 'plan') return 'plan';
  return MODE_ORDER.includes(mode) ? mode : 'ask';
}
const strictest = (...modes) => modes.reduce((a, b) => (MODE_ORDER.indexOf(b) > MODE_ORDER.indexOf(a) ? b : a));

function childAuthority(record, sourceSummary, childSummary = null) {
  const snapshot = record.binding.session;
  const modes = [snapshot.source_run_mode, liveRunMode(sourceSummary)];
  if (record.decision.options.run_mode === 'plan') modes.push('plan');
  if (childSummary) modes.push(liveRunMode(childSummary));
  const runMode = strictest(...modes);
  return {
    runMode,
    lockdown: snapshot.lockdown === true || sourceSummary?.lockdown === true || childSummary?.lockdown === true,
    planMode: runMode === 'plan',
    approvalMode: runMode === 'auto' ? 'auto_run' : 'prompt',
  };
}

function childSpec(record, sourceSummary) {
  const options = record.decision.options;
  const authority = childAuthority(record, sourceSummary);
  return {
    childSessionId: record.child_session_id, childIncarnation: record.child_session_incarnation,
    spawnedFrom: {
      schema_version: 1, parent_session_id: record.source_session_id,
      parent_session_incarnation: record.source_session_incarnation, proposal_id: record.proposal_id,
      created_at: record.decision.accepted_at, child_creation_hash: record.child_creation_hash,
      reporting_consent_id: record.decision.decision_id,
    },
    title: record.normalized_input.title, projectId: options.destination_project_id,
    preferences: {
      preferred_model: options.preferred_model, reasoning_effort: options.reasoning_effort,
      run_mode: authority.runMode,
    },
    lockdown: authority.lockdown,
  };
}

function firstTurnRequest(record, sourceSummary, childSummary) {
  const options = record.decision.options;
  const authority = childAuthority(record, sourceSummary, childSummary);
  // A blank Background (empty or whitespace only) sends no row (D6); the context row rejects blank bodies.
  const blank = record.handoff.background.trim() === '';
  const handoff = blank ? null : buildSessionHandoff({
    proposalId: record.proposal_id, sourceSessionId: record.source_session_id,
    sourceSessionIncarnation: record.source_session_incarnation, body: record.handoff.background,
  });
  if (!blank && !handoff) throw new Error('session_handoff_invalid');
  return {
    sessionId: record.child_session_id, prompt: record.handoff.task, visiblePrompt: record.handoff.task,
    attachments: [], preferredModel: options.preferred_model || '', reasoningEffort: options.reasoning_effort ?? undefined,
    planMode: authority.planMode,
    approvalMode: authority.approvalMode,
    ...(handoff ? { sessionHandoff: handoff } : {}),
  };
}

async function submitFirstTurn(ports, record) {
  const runtime = ports.getRuntime();
  if (typeof runtime?.submitApplicationTurn !== 'function') {
    return { outcome: 'refused', causeCode: 'runtime_unavailable', runtimeUnavailable: true };
  }
  // The runtime-valid form of the record's first-turn dispatch key; restart reconciliation looks it up the same way.
  const key = R.runtimeIdempotencyKey(record.dispatch_key_sha256);
  let result;
  try {
    const request = firstTurnRequest(record, ports.getSessionSummary(record.source_session_id),
      ports.getSessionSummary(record.child_session_id));
    result = await runtime.submitApplicationTurn(request, { idempotencyKey: key });
  } catch {
    result = { reason: 'runtime_submission_refused', acceptance: 'unknown' };
  }
  const validAck = (ack) => typeof ack?.work_id === 'string' && ack.work_id.length > 0
    && typeof ack.turn_id === 'string' && ack.turn_id.length > 0;
  if (result?.ok === true && validAck(result)) return { outcome: 'ack', workId: result.work_id, turnId: result.turn_id };
  if (result?.acceptance !== 'rejected') {
    try {
      const found = runtime.findApplicationSubmission?.(key);
      if (found?.session_id === record.child_session_id && validAck(found)) {
        return { outcome: 'ack', workId: found.work_id, turnId: found.turn_id };
      }
    } catch {
      // Unproven admission remains retryable under the same durable key.
    }
  }
  const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
  return { outcome: 'refused', causeCode: reason, runtimeUnavailable: RUNTIME_UNAVAILABLE_REASONS.has(reason) };
}

function notifyBoth(ports, record) {
  ports.notify(record.source_session_id);
  ports.notify(record.child_session_id);
}

async function resumeChildCreation(ports, { sessionId, proposalId }) {
  let { record } = readProposal(ports, sessionId, proposalId);
  if (!record) return failure('not_found');
  if (record.kind !== 'session' || record.decision?.choice !== 'new_session'
    || !record.handoff || !record.child_session_id) return failure('authorization_required');
  if (record.action_state === 'succeeded') return storedResult(record);
  if (!['preparing', 'child_created'].includes(record.action_state)) return failure('authorization_required');
  let created;
  try {
    if (ports.sessionExists(record.child_session_id)) {
      created = ports.readSpawnedFrom(record.child_session_id)?.child_creation_hash === record.child_creation_hash
        ? { ok: true } : { ok: false, code: 'proof_mismatch' };
    } else created = await ports.createLinkedChildSession(childSpec(record, ports.getSessionSummary(record.source_session_id)));
  } catch {
    created = { ok: false, code: 'child_creation_failed' };
  }
  if (created?.ok !== true) {
    const updated = change(ports, record, (r) => S.markFirstTurnRefused(r, { causeCode: created?.code || 'child_creation_failed' }));
    if (!updated.error) ports.notify(sessionId);
    return updated.error || failure('preparation_failed', true, created?.code || 'child_creation_failed');
  }
  if (record.action_state === 'preparing') {
    const updated = change(ports, record, S.markChildCreated);
    if (updated.error) return updated.error;
    record = updated.record;
  }
  notifyBoth(ports, record);
  const result = await submitFirstTurn(ports, record);
  const updated = change(ports, record, (r) => result.outcome === 'ack'
    ? S.markFirstTurnAdmitted(r, result) : S.markFirstTurnRefused(r, result));
  if (updated.error) return updated.error;
  notifyBoth(ports, updated.record);
  ports.log?.('INFO', 'proposal.session_first_turn', {
    proposalId, childSessionId: record.child_session_id, state: updated.record.action_state,
  });
  return storedResult(updated.record);
}

async function completeSessionHandoff(ports, args) {
  const { sessionId, proposalId, attemptId, task, background } = args;
  const { read, record } = readProposal(ports, sessionId, proposalId);
  if (!record) return failure('not_found');
  if (record.kind !== 'session' || record.decision_state !== 'accepted' || record.decision?.choice !== 'new_session'
    || record.source_session_id !== sessionId || record.source_session_incarnation !== args.sessionIncarnation
    || read.session_incarnation !== args.sessionIncarnation || record.attempt_id !== attemptId
    || typeof args.turnId !== 'string' || !args.turnId || typeof args.toolCallId !== 'string' || !args.toolCallId
    || (record.preparation_turn_id !== null && record.preparation_turn_id !== args.turnId)) {
    return failure('authorization_required');
  }
  const cause = S.handoffTextCause({ task, background });
  if (cause) return failure('invalid_request', false, cause);
  if (record.handoff) {
    return record.handoff.sha256 === S.handoffSha256({ task, background })
      ? storedResult(record) : failure('idempotency_conflict');
  }
  if (!['queued', 'preparing'].includes(record.action_state)) return failure('authorization_required');
  const childSessionId = createSessionId();
  const childIncarnation = `inc_${crypto.randomBytes(16).toString('hex')}`;
  const updated = change(ports, record, (current) => S.recordHandoff(
    current.action_state === 'queued' ? S.markPreparing(current) : current,
    { task, background, childSessionId, childIncarnation }
  ));
  if (updated.error) return updated.error;
  clearPreparationDeadline(ports, { proposalId, attemptId });
  const result = await resumeChildCreation(ports, { sessionId, proposalId });
  if (result.ok !== true) {
    // A failed store write must not strand the record in preparing/child_created without Retry.
    const latest = readProposal(ports, sessionId, proposalId).record;
    if (latest && ['preparing', 'child_created'].includes(latest.action_state)) {
      const marked = change(ports, latest, (r) => S.markFirstTurnRefused(r, { causeCode: result.cause_code || result.reason }));
      if (!marked.error) ports.notify(sessionId);
    }
  }
  return result;
}

module.exports = {
  PREPARATION_DEADLINE_MS, buildPreparationRequest, startPreparationDeadline, clearPreparationDeadline,
  completeSessionHandoff, resumeChildCreation,
};
