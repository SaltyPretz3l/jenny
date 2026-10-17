'use strict';

/* services/chat-proposal-session-flow.js - the runtime side of a session proposal (row 59
 * checkpoint 5a-1): the injected ports, the source-turn settlement of an ordinary offer (D4:
 * waiting_for_source, withdraw on a failed or cancelled source turn), dispatch of the Do it here
 * continuation and the New session preparation turn, the preparation turn's stream events and
 * 60 s deadline, cancel, and startup reconciliation of every session state. It works on a
 * ChatProposalService instance (`svc`) through that service's own record plumbing. Nothing here
 * resumes or resubmits after a restart, and no diagnostic carries a title, description, task or
 * background: ids, states and reason tokens only.
 */

const continuation = require('./chat-proposal-continuation');
const { fail, succeed } = require('./chat-proposal-contract');
const S = require('./backend/chat-proposal-session-records');

const MAX_TRACKED = 1024;
const RECHECK_DELAYS_MS = Object.freeze([250, 1000, 4000, 16000]);
const RECHECK_STEADY_MS = 30000;
// About an hour of steady polling; past it the choice waits for the next source event, Cancel or a restart.
const RECHECK_MAX_STEPS = 124;

const unsupportedHandoff = () => false;

// ---------- ports ----------

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return handle;
}

// Every port is optional and defaults to a safe refusal: no destinations or models, nothing
// resolvable, the source work's state unknown (so an ordinary offer keeps waiting), no handoff
// support and no child creation.
function buildPorts(options = {}) {
  const pick = (name, fallback) => (typeof options[name] === 'function' ? options[name] : fallback);
  return {
    listDestinations: pick('listDestinations', () => []),
    listModelOptions: pick('listModelOptions', () => ({ models: [], reasoning_efforts: [] })),
    resolveUserMessageTurn: pick('resolveUserMessageTurn', () => null),
    isSourceWorkSettled: pick('isSourceWorkSettled', () => null),
    getTurnCompletionReason: pick('getTurnCompletionReason', () => null),
    supportsSessionHandoff: pick('supportsSessionHandoff', unsupportedHandoff),
    supportsProducerTool: pick('supportsProducerTool', unsupportedHandoff),
    createLinkedChildSession: pick('createLinkedChildSession', () => ({ ok: false, code: 'unsupported' })),
    sessionExists: pick('sessionExists', () => false),
    readSpawnedFrom: pick('readSpawnedFrom', () => null),
    setTimer: pick('setTimer', defaultSetTimer),
    clearTimer: pick('clearTimer', (handle) => clearTimeout(handle)),
  };
}

function safely(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

// The object S6's handoff functions run against (interface note cp5a-s5-s6-interface.md).
function handoffPorts(svc) {
  if (!svc._handoffPortsCache) {
    svc._handoffPortsCache = {
      store: svc._store,
      records: svc._records,
      now: () => svc._now(),
      createId: () => svc._createId(),
      log: (level, event, details) => svc._log(level, event, details),
      notify: (sessionId) => svc._changed(sessionId),
      getRuntime: () => svc._getRuntime(),
      getSessionSummary: (sessionId) => svc._getSessionSummary(sessionId),
      createLinkedChildSession: (spec) => svc._ports.createLinkedChildSession(spec),
      sessionExists: (sessionId) => svc._ports.sessionExists(sessionId),
      readSpawnedFrom: (sessionId) => svc._ports.readSpawnedFrom(sessionId),
      setTimer: (fn, ms) => svc._ports.setTimer(fn, ms),
      clearTimer: (handle) => svc._ports.clearTimer(handle),
      deadlines: svc._deadlines,
    };
  }
  return svc._handoffPortsCache;
}

const apply = (svc, sessionId, proposalId, build) => svc._apply(sessionId, proposalId, (current) => {
  const next = build(current);
  return next ? { record: next } : { abort: { reason: 'noop' } };
});

const isOrdinaryOffer = (record) => record.kind === 'session' && record.binding.session.effective_initiation === 'offer';

// ---------- source-turn settlement (D4) ----------

// 'settled'   the source turn ended at its boundary and the runtime's work is terminal (or the
//             proposal never waits: an unsolicited suggestion or an authorized request)
// 'waiting'   the source turn is still running or its work has not settled
// 'ended'     the source turn failed or was cancelled before settling: its offer is withdrawn
function sourceStatus(svc, record) {
  if (!isOrdinaryOffer(record)) return 'settled';
  const sessionId = record.source_session_id;
  const turnId = record.source_turn_id;
  const seen = svc._turnTerminals.get(turnId);
  if (seen === 'failed' || seen === 'cancelled') return 'ended';
  const settled = safely(() => svc._ports.isSourceWorkSettled(sessionId, turnId));
  const reason = safely(() => svc._ports.getTurnCompletionReason(sessionId, turnId));
  if (reason === 'failed') return 'ended';
  if (seen === 'complete' || typeof reason === 'string') return settled === true ? 'settled' : 'waiting';
  // Terminal work with no terminal for the turn on record: the turn did not reach its boundary.
  return settled === true ? 'ended' : 'waiting';
}

function registerOfferTurn(svc, turnId, sessionId) {
  boundedSet(svc._offerTurns, turnId, sessionId);
}

const markWithdrawn = (svc, record) => (record.kind === 'session' && record.decision_state === 'pending'
  ? svc._records.nextRevision(record, { decision_state: 'withdrawn', action_state: 'none' }) : null);

function stopWatching(svc, proposalId) {
  const watch = svc._waiting.get(proposalId);
  if (watch?.handle !== undefined) safely(() => svc._ports.clearTimer(watch.handle));
  svc._waiting.delete(proposalId);
}

// A pending ordinary offer of a source turn that did not settle is withdrawn; a choice already
// clicked (waiting_for_source) is cancelled. Unsolicited suggestions are untouched.
function withdrawOffer(svc, record) {
  const sessionId = record.source_session_id;
  const build = record.decision_state === 'pending' ? (cur) => markWithdrawn(svc, cur) : S.cancelWaiting;
  const done = apply(svc, sessionId, record.proposal_id, build);
  stopWatching(svc, record.proposal_id);
  return done;
}

function withdrawTurn(svc, sessionId, turnId) {
  const read = svc._store.read(sessionId);
  if (!read.ok || read.frozen) return;
  for (const record of read.records) {
    if (record.source_turn_id !== turnId || !isOrdinaryOffer(record)) continue;
    const waiting = record.decision_state === 'accepted' && record.action_state === 'waiting_for_source';
    if (record.decision_state === 'pending' || waiting) withdrawOffer(svc, record);
  }
}

// chat-stream events of a SOURCE turn that published an ordinary offer.
function onSourceTurnEvent(svc, event) {
  const turnId = typeof event?.turnId === 'string' ? event.turnId : '';
  if (!turnId || !svc._offerTurns.has(turnId)) return;
  const { terminal } = continuation.streamTerminal(event);
  if (!terminal) return;
  const sessionId = svc._offerTurns.get(turnId);
  svc._offerTurns.delete(turnId);
  boundedSet(svc._turnTerminals, turnId, terminal);
  try {
    if (terminal === 'complete') {
      for (const [proposalId, watch] of [...svc._waiting]) {
        if (watch.turnId !== turnId) continue;
        watch.step = 0; // the work usually turns terminal just after the event: back to the fast rechecks
        recheckWaiting(svc, proposalId);
      }
    } else {
      withdrawTurn(svc, sessionId, turnId);
    }
  } catch {
    svc._log('WARN', 'chat_proposal.source_settlement_failed', { reason: 'exception' });
  }
}

function watchWaiting(svc, record) {
  const proposalId = record.proposal_id;
  stopWatching(svc, proposalId);
  svc._waiting.set(proposalId, {
    sessionId: record.source_session_id, turnId: record.source_turn_id, step: 0, handle: undefined,
  });
  scheduleRecheck(svc, proposalId);
}

function scheduleRecheck(svc, proposalId) {
  const watch = svc._waiting.get(proposalId);
  if (!watch || watch.step >= RECHECK_MAX_STEPS) return;
  const delay = RECHECK_DELAYS_MS[watch.step] ?? RECHECK_STEADY_MS;
  watch.step += 1;
  watch.handle = safely(() => svc._ports.setTimer(() => recheckWaiting(svc, proposalId), delay));
}

// One settlement recheck of a waiting choice: release and dispatch it, cancel it, or keep waiting.
function recheckWaiting(svc, proposalId) {
  const watch = svc._waiting.get(proposalId);
  if (!watch) return;
  if (watch.handle !== undefined) safely(() => svc._ports.clearTimer(watch.handle));
  watch.handle = undefined;
  const record = svc._latest(watch.sessionId, proposalId);
  if (!record || record.decision_state !== 'accepted' || record.action_state !== 'waiting_for_source') {
    svc._waiting.delete(proposalId);
    return;
  }
  const status = sourceStatus(svc, record);
  if (status === 'waiting') {
    scheduleRecheck(svc, proposalId);
    return;
  }
  svc._waiting.delete(proposalId);
  if (status === 'ended') {
    apply(svc, watch.sessionId, proposalId, S.cancelWaiting);
    return;
  }
  const released = apply(svc, watch.sessionId, proposalId, S.releaseWaiting);
  if (released.ok && released.record) svc._later(() => dispatch(svc, watch.sessionId, released.record));
}

// ---------- dispatch ----------

function handoffModule(svc) {
  return svc._handoff();
}

// queued -> the continuation (Do it here), the preparation turn (New session) or, once a child is
// reserved, the child creation and first turn (retry).
async function dispatch(svc, sessionId, record) {
  if (record.decision.choice === 'do_it_here') return svc._dispatch(sessionId, record);
  if (record.handoff !== null) return resumeChild(svc, sessionId, record);
  return dispatchPreparation(svc, sessionId, record);
}

async function dispatchPreparation(svc, sessionId, record) {
  const mod = handoffModule(svc);
  const proposalId = record.proposal_id;
  let result;
  try {
    if (typeof mod?.buildPreparationRequest !== 'function') throw new Error('handoff_unavailable');
    result = await continuation.submitContinuation({
      runtime: svc._getRuntime(), record, session: svc._getSessionSummary(sessionId), build: mod.buildPreparationRequest,
    });
  } catch {
    result = { outcome: 'refused', runtimeUnavailable: false, causeCode: 'exception' };
  }
  if (result.outcome === 'ack') {
    svc._track(result.turn_id, sessionId, proposalId, 'queued', 'prep');
    const acked = apply(svc, sessionId, proposalId, (cur) => S.markPrepAcknowledged(cur, { workId: result.work_id, turnId: result.turn_id }));
    if (!acked.ok && !acked.aborted) svc._log('WARN', 'chat_proposal.ack_not_persisted', { reason: acked.reason });
    return;
  }
  const refused = apply(svc, sessionId, proposalId, (cur) => S.markPrepRefused(cur, {
    runtimeUnavailable: result.runtimeUnavailable === true, causeCode: result.causeCode,
  }));
  if (!refused.ok && !refused.aborted) svc._log('WARN', 'chat_proposal.refusal_not_persisted', { reason: refused.reason });
}

// The child is reserved: S6 creates the missing child with the SAME proof and resubmits the SAME
// first-turn key. A failure keeps the child and leaves the record retryable.
async function resumeChild(svc, sessionId, record) {
  const mod = handoffModule(svc);
  let result;
  try {
    result = typeof mod?.resumeChildCreation === 'function'
      ? await mod.resumeChildCreation(handoffPorts(svc), { sessionId, proposalId: record.proposal_id })
      : { ok: false };
  } catch {
    result = { ok: false };
  }
  if (result?.ok === true) return;
  apply(svc, sessionId, record.proposal_id, (cur) => S.markFirstTurnRefused(cur, { causeCode: 'resume_failed' }));
}

// ---------- preparation turn events and deadline ----------

function clearDeadline(svc, record) {
  const mod = svc._handoff();
  if (record && typeof mod?.clearPreparationDeadline === 'function') {
    safely(() => mod.clearPreparationDeadline(handoffPorts(svc), { proposalId: record.proposal_id, attemptId: record.attempt_id }));
  }
}

function failPreparation(svc, sessionId, record, causeCode) {
  clearDeadline(svc, record);
  return apply(svc, sessionId, record.proposal_id, (cur) => (cur.attempt_id === record.attempt_id
    ? S.markPreparationFailed(cur, { causeCode }) : null));
}

function onDeadline(svc, sessionId, proposalId, attemptId) {
  const record = svc._latest(sessionId, proposalId);
  if (!record || record.attempt_id !== attemptId || record.handoff !== null) return;
  if (record.decision_state !== 'accepted' || !['queued', 'preparing'].includes(record.action_state)) return;
  if (record.preparation_work_id) {
    safely(() => svc._getRuntime()?.cancel?.(record.preparation_work_id, { reason: 'deadline' }));
  }
  svc._untrack(record.preparation_turn_id);
  failPreparation(svc, sessionId, record, 'deadline');
}

function startDeadline(svc, record) {
  const mod = svc._handoff();
  if (typeof mod?.startPreparationDeadline !== 'function') return;
  safely(() => mod.startPreparationDeadline(handoffPorts(svc), {
    sessionId: record.source_session_id,
    proposalId: record.proposal_id,
    attemptId: record.attempt_id,
    onExpire: () => onDeadline(svc, record.source_session_id, record.proposal_id, record.attempt_id),
  }));
}

// chat-stream events of the preparation turn: the first live event starts the 60 s deadline and
// marks the record preparing; a terminal without an accepted handoff fails the preparation.
function onPrepEvent(svc, tracked, event) {
  const turnId = event.turnId;
  const next = continuation.classifyStreamEvent(event);
  if (!next) return;
  const { sessionId, proposalId } = tracked;
  try {
    if (next === 'admitted') {
      if (tracked.state === 'started') return;
      tracked.state = 'started';
      const marked = apply(svc, sessionId, proposalId, S.markPreparing);
      const record = marked.record || svc._latest(sessionId, proposalId);
      if (record && record.action_state === 'preparing') startDeadline(svc, record);
      return;
    }
    svc._untrack(turnId);
    const record = svc._latest(sessionId, proposalId);
    if (!record) return;
    clearDeadline(svc, record);
    if (record.decision_state !== 'accepted') return;
    // A handoff whose child or first turn never got recorded (a failed write) would otherwise stay
    // at Preparing/Starting with neither Cancel nor Retry until the next restart.
    if (record.handoff !== null) {
      if (['preparing', 'child_created'].includes(record.action_state) && record.first_turn_work_id === null) {
        apply(svc, sessionId, proposalId, (cur) => (cur.first_turn_work_id === null
          ? S.markFirstTurnRefused(cur, { causeCode: 'prep_terminal' }) : null));
      }
      return;
    }
    if (!['queued', 'preparing'].includes(record.action_state)) return;
    const cause = { succeeded: 'no_handoff', failed: 'prep_error', cancelled: 'prep_cancelled' }[next];
    failPreparation(svc, sessionId, record, cause);
  } catch {
    svc._log('WARN', 'chat_proposal.prep_event_failed', { reason: 'exception' });
  }
}

// ---------- cancel ----------

// waiting_for_source and a pre-child New session cancel here; Do it here uses the continuation
// cancel. Returns null when this flow does not own the record.
function cancelSession(svc, req, record) {
  const choice = record.decision?.choice;
  if (record.kind !== 'session' || (choice === 'do_it_here' && record.action_state !== 'waiting_for_source')) return null;
  const done = (proposal) => succeed({ created: true, proposal: svc._project(proposal) });
  if (record.action_state === 'waiting_for_source') {
    stopWatching(svc, record.proposal_id);
    svc._rememberGesture('cancel', req);
    const cancelled = apply(svc, record.source_session_id, record.proposal_id, S.cancelWaiting);
    return cancelled.ok && cancelled.record ? done(cancelled.record) : fail('not_pending', { currentRevision: record.revision });
  }
  if (record.child_session_id !== null && record.action_state === 'needs_attention') {
    // Nothing runs for a first turn that was never admitted: the cancel only settles the record.
    svc._rememberGesture('cancel', req);
    const cancelled = apply(svc, record.source_session_id, record.proposal_id, S.markSessionCancelled);
    return cancelled.ok && cancelled.record ? done(cancelled.record) : fail('not_pending', { currentRevision: record.revision });
  }
  if (!record.preparation_work_id) return fail('submission_pending', { currentRevision: record.revision });
  const runtime = svc._getRuntime();
  if (typeof runtime?.cancel !== 'function') return fail('unavailable', { currentRevision: record.revision });
  let outcome;
  try {
    outcome = runtime.cancel(record.preparation_work_id, { reason: 'user' });
  } catch {
    return fail('unavailable', { currentRevision: record.revision, retryable: true });
  }
  if (!['cancelled', 'requested'].includes(outcome?.status)) return fail('not_pending', { currentRevision: record.revision });
  svc._rememberGesture('cancel', req);
  clearDeadline(svc, record);
  svc._untrack(record.preparation_turn_id);
  // The user's cancel is durable now; the runtime stops the turn on its own. A handoff recorded
  // first wins (the record then has a child and cancels through the child's own controls).
  const cancelled = apply(svc, record.source_session_id, record.proposal_id, S.markSessionCancelled);
  return cancelled.ok && cancelled.record
    ? done(cancelled.record) : fail('not_pending', { currentRevision: svc._latest(record.source_session_id, record.proposal_id)?.revision ?? record.revision });
}

// A child created but not yet admitted starts no other turn until its first turn is admitted or the
// proposal is cancelled (spec, linked chats). Only the first turn's own submission (its pdk_ key) passes.
// Returns the refusal reason or null; a missing source or record never blocks.
function linkedFirstTurnBlock(svc, sessionId, idempotencyKey = null) {
  const origin = svc._ports.readSpawnedFrom(sessionId);
  if (!origin || typeof origin.parent_session_id !== 'string' || typeof origin.proposal_id !== 'string') return null;
  const record = svc._latest(origin.parent_session_id, origin.proposal_id);
  if (record?.kind !== 'session' || record.child_session_id !== sessionId || record.first_turn_work_id !== null) return null;
  if (!['preparing', 'child_created', 'needs_attention'].includes(record.action_state)) return null;
  return idempotencyKey === svc._records.runtimeIdempotencyKey(record.dispatch_key_sha256) ? null : 'linked_first_turn_pending';
}

// ---------- startup reconciliation ----------

function ackFrom(runtime, key, sessionId) {
  const found = typeof runtime?.findApplicationSubmission === 'function' ? safely(() => runtime.findApplicationSubmission(key)) : null;
  return found && found.session_id === sessionId ? found : null;
}

function reconcilePreparation(svc, sessionId, record) {
  const runtime = svc._getRuntime();
  const proposalId = record.proposal_id;
  if (record.handoff !== null) {
    // A reserved child: never resumed on restart; the user's Retry creates what is missing.
    apply(svc, sessionId, proposalId, (cur) => S.markFirstTurnRefused(cur, { causeCode: 'restart' }));
    return;
  }
  if (!record.preparation_work_id) {
    const found = ackFrom(runtime, svc._records.runtimeIdempotencyKey(record.dispatch_key_sha256), sessionId);
    if (!found) {
      apply(svc, sessionId, proposalId, (cur) => S.markPrepRefused(cur, { causeCode: 'dispatch_lost' }));
      return;
    }
    const acked = apply(svc, sessionId, proposalId, (cur) => S.markPrepAcknowledged(cur, { workId: found.work_id, turnId: found.turn_id }));
    if (acked.ok && acked.record) reconcilePreparation(svc, sessionId, acked.record);
    return;
  }
  const work = typeof runtime?.getApplicationWork === 'function' ? safely(() => runtime.getApplicationWork(record.preparation_work_id)) : null;
  if (work && ['pending', 'running'].includes(work.status)) {
    svc._track(record.preparation_turn_id, sessionId, proposalId, record.action_state === 'preparing' ? 'started' : 'queued', 'prep');
    return;
  }
  const cause = { completed: 'no_handoff', cancelled: 'prep_cancelled' }[work?.status] || 'restart';
  failPreparation(svc, sessionId, record, cause);
}

function reconcileFirstTurn(svc, sessionId, record) {
  const found = ackFrom(svc._getRuntime(), svc._records.runtimeIdempotencyKey(record.dispatch_key_sha256), record.child_session_id);
  if (found) {
    apply(svc, sessionId, record.proposal_id, (cur) => S.markFirstTurnAdmitted(cur, { workId: found.work_id, turnId: found.turn_id }));
  } else {
    apply(svc, sessionId, record.proposal_id, (cur) => S.markFirstTurnRefused(cur, { causeCode: 'dispatch_lost' }));
  }
}

// Returns true when this flow handled the record; false leaves a Do it here continuation to the
// shared Git reconciliation. Pending ordinary offers are settled against their source turn.
function reconcileRecord(svc, sessionId, record) {
  if (record.kind !== 'session') return false;
  if (record.decision_state === 'pending') {
    if (isOrdinaryOffer(record)) {
      if (sourceStatus(svc, record) === 'ended') withdrawOffer(svc, record);
      else registerOfferTurn(svc, record.source_turn_id, sessionId);
    }
    return true;
  }
  if (record.decision_state !== 'accepted') return true;
  const state = record.action_state;
  if (state === 'waiting_for_source') {
    const status = sourceStatus(svc, record);
    if (status === 'ended') apply(svc, sessionId, record.proposal_id, S.cancelWaiting);
    else if (status === 'waiting') watchWaiting(svc, record);
    else {
      const released = apply(svc, sessionId, record.proposal_id, S.releaseWaiting);
      if (released.ok && released.record) svc._later(() => dispatch(svc, sessionId, released.record));
    }
    return true;
  }
  if (record.decision.choice === 'do_it_here') return false;
  if (state === 'queued' || state === 'preparing') reconcilePreparation(svc, sessionId, record);
  else if (state === 'child_created') reconcileFirstTurn(svc, sessionId, record);
  return true;
}

function disposeFlow(svc) {
  for (const watch of svc._waiting.values()) {
    if (watch.handle !== undefined) safely(() => svc._ports.clearTimer(watch.handle));
  }
  svc._waiting.clear();
  for (const handle of svc._deadlines.values()) safely(() => svc._ports.clearTimer(handle));
  svc._deadlines.clear();
  svc._offerTurns.clear();
  svc._turnTerminals.clear();
}

module.exports = {
  RECHECK_DELAYS_MS,
  RECHECK_STEADY_MS,
  buildPorts,
  cancelSession,
  clearDeadline,
  linkedFirstTurnBlock,
  disposeFlow,
  dispatch,
  handoffPorts,
  onPrepEvent,
  onSourceTurnEvent,
  reconcileRecord,
  recheckWaiting,
  registerOfferTurn,
  sourceStatus,
  watchWaiting,
  withdrawOffer,
};
