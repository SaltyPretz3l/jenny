const { copyAssistantErrorRecoveryMetadata } = require('./chat-error-recovery');
const {
  DURABLE_EVENT_TYPES,
  UNPERSISTED_DURABLE_TYPES,
  reduceToTurnEventKind,
  validateTurnEvent,
} = require('./canonical-turn-event');
const {
  cloneJsonValue,
  normalizeId,
  sanitizePathFieldsInPayload,
  attachStreamEnvelopeMetadata,
} = require('./canonical-turn-event-normalization');

const TOOL_RELATED_KINDS = new Set([
  'tool_use',
  'tool_executing',
  'tool_result',
  'approval_requested',
  'approval_resolved',
]);
const LIVE_CAPTURED_KINDS = new Set([
  ...TOOL_RELATED_KINDS,
  'assistant_text_segment',
  'reasoning_phase',
  // Phase 11C: plan-then-act plan summaries are durable and live-captured so
  // the renderer projector can render plan visuals on reload.
  'plan_object',
  'plan_document',
  // Citations: derived in noteEvent from a web_search tool_result's
  // citations/sources payload (flag `source_citations`, default-off). No
  // sidecar wire change — the kind exists only collector-side.
  'source_citations',
]);
function buildMessageIndex(messages) {
  const index = new Map();
  const list = Array.isArray(messages) ? messages : [];
  for (let position = 0; position < list.length; position += 1) {
    const message = list[position];
    const messageId = normalizeId(message?.id);
    if (messageId && !index.has(messageId)) {
      index.set(messageId, message);
    }
  }
  return index;
}

function buildPersistedTurnEvent(event, messageById) {
  const sourceMessage = messageById.get(normalizeId(event?.primary_message_id)) || null;
  const payload = sanitizePathFieldsInPayload(cloneJsonValue(
    event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload
      : {}
  ));
  if (event?.kind === 'assistant_error' && sourceMessage) {
    copyAssistantErrorRecoveryMetadata(payload, sourceMessage);
  }
  attachStreamEnvelopeMetadata(payload, event?.stream_envelope);
  if (event?.kind === 'tool_result' && Array.isArray(payload.generated_artifacts)) {
    payload.generated_artifacts = payload.generated_artifacts.map((artifact) => ({
      ...artifact,
      tool_call_id: normalizeId(
        artifact?.tool_call_id || artifact?.toolCallId || event?.tool_call_id
      ),
    }));
  }
  const startedAt = normalizeId(
    event?.started_at
    || payload.started_at
    || sourceMessage?.timestamp
  );
  const completedAt = normalizeId(
    event?.completed_at
    || payload.completed_at
    || sourceMessage?.finalizedAt
    || sourceMessage?.timestamp
  );
  return {
    event_id: normalizeId(event?.event_id),
    turn_id: normalizeId(event?.turn_id),
    kind: normalizeId(event?.kind),
    status: normalizeId(event?.status),
    primary_message_id: normalizeId(event?.primary_message_id),
    source_message_ids: Array.isArray(event?.source_message_ids)
      ? event.source_message_ids.map((value) => normalizeId(value)).filter(Boolean)
      : [],
    target_message_id: normalizeId(event?.target_message_id),
    tool_call_id: normalizeId(event?.tool_call_id),
    segment_group_index: Number.isInteger(Number(event?.segment_group_index))
      ? Math.max(0, Math.floor(Number(event.segment_group_index)))
      : null,
    phase_id: normalizeId(event?.phase_id),
    started_at: startedAt,
    completed_at: completedAt,
    payload,
  };
}

function buildCapturedTurnEventForStorage(event) {
  return buildPersistedTurnEvent(event, new Map());
}

function settleCapturedReasoningFromProjection(capturedEvents, projectedEvents) {
  const captured = Array.isArray(capturedEvents) ? capturedEvents : [];
  const projected = (Array.isArray(projectedEvents) ? projectedEvents : []).filter(
    (event) => normalizeId(event?.kind) === 'reasoning_phase'
  );
  const usedProjectedIndexes = new Set();
  for (const event of captured) {
    if (normalizeId(event?.kind) !== 'reasoning_phase') continue;
    const phaseId = normalizeId(event?.phase_id || event?.payload?.phase_id);
    if (!phaseId) continue;
    const primaryMessageId = normalizeId(event?.primary_message_id);
    let matchIndex = projected.findIndex((candidate, index) =>
      !usedProjectedIndexes.has(index)
      && normalizeId(candidate?.phase_id || candidate?.payload?.phase_id) === phaseId
      && normalizeId(candidate?.primary_message_id) === primaryMessageId
    );
    if (matchIndex < 0) {
      matchIndex = projected.findIndex((candidate, index) =>
        !usedProjectedIndexes.has(index)
        && normalizeId(candidate?.phase_id || candidate?.payload?.phase_id) === phaseId
      );
    }
    if (matchIndex < 0) continue;
    const match = projected[matchIndex];
    const completedAt = normalizeId(match?.completed_at || match?.payload?.completed_at);
    const projectedStatus = normalizeId(match?.status);
    const completed = match?.payload?.completed === true
      || projectedStatus === 'complete'
      || projectedStatus === 'completed'
      || projectedStatus === 'done'
      || Boolean(completedAt);
    if (!completed) continue;
    usedProjectedIndexes.add(matchIndex);
    event.status = 'completed';
    event.payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    event.payload.completed = true;
    if (completedAt) {
      event.completed_at = completedAt;
    }
  }
}

function reasoningPhaseIdentity(source, kind) {
  if (kind !== 'reasoning_phase') {
    return '';
  }
  const payload = source?.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload
    : {};
  return normalizeId(source?.phase_id || source?.phaseId || payload.phase_id)
    || normalizeId(payload.thinking_id || payload.thinkingId);
}

function buildCaptureDedupeKey(source, kind, turnId, toolCallId) {
  // reasoning_phase capture coalesces per PHASE, not per delivered chunk: a
  // streamed phase arrives as hundreds of per-delta snapshots that would
  // otherwise each persist as their own turn event (the 1,415-events-per-turn
  // session-bloat defect). Identity by phase wins over the per-chunk event_id.
  const phaseIdentity = reasoningPhaseIdentity(source, kind);
  if (phaseIdentity) {
    return `${turnId}:reasoning_phase:phase:${phaseIdentity}`;
  }
  const explicitEventId = normalizeId(source?.event_id || source?.eventId);
  if (explicitEventId) {
    return `event:${explicitEventId}`;
  }
  if (kind === 'reasoning_phase') {
    const payload = source?.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
      ? source.payload
      : {};
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return [
      turnId,
      kind,
      normalizeId(payload.thinking_id || payload.thinkingId),
      normalizeId(entries[0]?.id),
      normalizeId(entries[0]?.timestamp),
      normalizeId(source?.primary_message_id || source?.primaryMessageId),
    ].join(':');
  }
  return [
    turnId,
    kind,
    toolCallId,
    normalizeId(source?.primary_message_id || source?.primaryMessageId),
  ].join(':');
}

// Mirrors mergeReasoningEntries in renderer/chat/renderer-turn-row-projector.js:
// the latest snapshot of an entry id replaces the prior one, unseen ids append.
function mergeReasoningEntriesById(existingEntries, incomingEntries) {
  const merged = (Array.isArray(existingEntries) ? existingEntries : []).slice();
  const indexById = new Map();
  for (let index = 0; index < merged.length; index += 1) {
    const id = normalizeId(merged[index]?.id);
    if (id && !indexById.has(id)) {
      indexById.set(id, index);
    }
  }
  for (const entry of (Array.isArray(incomingEntries) ? incomingEntries : [])) {
    const id = normalizeId(entry?.id);
    if (id && indexById.has(id)) {
      merged[indexById.get(id)] = entry;
      continue;
    }
    if (id) {
      indexById.set(id, merged.length);
    }
    merged.push(entry);
  }
  return merged;
}

function assistantTextPayloadHasUsableText(event) {
  if (normalizeId(event?.kind) !== 'assistant_text_segment') {
    return true;
  }
  const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  return String(payload.text || '').length > 0;
}

function statusForCanonicalEvent(event) {
  switch (normalizeId(event?.type)) {
    case 'tool_execution_started':
      return 'running';
    case 'tool_execution_completed':
    case 'tool_approval_resolved':
      return 'completed';
    case 'tool_execution_failed':
    case 'turn_failed':
      return 'error';
    case 'turn_cancelled':
      return 'cancelled';
    case 'tool_approval_requested':
      return 'approval_pending';
    case 'tool_call_requested':
      return 'pending';
    default:
      return '';
  }
}

function primaryMessageIdForCanonicalEvent(event, kind) {
  const turnId = normalizeId(event?.turn_id);
  const toolCallId = normalizeId(event?.tool_call_id);
  if (!turnId) {
    return '';
  }
  if (
    kind === 'assistant_text_segment'
    || kind === 'reasoning_phase'
    || kind === 'assistant_error'
  ) {
    return `assistant_${turnId}`;
  }
  if (!toolCallId) {
    return '';
  }
  if (kind === 'tool_result') {
    return `tool_result_${turnId}_${toolCallId}`;
  }
  if (TOOL_RELATED_KINDS.has(kind)) {
    return `tool_use_${turnId}_${toolCallId}`;
  }
  return '';
}

function logCanonicalDrop(logger, result, source) {
  if (typeof logger !== 'function') {
    return;
  }
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  try {
    logger('WARN', 'canonical_turn_event.dropped', {
      status: normalizeId(result?.status) || 'dropped',
      diagnostic_code: normalizeId(diagnostics[0]?.code) || 'unknown',
      turnId: normalizeId(source?.turn_id || source?.turnId),
      eventType: normalizeId(source?.type || source?.event_type || source?.eventType),
      seq: Number.isFinite(Number(source?.seq)) ? Math.trunc(Number(source.seq)) : null,
    });
  } catch (_error) {
    // Logging is best-effort; malformed diagnostics must not break capture.
  }
}

function normalizeCanonicalTurnEventForCapture(source, logger, prevalidatedResult) {
  // Reuse a supplied validateTurnEvent result to avoid duplicate validation and
  // payload capping; otherwise validate locally.
  const result = (prevalidatedResult
    && typeof prevalidatedResult === 'object'
    && typeof prevalidatedResult.status === 'string')
    ? prevalidatedResult
    : validateTurnEvent(source);
  if (result.status !== 'accepted' || !result.event) {
    logCanonicalDrop(logger, result, source);
    return null;
  }
  const kind = reduceToTurnEventKind(result.event);
  if (!kind) {
    if (
      DURABLE_EVENT_TYPES.has(result.event.type)
      && !UNPERSISTED_DURABLE_TYPES.has(result.event.type)
    ) {
      logCanonicalDrop(logger, {
        status: 'dropped',
        diagnostics: [{ code: 'unmapped_durable_type' }],
      }, result.event);
    }
    return null;
  }
  const event = result.event;
  const payload = cloneJsonValue(
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload
      : {}
  );
  payload.canonical_event_type = event.type;
  payload.canonical_part_id = event.part_id;
  payload.canonical_seq = event.seq;
  const primaryMessageId = primaryMessageIdForCanonicalEvent(event, kind);
  return {
    event_id: event.event_id,
    turn_id: event.turn_id,
    kind,
    status: statusForCanonicalEvent(event),
    primary_message_id: primaryMessageId,
    source_message_ids: primaryMessageId ? [primaryMessageId] : [],
    tool_call_id: event.tool_call_id,
    segment_group_index: payload.segment_group_index ?? null,
    phase_id: normalizeId(payload.phase_id),
    started_at: event.type.endsWith('_started') ? event.ts : '',
    completed_at: event.type.endsWith('_completed') || event.type.endsWith('_failed')
      ? event.ts
      : '',
    payload,
  };
}

module.exports = {
  TOOL_RELATED_KINDS,
  LIVE_CAPTURED_KINDS,
  buildMessageIndex,
  buildPersistedTurnEvent,
  buildCapturedTurnEventForStorage,
  settleCapturedReasoningFromProjection,
  reasoningPhaseIdentity,
  buildCaptureDedupeKey,
  mergeReasoningEntriesById,
  assistantTextPayloadHasUsableText,
  normalizeCanonicalTurnEventForCapture,
};
