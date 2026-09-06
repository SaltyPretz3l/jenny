// Failure and interruption helpers take explicit ctx so they share the runtime's
// closure-backed state.

const {
  persistAssistantFailure,
  clearActiveTurn,
  clearInteractivePendingState,
} = require('./chat-stream-session-lifecycle');
const {
  resolveTerminalStatusFromErrorPayload,
} = require('./chat-stream-terminal-utils');
const { planTerminalToolRepairs } = require('./chat-terminal-tool-repair-planner');
const { settleUnfinishedToolsForStream } = require('./chat-stream-tool-handling');
const {
  buildStreamToolResultMessageId,
  buildStreamToolUseMessageId,
} = require('./tool-message-id');

function clearInteractiveStateOnFailure(ctx) {
  if (ctx.normalizedInteractiveResponse) {
    clearInteractivePendingState(ctx.adapter, ctx.normalizedPreferences);
  }
}

function shouldPersistFailureMessage(ctx) {
  // Partial streamed text STRENGTHENS the case for persistence: a failure
  // after tokens streamed must leave a durable row carrying that text, or
  // the partial answer survives nowhere (the renderer's terminal hydration
  // replaces the live bubble with store contents). Only a settled visible
  // completion or a settled question batch — each already persisted its own
  // assistant row — veto the failure row.
  return !ctx.visibleCompletionEmitted && !ctx.streamSawBatch;
}

function persistFailureMessage(ctx, errorPayload) {
  const terminalStatus = resolveTerminalStatusFromErrorPayload(errorPayload);
  const terminalSubcode = String(errorPayload?.terminal_subcode || '').trim().toLowerCase();
  const persisted = persistAssistantFailure(ctx.adapter, {
    messageId: `assistant_${ctx.streamId}`,
    // Only the unpersisted tail: segments before the last tool boundary
    // were already written by persistCurrentTextSegment; with no boundary,
    // currentSegmentText equals the full assistantText.
    content: ctx.currentSegmentText,
    errorPayload,
    reasoningEntries: ctx.reasoningEntries,
    parentStreamId: ctx.streamId,
    phases: ctx.transcriptCollector.slice.phases,
    visibleSegments: ctx.transcriptCollector.slice.visibleSegments,
    toolSteps: ctx.transcriptCollector.slice.toolSteps,
    model: ctx.model,
    terminalStatus,
    terminalSubcode,
  });
  ctx.transcriptCollector.resetSlice();
  clearActiveTurn(ctx.adapter, {
    requestId: ctx.streamId,
    streamId: ctx.streamId,
  });
  return persisted;
}

function clearReconnectStateOnFailure(ctx) {
  clearActiveTurn(ctx.adapter, {
    requestId: ctx.streamId,
    streamId: ctx.streamId,
  });
}

function getErrorState(ctx) {
  return {
    sidecarError: ctx.sidecarError,
    sidecarErrorCode: ctx.sidecarErrorCode,
    sidecarErrorRetryable: ctx.sidecarErrorRetryable,
    sidecarErrorCategory: ctx.sidecarErrorCategory,
    sidecarTerminalSubcode: ctx.sidecarTerminalSubcode,
    sidecarErrorType: ctx.sidecarErrorType,
    sidecarErrorMessage: ctx.sidecarErrorMessage,
  };
}

function noteDiagnosticToolEvent(ctx, { callId, toolName, phase } = {}) {
  const normalizedCallId = String(callId || '').trim();
  const normalizedPhase = String(phase || '').trim();
  if (!normalizedCallId || !normalizedPhase) {
    return;
  }
  const normalizedToolName = String(toolName || '').trim()
    || ctx.diagnosticToolNamesByCallId.get(normalizedCallId)
    || 'tool';
  ctx.diagnosticToolNamesByCallId.set(normalizedCallId, normalizedToolName);
  ctx.diagnosticToolEvents.push({
    call_id: normalizedCallId,
    name: normalizedToolName,
    phase: normalizedPhase,
    ts_ms: Date.now(),
  });
}

function settleUnfinishedToolRows(ctx, reason) {
  if (!ctx.latestToolContext || ctx.unfinishedToolsSettled) {
    return 0;
  }
  const messages = ctx.service?.sessionStore?.getSessionMessages?.(ctx.resolvedSessionId) || [];
  const coordinated = Boolean(ctx.service?.terminalCoordinator?.settle);
  const plan = coordinated
    ? planTerminalToolRepairs(messages, ctx.streamId, {
        model: ctx.model,
        terminalState: 'interrupted',
      })
    : {
        ok: true,
        repairs: settleUnfinishedToolsForStream(
          ctx.service,
          ctx.latestToolContext,
          'interrupted'
        ),
      };
  if (!plan.ok) {
    ctx.unfinishedToolRepairFailure = plan.reason;
    ctx.service?._emitServiceLog?.('ERROR', 'chat.stream_tool_repair_plan_refused', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: plan.reason,
    });
    return 0;
  }
  const settlements = plan.repairs;
  ctx.unfinishedToolRepairs = coordinated ? settlements : [];
  ctx.unfinishedToolsSettled = true;
  if (
    settlements.length
    && ctx.turnMetrics
    && typeof ctx.turnMetrics.recordOrphanToolRepair === 'function'
  ) {
    for (let index = 0; index < settlements.length; index += 1) {
      ctx.turnMetrics.recordOrphanToolRepair();
    }
    ctx.publishCanonicalMetricsSnapshot();
  }
  for (const settlement of settlements) {
    const source = messages.find((message) => String(message?.id || '') === settlement.messageId);
    const toolName = String(settlement.toolName || source?.tool_call?.tool_name || 'tool');
    noteDiagnosticToolEvent(ctx, {
      callId: settlement.callId,
      toolName,
      phase: 'result',
    });
    ctx.transcriptCollector.noteToolStep({
      callId: settlement.callId,
      toolName,
      status: 'error',
      toolUseMessageId: buildStreamToolUseMessageId(ctx.streamId, settlement.callId),
      toolResultMessageId: buildStreamToolResultMessageId(ctx.streamId, settlement.callId),
    });
  }
  if (settlements.length && typeof ctx.service._emitServiceLog === 'function') {
    ctx.service._emitServiceLog('WARN', coordinated
      ? 'chat.stream_unfinished_tools_planned'
      : 'chat.stream_unfinished_tools_settled', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: String(reason || '').trim(),
      count: settlements.length,
    });
  }
  return settlements.length;
}

module.exports = {
  clearInteractiveStateOnFailure,
  shouldPersistFailureMessage,
  persistFailureMessage,
  clearReconnectStateOnFailure,
  getErrorState,
  noteDiagnosticToolEvent,
  settleUnfinishedToolRows,
};
