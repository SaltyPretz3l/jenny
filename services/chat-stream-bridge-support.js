const { normalizeString: normalizeToken } = require('./shared/normalize');
const {
  TERMINAL_STATUSES,
  normalizeTerminalStatus,
} = require('./backend/generated-chat-lifecycle-contract');

const TOOL_CHAT_STREAM_TYPES = new Set(['tool_use', 'tool_result', 'tool_approval_needed']);

function normalizeEventPayload(event) {
  return event && typeof event === 'object' && !Array.isArray(event) ? { ...event } : {};
}

function normalizeErrorMessage(error) {
  return normalizeToken(error && typeof error === 'object' ? error.message : error);
}

function invokeSafely(callback, ...args) {
  if (typeof callback !== 'function') {
    return '';
  }
  try {
    callback(...args);
    return '';
  } catch (error) {
    return normalizeErrorMessage(error);
  }
}

function resolveRequestId(payload, stats) {
  return normalizeToken(payload?.request_id || payload?.requestId)
    || normalizeToken(stats?.requestId)
    || normalizeToken(payload?.streamId)
    || '';
}

function countReasoningChunks(payload) {
  const reasoning = payload && typeof payload.reasoning === 'object' && !Array.isArray(payload.reasoning)
    ? payload.reasoning
    : null;
  const entriesDelta = Array.isArray(reasoning?.entriesDelta) ? reasoning.entriesDelta : [];
  return entriesDelta.length;
}

function createStreamStats(payload, startedAtMs) {
  return {
    startedAtMs,
    sessionId: normalizeToken(payload?.sessionId),
    model: normalizeToken(payload?.model),
    requestId: resolveRequestId(payload),
    traceId: normalizeToken(payload?.traceId || payload?.trace_id),
    forwardedEventCount: 0,
    deltaCount: 0,
    reasoningChunkCount: 0,
    thinkingStatusCount: 0,
    toolEventCount: 0,
    agentStatusCount: 0,
    messageUpdatedCount: 0,
    rendererForwardFailedCount: 0,
    rendererForwardError: '',
    firstNotificationLogged: false,
  };
}

function recordRendererForwardFailure(stats, errorMessage) {
  if (!stats || !errorMessage) {
    return;
  }
  stats.rendererForwardFailedCount += 1;
  stats.rendererForwardError = errorMessage;
}

function updateStreamStats(stats, payload, type) {
  if (!stats) {
    return;
  }
  stats.forwardedEventCount += 1;
  const nextSessionId = normalizeToken(payload?.sessionId);
  const nextModel = normalizeToken(payload?.model);
  const nextRequestId = resolveRequestId(payload, stats);
  const nextTraceId = normalizeToken(payload?.traceId || payload?.trace_id);
  if (nextSessionId) {
    stats.sessionId = nextSessionId;
  }
  if (nextModel) {
    stats.model = nextModel;
  }
  if (nextRequestId) {
    stats.requestId = nextRequestId;
  }
  if (nextTraceId) {
    stats.traceId = nextTraceId;
  }
  if (type === 'delta') {
    stats.deltaCount += 1;
    stats.reasoningChunkCount += countReasoningChunks(payload);
    return;
  }
  if (type === 'thinking_status') {
    stats.thinkingStatusCount += 1;
    return;
  }
  if (TOOL_CHAT_STREAM_TYPES.has(type)) {
    stats.toolEventCount += 1;
    return;
  }
  if (type === 'agent_status') {
    stats.agentStatusCount += 1;
    return;
  }
  if (type === 'message_updated') {
    stats.messageUpdatedCount += 1;
  }
}

function buildTerminalSummary(payload, type, stats, nowMs) {
  const normalizedMessage = normalizeToken(payload?.message);
  const terminalContext = buildTerminalContext(payload, stats, nowMs);
  const terminalSubcode = normalizeToken(payload?.terminal_subcode);
  const cancelReason = normalizeToken(payload?.cancel_reason || payload?.cancelReason);
  const errorType = normalizeToken(payload?.error_type);
  const errorMessage = normalizeToken(payload?.error_message);
  return {
    type,
    streamId: terminalContext.streamId,
    stream_id: terminalContext.streamId,
    requestId: terminalContext.requestId,
    request_id: terminalContext.requestId,
    traceId: terminalContext.traceId,
    trace_id: terminalContext.traceId,
    sessionId: terminalContext.sessionId,
    model: terminalContext.model,
    message: normalizedMessage,
    errorCode: normalizeToken(payload?.error_code),
    retryable: payload?.retryable !== false,
    category: normalizeToken(payload?.category),
    ...(terminalSubcode ? { terminalSubcode, terminal_subcode: terminalSubcode } : {}),
    ...(cancelReason ? { cancelReason, cancel_reason: cancelReason } : {}),
    ...(errorType ? { errorType, error_type: errorType } : {}),
    ...(errorMessage ? { errorMessage, error_message: errorMessage } : {}),
    durationMs: terminalContext.durationMs,
    forwardedEventCount: Number(stats?.forwardedEventCount || 0),
    deltaCount: Number(stats?.deltaCount || 0),
    reasoningChunkCount: Number(stats?.reasoningChunkCount || 0),
    thinkingStatusCount: Number(stats?.thinkingStatusCount || 0),
    toolEventCount: Number(stats?.toolEventCount || 0),
    agentStatusCount: Number(stats?.agentStatusCount || 0),
    messageUpdatedCount: Number(stats?.messageUpdatedCount || 0),
    ...(Number(stats?.rendererForwardFailedCount || 0) > 0
      ? {
        rendererForwardFailed: true,
        rendererForwardError: normalizeToken(stats?.rendererForwardError),
        rendererForwardFailedCount: Number(stats?.rendererForwardFailedCount || 0),
      }
      : {}),
  };
}

function buildTerminalContext(payload, stats, nowMs) {
  const streamId = normalizeToken(payload?.streamId);
  const requestId = resolveRequestId(payload, stats);
  const traceId = normalizeToken(payload?.traceId || payload?.trace_id)
    || normalizeToken(stats?.traceId)
    || requestId;
  return {
    streamId,
    requestId,
    traceId,
    model: normalizeToken(payload?.model) || normalizeToken(stats?.model),
    sessionId: normalizeToken(payload?.sessionId) || normalizeToken(stats?.sessionId),
    durationMs: stats ? Math.max(nowMs - Number(stats.startedAtMs || nowMs), 0) : 0,
  };
}

function canonicalTerminalOutcome(payload, fallbackType) {
  const candidates = [
    payload?.terminal_status,
    payload?.terminalStatus,
    payload?.status,
    fallbackType,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTerminalStatus(candidate);
    if (TERMINAL_STATUSES.has(normalized)) {
      return normalized;
    }
  }
  return 'complete';
}

function terminalOutcomeDetail(payload) {
  const detail = normalizeToken(
    payload?.terminal_subcode
    || payload?.terminalSubcode
    || payload?.cancel_reason
    || payload?.cancelReason
    || payload?.error_code
    || payload?.errorCode
  ).slice(0, 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(detail) ? detail : '';
}

function buildUsageMetadata(payload, type, stats, nowMs) {
  const terminalContext = buildTerminalContext(payload, stats, nowMs);
  return {
    streamId: terminalContext.streamId,
    requestId: terminalContext.requestId,
    traceId: terminalContext.traceId,
    model: terminalContext.model,
    sessionId: terminalContext.sessionId,
    terminalType: type,
    outcome: canonicalTerminalOutcome(payload, type),
    outcomeDetail: terminalOutcomeDetail(payload),
    durationMs: terminalContext.durationMs,
  };
}

function mergeDeltaPayloads(existing, incoming) {
  // content is incremental: concat existing + incoming.
  // aggregate is cumulative: prefer the latest checkpoint or reconstruct it.
  // reasoning.entriesDelta snapshots replace by id; compatible edits fold.
  const merged = { ...existing, ...incoming };
  const existingContent = String(existing.content || '');
  const incomingContent = String(incoming.content || '');
  if (existingContent || incomingContent) {
    merged.content = existingContent + incomingContent;
  }
  const incomingHasAggregate = Object.prototype.hasOwnProperty.call(incoming, 'aggregate');
  const incomingHasAggregateLength = Object.prototype.hasOwnProperty.call(incoming, 'aggregateLength');
  if (incomingHasAggregate) {
    merged.aggregate = incoming.aggregate;
    if (incomingHasAggregateLength) {
      merged.aggregateLength = incoming.aggregateLength;
    } else {
      // Do NOT synthesize a length here. With aggregate_checkpoints OFF no payload
      // carries aggregateLength, so synthesizing one put a key on every coalesced
      // frame that the pre-change bridge never emitted -- breaking the
      // byte-identical rollback the flag promises. Deleting is also the safer rule:
      // it drops any length inherited from `existing`, which would otherwise sit
      // beside a newer aggregate it does not describe.
      delete merged.aggregateLength;
    }
  } else if (incomingHasAggregateLength && Object.prototype.hasOwnProperty.call(existing, 'aggregate')) {
    const existingAggregate = String(existing.aggregate || '');
    if (existingAggregate.length + incomingContent.length === incoming.aggregateLength) {
      merged.aggregate = existingAggregate + incomingContent;
    } else {
      delete merged.aggregate;
    }
  }
  const existingReasoning = existing.reasoning && typeof existing.reasoning === 'object' && !Array.isArray(existing.reasoning)
    ? existing.reasoning : null;
  const incomingReasoning = incoming.reasoning && typeof incoming.reasoning === 'object' && !Array.isArray(incoming.reasoning)
    ? incoming.reasoning : null;
  if (existingReasoning || incomingReasoning) {
    const existingEntries = Array.isArray(existingReasoning?.entriesDelta) ? existingReasoning.entriesDelta : [];
    const incomingEntries = Array.isArray(incomingReasoning?.entriesDelta) ? incomingReasoning.entriesDelta : [];
    const entriesDelta = existingEntries.slice();
    const entryIndexById = new Map();
    for (let index = 0; index < entriesDelta.length; index += 1) {
      const id = String(entriesDelta[index]?.id || '').trim();
      if (id && !entryIndexById.has(id)) entryIndexById.set(id, index);
    }
    for (const entry of incomingEntries) {
      const id = String(entry?.id || '').trim();
      const existingIndex = id ? entryIndexById.get(id) : undefined;
      if (Number.isInteger(existingIndex)) {
        const previous = entriesDelta[existingIndex];
        const incomingIsEdit = entry
          && typeof entry.baseLength === 'number'
          && typeof entry.append === 'string';
        const previousIsEdit = previous
          && typeof previous.baseLength === 'number'
          && typeof previous.append === 'string';
        if (!incomingIsEdit) {
          entriesDelta[existingIndex] = entry;
        } else if (
          previousIsEdit
          && typeof previous.baseTail === 'string'
          && typeof entry.baseTail === 'string'
          && entry.baseLength === previous.baseLength + previous.append.length
          && entry.baseTail.endsWith(previous.append.slice(
            -Math.min(previous.append.length, entry.baseTail.length)
          ))
        ) {
          entriesDelta[existingIndex] = {
            ...entry,
            baseLength: previous.baseLength,
            baseTail: previous.baseTail,
            append: previous.append + entry.append,
          };
        } else if (
          !previousIsEdit
          && typeof previous?.text === 'string'
          && typeof entry.baseTail === 'string'
          && entry.baseLength === previous.text.length
          && previous.text.endsWith(entry.baseTail)
        ) {
          const folded = {
            ...previous,
            text: previous.text + entry.append,
            timestamp: entry.timestamp || previous.timestamp,
          };
          const thinkingId = entry.thinkingId != null ? String(entry.thinkingId) : '';
          if (thinkingId) folded.thinkingId = thinkingId;
          delete folded.baseLength;
          delete folded.append;
          entriesDelta[existingIndex] = folded;
        } else if (previousIsEdit) {
          entriesDelta[existingIndex] = entry;
        }
      } else {
        if (id) entryIndexById.set(id, entriesDelta.length);
        entriesDelta.push(entry);
      }
    }
    merged.reasoning = {
      ...(existingReasoning || {}),
      ...(incomingReasoning || {}),
      entriesDelta,
    };
  }
  // Stale-aggregate hazard: never carry a checkpoint beside a newer watermark.
  if (
    Object.prototype.hasOwnProperty.call(merged, 'aggregate')
    && Object.prototype.hasOwnProperty.call(merged, 'aggregateLength')
    && String(merged.aggregate || '').length !== merged.aggregateLength
  ) {
    delete merged.aggregate;
  }
  return merged;
}

function isTruthyOption(value) {
  if (typeof value === 'function') {
    try {
      return value() === true;
    } catch (_error) {
      return false;
    }
  }
  return value === true;
}

function normalizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function resolveTurnId(payload) {
  return normalizeToken(payload?.turnId || payload?.turn_id || payload?.requestId || payload?.request_id)
    || normalizeToken(payload?.streamId);
}

function resolveEnvelopeIdentity(payload, streamId) {
  return {
    requestId: normalizeToken(payload.requestId || payload.request_id || streamId),
    traceId: normalizeToken(payload.traceId || payload.trace_id || streamId),
  };
}

module.exports = {
  normalizeEventPayload,
  normalizeToken,
  normalizeErrorMessage,
  invokeSafely,
  resolveRequestId,
  countReasoningChunks,
  createStreamStats,
  recordRendererForwardFailure,
  updateStreamStats,
  buildTerminalSummary,
  buildTerminalContext,
  buildUsageMetadata,
  mergeDeltaPayloads,
  isTruthyOption,
  normalizeNumber,
  resolveTurnId,
  resolveEnvelopeIdentity,
};
