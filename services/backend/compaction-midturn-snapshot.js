'use strict';

const {
  buildAutomaticCompactionSnapshot,
  fingerprintCompactionPrefix,
} = require('./session-compaction-snapshot');

const MID_TURN_TASK_PIN_MAX_CHARS = 8000;
const MID_TURN_TASK_STUB = '[Original request summarized above]';

function emitAutomaticSummaryLog(ctx, level, event, details) {
  try {
    ctx.service?._emitServiceLog?.(level, event, details);
  } catch (_error) {
    // Summary persistence remains best-effort when diagnostics are unavailable.
  }
}

function persistAutomaticCompactionSnapshotUnsafe(ctx, params) {
  const candidate = ctx.automaticCompactionContext;
  if (!candidate?.eligible || candidate.attempted || candidate.persisted
    || ctx.streamSawDone || ctx.sidecarError || ctx.sidecarDoneTerminalError) {
    return false;
  }
  if (
    String(params.phase || '') !== 'preflight'
    || String(params.summary_status || '') !== 'created'
  ) {
    return false;
  }
  if (params.input_complete !== true) return false;
  candidate.attempted = true;
  const current = ctx.service?.sessionStore?.getSessionMessages?.(ctx.resolvedSessionId);
  const messages = Array.isArray(current) ? current : [];
  const boundaryCount = Number(candidate.boundaryMessageCount);
  const prefix = Number.isSafeInteger(boundaryCount) && boundaryCount > 0
    ? messages.slice(0, boundaryCount)
    : [];
  const liveUserPresent = messages.some(
    (message) => String(message?.id || '') === String(candidate.currentUserMessageId || '')
  );
  if (
    !liveUserPresent
    || prefix.length !== boundaryCount
    || fingerprintCompactionPrefix(prefix) !== candidate.boundaryFingerprint
  ) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: 'boundary_changed',
    });
    return false;
  }
  const snapshot = buildAutomaticCompactionSnapshot({
    summaryMessage: params.summary_message,
    tokensBefore: params.tokens_before,
    tokensAfter: params.tokens_after,
    boundaryMessageId: candidate.boundaryMessageId,
    boundaryMessageCount: boundaryCount,
  });
  if (!snapshot) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: 'malformed_or_oversized_summary',
    });
    return false;
  }
  if (!ctx.service.sessionStore.setCompactionSnapshot(ctx.resolvedSessionId, snapshot)) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: 'store_rejected',
    });
    return false;
  }
  candidate.persisted = true;
  emitAutomaticSummaryLog(ctx, 'INFO', 'chat.automatic_summary_persisted', {
    sessionId: ctx.resolvedSessionId,
    streamId: ctx.streamId,
    boundary_message_count: boundaryCount,
    tokens_before: snapshot.tokens_before,
    tokens_after: snapshot.tokens_after,
  });
  return true;
}

function persistAutomaticCompactionSnapshot(ctx, params) {
  try {
    return persistAutomaticCompactionSnapshotUnsafe(ctx, params);
  } catch (_error) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      reason: 'persistence_exception',
    });
    return false;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stageMidTurnCompactionCandidate(ctx, params) {
  try {
    const candidate = ctx?.automaticCompactionContext;
    const coveredThroughToolCallId = String(params?.covered_through_tool_call_id || '').trim();
    if (
      !candidate?.eligible
      || String(params?.phase || '') !== 'tool_loop'
      || String(params?.summary_status || '') !== 'created'
      || !isPlainObject(params?.summary_message)
      || !coveredThroughToolCallId
    ) {
      return false;
    }
    candidate.midTurn = {
      summaryMessage: params.summary_message,
      tokensBefore: params.tokens_before,
      tokensAfter: params.tokens_after,
      coveredThroughToolCallId,
    };
    return true;
  } catch (_error) {
    return false;
  }
}

function commitMidTurnCompactionSnapshotUnsafe(ctx) {
  const candidate = ctx.automaticCompactionContext;
  const midTurn = candidate?.midTurn;
  if (!midTurn) return false;
  candidate.midTurn = null;

  const current = ctx.service?.sessionStore?.getSessionMessages?.(ctx.resolvedSessionId);
  const messages = Array.isArray(current) ? current : [];
  const boundaryMessageCount = Number(candidate.boundaryMessageCount);
  const prefix = Number.isSafeInteger(boundaryMessageCount) && boundaryMessageCount > 0
    ? messages.slice(0, boundaryMessageCount)
    : [];
  if (
    prefix.length !== boundaryMessageCount
    || fingerprintCompactionPrefix(prefix) !== candidate.boundaryFingerprint
  ) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      phase: 'tool_loop',
      reason: 'boundary_changed',
    });
    return false;
  }

  const currentUserMessageId = String(candidate.currentUserMessageId || '');
  const userIndex = messages.findIndex(
    (message) => String(message?.id || '') === currentUserMessageId
  );
  if (userIndex < boundaryMessageCount) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      phase: 'tool_loop',
      reason: 'boundary_changed',
    });
    return false;
  }

  const coveredIndex = messages.findIndex((message, index) => (
    index > userIndex
    && message?.kind === 'tool_result'
    && String(message?.tool_result?.call_id) === midTurn.coveredThroughToolCallId
  ));
  if (coveredIndex < 0) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      phase: 'tool_loop',
      reason: 'covered_call_missing',
    });
    return false;
  }

  // A multi-call iteration persists as [tool_use, tool_use, tool_result, tool_result]
  // while the sidecar's rows are strict pairs, so the covered result can sit
  // mid-batch. Never split a batch: pull the boundary back to the first tool_use
  // whose result would otherwise be retained without it (and dropped as an orphan).
  let boundaryCount = coveredIndex + 1;
  for (let settled = false; !settled;) {
    settled = true;
    for (let index = boundaryCount; index < messages.length; index += 1) {
      const row = messages[index];
      if (row?.kind !== 'tool_result') continue;
      const callId = String(row?.tool_result?.call_id ?? '');
      const useIndex = messages.findIndex((message, useAt) => (
        useAt > userIndex && useAt < boundaryCount && message?.kind === 'tool_use'
        && String(message?.tool_call?.call_id ?? '') === callId
      ));
      if (useIndex >= 0) {
        boundaryCount = useIndex;
        settled = false;
        break;
      }
    }
  }

  const rawTask = messages[userIndex].content;
  const taskText = typeof rawTask === 'string' ? rawTask : '';
  const taskMessage = {
    role: 'user',
    content: taskText && taskText.length <= MID_TURN_TASK_PIN_MAX_CHARS ? taskText : MID_TURN_TASK_STUB,
  };
  const snapshot = buildAutomaticCompactionSnapshot({
    summaryMessage: midTurn.summaryMessage,
    taskMessage,
    tokensBefore: midTurn.tokensBefore,
    tokensAfter: midTurn.tokensAfter,
    boundaryMessageId: messages[boundaryCount - 1].id,
    boundaryMessageCount: boundaryCount,
  });
  if (!snapshot) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      phase: 'tool_loop',
      reason: 'malformed_or_oversized_summary',
    });
    return false;
  }
  if (!ctx.service.sessionStore.setCompactionSnapshot(ctx.resolvedSessionId, snapshot)) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      phase: 'tool_loop',
      reason: 'store_rejected',
    });
    return false;
  }
  emitAutomaticSummaryLog(ctx, 'INFO', 'chat.automatic_summary_persisted', {
    sessionId: ctx.resolvedSessionId,
    streamId: ctx.streamId,
    phase: 'tool_loop',
    boundary_message_count: snapshot.boundary_message_count,
    tokens_before: snapshot.tokens_before,
    tokens_after: snapshot.tokens_after,
  });
  return true;
}

function commitMidTurnCompactionSnapshot(ctx) {
  try {
    return commitMidTurnCompactionSnapshotUnsafe(ctx);
  } catch (_error) {
    emitAutomaticSummaryLog(ctx, 'WARN', 'chat.automatic_summary_not_persisted', {
      sessionId: ctx?.resolvedSessionId,
      streamId: ctx?.streamId,
      phase: 'tool_loop',
      reason: 'persistence_exception',
    });
    return false;
  }
}

module.exports = {
  commitMidTurnCompactionSnapshot,
  persistAutomaticCompactionSnapshot,
  stageMidTurnCompactionCandidate,
};
