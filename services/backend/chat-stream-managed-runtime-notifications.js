const { acceptPrefillProgress } = require('./prefill-progress');

// Notification handlers receive explicit ctx so extracted functions mutate shared runtime state.

const {
  isSuccessfulStopReason,
  textSequenceKey,
} = require('./chat-stream-managed-runtime-utils');
const {
  appendProviderReasoningDelta,
  isPairedReasoningDelta,
} = require('./chat-stream-reasoning-delta');
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
const { MID_TURN_ACKS } = require('./background-job-mid-turn');
const {
  commitMidTurnCompactionSnapshot,
  persistAutomaticCompactionSnapshot,
  stageMidTurnCompactionCandidate,
} = require('./compaction-midturn-snapshot');
const { buildContextUsageStreamEvent, rebuildChatDoneUsage } = require('./chat-stream-usage');
const { persistTerminalContextUsage } = require('./session-context-usage');
const { normalizeCompletion, normalizeResumableStop } = require('./chat-stream-stop-detail');
const { createCompactionDiagnostics } = require('./turn-diagnostic-compactions');
const { applyVisibleTextDelta, handleCanonicalTurnEvent } = require('./chat-stream-managed-runtime-canonical-bridge');
const { applyStreamReset, notePhaseCompleted, notePhaseStarted } = require('./chat-stream-managed-runtime-phase-reset');

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
  'context.compaction_started',
  'context.compacted',
  'context.usage',
  'inference.performance',
  'heuristic.fire',
  'chat.plan_usage',
  'chat.done',
  'chat.error',
  'runtime.gap_candidate',
  'session.mail_consumed',
  'session.job_notice_consumed',
]);

// ChatGPT plan-usage meter ingest (composer footer ring, additive/optional
// wire key -- see docs/plans "ChatGPT plan-usage meter"). `snapshot` is the
// RAW `usage.plan_usage` / `plan_usage` value straight off the wire; the
// store owns normalization. Never lets a store failure break turn settlement.
function ingestPlanUsage(ctx, snapshot, source) {
  const { service, streamId } = ctx;
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }
  try {
    service?.chatgptPlanUsageStore?.ingest?.(snapshot, { source });
  } catch (_error) {
    service?._emitServiceLog?.('WARN', 'chat.plan_usage_not_ingested', { streamId, source });
  }
}

// FG-008: the turn's compactions for the diagnostics dump (read back through the
// runtime's getDiagnosticCompactions). Summary text only under agent_test_hooks.
function recordCompactionDiagnostic(ctx, params, summaryPersisted) {
  ctx.compactionDiagnostics ||= createCompactionDiagnostics({
    includeText: ctx.service?.featureFlags?.agent_test_hooks === true,
  });
  ctx.compactionDiagnostics.record(params, { summaryPersisted });
}

function handleNotification(ctx, notification, {
  toolContext,
  handleToolNotification,
}) {
  if (notification.method === 'heuristic.fire') return;
  const {
    service, adapter, streamId, resolvedSessionId, transcriptCollector,
    turnMetrics, canonicalBridgeEnabled,
    emitChatStream, emitThinkingStatus, persistCurrentTextSegment,
    noteDiagnosticToolEvent, settleUnfinishedToolRows,
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
      requestId: ctx.turnId || streamId,
      streamId,
    });
  };
  if (notification.method === 'turn.event') {
    handleCanonicalTurnEvent(ctx, params, {
      toolContext,
      handleToolNotification,
      touchProgress,
    });
    return;
  }
  if (notification.method === 'chat.thinking') {
    if (params.progress !== undefined) {
      const accepted = acceptPrefillProgress(ctx, params);
      if (accepted) {
        if (accepted.moved) touchProgress();
        emitThinkingStatus('', String(params.thinking_id || ''), accepted.progress);
      }
      return;
    }
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
    coordinateWorkLifecycle(service, adapter, { ...agentStatus, requestId: ctx.turnId || streamId });
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
    notePhaseStarted(ctx, params);
    return;
  }
  if (notification.method === 'chat.phase_completed') {
    touchProgress();
    notePhaseCompleted(ctx, params);
    return;
  }
  if (notification.method === 'chat.stream_reset') {
    applyStreamReset(ctx, params);
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
    if (callId && ((canonicalBridgeEnabled && ctx.canonicalToolStartedCallIds.has(callId))
      || (toolContext?.seenToolCalls instanceof Set && toolContext.seenToolCalls.has(callId)))) {
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
    noteBackgroundJobFromToolResult(service, ctx, params, toolContext?.workspaceRoot);
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
  if (handleToolNotification(service, toolContext, notification, {
    ...(notification.method === 'tool.executing'
      ? { nextAssistantMessageId: `assistant_${streamId}_seg${ctx.textSegmentIndex}` }
      : {}),
  })) {
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
  if (notification.method === 'context.compaction_started') {
    // `compactionPhase`, not `phase`: emitChatStream owns `phase` (it is the
    // transport phase snapshot) and would overwrite a sidecar string there.
    emitChatStream({
      type: 'context_compacting',
      compactionPhase: String(params.phase || 'preflight'),
      tokensBefore: Math.max(0, Number(params.tokens_before || 0) || 0),
      messageCount: Math.max(0, Number(params.message_count || 0) || 0),
      ...ctx.eventBase,
    }, { channel: 'control' });
    return;
  }
  if (notification.method === 'context.compacted') {
    const summaryPersisted = persistAutomaticCompactionSnapshot(ctx, params);
    stageMidTurnCompactionCandidate(ctx, params);
    const contextCompaction = {
      strategy: String(params.strategy || 'micro'),
      tokensBefore: Number(params.tokens_before || 0) || 0,
      tokensAfter: Number(params.tokens_after || 0) || 0,
      phase: String(params.phase || 'preflight'),
      summaryStatus: String(params.summary_status || 'not_created'),
      reasonCode: String(params.reason_code || '').slice(0, 80),
      inputComplete: params.input_complete !== false,
      droppedMessages: Math.max(0, Number(params.dropped_messages || 0) || 0),
      droppedBytes: Math.max(0, Number(params.dropped_bytes || 0) || 0),
      summarySourceDroppedMessages: Math.max(0, Number(params.summary_source_dropped_messages || 0) || 0),
      summaryPersisted,
      summaryExcerpt: String(params.summary_message?.content || '')
        .replace(/\s+/g, ' ').trim().slice(0, 1200),
    };
    const { phase: compactionPhase, ...wireFields } = contextCompaction;
    emitChatStream({
      type: 'context_compacted',
      ...wireFields,
      compactionPhase,
      ...ctx.eventBase,
    }, { channel: 'control' });
    ctx.transcriptCollector?.noteContextCompaction?.({
      ...contextCompaction,
      occurredAt: new Date().toISOString(),
    });
    recordCompactionDiagnostic(ctx, params, summaryPersisted);
    return;
  }
  if (notification.method === 'chat.plan_usage') {
    ingestPlanUsage(ctx, params.plan_usage, 'chat_progress');
    return;
  }
  // Ephemeral live metrics (row 59 cp6): the intake validates ownership; the stream never waits on it.
  if (notification.method === 'inference.performance') return void service.inferenceIntake?.accept(ctx, params);
  const midTurnAck = MID_TURN_ACKS.get(notification.method); // mail / job notice acks (background-job-mid-turn.js)
  if (midTurnAck) return void midTurnAck(ctx, params);
  if (notification.method === 'context.usage') {
    // Ephemeral mid-turn meter snapshot.
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
    ctx.completion = normalizeCompletion(params);
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
