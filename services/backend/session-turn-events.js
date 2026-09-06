const {
  normalizeTurnEvent,
} = require('./message-normalization');
const {
  logTurnEventDedupeDropped,
} = require('./session-store-logging');
const {
  recordLifecycleDiagnostic,
} = require('./chat-lifecycle-diagnostics');
const {
  finalizeCommit,
  hasDurableProof,
} = require('./conversation-store-port');

// Incompatible shape or kind changes bump TURN_EVENT_LOG_VERSION; additive
// payload fields do not. A bump must also widen the renderer projector's
// SUPPORTED_TURN_EVENT_LOG_VERSION (older builds fall back to message
// projection). Newer on-disk versions must not be mutated.
const TURN_EVENT_LOG_VERSION = 4;
const { settleStalePlanDocumentsOnRead } = require('./plan-document-events');

function normalizeAndSortTurnEvents(rawTurnEvents) {
  const turnEvents = Array.isArray(rawTurnEvents)
    ? rawTurnEvents
        .map((event, index) => normalizeTurnEvent(event, index))
        .filter(Boolean)
        .sort((left, right) => {
          const leftSeq = Number.isInteger(left?.event_seq) ? left.event_seq : Number.MAX_SAFE_INTEGER;
          const rightSeq = Number.isInteger(right?.event_seq) ? right.event_seq : Number.MAX_SAFE_INTEGER;
          return leftSeq - rightSeq;
        })
    : [];
  const maxSeq = turnEvents.reduce((max, event) => (
    Number.isInteger(event?.event_seq) && event.event_seq > max ? event.event_seq : max
  ), -1);
  return { turnEvents, maxSeq };
}

// Append turn events to `store`'s canonical record and report a STRUCTURED
// durability result instead of a session summary. Counts live in `value` on
// the shared CommitResult contract.
// Callers that discard a crash-recovery journal after this call MUST gate on
// `ok`: the historical contract returned a truthy summary even when nothing was
// persisted (future log version, all-duplicates, or a write-blocked upsert),
// which let the turn-event journal be cleared while turn_events never landed.
//   ok:false reasons -> 'unknown_session' | 'newer_schema' | 'write_failed'
//   ok:true  reasons -> null | 'no_events' | 'all_duplicates'
// The no-events case is ok:true with appended:0 (nothing new to make durable).
// The all-duplicates case is ok:true with appended:0 once the caller's
// durability bar is satisfied: for `durable:false` callers the events are
// already in cache, which is correct-enough; for `durable:true` callers a
// prior attempt may have mutated the cache without reaching disk (SP-03 —
// duplicate-only durable replay), so this path also forces a flush before
// reporting ok, exactly like the normal append path below. Pass
// `durable:true` to force the session to disk before ok is reported true, so
// "accepted into cache" is never mistaken for "safe on disk" under debouncing.
//
// `store` is an ElectronSessionStore instance; this helper uses its cache,
// normalization, compaction, and persistence seams exactly as the original
// instance method did (mirrors the session-storage-migration.js `self` pattern).
function appendTurnEventsToSession(store, sessionId, events, {
  updateLogVersion = true,
  bumpUpdatedAt = false,
  durable = false,
} = {}) {
  const session = store.getSession(sessionId);
  if (!session) {
    return finalizeCommit(store, sessionId, {
      accepted: false,
      reason: 'unknown_session',
      value: { appended: 0, duplicateCount: 0 },
    });
  }
  if (Number(session.turn_event_log_version || 0) > TURN_EVENT_LOG_VERSION) {
    return finalizeCommit(store, sessionId, {
      accepted: false,
      reason: 'newer_schema',
      value: { appended: 0, duplicateCount: 0 },
    });
  }
  const sourceEvents = Array.isArray(events) ? events : [];
  if (!sourceEvents.length) {
    return finalizeCommit(store, sessionId, {
      accepted: true,
      reason: 'no_events',
      value: { appended: 0, duplicateCount: 0 },
      durableRequested: durable,
    });
  }
  const existingEventsById = new Map(
    session.turn_events
      .map((event) => [String(event?.event_id || '').trim(), event])
      .filter(([eventId]) => Boolean(eventId))
  );
  let nextSeq = Math.max(
    Number(session.turn_event_seq_counter) || 0,
    session.turn_events.length
  );
  const appendedEvents = [];
  let duplicateCount = 0;
  for (let index = 0; index < sourceEvents.length; index += 1) {
    const normalized = normalizeTurnEvent(sourceEvents[index], index);
    if (!normalized) {
      continue;
    }
    const retainedEvent = existingEventsById.get(normalized.event_id);
    if (retainedEvent) {
      duplicateCount += 1;
      logTurnEventDedupeDropped(
        store._logger,
        store.conversationStore?.kind === 'shadow'
          ? 'session_shadow_store'
          : 'electron_session_store',
        sessionId,
        retainedEvent,
        normalized
      );
      continue;
    }
    const appendedEvent = {
      ...normalized,
      event_seq: nextSeq,
    };
    appendedEvents.push(appendedEvent);
    existingEventsById.set(normalized.event_id, appendedEvent);
    nextSeq += 1;
  }
  if (!appendedEvents.length) {
    // Every incoming event was already present (deduped away). Under
    // debouncing the cache can be ahead of disk (SP-03): a prior durable
    // append may have mutated the cache and then failed to flush, and a
    // same-process retry of the identical events lands here as
    // all-duplicates. If the caller asked for `durable`, force the same
    // flush-or-fail check the normal append path takes below, so a caller
    // that clears its crash-recovery journal on ok:true is never fooled by
    // "already in the in-memory session" into discarding journal provenance
    // whose events never actually reached disk.
    return finalizeCommit(store, sessionId, {
      accepted: true,
      reason: 'all_duplicates',
      value: { appended: 0, duplicateCount },
      durableRequested: durable,
    });
  }
  const combinedEvents = session.turn_events.concat(appendedEvents);
  const compactedTurnEvents = typeof store._compactTurnEvents === 'function'
    ? store._compactTurnEvents(sessionId, combinedEvents)
    : combinedEvents;
  const patch = {
    turn_events: compactedTurnEvents,
    turn_event_seq_counter: nextSeq,
    turn_event_log_version: updateLogVersion
      ? Math.max(Number(session.turn_event_log_version || 0), TURN_EVENT_LOG_VERSION)
      : Number(session.turn_event_log_version || 0),
  };
  const updated = typeof store._updateSessionRecord === 'function'
    ? store._updateSessionRecord(sessionId, patch, { bumpUpdatedAt })
    : store.upsertSession?.(sessionId, patch, { bumpUpdatedAt, allowCreate: false });
  if (!updated) {
    // The upsert was refused: either the store froze on a newer on-disk schema
    // or the synchronous write threw. Report not-ok so callers retain the
    // journal; distinguish the two so the diagnostic is actionable.
    return finalizeCommit(store, sessionId, {
      accepted: false,
      reason: store._backend.hasNewerSchema() ? 'newer_schema' : 'write_failed',
      value: { appended: 0, duplicateCount },
    });
  }
  const appended = appendedEvents.length;
  return finalizeCommit(store, sessionId, {
    accepted: true,
    applied: true,
    reason: null,
    value: { appended, duplicateCount },
    durableRequested: durable,
  });
}

// Append the finalized turn events durably and reconcile the crash-recovery
// journal for a single turn. The journal is cleared ONLY when the events are
// safely on disk (or were already durable); on a write-blocked/refused append
// it is RETAINED and a bounded WARN is emitted so the next recovery pass can
// retry (replay dedupes on event_id). Returns { appended }.
function persistDurableTurnEvents({ store, journal, logger, sessionId, turnId, events }) {
  // durable:true forces the events to disk before we consider clearing the
  // journal — the journal is this turn's crash-recovery provenance source and
  // must not be discarded on a merely-scheduled (debounced) write.
  const appendResult = store.appendTurnEvents(sessionId, events, {
    updateLogVersion: true,
    bumpUpdatedAt: false,
    durable: true,
  });
  const validResult = appendResult
    && typeof appendResult === 'object'
    && !Array.isArray(appendResult)
    && hasDurableProof(appendResult);
  const ok = validResult === true;
  const appended = ok && Number.isFinite(Number(appendResult.value?.appended))
    ? Math.max(0, Number(appendResult.value.appended))
    : 0;
  const reason = ok ? appendResult.reason : (
    appendResult?.ok === false ? appendResult.reason : 'invalid_commit_result'
  );
  if (ok) {
    if (logger && appended > 0) {
      logger('DEBUG', 'chat.turn_events_persisted', { sessionId, turnId, appended });
    }
    if (journal && typeof journal.clear === 'function') {
      journal.clear(sessionId, turnId, { commitResult: appendResult });
    }
  } else if (logger) {
    // Persist failed (unknown session / newer schema / write error): KEEP the
    // journal so the next recovery pass can retry; replay dedupes on event_id.
    logger('WARN', 'turn_journal.retained_after_persist_failure', {
      sessionId,
      turnId,
      reason: reason || 'unknown',
    });
    // A refused durable append is a backend durability_degrade condition.
    recordLifecycleDiagnostic(logger, 'durability_degrade', {
      reason: reason || 'unknown',
      sessionId,
      turnId,
    });
  }
  return { ok, appended, reason: ok ? null : (reason || 'append_refused') };
}

// CTL-001: whole-turn, boundary-explicit event truncation for an edit-resend.
// A turn's events survive only when the turn sits strictly BEFORE the edit
// boundary. The boundary turn is the first turn (in event-log order)
// referencing the edited target or any removed later message; its entire event
// slice — old user payload, assistant text, reasoning, tool and approval
// events — is discarded together with every later turn's, so stale pre-edit
// history can never rehydrate. Pure function over plain data, shared by both
// truncateAfterMessage implementations (ElectronSessionStore and
// SessionShadowStore) so the boundary rule cannot drift between the primary
// store and its recovery mirror.
function truncateTurnEventsAtEditBoundary({ messages, targetIndex, targetId, turnEvents }) {
  const sourceEvents = Array.isArray(turnEvents) ? turnEvents : [];
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const staleMessageIdSet = new Set([targetId]);
  for (const message of sourceMessages.slice(targetIndex + 1)) {
    const staleId = String(message?.id || '');
    if (staleId) {
      staleMessageIdSet.add(staleId);
    }
  }
  const turnOrder = [];
  const seenTurnIds = new Set();
  const taintedTurnIds = new Set();
  for (const event of sourceEvents) {
    if (!event) continue;
    const turnId = String(event.turn_id || '').trim();
    if (!turnId) continue;
    if (!seenTurnIds.has(turnId)) {
      seenTurnIds.add(turnId);
      turnOrder.push(turnId);
    }
    const primaryId = String(event.primary_message_id || '').trim();
    const sourceIds = Array.isArray(event.source_message_ids) ? event.source_message_ids : [];
    if (
      (primaryId && staleMessageIdSet.has(primaryId))
      || sourceIds.some((id) => staleMessageIdSet.has(String(id || '').trim()))
    ) {
      taintedTurnIds.add(turnId);
    }
  }
  const boundaryIndex = turnOrder.findIndex((turnId) => taintedTurnIds.has(turnId));
  const survivingTurnIdSet = new Set(
    boundaryIndex === -1 ? turnOrder : turnOrder.slice(0, boundaryIndex)
  );
  return sourceEvents.filter((event) => {
    const turnId = String(event?.turn_id || '').trim();
    return turnId ? survivingTurnIdSet.has(turnId) : false;
  });
}

// Re-anchoring an existing user message has TWO modes, and they differ only in
// what happens to everything after it. Both live here because both stores call
// them and their own comments require the rule not to drift between the primary
// store and its recovery mirror.
//
//   edit-and-resend (default) -- the prompt CHANGED, so every message and turn
//     after it is stale and goes, per the CTL-001 boundary rule above.
//   failure retry (preserveSupersededTurn) -- the prompt did NOT change; the
//     turn failed. The attempt stays, in messages[] and in the event log, so
//     the transcript still renders it and the retry can build on the work it
//     already did instead of repeating ~50 tool calls. Owner decision,
//     2026-08-26, after a plan_drift terminal cost an entire turn.
//
// The target message itself is replaced by `survivingTarget` in both modes:
// the caller has already applied any content/attachment patch to it, and for a
// retry that patch is a no-op restatement of the same prompt.
//
// `snapshotBasis` is the message list a compaction snapshot must still cover to
// stay valid (JCA-003). A retry restates the same prompt, so the summarized
// prefix survives and the snapshot is worth keeping; a real edit that rewrote
// the target strands anything summarized at or after it.
function resolveReanchoredHistory({
  messages,
  targetIndex,
  targetId,
  survivingTarget,
  turnEvents,
  preserveSupersededTurn,
  targetUnchanged,
}) {
  const sourceMessages = Array.isArray(messages) ? messages : [];
  if (preserveSupersededTurn === true) {
    const messagesOut = sourceMessages.map(
      (message, index) => (index === targetIndex ? survivingTarget : message)
    );
    return {
      messages: messagesOut,
      turnEvents: Array.isArray(turnEvents) ? [...turnEvents] : [],
      snapshotBasis: messagesOut,
    };
  }
  const messagesOut = [...sourceMessages.slice(0, targetIndex), survivingTarget];
  return {
    messages: messagesOut,
    snapshotBasis: targetUnchanged === true
      ? messagesOut
      : sourceMessages.slice(0, targetIndex),
    turnEvents: truncateTurnEventsAtEditBoundary({
      messages: sourceMessages,
      targetIndex,
      targetId,
      turnEvents,
    }),
  };
}

// CTL-010: whole-turn event-log compaction. The persisted projector treats an
// event-covered turn as authoritative and its claim pass rescues only benign
// shapes, so a turn that keeps SOME events but loses others renders split /
// orphaned and fires the legacy-markup rollout canary as a false positive.
// Two rules follow:
//   1. Compaction drops OLDEST WHOLE TURNS — the survivors are the newest
//      contiguous suffix of turns whose cumulative event count fits the keep
//      budget. A single turn larger than the whole budget is dropped entirely
//      (its messages fall back to message-derived projection, which renders
//      the full turn), never retained as an accidental event suffix.
//   2. The summary marker carries a SYNTHETIC turn_id (`<sessionId>:compaction`)
//      that can never collide with a real stream id — a marker reusing a
//      dropped turn's id would itself mark that turn event-covered and orphan
//      its messages onto the canary path.
// Prior markers are absorbed into the new one (cumulative counts), so a log
// only ever holds a single marker. Pure function over plain data, sibling to
// truncateTurnEventsAtEditBoundary for the same cannot-drift reason.
const TURN_EVENT_COMPACTION_KIND = 'turn_events_compacted';

function compactTurnEventsToWholeTurns({ sessionId, turnEvents, maxEvents, keepEvents }) {
  const source = Array.isArray(turnEvents) ? turnEvents : [];
  const max = Math.max(0, Number(maxEvents) || 0);
  if (!max || source.length <= max) {
    return { turnEvents: source, compacted: false, compactedEventCount: 0, compactedTurnCount: 0 };
  }
  // Reserve one slot for the marker, mirroring the historical keep <= max - 1.
  const keepBudget = Math.max(1, Math.min(Number(keepEvents) || max - 1, max - 1));
  const priorMarkers = [];
  const realEvents = [];
  for (const event of source) {
    if (event && event.kind === TURN_EVENT_COMPACTION_KIND) {
      priorMarkers.push(event);
    } else if (event) {
      realEvents.push(event);
    }
  }
  const turnOrder = [];
  const eventsByTurn = new Map();
  for (const event of realEvents) {
    const turnId = String(event.turn_id || '').trim();
    if (!eventsByTurn.has(turnId)) {
      eventsByTurn.set(turnId, []);
      turnOrder.push(turnId);
    }
    eventsByTurn.get(turnId).push(event);
  }
  // Newest-first accumulation, stopping at the first turn that does not fit:
  // survivors must be a CONTIGUOUS suffix (skipping a large middle turn to
  // rescue an older small one would leave a gap the projector renders as
  // out-of-order history).
  const survivingTurnIds = new Set();
  let budget = keepBudget;
  for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
    const turnSize = eventsByTurn.get(turnOrder[index]).length;
    if (turnSize > budget) break;
    survivingTurnIds.add(turnOrder[index]);
    budget -= turnSize;
  }
  const retained = realEvents.filter(
    (event) => survivingTurnIds.has(String(event.turn_id || '').trim())
  );
  const droppedEventCount = realEvents.length - retained.length;
  if (!droppedEventCount && !priorMarkers.length) {
    return { turnEvents: source, compacted: false, compactedEventCount: 0, compactedTurnCount: 0 };
  }
  let cumulativeEventCount = droppedEventCount;
  let cumulativeTurnCount = turnOrder.length - survivingTurnIds.size;
  let markerSeq = null;
  let firstEventId = '';
  for (const marker of priorMarkers) {
    cumulativeEventCount += Math.max(0, Number(marker?.payload?.compacted_count) || 0);
    cumulativeTurnCount += Math.max(0, Number(marker?.payload?.compacted_turn_count) || 0);
    if (Number.isInteger(marker?.event_seq) && (markerSeq === null || marker.event_seq < markerSeq)) {
      markerSeq = marker.event_seq;
    }
    if (!firstEventId && marker?.payload?.first_event_id) {
      firstEventId = String(marker.payload.first_event_id);
    }
  }
  const droppedEvents = realEvents.filter(
    (event) => !survivingTurnIds.has(String(event.turn_id || '').trim())
  );
  const firstDropped = droppedEvents[0] || null;
  const lastDropped = droppedEvents[droppedEvents.length - 1] || null;
  if (firstDropped && Number.isInteger(firstDropped.event_seq)
    && (markerSeq === null || firstDropped.event_seq < markerSeq)) {
    markerSeq = firstDropped.event_seq;
  }
  const marker = {
    event_id: `${sessionId}:${TURN_EVENT_COMPACTION_KIND}:${Date.now()}`,
    event_seq: markerSeq === null ? 0 : markerSeq,
    turn_id: `${String(sessionId || 'session')}:compaction`,
    kind: TURN_EVENT_COMPACTION_KIND,
    status: 'completed',
    primary_message_id: '',
    source_message_ids: [],
    payload: {
      compacted_count: cumulativeEventCount,
      compacted_turn_count: cumulativeTurnCount,
      first_event_id: firstEventId || String(firstDropped?.event_id || ''),
      last_event_id: String(lastDropped?.event_id || ''),
      compacted_at: new Date().toISOString(),
    },
  };
  return {
    turnEvents: [marker, ...retained],
    compacted: true,
    compactedEventCount: cumulativeEventCount,
    compactedTurnCount: cumulativeTurnCount,
  };
}

module.exports = {
  settleStalePlanDocumentsOnRead,
  TURN_EVENT_LOG_VERSION,
  appendTurnEventsToSession,
  compactTurnEventsToWholeTurns,
  normalizeAndSortTurnEvents,
  persistDurableTurnEvents,
  resolveReanchoredHistory,
  truncateTurnEventsAtEditBoundary,
};
