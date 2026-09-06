function safeEmitLog(logger, level, event, details = {}) {
  if (typeof logger !== 'function') {
    return;
  }
  try {
    logger(level, event, details);
  } catch (error) {
    void error;
  }
}

function normalizeErrorDetails(error) {
  return {
    errorCode: error && error.code ? String(error.code) : null,
    errorMessage: error && error.message ? String(error.message) : String(error || 'unknown error'),
  };
}

function logWriteFailed(logger, event, filePath, error) {
  safeEmitLog(logger, 'WARN', event, {
    filePath,
    ...normalizeErrorDetails(error),
  });
}

function logNewerSchemaDetected(logger, event, filePath, observedVersion, expectedVersion) {
  safeEmitLog(logger, 'WARN', event, {
    filePath,
    observedVersion,
    expectedVersion,
  });
}

function safeStableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    void error;
    return '';
  }
}

function logTurnEventDedupeDropped(logger, storeName, sessionId, retainedEvent, droppedEvent) {
  safeEmitLog(logger, 'WARN', 'turn_event.dedupe_dropped', {
    store: storeName,
    sessionId,
    eventId: String(droppedEvent?.event_id || retainedEvent?.event_id || ''),
    turnId: String(droppedEvent?.turn_id || retainedEvent?.turn_id || ''),
    kind: String(droppedEvent?.kind || retainedEvent?.kind || ''),
    retainedEventSeq: Number.isInteger(retainedEvent?.event_seq) ? retainedEvent.event_seq : null,
    droppedEventSeq: Number.isInteger(droppedEvent?.event_seq) ? droppedEvent.event_seq : null,
    payloadChanged: safeStableStringify(retainedEvent?.payload || null)
      !== safeStableStringify(droppedEvent?.payload || null),
  });
}

module.exports = {
  logNewerSchemaDetected,
  logTurnEventDedupeDropped,
  logWriteFailed,
  safeEmitLog,
};
