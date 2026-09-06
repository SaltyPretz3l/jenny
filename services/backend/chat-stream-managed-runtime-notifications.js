// Notification handlers receive explicit ctx so extracted functions mutate shared runtime state.

const {
  normalizeRuntimeToken,
  normalizeRuntimeNumber,
  buildPhaseSnapshot,
  normalizeTokenRate,
  isSuccessfulStopReason,
  textSequenceKey,
} = require('./chat-stream-managed-runtime-utils');
const {
  appendProviderReasoningDelta,
  buildAggregateCheckpointFields,
  isPairedReasoningDelta,
} = require('./chat-stream-reasoning-delta');
const {
  reduceToTurnEventKind,
  validateTurnEvent,
} = require('./canonical-turn-event');
const {
  isAgentStatusSurfaceEnabled,
  coordinateWorkLifecycle,
  normalizeAgentProgressNotification,
} = require('./work-lifecycle-coordinator');
const { normalizePendingQuestionBatch } = require('./message-normalization');
const {
  buildStreamToolResultMessageId,
  buildStreamToolUseMessageId,
} = require('./tool-message-id');
const {
  normalizePhaseSummary,
} = require('./chat-transcript-phase-collector');
const {
  hasValidInteractiveQuestionCount,
} = require('./interactive-session-utils');
const {
  INTERACTIVE_ERROR_CODES,
} = require('./error-codes');
const {
  touchActiveTurnProgress,
} = require('./chat-stream-session-lifecycle');
const {
  noteBackgroundJobFromToolResult,
} = require('./chat-stream-background-jobs');
const {
  attachWorkspaceIdentityToCanonicalEvent,
} = require('./chat-stream-tool-payload-utils');
const {
  commitMidTurnCompactionSnapshot,
  persistAutomaticCompactionSnapshot,
  stageMidTurnCompactionCandidate,
} = require('./compaction-midturn-snapshot');
const { buildContextUsageStreamEvent, rebuildChatDoneUsage } = require('./chat-stream-usage');
const { persistTerminalContextUsage } = require('./session-context-usage');
const { normalizeResumableStop } = require('./chat-stream-stop-detail');

// Every notification.method this router (or the tool-handling claim at the
// bottom of handleNotification) knows how to consume. Anything else used to
// fall through every if-block and vanish with no trace (W3.8).
const KNOWN_NOTIFICATION_METHODS = new Set([
  'turn.event',
  'chat.thinking',
  'agent.progress',
  'chat.question_batch',
  'chat.phase_started',
  'chat.phase_completed',
  'chat.stream_reset',
  'chat.token',
  'tool.executing',
  'tool.output_chunk',
  'tool.result',
  'context.compacted',
  'context.usage',
  'chat.done',
  'chat.error',
  'runtime.gap_candidate',
]);

function canonicalToolNotification(ctx, event) {
  const { streamId, resolvedSessionId } = ctx;
  const eventType = normalizeRuntimeToken(event?.type);
  const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const callId = normalizeRuntimeToken(event?.tool_call_id || payload.tool_call_id || payload.toolCallId);
  const toolName = normalizeRuntimeToken(payload.tool_name || payload.toolName);
  if (!callId || !toolName) {
    return null;
  }
  const common = {
    request_id: streamId,
    requestId: streamId,
    stream_id: streamId,
    streamId,
    session_id: resolvedSessionId,
    sessionId: resolvedSessionId,
    tool_name: toolName,
    tool_call_id: callId,
    tool_input: payload.tool_input || payload.input || {},
  };
  if (eventType === 'tool_call_requested' || eventType === 'tool_execution_started') {
    return {
      method: 'tool.executing',
      params: common,
    };
  }
  if (eventType === 'tool_execution_completed' || eventType === 'tool_execution_failed') {
    const success = eventType === 'tool_execution_completed' && payload.success !== false;
    return {
      method: 'tool.result',
      params: {
        ...common,
        success,
        output: String(payload.tool_output_summary || payload.output_text || payload.output || ''),
        content_type: normalizeRuntimeToken(payload.content_type) || 'text',
        ...(payload.ui_payload != null ? { ui_payload: payload.ui_payload } : {}),
        ...(Array.isArray(payload.generated_artifacts) ? { generated_artifacts: payload.generated_artifacts } : {}),
        ...(payload.error_code ? { error_code: payload.error_code } : {}),
        ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? { metadata: payload.metadata }
          : {}),
        ...(payload.duration_ms != null ? { duration_ms: payload.duration_ms } : {}),
      },
    };
  }
  return null;
}

function applyVisibleTextDelta(ctx, tokenDelta, params = {}, options = {}) {
  const { service, streamId, resolvedSessionId, transcriptCollector, emitChatStream } = ctx;
  const text = String(tokenDelta || '');
  if (!text) {
    return false;
  }
  const sequenceValue = params.sequence ?? params.tokenSequence;
  const shouldDedupeSequence = options.dedupeBySequence === true
    && Boolean(textSequenceKey(sequenceValue));
  if (shouldDedupeSequence && !ctx.appliedTextSequenceGate.shouldApply(sequenceValue)) {
    return false;
  }
  if (ctx.streamSawBatch) {
    ctx.sidecarProtocolError = new Error(
      `${INTERACTIVE_ERROR_CODES.TEXT_AFTER_BATCH} Interactive protocol error: received text after question batch.`
    );
    return false;
  }
  ctx.streamSawText = true;
  ctx.assistantText += text;
  ctx.currentSegmentText += text;
  transcriptCollector.appendText(text, {
    timestamp: params.timestamp || new Date().toISOString(),
  });
  if (shouldDedupeSequence) {
    const gapOverflowed = ctx.appliedTextSequenceGate.note(sequenceValue);
    if (
      gapOverflowed
      && ctx.textSequenceGapOverflowWarned !== true
      && typeof service._emitServiceLog === 'function'
    ) {
      ctx.textSequenceGapOverflowWarned = true;
      service._emitServiceLog('WARN', 'chat.text_sequence_gap_overflow', {
        sessionId: resolvedSessionId,
        streamId,
        model: ctx.model,
        ...ctx.appliedTextSequenceGate.state(),
      });
    }
  }
  const tokenSequence = normalizeRuntimeNumber(sequenceValue);
  const assistantText = ctx.assistantText;
  emitChatStream({
    type: 'delta',
    content: text,
    ...buildAggregateCheckpointFields(ctx, assistantText, {
      forceCheckpoint: options.forceAggregateCheckpoint === true,
    }),
    ...(tokenSequence != null ? { tokenSequence } : {}),
    ...ctx.eventBase,
  }, {
    channel: 'response',
  });
  return true;
}

function applyCanonicalBridgeEvent(ctx, event, {
  toolContext,
  handleToolNotification,
  touchProgress,
} = {}) {
  const {
    service, streamId, canonicalBridgeEnabled, transcriptCollector,
    persistCurrentTextSegment, noteDiagnosticToolEvent,
  } = ctx;
  if (!canonicalBridgeEnabled || !event || typeof event !== 'object') {
    return false;
  }
  const eventType = normalizeRuntimeToken(event.type);
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  if (eventType === 'text_delta') {
    if (typeof touchProgress === 'function') touchProgress();
    return applyVisibleTextDelta(ctx, String(payload.delta || ''), {
      sequence: payload.sequence ?? event.seq,
      timestamp: event.ts,
    }, {
      dedupeBySequence: true,
    });
  }
  if (eventType === 'text_part_completed') {
    const completedText = String(payload.text || '');
    if (completedText && !ctx.assistantText) {
      if (typeof touchProgress === 'function') touchProgress();
      return applyVisibleTextDelta(ctx, completedText, {
        sequence: payload.sequence,
        timestamp: event.ts,
      }, {
        dedupeBySequence: false,
        forceAggregateCheckpoint: true,
      });
    }
    if (completedText && completedText.length > ctx.assistantText.length
      && completedText.startsWith(ctx.assistantText)) {
      const suffix = completedText.slice(ctx.assistantText.length);
      if (typeof touchProgress === 'function') touchProgress();
      return applyVisibleTextDelta(ctx, suffix, {
        timestamp: event.ts,
      }, {
        dedupeBySequence: false,
        forceAggregateCheckpoint: true,
      });
    }
    return true;
  }
  if (eventType === 'reasoning_delta') {
    if (typeof touchProgress === 'function') touchProgress();
    const thinkingId = payload.thinking_id || event.part_id;
    if (!isPairedReasoningDelta(ctx, 'canonical', payload.delta, thinkingId)) {
      appendProviderReasoningDelta(ctx, payload.delta, event.ts || new Date().toISOString(), thinkingId, payload);
    }
    return true;
  }
  const toolNotification = canonicalToolNotification(ctx, event);
  if (!toolNotification) {
    return false;
  }
  if (typeof touchProgress === 'function') touchProgress();
  const callId = normalizeRuntimeToken(toolNotification.params?.tool_call_id);
  if (toolNotification.method === 'tool.executing') {
    const toolCallAlreadyProjected = toolContext?.seenToolCalls instanceof Set
      && toolContext.seenToolCalls.has(callId);
    if (
      (ctx.canonicalToolStartedCallIds.has(callId) && eventType === 'tool_execution_started')
      || toolCallAlreadyProjected
    ) {
      return true;
    }
    ctx.canonicalToolStartedCallIds.add(callId);
    ctx.unfinishedToolsSettled = false;
    persistCurrentTextSegment({ allowReasoningOnly: true, atToolBoundary: true });
    noteDiagnosticToolEvent({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      phase: 'executing',
    });
    transcriptCollector.noteToolStep({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      status: 'running',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, callId),
    });
  } else if (toolNotification.method === 'tool.result') {
    // W2-2: a backgrounded run_command's result carries its job id — hand it
    // to the tracker (idempotent, so the legacy notification arriving for the
    // same call is harmless).
    noteBackgroundJobFromToolResult(service, ctx, toolNotification.params);
    noteDiagnosticToolEvent({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      phase: 'result',
    });
    transcriptCollector.noteToolStep({
      callId,
      toolName: String(toolNotification.params.tool_name || ''),
      status: toolNotification.params.success === true ? 'completed' : 'error',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, callId),
      toolResultMessageId: buildStreamToolResultMessageId(streamId, callId),
    });
  }
  return typeof handleToolNotification === 'function'
    ? handleToolNotification(service, toolContext, toolNotification)
    : false;
}

// ChatGPT plan-usage meter ingest (composer footer ring, additive/optional
// wire key -- see docs/plans "ChatGPT plan-usage meter"). `snapshot` is the
// RAW `usage.plan_usage` / `plan_usage` value straight off the wire; the
// store owns normalization. Never lets a store failure break turn settlement.
function ingestPlanUsage(ctx, snapshot, source) {
  const { service, streamId } = ctx;
  if (service?.featureFlags?.chatgpt_plan_meter === false) {
    return;
  }
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }
  try {
    service?.chatgptPlanUsageStore?.ingest?.(snapshot, { source });
  } catch (_error) {
    service?._emitServiceLog?.('WARN', 'chat.plan_usage_not_ingested', { streamId, source });
  }
}

function handleNotification(ctx, notification, {
  toolContext,
  handleToolNotification,
}) {
  const {
    service, adapter, streamId, resolvedSessionId, transcriptCollector,
    turnMetrics, turnEventCollector, assistantBaseMessageId, canonicalBridgeEnabled,
    emitChatStream, emitThinkingStatus, persistCurrentTextSegment,
    discardPersistedTextSegmentsForReset, noteDiagnosticToolEvent, settleUnfinishedToolRows,
    recordSidecarErrorFromParams, beginVisibleCompletionFinalization,
  } = ctx;
  if (toolContext && typeof toolContext === 'object') {
    ctx.latestToolContext = toolContext;
  }
  const params = notification.params && typeof notification.params === 'object'
    ? notification.params
    : {};
  if (turnMetrics && typeof turnMetrics.recordLegacyNotification === 'function') {
    if (notification.method === 'turn.event') {
      if (typeof turnMetrics.recordCanonicalEvent === 'function') {
        turnMetrics.recordCanonicalEvent(params);
      }
      const emittedAt = Date.parse(String(params.ts || ''));
      if (Number.isFinite(emittedAt) && typeof turnMetrics.recordLatency === 'function') {
        turnMetrics.recordLatency(
          'sidecar_notification_to_electron_ms',
          Math.max(Date.now() - emittedAt, 0)
        );
      }
    } else {
      turnMetrics.recordLegacyNotification(notification);
    }
    // No per-notification metrics snapshot rebuild (finding #6): the O(1)
    // counters above are enough; the full snapshot is published once at settle.
  }
  const touchProgress = () => {
    touchActiveTurnProgress(adapter, {
      requestId: streamId,
      streamId,
    });
  };
  if (notification.method === 'turn.event') {
    const identityStampedParams = attachWorkspaceIdentityToCanonicalEvent(
      params,
      service,
      toolContext?.workspaceRoot
    );
    const validation = validateTurnEvent(identityStampedParams);
    if (
      validation.status !== 'accepted'
      && turnMetrics
      && typeof turnMetrics.recordDroppedCanonicalEvent === 'function'
    ) {
      turnMetrics.recordDroppedCanonicalEvent();
    }
    const captured = turnEventCollector && typeof turnEventCollector.noteEvent === 'function'
      ? turnEventCollector.noteEvent(identityStampedParams, { validation })
      : null;
    if (
      !captured
      && validation.status === 'accepted'
      && reduceToTurnEventKind(validation.event)
      && turnMetrics
      && typeof turnMetrics.recordDroppedCanonicalEvent === 'function'
    ) {
      turnMetrics.recordDroppedCanonicalEvent();
    }
    if (validation.status === 'accepted') {
      applyCanonicalBridgeEvent(ctx, validation.event, {
        toolContext,
        handleToolNotification,
        touchProgress,
      });
    }
    return;
  }
  if (notification.method === 'chat.thinking') {
    touchProgress();
    const thinkingBudgetChars = Number(params.thinking_budget_chars);
    if (Number.isFinite(thinkingBudgetChars) && thinkingBudgetChars > 0) {
      ctx.thinkingBudgetChars = Math.max(ctx.thinkingBudgetChars || 0, thinkingBudgetChars);
    }
    const kind = String(params.kind || '').trim().toLowerCase();
    const shouldPersist = params.persist === true || kind === 'reasoning';
    const thinkingId = String(params.thinking_id || '');
    if (!shouldPersist && thinkingId) {
      ctx.currentThinkingPhaseId = thinkingId;
    }
    if (shouldPersist) {
      if (!canonicalBridgeEnabled || !isPairedReasoningDelta(ctx, 'legacy', params.delta, thinkingId)) {
        appendProviderReasoningDelta(ctx, params.delta, undefined, thinkingId || ctx.currentThinkingPhaseId, {
          tokens_per_second: params.tokens_per_second,
        });
      }
    } else {
      emitThinkingStatus(params.delta, thinkingId);
    }
    return;
  }
  if (notification.method === 'agent.progress') {
    const agentStatus = normalizeAgentProgressNotification(params, {
      streamId,
      sessionId: resolvedSessionId,
      requestId: streamId,
    });
    if (!agentStatus || !isAgentStatusSurfaceEnabled(service, agentStatus)) {
      return;
    }
    coordinateWorkLifecycle(service, adapter, agentStatus);
    emitChatStream({
      ...ctx.eventBase,
      ...agentStatus,
    }, { channel: 'control' });
    return;
  }
  if (notification.method === 'chat.question_batch') {
    touchProgress();
    if (ctx.streamSawText && !ctx.streamSawDone) {
      ctx.sidecarProtocolError = new Error(
        `${INTERACTIVE_ERROR_CODES.MIXED_TEXT_AND_BATCH} Interactive protocol error: mixed text and question batch in one turn.`
      );
      return;
    }
    const candidateBatch =
      params.batch && typeof params.batch === 'object' ? params.batch : params;
    const normalizedBatch = normalizePendingQuestionBatch(candidateBatch);
    if (!normalizedBatch || !hasValidInteractiveQuestionCount(normalizedBatch)) {
      ctx.sidecarProtocolError = new Error(
        `${INTERACTIVE_ERROR_CODES.INVALID_BATCH_PAYLOAD} Interactive protocol error: invalid question batch payload.`
      );
      return;
    }
    ctx.questionBatch = normalizedBatch;
    ctx.streamSawBatch = true;
    emitThinkingStatus('');
    return;
  }
  if (notification.method === 'chat.phase_started') {
    touchProgress();
    if (service?.featureFlags?.aggregate_checkpoints === true) {
      ctx.aggregateCheckpointPending = true;
    }
    const summary = normalizePhaseSummary(params.summary);
    const tokenRate = normalizeTokenRate(params.tokens_per_second);
    transcriptCollector.notePhaseStarted({
      phase_id: String(params.phase_id || ''),
      phase_kind: String(params.phase_kind || ''),
      iteration: Number(params.iteration || 0) || 0,
      thinking_id: String(params.thinking_id || ''),
      tool_call_id: String(params.tool_call_id || ''),
      tool_name: String(params.tool_name || ''),
      summary,
      ...(tokenRate != null ? { tokens_per_second: tokenRate } : {}),
    });
    ctx.currentPhaseSnapshot = buildPhaseSnapshot({
      phase_id: String(params.phase_id || ''),
      phase_kind: String(params.phase_kind || ''),
      iteration: Number(params.iteration || 0) || 0,
      thinking_id: String(params.thinking_id || ''),
      tool_call_id: String(params.tool_call_id || ''),
      tool_name: String(params.tool_name || ''),
      summary,
    });
    emitChatStream({
      type: 'phase_started',
      phaseId: String(params.phase_id || ''),
      phaseKind: String(params.phase_kind || ''),
      iteration: Number(params.iteration || 0) || 0,
      thinkingId: String(params.thinking_id || ''),
      toolCallId: String(params.tool_call_id || ''),
      toolName: String(params.tool_name || ''),
      summary,
      ...(tokenRate != null ? { tokensPerSecond: tokenRate } : {}),
      ...ctx.eventBase,
    }, { channel: 'phase', phase: ctx.currentPhaseSnapshot });
    return;
  }
  if (notification.method === 'chat.phase_completed') {
    touchProgress();
    if (service?.featureFlags?.aggregate_checkpoints === true) {
      ctx.aggregateCheckpointPending = true;
    }
    const summary = normalizePhaseSummary(params.summary);
    const tokenRate = normalizeTokenRate(params.tokens_per_second);
    transcriptCollector.notePhaseCompleted({
      phase_id: String(params.phase_id || ''),
      completed_at: new Date().toISOString(),
      summary,
      ...(tokenRate != null ? { tokens_per_second: tokenRate } : {}),
    });
    ctx.currentPhaseSnapshot = buildPhaseSnapshot({
      phase_id: String(params.phase_id || ''),
      phase_kind: String(params.phase_kind || ''),
      iteration: Number(params.iteration || 0) || 0,
      thinking_id: String(params.thinking_id || ''),
      tool_call_id: String(params.tool_call_id || ''),
      tool_name: String(params.tool_name || ''),
      summary,
    }) || ctx.currentPhaseSnapshot;
    emitChatStream({
      type: 'phase_completed',
      phaseId: String(params.phase_id || ''),
      phaseKind: String(params.phase_kind || ''),
      iteration: Number(params.iteration || 0) || 0,
      thinkingId: String(params.thinking_id || ''),
      toolCallId: String(params.tool_call_id || ''),
      toolName: String(params.tool_name || ''),
      summary,
      ...(tokenRate != null ? { tokensPerSecond: tokenRate } : {}),
      ...ctx.eventBase,
    }, { channel: 'phase', phase: ctx.currentPhaseSnapshot });
    return;
  }
  if (notification.method === 'chat.stream_reset') {
    // Most resets replace the entire active answer. Tool continuations and
    // terminal wind-downs instead preserve earlier durable segments while
    // clearing only the current live slice. This deliberately does not depend
    // on canonicalBridgeEnabled: multi-tool turns need the same persistence
    // behavior with the canonical bridge canary disabled.
    const resetReason = String(params.reason || '');
    const preserveToolContinuation = (
      resetReason === 'tool_continuation'
      && service?.featureFlags?.response_loop_display_v2 === true
    );
    // deterministic_replacement is NOT a preserve reason. StreamResetEvent's
    // contract (sidecar/ai/routing/loop_events.py) names it alongside
    // provider_retry / nudge_retry / reflexive_retry / post_tool_restart as a
    // garbage reset whose "discarded text is bad and must not survive", and
    // its emission site
    // (tool_loop_finalize.py) fires it when the model produced pseudo-search
    // text for a lookup it could not run — the loop then returns the real
    // unavailability answer instead. Preserving those segments persists
    // fabricated content into the transcript.
    const preservePriorSegments = preserveToolContinuation
      || resetReason === 'model_winddown';
    if (!preservePriorSegments) {
      discardPersistedTextSegmentsForReset();
      // The reset discards the persisted segment messages, so the live-captured
      // text/reasoning turn events that referenced them must not persist either.
      if (turnEventCollector && typeof turnEventCollector.discardCapturedEvents === 'function') {
        turnEventCollector.discardCapturedEvents(streamId, [
          'assistant_text_segment',
          'reasoning_phase',
        ]);
      }
    } else if (
      !preserveToolContinuation
      && turnEventCollector
      && typeof turnEventCollector.discardCapturedEvents === 'function'
    ) {
      turnEventCollector.discardCapturedEvents(
        streamId,
        ['assistant_text_segment', 'reasoning_phase'],
        { primaryMessageId: assistantBaseMessageId },
      );
    }
    ctx.lastReasoningEventPhaseKey = '';
    // Advance the reasoning ordinal even when preserving: the pre-reset phase's
    // event_id is already in the journal (which dedupes by event_id), so a
    // post-reset reasoning phase needs a fresh id to journal at all — otherwise
    // it silently collides with the pre-reset phase and one is dropped.
    ctx.reasoningTurnEventOrdinal += 1;
    ctx.assistantText = '';
    ctx.currentSegmentText = '';
    ctx.reasoningEntries = [];
    ctx.reasoningTailBreakPending = false;
    ctx.reasoningRawTailText = '';
    ctx.reasoningSanitizedTailText = '';
    ctx.reasoningTruncationLogged = false;
    ctx.questionBatch = null;
    ctx.thinkingStatusText = '';
    ctx.currentThinkingPhaseId = '';
    ctx.lastReasoningThinkingId = '';
    ctx.reasoningTransportChunks = null;
    ctx.streamSawText = false;
    ctx.streamSawDone = false;
    ctx.streamSawBatch = false;
    // Convention-following only, with no reachable repro today: a successful
    // chat.done both sets this and finalizes in the same block, so a reset can
    // never land between the two. Kept because this block's job is to void every
    // terminal-shaped field the discarded attempt produced, and a future change
    // that defers finalization would otherwise reintroduce the stale carry.
    ctx.resumableStop = null;
    // Keep hasPersistedSegments on the preserve path: the preserved segments are
    // still real, so finalize must route the final answer through the proven
    // multi-segment path (persist it as its own segment) rather than rewriting
    // the base message. On the discard path nothing survives, so clear it.
    // The refusal latch clears with it: a refusal describes content this
    // discard just erased, and left set it would falsely veto the restarted
    // reply's settle (spurious durability warning + retained active_turn).
    // On the preserve path a pre-reset refusal is still a real durable loss,
    // so the latch survives there.
    if (!preservePriorSegments) {
      ctx.hasPersistedSegments = false;
      ctx.segmentPersistRefused = false;
      ctx.refusedTextSegments = [];
    }
    ctx.visibleAssistantMessageId = assistantBaseMessageId;
    ctx.currentPhaseSnapshot = null;
    ctx.appliedTextSequenceGate.reset();
    ctx.canonicalToolStartedCallIds.clear();
    ctx.legacyTextSequence = 0;
    if (service?.featureFlags?.aggregate_checkpoints === true) {
      ctx.aggregateCheckpointPending = true;
    }
    transcriptCollector.resetSlice();
    transcriptCollector.turnHasVisibleText = false;
    // Emit the exact next persisted assistant segment ID after reset because the
    // renderer's local counter can diverge; compute it after reset bookkeeping.
    const nextAssistantMessageId = `assistant_${streamId}_seg${ctx.textSegmentIndex}`;
    // What this reset ERASED, named for the renderer so it never has to
    // re-derive the branch above from `reason` alone (it cannot: the
    // tool_continuation preserve is flag-gated, and model_winddown erases the
    // live slice while keeping its persisted segments). Exactly three shapes:
    //   'all'        -> discardPersistedTextSegmentsForReset() + every captured
    //                   assistant_text_segment / reasoning_phase for the turn.
    //   'live_slice' -> persisted segments survive; only the captured events
    //                   scoped to assistantBaseMessageId (the unsaved live
    //                   slice) are dropped. model_winddown.
    //   'none'       -> nothing erased. tool_continuation with
    //                   response_loop_display_v2 on.
    const discardScope = !preservePriorSegments
      ? 'all'
      : (preserveToolContinuation ? 'none' : 'live_slice');
    emitChatStream({
      type: 'stream_reset',
      // The renderer stamps a "restarted" truncation marker on the latest
      // assistant rows for discarding resets; a preserved tool_continuation
      // reset is genuine commentary and must not be marked. Forward the
      // sidecar's reason so the live reducer can tell the two apart.
      reason: resetReason,
      next_assistant_message_id: nextAssistantMessageId,
      preserve_prior_segments: preservePriorSegments,
      discard_scope: discardScope,
      ...ctx.eventBase,
    }, { channel: 'control', phase: null });
    return;
  }
  if (notification.method === 'chat.token') {
    touchProgress();
    const tokenDelta = String(params.delta || '');
    const bridgeParams = canonicalBridgeEnabled && !textSequenceKey(params.sequence ?? params.tokenSequence)
      ? { ...params, sequence: (ctx.legacyTextSequence += 1) }
      : params;
    applyVisibleTextDelta(ctx, tokenDelta, bridgeParams, {
      dedupeBySequence: canonicalBridgeEnabled,
    });
    return;
  }
  if (notification.method === 'tool.executing') {
    touchProgress();
    const callId = String(params.tool_call_id || '').trim();
    if (canonicalBridgeEnabled && callId && ctx.canonicalToolStartedCallIds.has(callId)) {
      return true;
    }
    ctx.unfinishedToolsSettled = false;
    persistCurrentTextSegment({ allowReasoningOnly: true, atToolBoundary: true });
    noteDiagnosticToolEvent({
      callId,
      toolName: String(params.tool_name || ''),
      phase: 'executing',
    });
    transcriptCollector.noteToolStep({
      callId,
      toolName: String(params.tool_name || ''),
      status: 'running',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, callId),
    });
  }
  if (notification.method === 'tool.output_chunk') {
    // W2-1 live tail: streamed output proves the turn is alive — feed the
    // idle watchdog. Forwarding happens in handleToolNotification below.
    touchProgress();
  }
  if (notification.method === 'tool.result') {
    touchProgress();
    // W2-2 background-job registration (idempotent with the canonical-bridge
    // call site above — the tracker dedupes by job id).
    noteBackgroundJobFromToolResult(service, ctx, params);
    if (params.success === true) {
      // Turn-scoped completed-tool tally: finalizeVisibleCompletion consults it
      // so a no-visible-text ending cannot fail a turn whose tool work landed
      // (F2). Deliberately NOT reset by chat.stream_reset — an executed tool's
      // side effects survive a text reset.
      ctx.toolResultCounts.successful += 1;
    } else {
      ctx.toolResultCounts.failed += 1;
    }
    noteDiagnosticToolEvent({
      callId: String(params.tool_call_id || ''),
      toolName: String(params.tool_name || ''),
      phase: 'result',
    });
    transcriptCollector.noteToolStep({
      callId: String(params.tool_call_id || ''),
      toolName: String(params.tool_name || ''),
      status: params.success === true ? 'completed' : 'error',
      toolUseMessageId: buildStreamToolUseMessageId(streamId, params.tool_call_id),
      toolResultMessageId: buildStreamToolResultMessageId(streamId, params.tool_call_id),
    });
  }
  if (handleToolNotification(service, toolContext, notification)) {
    return;
  }
  const notificationMethod = String(notification.method || '').trim();
  if (!KNOWN_NOTIFICATION_METHODS.has(notificationMethod)) {
    // Unknown method: count it and warn once per (stream, method) so a
    // sidecar/runtime protocol drift is visible instead of silently eaten.
    if (!(ctx.unknownNotificationMethodCounts instanceof Map)) {
      ctx.unknownNotificationMethodCounts = new Map();
    }
    const unknownCount = (ctx.unknownNotificationMethodCounts.get(notificationMethod) || 0) + 1;
    ctx.unknownNotificationMethodCounts.set(notificationMethod, unknownCount);
    if (unknownCount === 1 && typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.unknown_notification_method', {
        sessionId: resolvedSessionId,
        streamId,
        model: ctx.model,
        method: notificationMethod,
      });
    }
    return;
  }
  if (notification.method === 'context.compacted') {
    const summaryPersisted = persistAutomaticCompactionSnapshot(ctx, params);
    stageMidTurnCompactionCandidate(ctx, params);
    emitChatStream({
      type: 'context_compacted',
      strategy: String(params.strategy || 'micro'),
      tokensBefore: Number(params.tokens_before || 0) || 0,
      tokensAfter: Number(params.tokens_after || 0) || 0,
      phase: String(params.phase || 'preflight'),
      summaryStatus: String(params.summary_status || 'not_created'),
      reasonCode: String(params.reason_code || '').slice(0, 80),
      inputComplete: params.input_complete !== false,
      droppedMessages: Math.max(0, Number(params.dropped_messages || 0) || 0),
      droppedBytes: Math.max(0, Number(params.dropped_bytes || 0) || 0),
      summaryPersisted,
      ...ctx.eventBase,
    }, { channel: 'control' });
    return;
  }
  if (notification.method === 'context.usage') {
    // Ephemeral mid-turn meter snapshot. Second gate of the two-layer
    // context_usage_live kill switch (the sidecar owns the first): flag-off
    // drops the snapshot here so a stale sidecar cannot move the ring.
    if (service?.featureFlags?.context_usage_live === false) {
      return;
    }
    emitChatStream({
      ...buildContextUsageStreamEvent(params, ctx.model),
      ...ctx.eventBase,
    }, { channel: 'control' });
    return;
  }
  if (notification.method === 'chat.done') {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('DEBUG', 'chat.stream_received_chat_done', {
        sessionId: resolvedSessionId,
        streamId,
        model: ctx.model,
      });
    }
    const usage = params.usage && typeof params.usage === 'object' ? params.usage : null;
    if (usage) {
      ctx.turnUsage = rebuildChatDoneUsage(usage, ctx.model);
      // Terminal readings are the only ones authoritative enough to seed the
      // composer ring after a restart; the mid-turn context.usage branch above
      // deliberately persists nothing.
      persistTerminalContextUsage(ctx, ctx.turnUsage);
      ingestPlanUsage(ctx, usage.plan_usage, 'chat_done');
    }
    settleUnfinishedToolRows('chat_done');
    if (!isSuccessfulStopReason(params.stop_reason)) {
      ctx.sidecarDoneTerminalError = recordSidecarErrorFromParams(params, {
        stopReason: params.stop_reason,
        retryable: false,
      });
      emitThinkingStatus('');
      return;
    }
    ctx.resumableStop = normalizeResumableStop(params.resumable_stop);
    if (typeof ctx.applyAuthoritativeTerminalText === 'function') {
      ctx.applyAuthoritativeTerminalText(
        params.response_text,
        params.completion_source,
        'chat_done'
      );
    }
    commitMidTurnCompactionSnapshot(ctx);
    ctx.streamSawDone = true;
    if (ctx.streamSawText && !ctx.streamSawBatch && !ctx.visibleCompletionPromise) {
      beginVisibleCompletionFinalization();
    }
    return;
  }
  if (notification.method === 'chat.error') {
    recordSidecarErrorFromParams(params);
    ingestPlanUsage(ctx, params.plan_usage, 'chat_error');
  }
  if (notification.method === 'runtime.gap_candidate') {
    try {
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info('[runtime.gap_candidate]', JSON.stringify({
          schema_version: params.schema_version,
          fingerprint_version: params.fingerprint_version,
          reason_code: params.reason_code,
          detector_id: params.detector_id,
          feature_area: params.feature_area,
          semantic_fingerprint: params.semantic_fingerprint,
          occurrence_id: params.occurrence_id,
          thread_id: params.thread_id,
          turn_id: params.turn_id,
          first_seen_at: params.first_seen_at,
          last_seen_at: params.last_seen_at,
          evidence_issue_safe: params.evidence_issue_safe || null,
        }));
      }
    } catch (logError) {
      void logError;
    }
    service.emit('runtime-gap-candidate', {
      ...ctx.eventBase,
      payload: params,
    });
  }
}

module.exports = {
  handleNotification,
};
