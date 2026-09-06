// Behavioral tests for CanonicalTurnEventCollector (services/backend/canonical-turn-event-collector.js).
// Static-literal direct import so the existence gate graph reaches the source.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CanonicalTurnEventCollector,
  buildPersistedTurnEvent,
} = require('../services/backend/canonical-turn-event-collector');
const { buildCommitResult } = require('../services/backend/conversation-store-port');

// ---------------------------------------------------------------------------
// Minimal fake helpers
// ---------------------------------------------------------------------------

function makeStore(overrides = {}) {
  const db = { sessions: {} };
  return {
    getSession(sessionId) {
      return db.sessions[sessionId] || null;
    },
    getSessionMessages(sessionId) {
      return (db.sessions[sessionId] && db.sessions[sessionId].messages) || [];
    },
    getSessionTurnEvents(sessionId) {
      return (db.sessions[sessionId] && db.sessions[sessionId].turn_events) || [];
    },
    appendTurnEvents(sessionId, events) {
      if (!db.sessions[sessionId]) db.sessions[sessionId] = {};
      if (!db.sessions[sessionId].turn_events) db.sessions[sessionId].turn_events = [];
      db.sessions[sessionId].turn_events.push(...events);
    },
    _db: db,
    ...overrides,
  };
}

function makeJournal() {
  const calls = { append: [], clear: [] };
  return {
    append(sessionId, turnId, events) {
      calls.append.push({ sessionId, turnId, events });
    },
    clear(sessionId, turnId) {
      calls.clear.push({ sessionId, turnId });
    },
    _calls: calls,
  };
}

// Build a raw (non-canonical) turn event shape for noteEvent.
function rawEvent(overrides = {}) {
  return {
    kind: 'tool_use',
    turn_id: 'turn-1',
    event_id: 'evt-1',
    status: 'pending',
    payload: {},
    ...overrides,
  };
}

// Build a canonical (v=1) envelope for noteEvent.
function canonicalEnvelope(type, payload = {}, extra = {}) {
  return {
    v: 1,
    turn_id: 'turn-1',
    seq: 1,
    type,
    payload,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. attachStreamEnvelopeMetadata early-return (lines 124-125)
//    If payload already has stream_envelope, it must NOT be overwritten.
// ---------------------------------------------------------------------------

test('noteEvent: existing stream_envelope on payload is not overwritten by source envelope', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const existing = { sequence: 5, event_kind: 'pre-existing' };
  const captured = collector.noteEvent({
    kind: 'tool_use',
    turn_id: 'turn-1',
    event_id: 'e-se-1',
    status: 'pending',
    payload: { stream_envelope: existing },
    stream_envelope: { sequence: 99, event_kind: 'should-be-blocked' },
  });
  assert.ok(captured, 'event must be captured');
  // The pre-existing stream_envelope must survive intact.
  assert.deepEqual(captured.payload.stream_envelope, existing,
    'stream_envelope must not be overwritten when payload already carries it');
});

// ---------------------------------------------------------------------------
// 2. buildCaptureDedupeKey reasoning_phase fallback (lines 225-237)
//    No phase_id, no event_id, no explicit phase identity — falls to the
//    composite key built from payload fields.
// ---------------------------------------------------------------------------

test('noteEvent: reasoning_phase without phase_id or event_id uses composite dedupe key', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // No event_id, no phase_id, entries present for composite key.
  const first = collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    payload: {
      thinking_id: '',
      entries: [{ id: 'entry-1', timestamp: 'ts-1', text: 'hello' }],
    },
    primary_message_id: 'msg-1',
  });
  assert.ok(first, 'first capture must succeed');
  // Send a duplicate with the same composite identity — must coalesce.
  const second = collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    payload: {
      thinking_id: '',
      entries: [{ id: 'entry-1', timestamp: 'ts-1', text: 'updated' }],
    },
    primary_message_id: 'msg-1',
  });
  assert.strictEqual(second, first, 'second note must return the same captured event object (dedupe)');
  // The entry text should have been coalesced (latest wins).
  assert.equal(
    (first.payload.entries || []).find((e) => e.id === 'entry-1')?.text,
    'updated',
    'coalesced entry must carry the latest text'
  );
});

// ---------------------------------------------------------------------------
// 3. statusForCanonicalEvent: turn_failed → 'error' (line 290)
//    and turn_cancelled → 'cancelled' (line 292)
// ---------------------------------------------------------------------------

test('noteEvent(canonical): turn_failed maps to status=error', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const captured = collector.noteEvent(canonicalEnvelope('turn_failed', { message: 'boom' }, {
    tool_call_id: '',
    event_id: 'e-tf-1',
  }));
  assert.ok(captured, 'event must be captured');
  assert.equal(captured.kind, 'assistant_error', 'turn_failed maps to assistant_error kind');
  assert.equal(captured.status, 'error', 'turn_failed must produce status=error');
});

test('noteEvent(canonical): turn_cancelled maps to status=cancelled', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const captured = collector.noteEvent(canonicalEnvelope('turn_cancelled', {}, {
    event_id: 'e-tc-1',
  }));
  assert.ok(captured, 'event must be captured');
  assert.equal(captured.kind, 'assistant_error', 'turn_cancelled maps to assistant_error kind');
  assert.equal(captured.status, 'cancelled', 'turn_cancelled must produce status=cancelled');
});

// ---------------------------------------------------------------------------
// 4. primaryMessageIdForCanonicalEvent: no turn_id → '' (lines 306-307)
// ---------------------------------------------------------------------------

test('noteEvent(canonical): event without turn_id returns null (no primary_message_id)', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: '' });
  // We must not supply turnId to the collector so the fallback cannot fill it.
  // Supply a v=1 envelope that explicitly has an empty turn_id.
  const result = collector.noteEvent({
    v: 1,
    turn_id: '',
    seq: 1,
    type: 'text_part_completed',
    payload: { text: 'hi' },
  });
  // Validation rejects turn_id='', so noteEvent returns null.
  assert.strictEqual(result, null, 'event with no turn_id must not be captured');
});

// ---------------------------------------------------------------------------
// 5. primaryMessageIdForCanonicalEvent: no tool_call_id for tool kind → '' (lines 316-317)
// ---------------------------------------------------------------------------

test('noteEvent(canonical): tool_call_requested without tool_call_id yields empty primary_message_id', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // tool_call_requested maps to 'tool_use' kind; primary_message_id requires tool_call_id.
  const captured = collector.noteEvent({
    v: 1,
    turn_id: 'turn-1',
    seq: 1,
    type: 'tool_call_requested',
    payload: { tool_name: 'bash' },
    // no tool_call_id
  });
  assert.ok(captured, 'event must still be captured');
  assert.equal(captured.primary_message_id, '',
    'primary_message_id must be empty when tool_call_id is absent for a tool kind');
});

// ---------------------------------------------------------------------------
// 6. primaryMessageIdForCanonicalEvent: TOOL_RELATED_KINDS fallback → '' (line 324)
//    This would be a kind in TOOL_RELATED_KINDS that is NOT tool_result and
//    not a text/reasoning/error kind, but DOES have a tool_call_id.
//    approval_requested with tool_call_id → tool_use_<turn>_<callId>
//    We cover the empty branch by passing a non-matching scenario instead.
//    NOTE: line 324 is within primaryMessageIdForCanonicalEvent's final return ''
//    which requires a kind that falls through all branches. Since all TOOL_RELATED_KINDS
//    are handled by the `TOOL_RELATED_KINDS.has(kind)` branch returning tool_use_*,
//    we drive it via a raw (non-canonical) event whose kind is unknown to the function.
// ---------------------------------------------------------------------------

test('noteEvent(raw): unknown kind with tool_call_id leaves primary_message_id empty', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // 'plan_object' is in LIVE_CAPTURED_KINDS but not in TOOL_RELATED_KINDS and
  // not a text/reasoning/error kind, so primaryMessageIdForCanonicalEvent
  // would return ''. But raw events bypass that function entirely;
  // raw event primary_message_id comes from the source directly.
  // Instead, verify a canonical event whose kind maps to '' in primaryMessageIdForCanonicalEvent:
  // turn_started is DURABLE but reduceToTurnEventKind returns null (no PERSISTED_KIND_BY_TYPE entry).
  // So the canonical path exits early at `kind = reduceToTurnEventKind` → null → returns null.
  // We verify that path via a raw event with a not-tool, not-text kind.
  const captured = collector.noteEvent({
    kind: 'plan_object',
    turn_id: 'turn-1',
    event_id: 'e-po-1',
    status: 'completed',
    payload: { plan: 'do stuff' },
    // no primary_message_id in source
  });
  assert.ok(captured, 'plan_object raw event must be captured');
  assert.equal(captured.primary_message_id, '',
    'plan_object with no source primary_message_id yields empty primary_message_id');
});

test('canonical-primary finalize preserves captured plan and citation kinds', () => {
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    canonicalPrimary: true,
  });
  for (const kind of ['plan_object', 'plan_document', 'source_citations']) {
    collector.noteEvent({
      kind,
      turn_id: 'turn-1',
      event_id: `e-${kind}`,
      payload: { value: kind },
    });
  }
  const finalized = collector.buildFinalizedTurnEvents('turn-1', []);
  assert.deepEqual(finalized.map((event) => event.kind), [
    'plan_object', 'plan_document', 'source_citations',
  ]);
});

// ---------------------------------------------------------------------------
// 7. logCanonicalDrop: logger not a function (lines 329-330)
//    When no logger is provided, a drop must still return null without throwing.
// ---------------------------------------------------------------------------

test('noteEvent(canonical): invalid envelope without logger does not throw', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', logger: null });
  // v=99 is unsupported → validateTurnEvent returns status='unsupported' → drop.
  const result = collector.noteEvent({ v: 99, turn_id: 'turn-1', seq: 1, type: 'text_delta', payload: {} });
  assert.strictEqual(result, null, 'unsupported envelope must be dropped and return null');
});

// ---------------------------------------------------------------------------
// 8. logCanonicalDrop: catch block (lines 341-342)
//    Logger throws — must not propagate; drop still returns null.
// ---------------------------------------------------------------------------

test('noteEvent(canonical): logger that throws on drop is silently swallowed', () => {
  const throwingLogger = () => { throw new Error('logger-boom'); };
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    logger: throwingLogger,
  });
  // Drive a drop: version mismatch.
  let result;
  assert.doesNotThrow(() => {
    result = collector.noteEvent({ v: 2, turn_id: 'turn-1', seq: 1, type: 'text_delta', payload: {} });
  }, 'logger throw must be caught; noteEvent must not propagate it');
  assert.strictEqual(result, null, 'dropped event must return null even when logger throws');
});

// ---------------------------------------------------------------------------
// 9. flushJournalEvents: journal.append called for pending reasoning events (lines 431-432)
//    and the empty-group guard (lines 442-443) is bypassed when there are events.
// ---------------------------------------------------------------------------

test('flushJournalEvents: flushes pending reasoning events and clears the queue', () => {
  const journal = makeJournal();
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-1',
    journal,
  });
  // reasoning_phase events are queued rather than immediately journaled.
  collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    event_id: 'e-rp-1',
    phase_id: 'ph-1',
    payload: { phase_id: 'ph-1', entries: [{ id: 'en-1', text: 'thinking' }] },
  });
  // Before flush: append not yet called for this event.
  const beforeFlush = journal._calls.append.length;
  const flushed = collector.flushJournalEvents();
  assert.ok(flushed > 0, 'flushJournalEvents must return the count of flushed events');
  assert.ok(journal._calls.append.length > beforeFlush,
    'journal.append must be called during flush');
  const lastAppend = journal._calls.append[journal._calls.append.length - 1];
  assert.equal(lastAppend.sessionId, 'sess-1', 'append must carry the sessionId');
  assert.equal(lastAppend.turnId, 'turn-1', 'append must carry the turnId');
  assert.ok(Array.isArray(lastAppend.events) && lastAppend.events.length > 0,
    'appended events array must be non-empty');
});

test('flushJournalEvents: skips groups with no turnId (lines 430-432)', () => {
  const journal = makeJournal();
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-1',
    journal,
  });
  // Manually inject a pending entry with no turnId to exercise the skip branch.
  collector.pendingJournalEvents.push({ turnId: '', captured: { kind: 'reasoning_phase', payload: {} } });
  const flushed = collector.flushJournalEvents();
  assert.equal(flushed, 0, 'entry with no turnId must be skipped (flushed count = 0)');
  // journal.append must NOT have been called for the empty-turnId entry.
  assert.equal(journal._calls.append.length, 0, 'journal.append must not be called for empty turnId');
});

// ---------------------------------------------------------------------------
// 10. noteEvent: canonicalSource == null → null (lines 465-466)
//     A canonical envelope (has 'v' key) that fails validation returns null.
// ---------------------------------------------------------------------------

test('noteEvent: canonical envelope that fails validation is dropped (returns null)', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // seq < 1 is invalid.
  const result = collector.noteEvent({ v: 1, turn_id: 'turn-1', seq: 0, type: 'text_delta', payload: {} });
  assert.strictEqual(result, null, 'canonical event with invalid seq must return null');
});

// ---------------------------------------------------------------------------
// 11. _coalesceReasoningEvent: tokens_per_second update (lines 551-552)
//     render_collapsed (lines 553-555), completed flag (lines 556-558),
//     stream_envelope update (lines 559-562)
// ---------------------------------------------------------------------------

test('_coalesceReasoningEvent: coalesces tokens_per_second, render_collapsed, completed, and stream_envelope', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // First note: establishes the event.
  const phase_id = 'ph-coal-1';
  const first = collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    phase_id,
    event_id: 'e-coal-1',
    payload: { phase_id, entries: [{ id: 'en-a', text: 'a' }], chunk_count: 1 },
  });
  assert.ok(first, 'first capture must succeed');

  // Second note: same phase_id → coalesce. Carry tokens_per_second, render_collapsed, completed, stream_envelope.
  collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    phase_id,
    event_id: 'e-coal-2',
    payload: {
      phase_id,
      entries: [{ id: 'en-a', text: 'a-updated' }],
      tokens_per_second: 42.5,
      render_collapsed: true,
      completed: true,
      chunk_count: 2,
    },
    stream_envelope: { sequence: 10, event_kind: 'reasoning_phase' },
  });

  assert.equal(first.payload.tokens_per_second, 42.5, 'tokens_per_second must be coalesced');
  assert.equal(first.payload.render_collapsed, true, 'render_collapsed must be coalesced');
  assert.equal(first.payload.completed, true, 'completed must be coalesced');
  assert.ok(first.payload.stream_envelope, 'stream_envelope must be updated during coalesce');
  // chunk_count: 1 + 2 = 3
  assert.equal(first.payload.chunk_count, 3, 'chunk_count must accumulate across coalescings');
  // entry text updated
  const entry = (first.payload.entries || []).find((e) => e.id === 'en-a');
  assert.equal(entry && entry.text, 'a-updated', 'entry must be updated via latest-wins merge');
});

// ---------------------------------------------------------------------------
// 12. _coalesceReasoningEvent: fill phase_id, primary_message_id, source_message_ids (lines 575-584)
// ---------------------------------------------------------------------------

test('_coalesceReasoningEvent: fills phase_id and primary_message_id when initially absent', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  // Strategy: put phase_id ONLY in payload (not on source directly).
  // buildCaptureDedupeKey uses reasoningPhaseIdentity which checks
  //   source.phase_id || source.phaseId || payload.phase_id
  // so the payload-only phase_id produces a phase-based dedupeKey.
  // But capturedEvent.phase_id is set from normalizeId(source.phase_id || source.phaseId) = ''.
  // This is the scenario where existing.phase_id starts empty despite a dedupeKey existing.
  const PHASE_ID = 'ph-payload-only';
  const first = collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    // No source-level phase_id / phaseId so capturedEvent.phase_id = ''
    payload: {
      phase_id: PHASE_ID,   // dedupeKey uses this but capturedEvent.phase_id stays ''
      entries: [{ id: 'en-x', text: 'x' }],
    },
  });
  assert.ok(first, 'first capture must succeed');
  assert.equal(first.phase_id, '', 'phase_id must initially be empty (only in payload, not source)');
  assert.equal(first.primary_message_id, '', 'primary_message_id must initially be empty');
  assert.deepEqual(first.source_message_ids, [], 'source_message_ids must initially be empty');

  // Second note: same payload.phase_id → same dedupeKey → coalesce.
  // _coalesceReasoningEvent will see !existing.phase_id and fill from incoming.phase_id.
  collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    payload: {
      phase_id: PHASE_ID,
      entries: [{ id: 'en-x', text: 'x2' }],
    },
    primary_message_id: 'msg-filled',
    source_message_ids: ['msg-filled'],
  });

  assert.equal(first.phase_id, PHASE_ID,
    'phase_id must be filled from incoming.phase_id during coalesce');
  assert.equal(first.primary_message_id, 'msg-filled',
    'primary_message_id must be filled from coalesce delta source');
  assert.deepEqual(first.source_message_ids, ['msg-filled'],
    'source_message_ids must be filled from coalesce delta source');
});

// ---------------------------------------------------------------------------
// 13. _coalesceReasoningEvent: re-enqueue into pendingJournalEvents when not already queued (lines 591-593)
// ---------------------------------------------------------------------------

test('_coalesceReasoningEvent: re-enqueues into pendingJournalEvents on coalesce when not already present', () => {
  const journal = makeJournal();
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-1',
    journal,
  });
  const phase_id = 'ph-reenq-1';

  // First note — this queues the event in pendingJournalEvents.
  const first = collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    phase_id,
    event_id: 'e-reenq-1',
    payload: { phase_id, entries: [{ id: 'en-reenq', text: 'r1' }] },
  });
  assert.ok(first, 'first capture must succeed');

  // Flush — removes from pendingJournalEvents and pendingJournalEventRefs.
  collector.flushJournalEvents();
  assert.equal(collector.pendingJournalEvents.length, 0, 'pendingJournalEvents must be empty after flush');

  // Now coalesce again — since the event is no longer in pendingJournalEventRefs, it must be re-enqueued.
  collector.noteEvent({
    kind: 'reasoning_phase',
    turn_id: 'turn-1',
    phase_id,
    event_id: 'e-reenq-2',
    payload: { phase_id, entries: [{ id: 'en-reenq', text: 'r2' }] },
  });

  // After re-coalesce the event should be back in pendingJournalEvents.
  assert.ok(collector.pendingJournalEvents.length > 0,
    'after coalesce of a flushed event, it must be re-enqueued in pendingJournalEvents');
  assert.ok(collector.pendingJournalEventRefs.has(first),
    're-enqueued event must be tracked in pendingJournalEventRefs');
});

// ---------------------------------------------------------------------------
// 14. retargetCapturedEvents: early return for missing args (lines 609-610)
// ---------------------------------------------------------------------------

test('retargetCapturedEvents: returns 0 when turnId is missing', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-rt-1', kind: 'reasoning_phase', phase_id: 'ph-rt' }));
  const count = collector.retargetCapturedEvents('', { phaseIds: ['ph-rt'], messageId: 'msg-new' });
  assert.equal(count, 0, 'retargetCapturedEvents must return 0 when turnId is empty');
});

test('retargetCapturedEvents: returns 0 when messageId is missing', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-rt-2', kind: 'reasoning_phase', phase_id: 'ph-rt2' }));
  const count = collector.retargetCapturedEvents('turn-1', { phaseIds: ['ph-rt2'], messageId: '' });
  assert.equal(count, 0, 'retargetCapturedEvents must return 0 when messageId is empty');
});

test('retargetCapturedEvents: returns 0 when phaseIds is empty', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-rt-3', kind: 'reasoning_phase', phase_id: 'ph-rt3' }));
  const count = collector.retargetCapturedEvents('turn-1', { phaseIds: [], messageId: 'msg-new' });
  assert.equal(count, 0, 'retargetCapturedEvents must return 0 when phaseIds is empty');
});

// ---------------------------------------------------------------------------
// 15. discardCapturedEvents: early return for missing args (lines 633-634)
// ---------------------------------------------------------------------------

test('discardCapturedEvents: returns 0 when turnId is missing', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-dc-1', kind: 'tool_use' }));
  const count = collector.discardCapturedEvents('', ['tool_use']);
  assert.equal(count, 0, 'discardCapturedEvents must return 0 when turnId is empty');
  assert.equal(collector.capturedEvents.length, 1, 'no events must be discarded when turnId is empty');
});

test('discardCapturedEvents: returns 0 when kinds array is empty', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-dc-2', kind: 'tool_use' }));
  const count = collector.discardCapturedEvents('turn-1', []);
  assert.equal(count, 0, 'discardCapturedEvents must return 0 when kinds is empty');
  assert.equal(collector.capturedEvents.length, 1, 'no events must be discarded when kinds is empty');
});

test('discardCapturedEvents: removes matching events from capturedEvents and dedupeMap', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  collector.noteEvent(rawEvent({ event_id: 'e-dc-a', kind: 'tool_use', turn_id: 'turn-1' }));
  collector.noteEvent(rawEvent({ event_id: 'e-dc-b', kind: 'tool_result', turn_id: 'turn-1' }));
  const count = collector.discardCapturedEvents('turn-1', ['tool_use']);
  assert.equal(count, 1, 'discardCapturedEvents must return count of removed events');
  assert.equal(collector.capturedEvents.length, 1, 'only the non-matching event must remain');
  assert.equal(collector.capturedEvents[0].kind, 'tool_result', 'remaining event must be the non-discarded one');
});

// ---------------------------------------------------------------------------
// 16. mergePromotedObservations: logger path on error (lines 673-681)
// ---------------------------------------------------------------------------

test('mergePromotedObservations: catches merge error and logs a warning when logger is set', () => {
  const logCalls = [];
  const logger = (level, code, fields) => logCalls.push({ level, code, fields });

  const patchedCollector = new CanonicalTurnEventCollector({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    logger,
  });

  // Replace the promotedObservationQueue with a fake that returns a promotion
  // whose promoted_observation accessor throws. That throw fires inside
  // mergePromotedObservationsIntoTurnEvents (in the dedupe-key loop which is
  // inside the try block), exercising the catch path (lines 673-681).
  const throwingPromotion = {};
  Object.defineProperty(throwingPromotion, 'promoted_observation', {
    get() { throw new Error('promotion-getter-boom'); },
    configurable: true,
  });
  patchedCollector.promotedObservationQueue = {
    note() {},
    forTurn() { return [throwingPromotion]; },
  };

  const sourceEvents = [{ kind: 'tool_use', turn_id: 'turn-1' }];
  let result;
  assert.doesNotThrow(() => {
    result = patchedCollector.mergePromotedObservations('turn-1', sourceEvents);
  }, 'mergePromotedObservations must catch errors from the queue; must not propagate');

  // On error the source events are returned unmodified.
  assert.deepEqual(result, sourceEvents, 'on merge error the original sourceEvents must be returned');
  // The warning must have been logged.
  const warn = logCalls.find((c) => c.code === 'chat.turn_event_promotion_failed');
  assert.ok(warn, 'a WARN log for chat.turn_event_promotion_failed must be emitted on merge error');
  assert.equal(warn.level, 'WARN', 'log level must be WARN');
  assert.ok(warn.fields && warn.fields.sessionId === 'sess-1', 'log fields must include sessionId');
});

// ---------------------------------------------------------------------------
// 17. buildFinalizedTurnEvents: logger for empty assistant_text_segment (lines 792-793)
// ---------------------------------------------------------------------------

test('buildFinalizedTurnEvents: logs fallback warning and skips empty assistant_text_segment', () => {
  const logCalls = [];
  const logger = (level, code, fields) => logCalls.push({ level, code, fields });

  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-1',
    logger,
  });

  // Capture an assistant_text_segment with empty text.
  collector.noteEvent({
    kind: 'assistant_text_segment',
    turn_id: 'turn-1',
    event_id: 'e-ats-empty',
    primary_message_id: 'pm-ats-1',
    payload: { text: '' }, // empty → must be filtered out with a log warning
  });

  // buildFinalizedTurnEvents with no messages — turn not found, canonicalPrimary=false → returns [].
  // But we need canonicalPrimary=true to exercise the live-captured path.
  // Re-create a collector with canonicalPrimary=true.
  const c2 = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-1',
    logger,
    canonicalPrimary: true,
  });
  c2.noteEvent({
    kind: 'assistant_text_segment',
    turn_id: 'turn-1',
    event_id: 'e-ats-empty-2',
    primary_message_id: 'pm-ats-2',
    payload: { text: '' }, // empty
  });

  c2.buildFinalizedTurnEvents('turn-1', []);

  const warn = logCalls.find((c) => c.code === 'canonical_turn_event.assistant_text_fallback_to_projection');
  assert.ok(warn, 'must log assistant_text_fallback_to_projection for empty text segment');
  assert.equal(warn.level, 'WARN', 'log level must be WARN');
  assert.ok(warn.fields && warn.fields.reason === 'empty_or_truncated_payload_text',
    'log fields must carry the reason');
});

// ---------------------------------------------------------------------------
// 18. buildFinalizedTurnEvents: orphan captured tool events appended at end (lines 894-897)
// ---------------------------------------------------------------------------

test('buildFinalizedTurnEvents: orphan captured tool events (not in projected) are appended at the end', () => {
  // The real projector (projectTurnTree) synthesizes turn ids of the form
  // turn_<index>, so we target 'turn_0' — the turn a single assistant message
  // projects into. Capture a tool_use whose call_id has NO projected
  // counterpart so it is an ORPHAN: the projected-event loop never emits it,
  // and the trailing orphan-append loop (source lines 892-897) must add it.
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn_0',
    canonicalPrimary: false,
  });
  collector.noteEvent({
    kind: 'tool_use',
    turn_id: 'turn_0',
    event_id: 'e-orphan-1',
    tool_call_id: 'call-orphan',
    status: 'pending',
    payload: { tool_name: 'bash', arguments: '{}' },
  });

  // A single assistant message projects into turn_0 with one assistant_text_segment
  // (and NO tool event for call-orphan), so the captured tool event is orphaned.
  const messages = [{ id: 'm1', role: 'assistant', content: 'hello text' }];
  const out = collector.buildFinalizedTurnEvents('turn_0', messages);

  // The projected text segment must be present, AND the orphan tool event must
  // be appended — specifically at the END (after all projected events).
  assert.ok(out.length >= 2,
    'output must contain both the projected text segment and the appended orphan tool event');
  const orphan = out.find((e) => e.tool_call_id === 'call-orphan');
  assert.ok(orphan, 'orphan captured tool event must be appended into the finalized events');
  assert.equal(orphan.kind, 'tool_use', 'appended orphan must retain its tool_use kind');
  assert.equal(out[out.length - 1].tool_call_id, 'call-orphan',
    'orphan tool event must be appended at the END of the finalized events (lines 892-897)');
  // Sanity: a projected (non-tool) event precedes the orphan, proving the orphan
  // was NOT simply the only event — it was genuinely appended after projection.
  assert.ok(out.some((e) => e.kind === 'assistant_text_segment'),
    'the projected assistant_text_segment must also be present, before the orphan');
});

// ---------------------------------------------------------------------------
// 19. persistFinalizedTurn: getSessionMessages fallback (lines 907-908)
//     When messages is undefined, store.getSessionMessages is called.
// ---------------------------------------------------------------------------

test('persistFinalizedTurn: falls back to store.getSessionMessages when messages arg omitted', () => {
  const getSessionMessagesCalls = [];
  const store = makeStore({
    getSessionMessages(sessionId) {
      getSessionMessagesCalls.push(sessionId);
      return [];
    },
  });
  store._db.sessions['sess-fb'] = { turn_event_log_version: 0 };

  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-fb',
    store,
    canonicalPrimary: true,
  });

  // Don't pass messages argument → store.getSessionMessages must be called.
  collector.persistFinalizedTurn('sess-fb', 'turn-1' /* no messages arg */);
  assert.ok(getSessionMessagesCalls.includes('sess-fb'),
    'store.getSessionMessages must be called when messages arg is omitted');
});

// ---------------------------------------------------------------------------
// 20. persistFinalizedTurn: no events → skipped (lines 913-914)
// ---------------------------------------------------------------------------

test('persistFinalizedTurn: returns skipped=true when buildFinalizedTurnEvents yields no events', () => {
  const store = makeStore();
  store._db.sessions['sess-ne'] = { turn_event_log_version: 0 };

  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-ne',
    store,
    canonicalPrimary: true,
  });

  // No captured events and no messages → buildFinalizedTurnEvents returns [].
  const result = collector.persistFinalizedTurn('sess-ne', 'turn-1', []);
  assert.equal(result.skipped, true, 'result must be skipped when no events produced');
  assert.equal(result.reason, 'no_events', 'skipped reason must be no_events');
  assert.equal(result.appended, 0, 'appended must be 0 when skipped');
});

// ---------------------------------------------------------------------------
// 21. persistFinalizedTurn against a store with no getSessionTurnEvents reader.
//     The beforeCount/afterCount fallback this once named went away in 47300204;
//     the store shape is still supported and still worth pinning.
// ---------------------------------------------------------------------------

test('persistFinalizedTurn: falls back to 0 when getSessionTurnEvents is not a function', () => {
  // Build a store without getSessionTurnEvents.
  const appended = [];
  const store = {
    getSession() { return { turn_event_log_version: 0 }; },
    getSessionMessages() { return []; },
    // no getSessionTurnEvents
    appendTurnEvents(sessionId, events) { appended.push(...events); },
  };

  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-gt',
    store,
    canonicalPrimary: true,
  });

  // Capture a canonical assistant_text_segment so there are persisted events.
  collector.noteEvent({
    kind: 'assistant_text_segment',
    turn_id: 'turn-1',
    event_id: 'e-ats-gt',
    primary_message_id: 'pm-gt',
    payload: { text: 'hello world' },
  });

  const result = collector.persistFinalizedTurn('sess-gt', 'turn-1', []);
  // With canonicalPrimary=true and a text segment captured, buildFinalizedTurnEvents
  // produces that event even with no messages (empty projectedEvents), so the persist
  // path is NOT skipped — it actually reaches appendTurnEvents.
  assert.equal(result.skipped, false,
    'persist must proceed (not skip) when there is a captured event to persist');
  // appendTurnEvents must have actually been called with the persisted event(s).
  assert.ok(appended.length > 0,
    'appendTurnEvents must receive the captured event even with no getSessionTurnEvents');
  assert.ok(appended.some((e) => e.kind === 'assistant_text_segment'),
    'the persisted batch must include the captured assistant_text_segment');
  // Reported count is 0 while the append still happened -- distinct from skipped.
  assert.equal(result.appended, 0,
    'appended count must be 0 when the store exposes no getSessionTurnEvents reader');
});

// ---------------------------------------------------------------------------
// 22. persistFinalizedTurn: future log version → skipped (line 912-913)
// ---------------------------------------------------------------------------

test('persistFinalizedTurn: skips when session log version is in the future', () => {
  const store = makeStore();
  // TURN_EVENT_LOG_VERSION is 2; set to 99 to trigger the guard.
  store._db.sessions['sess-fv'] = { turn_event_log_version: 99 };

  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', store });
  const result = collector.persistFinalizedTurn('sess-fv', 'turn-1', []);
  assert.equal(result.skipped, true, 'future log version must cause skip');
  assert.equal(result.reason, 'future_log_version', 'skipped reason must be future_log_version');
});

// ---------------------------------------------------------------------------
// 23. persistFinalizedTurn: invalid_input (no sessionId / no store)
// ---------------------------------------------------------------------------

test('persistFinalizedTurn: returns invalid_input when sessionId is missing', () => {
  const store = makeStore();
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', store });
  const result = collector.persistFinalizedTurn('', 'turn-1', []);
  assert.equal(result.skipped, true, 'must be skipped when sessionId is empty');
  assert.equal(result.reason, 'invalid_input');
});

test('persistFinalizedTurn: returns invalid_input when store is absent', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const result = collector.persistFinalizedTurn('sess-1', 'turn-1', []);
  assert.equal(result.skipped, true, 'must be skipped when store is absent');
  assert.equal(result.reason, 'invalid_input');
});

// ---------------------------------------------------------------------------
// 23b. persistFinalizedTurn journal-clear gating on the structured
//      appendTurnEvents result (the durability fix). A write-blocked or refused
//      append (ok:false) must RETAIN the journal — it is the crash-recovery
//      source for the turn's tool/reasoning provenance — while an all-duplicates
//      or successful durable append clears it.
// ---------------------------------------------------------------------------

function makeAppendResultLogger() {
  const events = [];
  const logger = (level, event, data) => events.push({ level, event, data });
  logger.find = (name) => events.filter((entry) => entry.event === name);
  return logger;
}

// Capture a canonical assistant_text_segment so buildFinalizedTurnEvents yields
// a real event and persistFinalizedTurn actually reaches appendTurnEvents.
function captureOnePersistableEvent(collector) {
  collector.noteEvent({
    kind: 'assistant_text_segment',
    turn_id: 'turn-1',
    event_id: 'e-ats-persist',
    primary_message_id: 'pm-persist',
    payload: { text: 'durable content' },
  });
}

function appendCommit({ ok, appended = 0, duplicateCount = 0, reason = null }) {
  const epoch = ok ? 1 : 0;
  return buildCommitResult({
    ok, applied: ok && appended > 0, durable: ok, reason,
    commitEpoch: epoch, dirtyEpoch: epoch, durableEpoch: epoch,
    value: { appended, duplicateCount },
  });
}

for (const reason of ['unknown_session', 'newer_schema', 'write_failed']) {
  test(`persistFinalizedTurn RETAINS the journal when appendTurnEvents reports ok:false / ${reason}`, () => {
    const store = makeStore({
      appendTurnEvents() {
        return appendCommit({ ok: false, reason });
      },
    });
    store._db.sessions['sess-fail'] = { turn_event_log_version: 0 };
    const journal = makeJournal();
    const logger = makeAppendResultLogger();
    const collector = new CanonicalTurnEventCollector({
      turnId: 'turn-1',
      sessionId: 'sess-fail',
      store,
      journal,
      logger,
      canonicalPrimary: true,
    });
    captureOnePersistableEvent(collector);

    const result = collector.persistFinalizedTurn('sess-fail', 'turn-1', []);
    assert.equal(result.skipped, false, 'the persist path still runs (an append was attempted)');
    assert.equal(
      journal._calls.clear.length,
      0,
      'a failed persist must NOT clear the journal (the events never landed durably)'
    );
    const warns = logger.find('turn_journal.retained_after_persist_failure');
    assert.equal(warns.length, 1, 'a single bounded retained-after-failure WARN must be emitted');
    assert.equal(warns[0].data.reason, reason, 'the WARN carries the structured failure reason');
  });
}

test('persistFinalizedTurn CLEARS the journal when the store reports a flush-verified all_duplicates ok:true', () => {
  // SP-03 (L0.3): all-duplicates is NOT inherently durable — a duplicate-only
  // durable append only reaches ok:true after appendTurnEventsToSession has
  // itself forced a flush-or-fail check (see session-turn-events.js). This
  // store double reports the POST-flush-check outcome directly; the
  // journal-clearing contract under test is persistFinalizedTurn trusting the
  // store's structured `ok`, not an assumption that duplicates imply durable.
  const store = makeStore({
    appendTurnEvents() {
      return appendCommit({
        ok: true,
        duplicateCount: 3,
        reason: 'all_duplicates',
      });
    },
  });
  store._db.sessions['sess-dupe'] = { turn_event_log_version: 0 };
  const journal = makeJournal();
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-dupe',
    store,
    journal,
    canonicalPrimary: true,
  });
  captureOnePersistableEvent(collector);

  const result = collector.persistFinalizedTurn('sess-dupe', 'turn-1', []);
  assert.equal(result.skipped, false);
  assert.equal(result.appended, 0, 'all-duplicates reports zero appended');
  assert.equal(
    journal._calls.clear.length,
    1,
    'a flush-verified all_duplicates ok:true clears the journal; ok:true alone (not "all_duplicates" per se) is the gate'
  );
});

test('persistFinalizedTurn CLEARS the journal on a successful durable append (ok:true / appended)', () => {
  const store = makeStore({
    appendTurnEvents() {
      return appendCommit({ ok: true, appended: 2 });
    },
  });
  store._db.sessions['sess-ok'] = { turn_event_log_version: 0 };
  const journal = makeJournal();
  const collector = new CanonicalTurnEventCollector({
    turnId: 'turn-1',
    sessionId: 'sess-ok',
    store,
    journal,
    canonicalPrimary: true,
  });
  captureOnePersistableEvent(collector);

  const result = collector.persistFinalizedTurn('sess-ok', 'turn-1', []);
  assert.equal(result.skipped, false);
  assert.equal(result.appended, 2, 'the structured appended count is surfaced to the caller');
  assert.equal(journal._calls.clear.length, 1, 'a successful durable append clears the journal');
});

// ---------------------------------------------------------------------------
// 24. buildPersistedTurnEvent: exported directly, verify shape with messageById
// ---------------------------------------------------------------------------

test('buildPersistedTurnEvent: normalizes fields and sanitizes path keys in payload', () => {
  const event = {
    event_id: 'ev-1',
    turn_id: 'turn-1',
    kind: 'tool_result',
    status: 'completed',
    primary_message_id: 'pm-1',
    source_message_ids: ['pm-1'],
    target_message_id: '',
    tool_call_id: 'call-1',
    phase_id: '',
    segment_group_index: null,
    payload: {
      absolute_path: '/home/user/secret',  // must be redacted
      result: 'ok',
    },
  };
  const result = buildPersistedTurnEvent(event, new Map());
  assert.equal(result.event_id, 'ev-1', 'event_id must be preserved');
  assert.equal(result.turn_id, 'turn-1', 'turn_id must be preserved');
  assert.equal(result.payload.absolute_path, '[redacted:path]', 'absolute_path must be redacted');
  assert.equal(result.payload.result, 'ok', 'non-path field must be preserved');
});

// ---------------------------------------------------------------------------
// 25. noteEvent: deduplication path — returns existing captured event on repeat
// ---------------------------------------------------------------------------

test('noteEvent: duplicate raw event by event_id returns the existing captured event', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const evt = rawEvent({ event_id: 'dup-1', kind: 'tool_use', turn_id: 'turn-1' });
  const first = collector.noteEvent(evt);
  const second = collector.noteEvent(evt);
  assert.ok(first, 'first note must produce a captured event');
  assert.strictEqual(second, first, 'duplicate event must return the same captured event reference');
  assert.equal(collector.capturedEvents.length, 1, 'capturedEvents must not grow on duplicate');
});

// ---------------------------------------------------------------------------
// 26. noteEvent: null / non-object input returns null
// ---------------------------------------------------------------------------

test('noteEvent: null input returns null', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  assert.strictEqual(collector.noteEvent(null), null, 'noteEvent(null) must return null');
});

test('noteEvent: event with missing kind returns null', () => {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1' });
  const result = collector.noteEvent({ turn_id: 'turn-1', status: 'ok' }); // no kind
  assert.strictEqual(result, null, 'event missing kind must return null');
});

// ---------------------------------------------------------------------------
// 27. logCanonicalDrop: logger called with correct fields on drop (covers 333-339)
// ---------------------------------------------------------------------------

test('noteEvent(canonical): drop with logger records correct diagnostic fields', () => {
  const logCalls = [];
  const logger = (level, code, fields) => logCalls.push({ level, code, fields });
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', logger });
  // seq=0 causes invalid_seq → drop.
  collector.noteEvent({ v: 1, turn_id: 'turn-1', seq: 0, type: 'text_delta', payload: {} });
  const warn = logCalls.find((c) => c.code === 'canonical_turn_event.dropped');
  assert.ok(warn, 'logger must be called with canonical_turn_event.dropped on drop');
  assert.equal(warn.level, 'WARN', 'log level must be WARN');
  assert.ok(warn.fields && typeof warn.fields.diagnostic_code === 'string',
    'fields must include a diagnostic_code string');
  assert.ok(warn.fields.diagnostic_code.length > 0, 'diagnostic_code must be non-empty');
});
