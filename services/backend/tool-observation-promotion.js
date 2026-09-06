const {
  APPROVAL_ERROR_CODES,
  LOOP_PROTOCOL_ERROR_CODES,
  TOOL_ERROR_CODES,
} = require('./error-codes');
const { normalizeId } = require('../shared/normalize');

const LOOP_BUDGET_EXCEEDED_CODE = LOOP_PROTOCOL_ERROR_CODES.BUDGET_EXCEEDED;
const LOOP_TOOL_INTERRUPTED_CODE = LOOP_PROTOCOL_ERROR_CODES.TOOL_INTERRUPTED;
const APPROVAL_REJECTED_CODE = APPROVAL_ERROR_CODES.REJECTED;
const TOOL_APPROVAL_DENIED_CODE = TOOL_ERROR_CODES.APPROVAL_DENIED;

// Phase 6 Q19 promotion bridge: any sidecar ``turn_failed`` observation
// carrying one of these error codes promotes into the
// ``agent.stopped_due_to_loop`` event_type. Includes max-iterations alongside
// the semantic stuck-loop codes; all surface to the user as "the agent stopped
// because it was looping" so they share one canonical event_type.
const AGENT_STOPPED_LOOP_CODES = new Set([
  LOOP_PROTOCOL_ERROR_CODES.MAX_ITERATIONS,
  LOOP_PROTOCOL_ERROR_CODES.REPEATED_ERRORS,
  LOOP_PROTOCOL_ERROR_CODES.REPEATED_OBSERVATIONS,
  LOOP_PROTOCOL_ERROR_CODES.STUCK_SUSPECTED,
]);

function normalizeErrorCode(value) {
  return normalizeId(value).toUpperCase();
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(entry);
    }
    return cloned;
  }
  return value;
}

function compactSummary(value) {
  const normalized = normalizeId(value);
  return normalized.length > 1000 ? normalized.slice(0, 1000) : normalized;
}

function normalizedSequence(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function observationIdFromSequence(requestId, sequence) {
  const normalizedRequestId = normalizeId(requestId);
  const normalizedSequenceValue = normalizedSequence(sequence);
  if (!normalizedRequestId || normalizedSequenceValue < 1) {
    return '';
  }
  return `${normalizedRequestId}:tool_observation:${normalizedSequenceValue}`;
}

function buildPromotedObservation({
  observation,
  requestId,
  eventType,
  source = 'sidecar_tool_observation',
}) {
  const normalizedRequestId = normalizeId(observation?.request_id || requestId);
  const sequence = normalizedSequence(observation?.sequence);
  const observationId = observationIdFromSequence(normalizedRequestId, sequence);
  if (!observationId) {
    return null;
  }
  return {
    event_type: eventType,
    observation_id: observationId,
    observation_kind: normalizeId(observation?.kind),
    request_id: normalizedRequestId,
    turn_id: normalizeId(observation?.turn_id),
    sequence,
    tool_call_id: normalizeId(observation?.tool_call_id),
    tool_name: normalizeId(observation?.tool_name),
    error_code: normalizeErrorCode(observation?.error_code),
    summary: compactSummary(observation?.summary),
    source,
  };
}

function buildPromotionForObservation(observation, options = {}) {
  const source = asPlainObject(observation);
  const expectedRequestId = normalizeId(options.requestId);
  const requestId = normalizeId(source.request_id || expectedRequestId);
  if (!requestId) {
    return null;
  }
  if (expectedRequestId && normalizeId(source.request_id) && requestId !== expectedRequestId) {
    return null;
  }
  const kind = normalizeId(source.kind);
  const errorCode = normalizeErrorCode(source.error_code);
  const toolCallId = normalizeId(source.tool_call_id);
  const turnId = normalizeId(source.turn_id || options.turnId);

  let eventType = '';
  let targetKind = '';
  let targetToolCallId = '';
  let targetErrorCode = '';

  if (kind === 'turn_failed' && AGENT_STOPPED_LOOP_CODES.has(errorCode)) {
    eventType = 'agent.stopped_due_to_loop';
    targetKind = 'assistant_error';
    targetErrorCode = errorCode;
  } else if (kind === 'turn_failed' && errorCode === LOOP_BUDGET_EXCEEDED_CODE) {
    eventType = 'budget.exceeded';
    targetKind = 'assistant_error';
    targetErrorCode = errorCode;
  } else if (kind === 'tool_execution_failed' && errorCode === LOOP_TOOL_INTERRUPTED_CODE) {
    eventType = 'tool.cancelled';
    targetKind = 'tool_result';
    targetToolCallId = toolCallId;
    targetErrorCode = errorCode;
  } else if (
    kind === 'user_approval_rejected'
    || errorCode === APPROVAL_REJECTED_CODE
    || errorCode === TOOL_APPROVAL_DENIED_CODE
  ) {
    eventType = 'approval.gap_resolved';
    targetKind = 'approval_resolved';
    targetToolCallId = toolCallId;
  }

  if (!eventType || !targetKind) {
    return null;
  }
  const promotedObservation = buildPromotedObservation({
    observation: source,
    requestId,
    eventType,
  });
  if (!promotedObservation) {
    return null;
  }
  return {
    turn_id: turnId,
    target_kind: targetKind,
    target_tool_call_id: targetToolCallId,
    target_error_code: targetErrorCode,
    promoted_observation: promotedObservation,
  };
}

function buildPromotionsFromToolObservations(observations, options = {}) {
  const list = Array.isArray(observations) ? observations : [];
  const promotions = [];
  const seen = new Set();
  for (const observation of list) {
    const promotion = buildPromotionForObservation(observation, options);
    if (!promotion) {
      continue;
    }
    const key = promotionDedupeKey(promotion);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    promotions.push(promotion);
  }
  return promotions;
}

function buildElectronOrphanRepairPromotion({
  requestId,
  turnId,
  toolCallId,
  toolName,
  summary,
  terminalState,
} = {}) {
  const normalizedRequestId = normalizeId(requestId || turnId);
  const normalizedToolCallId = normalizeId(toolCallId);
  if (!normalizedRequestId || !normalizedToolCallId) {
    return null;
  }
  return {
    turn_id: normalizeId(turnId || requestId),
    target_kind: 'tool_result',
    target_tool_call_id: normalizedToolCallId,
    target_error_code: LOOP_TOOL_INTERRUPTED_CODE,
    promoted_observation: {
      event_type: 'tool.cancelled',
      observation_id: `${normalizedRequestId}:electron_orphan_repair:${normalizedToolCallId}`,
      observation_kind: 'orphaned_tool_call',
      request_id: normalizedRequestId,
      turn_id: normalizeId(turnId || requestId),
      sequence: 0,
      tool_call_id: normalizedToolCallId,
      tool_name: normalizeId(toolName),
      error_code: LOOP_TOOL_INTERRUPTED_CODE,
      summary: compactSummary(summary || `orphaned_tool_call ${normalizeId(terminalState)}`),
      source: 'electron_orphan_repair',
    },
  };
}

function promotedObservationKey(observation) {
  const eventType = normalizeId(observation.event_type);
  const observationId = normalizeId(observation.observation_id);
  return eventType && observationId ? `${eventType}:${observationId}` : '';
}

function promotionDedupeKey(promotion) {
  return promotedObservationKey(promotion?.promoted_observation || {});
}

function eventErrorCode(event) {
  const payload = asPlainObject(event?.payload);
  return normalizeErrorCode(
    payload.error_code
    || payload.code
    || event?.error_code
  );
}

function eventToolCallId(event) {
  const payload = asPlainObject(event?.payload);
  return normalizeId(
    event?.tool_call_id
    || payload.tool_call_id
    || payload.call_id
  );
}

function findPromotionTarget(events, promotion) {
  const targetKind = normalizeId(promotion?.target_kind);
  if (!targetKind) {
    return null;
  }
  const candidates = events.filter((event) => normalizeId(event?.kind) === targetKind);
  if (!candidates.length) {
    return null;
  }
  const targetToolCallId = normalizeId(promotion?.target_tool_call_id);
  const toolCandidates = targetToolCallId
    ? candidates.filter((event) => eventToolCallId(event) === targetToolCallId)
    : candidates;
  if (!toolCandidates.length) {
    return null;
  }
  const targetErrorCode = normalizeErrorCode(promotion?.target_error_code);
  if (!targetErrorCode) {
    return toolCandidates[0];
  }
  return toolCandidates.find((event) => eventErrorCode(event) === targetErrorCode)
    || (targetKind === 'assistant_error' && toolCandidates.length === 1 ? toolCandidates[0] : null);
}

function appendPromotedObservation(event, promotedObservation) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }
  const observation = asPlainObject(promotedObservation);
  const key = promotedObservationKey(observation);
  if (!key) {
    return false;
  }
  event.payload = asPlainObject(event.payload);
  const current = Array.isArray(event.payload.promoted_observations)
    ? event.payload.promoted_observations
    : [];
  if (
    current.some((entry) => promotedObservationKey(entry) === key)
  ) {
    event.payload.promoted_observations = current;
    return false;
  }
  event.payload.promoted_observations = [
    ...current,
    cloneJsonValue(observation),
  ];
  return true;
}

function mergePromotedObservationsIntoTurnEvents(events, promotions, { logger = null } = {}) {
  const targetEvents = Array.isArray(events) ? events : [];
  const promotionList = Array.isArray(promotions) ? promotions : [];
  const seen = new Set();
  for (const promotion of promotionList) {
    const key = promotionDedupeKey(promotion);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const target = findPromotionTarget(targetEvents, promotion);
    if (!target) {
      if (typeof logger === 'function') {
        logger('WARN', 'chat.turn_event_promotion_skipped', {
          turnId: normalizeId(promotion?.turn_id),
          targetKind: normalizeId(promotion?.target_kind),
          targetToolCallId: normalizeId(promotion?.target_tool_call_id),
          targetErrorCode: normalizeId(promotion?.target_error_code),
          eventType: normalizeId(promotion?.promoted_observation?.event_type),
          observationId: normalizeId(promotion?.promoted_observation?.observation_id),
        });
      }
      continue;
    }
    appendPromotedObservation(target, promotion.promoted_observation);
  }
  return targetEvents;
}

function createPromotedObservationQueue({ turnId = '' } = {}) {
  const fallbackTurnId = normalizeId(turnId);
  const promotedObservations = [];
  const promotedByDedupeKey = new Map();

  return {
    note(promotion) {
      const source = asPlainObject(promotion);
      const observation = asPlainObject(source.promoted_observation);
      const eventType = normalizeId(observation.event_type);
      const observationId = normalizeId(observation.observation_id);
      const targetKind = normalizeId(source.target_kind);
      const normalizedTurnId = normalizeId(source.turn_id || observation.turn_id || fallbackTurnId);
      if (!normalizedTurnId || !eventType || !observationId || !targetKind) {
        return null;
      }
      const dedupeKey = [
        normalizedTurnId,
        targetKind,
        normalizeId(source.target_tool_call_id),
        eventType,
        observationId,
      ].join(':');
      if (promotedByDedupeKey.has(dedupeKey)) {
        return promotedByDedupeKey.get(dedupeKey);
      }
      const normalized = {
        turn_id: normalizedTurnId,
        target_kind: targetKind,
        target_tool_call_id: normalizeId(source.target_tool_call_id),
        target_error_code: normalizeId(source.target_error_code),
        promoted_observation: cloneJsonValue(observation),
      };
      promotedObservations.push(normalized);
      promotedByDedupeKey.set(dedupeKey, normalized);
      return normalized;
    },

    forTurn(value) {
      const normalizedTurnId = normalizeId(value);
      return promotedObservations.filter((promotion) =>
        normalizeId(promotion?.turn_id) === normalizedTurnId
      );
    },
  };
}

function emitPromotionWarning(logger, logContext, message, promotion = null) {
  if (typeof logger !== 'function') {
    return;
  }
  const context = asPlainObject(logContext);
  try {
    logger('WARN', 'chat.tool_observation_promotion_failed', {
      ...context,
      eventType: normalizeId(promotion?.promoted_observation?.event_type),
      observationId: normalizeId(promotion?.promoted_observation?.observation_id),
      message,
    });
  } catch {
    // Promotion logging must not affect chat completion or canonical persistence.
  }
}

function noteToolObservationPromotions({
  turnEventCollector,
  observations,
  requestId,
  turnId,
  logger = null,
  logContext = {},
} = {}) {
  if (
    !turnEventCollector
    || typeof turnEventCollector.notePromotedObservation !== 'function'
    || !Array.isArray(observations)
    || observations.length < 1
  ) {
    return 0;
  }
  let promotions;
  try {
    promotions = buildPromotionsFromToolObservations(observations, {
      requestId,
      turnId,
    });
  } catch (error) {
    emitPromotionWarning(
      logger,
      logContext,
      String(error?.message || error)
    );
    return 0;
  }
  let promotedCount = 0;
  for (const promotion of promotions) {
    try {
      turnEventCollector.notePromotedObservation(promotion);
      promotedCount += 1;
    } catch (error) {
      emitPromotionWarning(
        logger,
        logContext,
        String(error?.message || error),
        promotion
      );
    }
  }
  return promotedCount;
}

module.exports = {
  buildElectronOrphanRepairPromotion,
  buildPromotionsFromToolObservations,
  createPromotedObservationQueue,
  mergePromotedObservationsIntoTurnEvents,
  noteToolObservationPromotions,
};
