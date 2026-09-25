'use strict';

const { normalizeContinuationContext, normalizeDecision } = require('../session-runtime/continuation-contracts');
const { stableJson } = require('../session-runtime/contracts');

const PAUSES = new WeakSet();
function projectDecisionPause(value) {
  return PAUSES.has(value) ? structuredClone(value.payload) : null;
}

// A single managed request owns its waiter and suspended-decision proof.
// This control never grants consent, publishes a checkpoint or releases an actor.
function createRuntimeDecisionControl({ context, sessionId, getCurrentWork, assertCurrent, signal }) {
  const captured = normalizeContinuationContext(context);
  if (!sessionId || typeof getCurrentWork !== 'function' || typeof assertCurrent !== 'function'
    || typeof signal?.aborted !== 'boolean') throw new TypeError('runtime_decision_control_dependencies_invalid');
  let offered = null;
  let suspended = null;
  function current({ requirePause = false } = {}) {
    try {
      const work = getCurrentWork();
      return !signal.aborted && assertCurrent() === true && work?.status === 'running'
      && work.work_id === captured.work_id && work.turn_id === captured.turn_id
      && work.session_id === sessionId && stableJson(work.attempt) === stableJson(captured.source_attempt)
      && work.control_request?.kind !== 'cancel'
      && (!requirePause || work.control_request?.kind === 'pause');
    } catch (_error) { return false; }
  }
  function requestPause() {
    if (suspended || !offered || !current({ requirePause: true })) return false;
    const candidate = offered;
    const pause = Object.freeze({ payload: Object.freeze({ schema_version: 1,
      request_id: captured.source_attempt.stream_id, decision: candidate.decision }) });
    PAUSES.add(pause);
    // The callback synchronously removes the exact live waiter before resolving
    // its reverse RPC. A late UI reply must find no waiter to authorize.
    if (candidate.suspend(pause) !== true) return false;
    offered = null;
    suspended = candidate.decision;
    return true;
  }
  function offer(decision, suspend) {
    if (!decision) return null;
    const normalized = Object.freeze(normalizeDecision(decision));
    if (typeof suspend !== 'function' || !current() || offered || suspended) {
      throw new Error('runtime_decision_offer_conflict');
    }
    const candidate = { decision: normalized, suspend };
    offered = candidate;
    // Install the waiter fully before an already-persisted pause can suspend it.
    queueMicrotask(() => { if (offered === candidate) requestPause(); });
    return () => { if (offered === candidate) offered = null; };
  }
  function validate(decision) {
    return Boolean(suspended && current({ requirePause: true })
      && stableJson(normalizeDecision(decision)) === stableJson(suspended));
  }
  // Terminal repair may observe invalidation even after cancellation/current-work
  // fencing closes publication. This receipt grants no consent or resume authority.
  const suspendedDecision = () => suspended ? { ...suspended } : null;
  return Object.freeze({ offer, requestPause, validate, suspendedDecision });
}

function pauseRuntimeDecision(service, context, work) {
  const streamId = context?.lease?.identity?.streamId;
  if (!streamId || context.cancelled || work.attempt?.stream_id !== streamId
    || work.control_request?.kind !== 'pause') return false;
  return service.activeStreams.get(streamId)?._runtimeDecisionControl?.requestPause() === true;
}

module.exports = { createRuntimeDecisionControl, projectDecisionPause, pauseRuntimeDecision };
