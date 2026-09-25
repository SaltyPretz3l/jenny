'use strict';

const { buildCapturedTurnEventForStorage } = require('./canonical-turn-event-collector-normalize');
const { isContinuationEvent, isContinuationTextProjection } = require('../session-runtime/continuation-events');
const { decisionProjection } = require('./runtime-continuation-effects');
const { stableJson } = require('../session-runtime/contracts');
const { hasDurableProof } = require('./conversation-store-port');

const SAFE_PREFIX_KINDS = new Set(['assistant_text_segment', 'reasoning_phase', 'plan_document']);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function persistRuntimeContinuationPrefix({ collector, conversationStore, sessionId, turnId, streamId,
  assertCurrent, validateDependency = null, pendingCalls = [], validateDecision = null, decision = null } = {}) {
  if (!collector || collector.canonicalPrimary !== true || collector.sessionId !== sessionId
    || collector.turnId !== turnId || collector.attemptId !== streamId
    || typeof collector.flushJournalEvents !== 'function'
    || !Array.isArray(collector.capturedEvents) || typeof conversationStore?.appendTurnEvents !== 'function'
    || typeof assertCurrent !== 'function' || assertCurrent() !== true) {
    fail('runtime_continuation_prefix_fence_conflict');
  }
  const captured = collector.capturedEvents;
  if (captured.length > 4096) fail('runtime_continuation_prefix_capacity');
  const dependencyProven = typeof validateDependency === 'function' && validateDependency(captured) === true;
  const decisionProven = typeof validateDecision === 'function' && validateDecision(captured) === true;
  const decisionContext = { decision, sessionId, turnId, streamId, pendingCalls, events: captured };
  const announced = new Set();
  for (const event of captured) {
    const pending = pendingCalls.find(call => call.call_id === event.tool_call_id);
    const announcement = pending && event.kind === 'tool_use' && event.payload?.canonical_event_type === 'tool_call_requested'
      && event.payload.tool_name === pending.tool_id && stableJson(event.payload.tool_input) === stableJson(pending.arguments)
      && !announced.has(pending.call_id) && String(event.event_id || '').startsWith(`${streamId}:`);
    if (announcement) announced.add(pending.call_id);
    if (event.turn_id !== turnId || (!SAFE_PREFIX_KINDS.has(event.kind) && !dependencyProven && !decisionProven && !announcement)
      || (!isContinuationEvent(event) && !dependencyProven && !(decisionProven && decisionProjection(event, decisionContext)))) {
      fail('runtime_continuation_prefix_ineligible');
    }
  }
  const events = captured.map(buildCapturedTurnEventForStorage);
  if (Buffer.byteLength(JSON.stringify(events)) > 8 * 1024 * 1024) fail('runtime_continuation_prefix_capacity');
  // A tools-only generation legitimately has an empty canonical event prefix.
  // The durable append still flushes the existing user message/active turn.
  const throughSeq = events.reduce((max, event) => Math.max(max, event.payload.canonical_seq || 0), 0);
  collector.flushJournalEvents();
  if (collector.journal && (typeof collector.journal.flush !== 'function' || collector.journal.flush() !== true)) {
    fail('runtime_continuation_journal_not_durable');
  }
  if (assertCurrent() !== true) fail('runtime_continuation_prefix_fence_conflict');
  const commit = conversationStore.appendTurnEvents(sessionId, events, { durable: true });
  if (!hasDurableProof(commit)) fail('runtime_continuation_prefix_not_durable');
  if (assertCurrent() !== true) fail('runtime_continuation_prefix_fence_conflict');
  // Keep the live journal and collector intact. Terminal finalization and
  // clearing recovery evidence belong to their existing lifecycle owner.
  return { through_seq: throughSeq, commit,
    projection_event_ids: events.filter(event => isContinuationTextProjection(event)
      || (decisionProven && decisionProjection(event, decisionContext))).map(event => event.event_id) };
}

module.exports = { persistRuntimeContinuationPrefix };
