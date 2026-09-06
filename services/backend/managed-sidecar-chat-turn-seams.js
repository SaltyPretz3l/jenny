// Self-contained turn seams extracted from the oversized
// startManagedSidecarChatStream closure in managed-sidecar-chat.js (file-size
// cap split, 2026-07-09): finalized-turn persistence acknowledgement (CTL-002)
// and the failed-turn diagnostic dump.
// Each takes explicit state and touches nothing closure-scoped.
const { dumpTurnDiagnostic } = require('./turn-diagnostic-dump');
const { TERMINAL_STATUS_COMPLETED } = require('./chat-stream-terminal-utils');

// CTL-002: the finalized-event persist reports a structured result — a refused
// append (journal retained for the next recovery pass) or a future-log-version
// freeze must not pass silently at this seam.
//
// Audit A4 (deliberate scope): this stays a structured WARN and does NOT route
// through the turn's "Reply not saved" durability toast — in this failure mode
// the reply's MESSAGES are durably persisted and only the canonical turn-event
// provenance is missing (reload presentation may degrade to the message-based
// fallback). A toast claiming the reply was lost would be false. The
// durability_reason field carries the normalized CTL-002 vocabulary so log
// consumers can correlate it with message-level durability warnings.
function acknowledgeFinalizedTurnPersistence(service, turnEventCollector, sessionId, streamId) {
  const outcome = turnEventCollector.persistFinalizedTurn(
    sessionId,
    streamId,
    service.sessionStore.getSessionMessages(sessionId)
  );
  if (
    outcome
    && (outcome.ok === false
      || (outcome.skipped && outcome.reason === 'future_log_version'))
  ) {
    service._emitServiceLog('WARN', 'chat.turn_event_persist_incomplete', {
      sessionId,
      streamId,
      appended: Number(outcome.appended || 0),
      skipped: Boolean(outcome.skipped),
      reason: String(outcome.reason || 'append_refused'),
      durability_reason: outcome.reason === 'future_log_version' ? 'future_schema' : 'write_failed',
      durability_scope: 'turn_events',
    });
  }
  return outcome;
}

// Fire-and-observe diagnostic dump for a turn that settled on a non-completed
// terminal status; never throws into the caller's terminal handling.
function dumpFailedTurnDiagnostic({
  service,
  sessionId,
  streamId,
  traceId,
  terminal,
  timingMarkers,
  turnDiagnosticState,
  runtime,
  normalizedErrorPayload,
  sidecarErrorType,
  sidecarErrorMessage,
  model,
  clientTiming,
}) {
  if (!terminal.status || terminal.status === TERMINAL_STATUS_COMPLETED) {
    return;
  }
  Promise.resolve(dumpTurnDiagnostic({
    service,
    sessionId,
    streamId,
    requestId: streamId,
    traceId,
    terminalStatus: terminal.status,
    timingMarkers,
    contextContributions: turnDiagnosticState.promptContributions,
    contextAssemblyBreakdown: turnDiagnosticState.contextAssemblyBreakdown,
    toolEvents: runtime.getDiagnosticToolEvents(),
    terminalError: {
      code: normalizedErrorPayload.error_code || null,
      message: normalizedErrorPayload.message || null,
      retryable: normalizedErrorPayload.retryable,
      category: normalizedErrorPayload.category || null,
      cancel_reason: normalizedErrorPayload.cancel_reason || null,
      terminal_subcode: normalizedErrorPayload.terminal_subcode
        || terminal.terminalSubcode
        || null,
      error_type: sidecarErrorType || null,
      error_message: sidecarErrorMessage || null,
    },
    engineType: turnDiagnosticState.engineType,
    model,
    mode: turnDiagnosticState.effectiveMode,
    counts: null,
    clientTiming,
  })).catch((dumpError) => {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.turn_diagnostic_dump_unexpected_error', {
        sessionId,
        streamId,
        traceId,
        message: String(dumpError?.message || dumpError),
      });
    }
  });
}

module.exports = {
  acknowledgeFinalizedTurnPersistence,
  dumpFailedTurnDiagnostic,
};
