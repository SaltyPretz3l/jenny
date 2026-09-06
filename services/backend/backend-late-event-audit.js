// Late sidecar event audit.
//
// Persists out-of-band sidecar notifications / approval requests that arrive
// after a tool result has settled into the matching tool_result message
// metadata. Extracted from backend-service.js as fn(service, ...) helpers; the
// BackendService class keeps thin delegators.

const MAX_LATE_EVENTS_PER_TOOL_RESULT = 50;
const MAX_LATE_EVENT_BYTES = 4096;
const MAX_LATE_EVENT_FIELD_CHARS = 128;

function boundedLateEventField(value) {
  return String(value == null ? '' : value).slice(0, MAX_LATE_EVENT_FIELD_CHARS);
}

function normalizeLateEvent(lateEvent) {
  try {
    const serialized = JSON.stringify(lateEvent);
    if (serialized && Buffer.byteLength(serialized, 'utf8') <= MAX_LATE_EVENT_BYTES) {
      return JSON.parse(serialized);
    }
  } catch (_error) {
    // Fall through to the bounded audit summary.
  }
  return {
    kind: boundedLateEventField(lateEvent?.kind),
    method: boundedLateEventField(lateEvent?.method),
    request_id: boundedLateEventField(lateEvent?.request_id),
    trace_id: boundedLateEventField(lateEvent?.trace_id),
    received_at: boundedLateEventField(lateEvent?.received_at),
    rpc_id: lateEvent?.rpc_id == null ? null : boundedLateEventField(lateEvent.rpc_id),
    truncated: true,
  };
}

function appendLateEventAudit(service, sessionId, callId, lateEvent) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedCallId = String(callId || '').trim();
  if (!normalizedSessionId || !normalizedCallId || !lateEvent || typeof lateEvent !== 'object') {
    return false;
  }
  const messages = service.sessionStore.getSessionMessages(normalizedSessionId);
  // Backward scan instead of [...messages].reverse().find(...) so a late event
  // does not copy + reverse the whole message array.
  let target = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      String(message?.kind || '').trim() === 'tool_result'
      && String(message?.tool_result?.call_id || '').trim() === normalizedCallId
    ) {
      target = message;
      break;
    }
  }
  if (!target) {
    return false;
  }
  const existingMetadata =
    target.tool_result?.metadata && typeof target.tool_result.metadata === 'object' && !Array.isArray(target.tool_result.metadata)
      ? { ...target.tool_result.metadata }
      : {};
  const existingLateEvents = Array.isArray(existingMetadata.late_events)
    ? existingMetadata.late_events.map(normalizeLateEvent)
    : [];
  const retainedLateEvents = [...existingLateEvents, normalizeLateEvent(lateEvent)];
  const droppedCount = Math.max(0, retainedLateEvents.length - MAX_LATE_EVENTS_PER_TOOL_RESULT);
  const nextLateEvents = retainedLateEvents.slice(-MAX_LATE_EVENTS_PER_TOOL_RESULT);
  const existingDroppedCount = Number.isSafeInteger(existingMetadata.dropped_count)
    && existingMetadata.dropped_count > 0
    ? existingMetadata.dropped_count
    : 0;
  service.sessionStore.updateMessage(normalizedSessionId, String(target.id || '').trim(), {
    tool_result: {
      ...target.tool_result,
      metadata: {
        ...existingMetadata,
        trace_id: String(existingMetadata.trace_id || lateEvent.trace_id || '').trim() || '',
        late_events: nextLateEvents,
        ...(existingDroppedCount + droppedCount > 0 ? { dropped_count: existingDroppedCount + droppedCount } : {}),
      },
    },
  });
  return true;
}

function recordLateSidecarEvent(service, message) {
  const params = message && typeof message === 'object' && message.params && typeof message.params === 'object'
    ? message.params
    : {};
  const sessionId = String(params.session_id || '').trim();
  const callId = String(params.tool_call_id || '').trim();
  if (!sessionId || !callId) {
    return false;
  }
  const lateEvent = {
    kind: String(message?.method || '').trim() === 'tool.request_approval'
      ? 'late_approval_request'
      : 'late_notification',
    method: String(message?.method || '').trim(),
    request_id: String(params.request_id || '').trim(),
    trace_id: String(params.trace_id || '').trim(),
    received_at: new Date().toISOString(),
    rpc_id: Object.prototype.hasOwnProperty.call(message || {}, 'id')
      ? message.id
      : null,
  };
  const persisted = service._appendLateEventAudit(sessionId, callId, lateEvent);
  if (persisted) {
    service._emitServiceLog('WARN', 'sidecar.late_event_persisted', {
      sessionId,
      callId,
      method: lateEvent.method,
      requestId: lateEvent.request_id,
      traceId: lateEvent.trace_id,
    });
  }
  return persisted;
}

module.exports = {
  appendLateEventAudit,
  recordLateSidecarEvent,
};
