const {
  normalizeTokenRate,
  createProtocolViolationError,
} = require('./chat-stream-managed-runtime-utils');
const {
  appendPersistedReasoningEntry,
} = require('./chat-stream-reasoning');
const {
  CHAT_PROTOCOL_ERROR_CODES,
} = require('./error-codes');

const AGGREGATE_CHECKPOINT_INTERVAL_MS = 2_000;
// Keep in sync with rendererReasoningEntryMergeUtils.REASONING_EDIT_BASE_TAIL_CHARS.
const REASONING_EDIT_BASE_TAIL_CHARS = 64;

function buildAggregateCheckpointFields(ctx, assistantText, { forceCheckpoint = false } = {}) {
  const aggregate = String(assistantText || '');
  if (ctx.service?.featureFlags?.aggregate_checkpoints !== true) {
    return { aggregate };
  }
  const nowMs = Date.now();
  const lastCheckpointAtMs = Number(ctx.lastAggregateCheckpointAtMs);
  const segmentIndex = Number.isInteger(ctx.textSegmentIndex) ? ctx.textSegmentIndex : 0;
  const shouldCheckpoint = forceCheckpoint
    || ctx.aggregateCheckpointPending === true
    || !Number.isFinite(lastCheckpointAtMs)
    || ctx.lastAggregateCheckpointSegmentIndex !== segmentIndex
    || nowMs - lastCheckpointAtMs >= AGGREGATE_CHECKPOINT_INTERVAL_MS;
  if (!shouldCheckpoint) {
    return { aggregateLength: aggregate.length };
  }
  ctx.lastAggregateCheckpointAtMs = nowMs;
  ctx.lastAggregateCheckpointSegmentIndex = segmentIndex;
  ctx.aggregateCheckpointPending = false;
  return { aggregate, aggregateLength: aggregate.length };
}

function resolvePersistedReasoningCap(thinkingBudgetChars) {
  const budget = Number(thinkingBudgetChars) || 0;
  if (budget <= 0) return 48_000;
  const perPhase = Math.min(Math.max(budget, 48_000), 131_072);
  return Math.min(perPhase * 4, 262_144);
}

function isPairedReasoningDelta(ctx, transport, delta, thinkingId) {
  const chunks = ctx.reasoningTransportChunks ||= { canonical: new Map(), legacy: new Map() };
  const key = `${String(thinkingId || '')}\u0000${String(delta || '')}`;
  const counterpart = transport === 'canonical' ? chunks.legacy : chunks.canonical;
  const counterpartCount = counterpart.get(key) || 0;
  if (counterpartCount > 0) {
    if (counterpartCount === 1) counterpart.delete(key);
    else counterpart.set(key, counterpartCount - 1);
    return true;
  }
  chunks[transport].set(key, (chunks[transport].get(key) || 0) + 1);
  return false;
}

function appendProviderReasoningDelta(ctx, delta, timestamp = new Date().toISOString(), thinkingId, meta = {}) {
  const {
    service, streamId, resolvedSessionId, transcriptCollector, assistantBaseMessageId,
    emitChatStream, noteTurnEvent,
  } = ctx;
  // The V2 coalescer replaces entries by id and cannot preserve append edits.
  const reasoningWireEnabled = service?.featureFlags?.reasoning_wire_deltas === true
    && service?.featureFlags?.stream_envelope_v2 !== true;
  if (!reasoningWireEnabled) {
    delete ctx.reasoningWireLast;
    ctx.reasoningWireResyncPending = false;
  }
  const nextText = String(delta || '');
  if (!nextText) {
    return;
  }
  const resolvedPhaseId = String(thinkingId || '');
  const phaseChanged = resolvedPhaseId && resolvedPhaseId !== ctx.lastReasoningThinkingId;
  if (resolvedPhaseId) {
    ctx.lastReasoningThinkingId = resolvedPhaseId;
  }
  // A persisted segment boundary ends the tail entry even when the thinking id
  // is unchanged/absent (sidecar iteration ids can repeat after an approval
  // resume): coalescing across the boundary duplicated the entry id on two
  // persisted segments.
  const coalesceTail = !phaseChanged && ctx.reasoningTailBreakPending !== true;
  const appended = appendPersistedReasoningEntry(ctx.reasoningEntries, nextText, timestamp, {
    coalesceTail,
    thinkingId: resolvedPhaseId,
    rawTailText: coalesceTail ? ctx.reasoningRawTailText : '',
    sanitizedTailText: coalesceTail ? ctx.reasoningSanitizedTailText : '',
    maxTotalChars: resolvePersistedReasoningCap(ctx.thinkingBudgetChars),
  });
  ctx.reasoningEntries = appended.entries;
  if (appended.entry) {
    ctx.reasoningTailBreakPending = false;
  }
  if (typeof appended.rawText === 'string') {
    ctx.reasoningRawTailText = appended.rawText;
  }
  if (typeof appended.sanitizedTailText === 'string') {
    ctx.reasoningSanitizedTailText = appended.sanitizedTailText;
  }
  if (appended.truncated && ctx.reasoningTruncationLogged !== true) {
    ctx.reasoningTruncationLogged = true;
    service._emitServiceLog('WARN', 'chat.reasoning_truncated', {
      sessionId: resolvedSessionId,
      streamId,
      model: ctx.model,
      reasoningEntryCount: ctx.reasoningEntries.length,
    });
  }
  if (!appended.entry) {
    return;
  }
  const collectorResult = transcriptCollector.appendReasoningEntries(
    [appended.entry],
    {
      thinking_id: resolvedPhaseId,
      timestamp,
      summary: meta.summary,
      tokens_per_second: meta.tokens_per_second ?? meta.tokensPerSecond,
    },
    {
      requirePhaseBoundary: service?.featureFlags?.phase_events === true,
    }
  );
  if (collectorResult.protocolViolation) {
    ctx.reasoningWireResyncPending = true;
    ctx.sidecarProtocolError = createProtocolViolationError(
      `${CHAT_PROTOCOL_ERROR_CODES.REASONING_AFTER_VISIBLE} Transcript protocol error: reasoning arrived after visible text without a new reasoning phase.`,
      CHAT_PROTOCOL_ERROR_CODES.REASONING_AFTER_VISIBLE
    );
    return;
  }
  const phase = collectorResult.phase || {};
  const tokensPerSecond = normalizeTokenRate(phase.tokens_per_second ?? meta.tokens_per_second ?? meta.tokensPerSecond);
  const summary = String(phase.summary || meta.summary || '').trim();
  const reasoningMessageId = ctx.visibleAssistantMessageId || assistantBaseMessageId;
  // One turn event per reasoning PHASE: the ordinal advances on phase change
  // only, so every per-delta snapshot of the same phase carries the same
  // event_id and the collector coalesces it in place instead of appending
  // hundreds of per-chunk events to the persisted turn-event log.
  const eventPhaseKey = String(phase.phase_id || resolvedPhaseId || '');
  const eventPhaseChanged = Boolean(
    eventPhaseKey && eventPhaseKey !== ctx.lastReasoningEventPhaseKey
  );
  if (eventPhaseChanged) {
    if (ctx.lastReasoningEventPhaseKey) {
      ctx.reasoningTurnEventOrdinal += 1;
    }
    ctx.lastReasoningEventPhaseKey = eventPhaseKey;
  }
  noteTurnEvent('reasoning_phase', {
    event_id: `${streamId}:reasoning_phase:live:${ctx.reasoningTurnEventOrdinal}`,
    primary_message_id: reasoningMessageId,
    source_message_ids: [reasoningMessageId],
    phase_id: String(phase.phase_id || resolvedPhaseId || ''),
    status: 'open',
    started_at: String(phase.started_at || timestamp || ''),
    completed_at: String(phase.completed_at || ''),
    payload: {
      phase_id: String(phase.phase_id || resolvedPhaseId || ''),
      phase_kind: 'reasoning',
      thinking_id: String(phase.thinking_id || resolvedPhaseId || ''),
      ...(summary ? { summary } : {}),
      ...(tokensPerSecond != null ? { tokens_per_second: tokensPerSecond } : {}),
      render_collapsed: phase.render_collapsed === true,
      entries: [appended.entry],
      chunk_count: 1,
    },
  });
  const assistantText = ctx.assistantText;
  const reasoningWireLast = ctx.reasoningWireLast;
  const entryText = String(appended.entry.text || '');
  const lastTrim = String(reasoningWireLast?.text || '').trim();
  const nextTrim = entryText.trim();
  const nowMs = Date.now();
  const emitReasoningEdit = reasoningWireEnabled
    && reasoningWireLast
    && reasoningWireLast.id === appended.entry.id
    && ctx.reasoningWireResyncPending !== true
    && !appended.truncated
    && !eventPhaseChanged
    && nowMs - reasoningWireLast.snapshotAtMs < AGGREGATE_CHECKPOINT_INTERVAL_MS
    && nextTrim.length > lastTrim.length
    && nextTrim.startsWith(lastTrim);
  const reasoningWireEntry = emitReasoningEdit
    ? {
        id: appended.entry.id,
        baseLength: lastTrim.length,
        baseTail: lastTrim.slice(-REASONING_EDIT_BASE_TAIL_CHARS),
        append: nextTrim.slice(lastTrim.length),
        timestamp: appended.entry.timestamp,
        ...(appended.entry.thinkingId ? { thinkingId: appended.entry.thinkingId } : {}),
      }
    : appended.entry;
  emitChatStream({
    type: 'delta',
    content: '',
    ...buildAggregateCheckpointFields(ctx, assistantText, {
      forceCheckpoint: eventPhaseChanged,
    }),
    reasoning: {
      source: 'provider',
      entriesDelta: [reasoningWireEntry],
      ...(appended.truncated ? { truncated: true } : {}),
      ...(summary ? { summary } : {}),
      ...(tokensPerSecond != null ? { tokensPerSecond } : {}),
    },
    ...ctx.eventBase,
  }, {
    channel: 'reasoning',
    phase: {
      phase_id: String(phase.phase_id || resolvedPhaseId || ''),
      phase_kind: 'reasoning',
      thinking_id: String(phase.thinking_id || resolvedPhaseId || ''),
      summary,
    },
  });
  if (reasoningWireEnabled) {
    ctx.reasoningWireLast = {
      id: appended.entry.id,
      text: entryText,
      snapshotAtMs: emitReasoningEdit ? reasoningWireLast.snapshotAtMs : nowMs,
    };
    ctx.reasoningWireResyncPending = false;
  }
}

module.exports = {
  appendProviderReasoningDelta,
  buildAggregateCheckpointFields,
  isPairedReasoningDelta,
  resolvePersistedReasoningCap,
};
