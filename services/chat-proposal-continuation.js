'use strict';

/* services/chat-proposal-continuation.js - the Git Commit / Test-first
 * continuation of an inline proposal (row 59 checkpoint 3): the main-built chat
 * request, its durable submission, the chat-stream outcome classifier and the
 * restart reconciliation verdict. Pure of persistence: the caller (the proposal
 * service) owns every record write. It never resumes, resubmits on restart, or
 * falls back to a non-durable start; a missing or closing runtime is a
 * `needs_attention` outcome, not a different path. No log line here carries a
 * summary, path or command.
 */

const { runtimeIdempotencyKey } = require('./backend/chat-proposal-records');

const RUNTIME_UNAVAILABLE_REASONS = new Set(['runtime_unavailable', 'runtime_disabled', 'runtime_closing']);
const LABELS = Object.freeze({
  commit: 'Commit the proposed changes',
  test_first: 'Test the proposed changes first',
});
const LOCAL_LABEL = 'Continue in this chat';
const TERMINAL_STREAM_TYPES = new Set(['complete', 'error', 'question_batch', 'plan_proposal']);

// Quoted proposal text is data from the model's own earlier turn: it scopes the
// task, it does not widen it.
function buildContinuationPrompt(record) {
  const { summary, paths } = record.normalized_input;
  const choice = record.decision?.choice;
  const scope = [
    'The user chose an option on your earlier proposal. Work only on the changes described here.',
    '',
    'Summary you proposed:',
    summary,
    '',
    'Files in scope (exact paths, nothing else):',
    ...paths.map((path) => `- ${path}`),
    '',
  ];
  const rules = choice === 'test_first'
    ? [
      'Task: run the checks relevant to these changes first (the tests, type checks and linters the repository documents), and report the results plainly: what ran, pass or fail counts, and any failure.',
      '- Follow the repository instructions for how to run checks.',
      '- Do not commit, stage, push or merge. Do not edit files to make a check pass; report the failure instead.',
      '- If a check cannot run, say why.',
    ]
    : [
      'Task: commit these changes.',
      '- Recheck the repository status and the diff of the listed files first. If a listed file no longer matches the summary, or the files differ from what was proposed, say so before committing.',
      '- Follow the repository instructions for commit messages and any required checks.',
      '- Commit only the listed paths. Leave every other change untouched.',
      '- Never push, merge, rebase, amend, reset or force anything.',
      '- When done, report what was committed in plain words.',
    ];
  return [...scope, ...rules].join('\n');
}

// "Do it here" on a session offer (row 59 checkpoint 5a): the title and description are the
// model's own words from its earlier turn; they scope the task, they do not widen it.
function buildLocalContinuationPrompt(record) {
  const { title, description } = record.normalized_input;
  return [
    'The user chose to continue here, in this chat, instead of starting a new one. Work on the task you offered now.',
    '',
    'Task you offered:',
    title,
    ...(description ? ['', description] : []),
  ].join('\n');
}

// Keeps the source's own mode: Plan stays Plan (the continuation never leaves it), model, effort
// and approval follow the session exactly as a plain send would.
function buildLocalContinuationRequest(record, session) {
  const mode = String(session?.run_mode || '').toLowerCase();
  return {
    sessionId: record.source_session_id,
    prompt: buildLocalContinuationPrompt(record),
    visiblePrompt: LOCAL_LABEL,
    attachments: [],
    preferredModel: typeof session?.preferred_model === 'string' ? session.preferred_model : '',
    reasoningEffort: typeof session?.reasoning_effort === 'string' ? session.reasoning_effort : undefined,
    planMode: session?.plan_mode === true || mode === 'plan',
    approvalMode: mode === 'auto' ? 'auto_run' : 'prompt',
    proposalDecision: {
      proposal_id: record.proposal_id,
      decision_id: record.decision.decision_id,
      accepted_revision: record.decision.accepted_revision,
      choice: 'do_it_here',
    },
  };
}

// A normal chat request for the source session with a short visible label. Model,
// effort and approval follow the session's current settings, exactly as a plain
// send would; Plan mode never reaches here (the decide gate refuses it first).
function buildContinuationRequest(record, session) {
  if (record.kind === 'session') return buildLocalContinuationRequest(record, session);
  const choice = record.decision.choice;
  return {
    sessionId: record.source_session_id,
    prompt: buildContinuationPrompt(record),
    visiblePrompt: LABELS[choice],
    attachments: [],
    preferredModel: typeof session?.preferred_model === 'string' ? session.preferred_model : '',
    reasoningEffort: typeof session?.reasoning_effort === 'string' ? session.reasoning_effort : undefined,
    planMode: false,
    approvalMode: session?.run_mode === 'auto' ? 'auto_run' : 'prompt',
    proposalDecision: {
      proposal_id: record.proposal_id,
      decision_id: record.decision.decision_id,
      accepted_revision: record.decision.accepted_revision,
      choice,
    },
  };
}

function runtimeReady(runtime) {
  return Boolean(runtime) && typeof runtime.submitApplicationTurn === 'function';
}

// Durable submission. Returns exactly one of
//   {outcome:'ack', work_id, turn_id}
//   {outcome:'refused', runtimeUnavailable, causeCode}
// An unproven acknowledgment is reconciled through the runtime store by the same
// idempotency key before it is called refused.
async function submitContinuation({
  runtime, record, session, build = buildContinuationRequest,
}) {
  if (!runtimeReady(runtime)) return { outcome: 'refused', runtimeUnavailable: true, causeCode: 'runtime_unavailable' };
  const key = runtimeIdempotencyKey(record.dispatch_key_sha256);
  let result;
  try {
    result = await runtime.submitApplicationTurn(build(record, session), { idempotencyKey: key });
  } catch {
    result = { ok: false, reason: 'runtime_submission_refused', acceptance: 'unknown' };
  }
  if (result?.ok === true && typeof result.work_id === 'string' && typeof result.turn_id === 'string') {
    return { outcome: 'ack', work_id: result.work_id, turn_id: result.turn_id };
  }
  const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
  if (result?.acceptance !== 'rejected') {
    const found = typeof runtime.findApplicationSubmission === 'function' ? runtime.findApplicationSubmission(key) : null;
    if (found && found.session_id === record.source_session_id) {
      return { outcome: 'ack', work_id: found.work_id, turn_id: found.turn_id };
    }
  }
  return { outcome: 'refused', runtimeUnavailable: RUNTIME_UNAVAILABLE_REASONS.has(reason), causeCode: reason };
}

// chat-stream event -> the action state it implies for the continuation turn, or
// null when it says nothing about the turn's progress. A turn that ends waiting
// for the user (questions, a plan) or at a deliberate boundary (a complete event carrying
// completionReason) finished its work without error.
function classifyStreamEvent(event) {
  const type = event?.type;
  if (typeof type !== 'string') return null;
  if (!TERMINAL_STREAM_TYPES.has(type)) return 'admitted'; // any live event of the turn means it started
  if (type !== 'error') return 'succeeded';
  if (event.error_code === 'session_busy' || event.category === 'session_busy') return null; // never started
  const status = String(event.terminal_status || event.status || '').toLowerCase();
  return status === 'cancelled' || event.category === 'cancelled' ? 'cancelled' : 'failed';
}

// The terminal a chat-stream event implies for a SOURCE turn (not a continuation):
// {terminal:'complete'|'failed'|'cancelled'|null, completionReason}. `completionReason` is the
// closed boundary reason S3 adds to the complete event (awaiting_proposal | session_handoff_completed).
function streamTerminal(event) {
  const next = classifyStreamEvent(event);
  const reason = event?.type === 'complete' && typeof event.completionReason === 'string' ? event.completionReason : null;
  if (next === 'succeeded') return { terminal: 'complete', completionReason: reason };
  if (next === 'failed' || next === 'cancelled') return { terminal: next, completionReason: null };
  return { terminal: null, completionReason: null };
}

// Reconciliation verdict for one unsettled Git record at startup. Never acts on
// the runtime; it only reads. `completeKnown(sessionId, turnId)` is true only when
// the turn's terminal is durably known to be a normal completion.
//   {verdict:'ack', work_id, turn_id}        queued, acknowledgment lost: adopt the found work
//   {verdict:'dispatch_lost'}                queued, nothing found: needs_attention (retry is idempotent)
//   {verdict:'succeeded'|'cancelled'|'unknown'|'keep'}
function reconcileVerdict({ runtime, record, completeKnown }) {
  const readable = runtime && typeof runtime.getApplicationWork === 'function';
  if (!record.continuation_work_id) {
    const found = runtime && typeof runtime.findApplicationSubmission === 'function'
      ? runtime.findApplicationSubmission(runtimeIdempotencyKey(record.dispatch_key_sha256)) : null;
    return found && found.session_id === record.source_session_id
      ? { verdict: 'ack', work_id: found.work_id, turn_id: found.turn_id }
      : { verdict: 'dispatch_lost' };
  }
  const work = readable ? runtime.getApplicationWork(record.continuation_work_id) : null;
  if (!work) return { verdict: 'unknown' };
  if (work.status === 'completed') {
    return completeKnown(record.source_session_id, record.continuation_turn_id)
      ? { verdict: 'succeeded' } : { verdict: 'unknown' };
  }
  if (work.status === 'cancelled') return { verdict: 'cancelled' };
  // pending/running work the runtime will still drive stays tracked by the stream
  // hook; a paused, restart_paused, failed or attention state cannot be proven
  // here and is never resumed.
  return ['pending', 'running'].includes(work.status) ? { verdict: 'keep' } : { verdict: 'unknown' };
}

module.exports = {
  LABELS,
  RUNTIME_UNAVAILABLE_REASONS,
  buildContinuationPrompt,
  buildContinuationRequest,
  buildLocalContinuationRequest,
  classifyStreamEvent,
  reconcileVerdict,
  streamTerminal,
  submitContinuation,
};
