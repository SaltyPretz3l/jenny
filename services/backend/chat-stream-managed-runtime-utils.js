// Pure, instance-independent managed-stream helpers; no closure capture or requires.

function normalizeRuntimeToken(value) {
  return String(value || '').trim();
}

function normalizeRuntimeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function buildPhaseSnapshot(source = {}) {
  const phaseId = normalizeRuntimeToken(source.phaseId || source.phase_id);
  const phaseKind = normalizeRuntimeToken(source.phaseKind || source.phase_kind);
  const thinkingId = normalizeRuntimeToken(source.thinkingId || source.thinking_id);
  const toolCallId = normalizeRuntimeToken(source.toolCallId || source.tool_call_id || source.callId || source.call_id);
  const toolName = normalizeRuntimeToken(source.toolName || source.tool_name);
  const summary = normalizeRuntimeToken(source.summary);
  const iteration = normalizeRuntimeNumber(source.iteration);
  if (!phaseId && !phaseKind && !thinkingId && !toolCallId && !toolName && !summary && iteration == null) {
    return null;
  }
  return {
    ...(phaseId ? { phaseId } : {}),
    ...(phaseKind ? { phaseKind } : {}),
    ...(iteration != null ? { iteration } : {}),
    ...(thinkingId ? { thinkingId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(summary ? { summary } : {}),
  };
}

function inferStreamChannel(payload) {
  const type = normalizeRuntimeToken(payload?.type);
  if (type === 'delta') {
    if (
      payload?.reasoning
      && typeof payload.reasoning === 'object'
      && !Array.isArray(payload.reasoning)
    ) {
      return 'reasoning';
    }
    return 'response';
  }
  if (type === 'phase_started' || type === 'phase_completed') {
    return 'phase';
  }
  if (type === 'tool_use' || type === 'tool_result' || type === 'tool_approval_needed') {
    return 'tool';
  }
  return 'control';
}

function phaseKindOf(phase) {
  return normalizeRuntimeToken(phase?.phaseKind || phase?.phase_kind).toLowerCase();
}

function phaseMatchesChannel(phase, channel) {
  const kind = phaseKindOf(phase);
  if (!kind) {
    return false;
  }
  if (channel === 'reasoning') {
    return kind === 'reasoning' || kind === 'thinking';
  }
  if (channel === 'response') {
    return kind === 'text' || kind === 'response' || kind === 'final_answer';
  }
  if (channel === 'tool') {
    return kind === 'tool_use' || kind === 'tool_result' || kind === 'approval_wait';
  }
  return channel === 'phase' || channel === 'control';
}

function normalizeTokenRate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeStopReason(value) {
  return String(value || '').trim().toLowerCase();
}

function isSuccessfulStopReason(value) {
  const reason = normalizeStopReason(value);
  // max_tokens = truncated at the output budget but still a successful
  // completion (the vision path reports honest truncation instead of a
  // hardcoded end_turn) — it must not settle the turn as a terminal error.
  return !reason || ['end_turn', 'stop', 'completed', 'complete', 'success', 'max_tokens'].includes(reason);
}

function textSequenceKey(value) {
  const sequence = normalizeRuntimeNumber(value);
  return sequence != null && sequence > 0 ? `seq:${sequence}` : '';
}

function createTextSequenceGate({ maxGap = 64 } = {}) {
  const normalizedMaxGap = normalizeRuntimeNumber(maxGap);
  const gapLimit = normalizedMaxGap != null && normalizedMaxGap >= 0 ? normalizedMaxGap : 64;
  let watermark = 0;
  const gap = new Set();

  function shouldApply(sequenceValue) {
    const sequence = normalizeRuntimeNumber(sequenceValue);
    if (sequence == null || sequence <= 0) {
      return true;
    }
    return sequence > watermark && !gap.has(sequence);
  }

  function note(sequenceValue) {
    const sequence = normalizeRuntimeNumber(sequenceValue);
    if (sequence == null || sequence <= watermark) {
      return false;
    }
    if (sequence === watermark + 1) {
      watermark = sequence;
      while (gap.delete(watermark + 1)) {
        watermark += 1;
      }
      return false;
    }
    if (gap.has(sequence)) {
      return false;
    }
    gap.add(sequence);
    if (gap.size <= gapLimit) {
      return false;
    }
    watermark = Math.max(...gap);
    for (const appliedSequence of gap) {
      if (appliedSequence <= watermark) {
        gap.delete(appliedSequence);
      }
    }
    return true;
  }

  function reset() {
    watermark = 0;
    gap.clear();
  }

  function state() {
    return { watermark, gapSize: gap.size };
  }

  return { shouldApply, note, reset, state };
}

function createProtocolViolationError(message, code = '') {
  const error = new Error(message);
  const normalizedCode = String(code || '').trim();
  if (normalizedCode) {
    error.error_code = normalizedCode;
    error.code = normalizedCode;
  }
  error.category = 'managed_sidecar';
  error.status = 'runtime_error';
  error.terminal_subcode = 'protocol_violation';
  error.retryable = false;
  return error;
}

module.exports = {
  normalizeRuntimeToken,
  normalizeRuntimeNumber,
  buildPhaseSnapshot,
  inferStreamChannel,
  phaseKindOf,
  phaseMatchesChannel,
  normalizeTokenRate,
  normalizeStopReason,
  isSuccessfulStopReason,
  textSequenceKey,
  createTextSequenceGate,
  createProtocolViolationError,
};
