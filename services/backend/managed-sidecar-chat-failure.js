// The failure path of startManagedSidecarChatStream (managed-sidecar-chat.js):
// map the thrown error, the abort reason and the sidecar's recorded error state
// onto one terminal payload, schedule a sidecar reconnect when warranted, settle
// execution, and persist/emit the failure. Writes the turn's terminal bookkeeping
// into `turnState` in place, so the caller's finally block sees every write even
// when a later step throws; the timeout error is read live from it.
const {
  buildTerminalErrorPayload,
  enrichTerminalErrorPayloadForEmit,
  isExpectedLifecycleCancellation,
  resolveTerminalRouting,
  streamErrorDetailsFromAbortSignal,
} = require('./chat-stream-terminal-utils');
const { scheduleManagedSidecarReconnectAfterFailure } = require('./managed-sidecar-chat-reconnect');
const { dumpFailedTurnDiagnostic } = require('./managed-sidecar-chat-turn-seams');
const { settleHostedExecution } = require('./hosted-execution-settlement');
const { abortImageBridgeExecutions } = require('./electron-tool-bridge');

async function settleManagedTurnFailure(service, {
  error, turnState, controller, runtime, streamWatchdog, model,
  resolvedSessionId, streamId, requestTraceId,
  timingMarkers, recordTimingMarker, turnDiagnosticState, normalizedClientTiming,
  fetchAndRecordProviderDiagnosticPhases, noteToolObservationPayload,
}) {
  const effectiveError = turnState.streamTimeoutError || (
    controller.signal.aborted
      ? streamErrorDetailsFromAbortSignal(controller.signal).error
      : error
  );
  // F-01 containment: the synchronous re-check-before-claim in
  // persistUserMessage() lost the admission race to a concurrent send on
  // this session. No user message was persisted and no active_turn was
  // claimed for THIS turn -- it never started one, so it is not a failed
  // turn and must not run the generic failed-turn machinery below (no
  // phantom assistant-failure row with no matching user message, no
  // sidecar restart consideration, no provider-diagnostics fetch). Reuse
  // the existing chat-stream 'error' event shape (same shape the
  // external path's session_busy rejection carries) so the renderer's
  // existing error handling surfaces the busy state with no new wiring.
  if (effectiveError && effectiveError.code === 'session_busy') {
    service._emitServiceLog('WARN', 'chat.session_busy_rejected', {
      sessionId: resolvedSessionId,
      streamId,
      traceId: requestTraceId,
    });
    service.emit('chat-stream', {
      type: 'error',
      message: String(effectiveError.message || 'a turn is already running'),
      error_code: 'session_busy',
      category: 'session_busy',
      retryable: true,
      status: 'runtime_error',
      ...runtime.getEventBase(),
    });
    return;
  }
  if (turnState.streamTimeoutError) {
    turnState.restartReason = 'chat.timeout';
    service._emitServiceLog('WARN', 'chat.stream_timeout', {
      sessionId: resolvedSessionId,
      streamId,
      model,
      idleTimeoutMs: streamWatchdog.getCeilings().idleTimeoutMs,
      absoluteTimeoutMs: streamWatchdog.getCeilings().absoluteTimeoutMs,
      message: String(turnState.streamTimeoutError.message || turnState.streamTimeoutError),
    });
  }
  // Keep active_turn until persistence so crash recovery can reconcile it.
  runtime.emitThinkingStatus('');
  const {
    sidecarErrorCode,
    sidecarErrorRetryable,
    sidecarErrorCategory,
    sidecarTerminalSubcode,
    sidecarErrorType,
    sidecarErrorMessage,
  } = runtime.getErrorState();
  const normalizedErrorPayload = buildTerminalErrorPayload(
    effectiveError,
    turnState.streamTimeoutError
      ? 'timeout'
      : (controller.signal.aborted ? 'cancelled' : sidecarErrorCategory)
  );
  await abortImageBridgeExecutions(service, streamId); // A lost transport cannot carry the render's result.
  await settleHostedExecution(service, streamId, normalizedErrorPayload);
  if (sidecarErrorCode && !normalizedErrorPayload.error_code) {
    normalizedErrorPayload.error_code = sidecarErrorCode;
  }
  if (sidecarErrorRetryable === false) {
    normalizedErrorPayload.retryable = false;
  }
  if (sidecarTerminalSubcode && !normalizedErrorPayload.terminal_subcode) {
    normalizedErrorPayload.terminal_subcode = sidecarTerminalSubcode;
  }
  if (sidecarErrorType && !normalizedErrorPayload.error_type) {
    normalizedErrorPayload.error_type = sidecarErrorType;
  }
  if (sidecarErrorMessage && !normalizedErrorPayload.error_message) {
    normalizedErrorPayload.error_message = sidecarErrorMessage;
  }
  noteToolObservationPayload(effectiveError?.rpc?.data?.tool_observations);
  const visibleCompletionEmitted = runtime.isVisibleCompletionEmitted();
  const reconnectReason = scheduleManagedSidecarReconnectAfterFailure(
    service,
    normalizedErrorPayload,
    {
      streamTimeout: Boolean(turnState.streamTimeoutError),
      visibleCompletionEmitted,
      sessionId: resolvedSessionId,
      streamId,
      traceId: requestTraceId,
    }
  );
  if (reconnectReason) {
    turnState.restartReason = reconnectReason;
  }
  await require('../execution/execution-settlement').settleExecution(service, streamId, normalizedErrorPayload);
  const terminal = resolveTerminalRouting({
    status: normalizedErrorPayload.status,
    terminalSubcode: normalizedErrorPayload.terminal_subcode,
    visibleCompletionEmitted,
  });
  turnState.terminalStatus = terminal.status;
  recordTimingMarker('terminal_settled');
  turnState.terminalSettledAt = Date.now();
  // A failed phase recording yields undefined, so the dump still runs and fetches for itself.
  fetchAndRecordProviderDiagnosticPhases().catch((providerDiagnosticError) => {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'chat.provider_phase_percentiles_failed', {
        sessionId: resolvedSessionId,
        streamId,
        traceId: requestTraceId,
        message: String(providerDiagnosticError?.message || providerDiagnosticError),
      });
    }
  }).then((providerDiagnostics) => dumpFailedTurnDiagnostic({
    service,
    sessionId: resolvedSessionId,
    streamId,
    traceId: requestTraceId,
    terminal,
    timingMarkers,
    turnDiagnosticState,
    runtime,
    normalizedErrorPayload,
    sidecarErrorType,
    sidecarErrorMessage,
    model,
    clientTiming: normalizedClientTiming,
    providerDiagnostics,
  }));
  if (terminal.logOnlyLateFailure) {
    const expectedLifecycleCancellation = isExpectedLifecycleCancellation(normalizedErrorPayload);
    const settlementEvent = expectedLifecycleCancellation ? 'cancelled' : 'failed';
    service._emitServiceLog(expectedLifecycleCancellation ? 'INFO' : 'WARN',
      `chat.stream_late_settlement_${settlementEvent}`, {
      sessionId: resolvedSessionId, streamId, model,
      message: String(effectiveError && effectiveError.message || effectiveError),
      timedOut: Boolean(turnState.streamTimeoutError), status: terminal.status,
      terminalSubcode: terminal.terminalSubcode,
      cancelReason: normalizedErrorPayload.cancel_reason || '',
    });
    if (!runtime.isTerminalCoordinatorHandled()) {
      runtime.clearReconnectStateOnFailure();
    }
    return;
  }
  const coordinatedFailure = await runtime.settleFailureTerminal(
    normalizedErrorPayload,
    terminal
  );
  if (!coordinatedFailure.handled) {
    if (runtime.shouldPersistFailureMessage() && terminal.persistAssistantFailure) {
      runtime.persistFailureMessage(normalizedErrorPayload);
    } else {
      runtime.clearReconnectStateOnFailure();
    }
    if (terminal.emitErrorEvent) {
      service.emit('chat-stream', {
        type: 'error',
        ...enrichTerminalErrorPayloadForEmit(normalizedErrorPayload, {
          terminalStatus: terminal.status,
          terminalSubcode: terminal.terminalSubcode,
        }),
        ...runtime.getEventBase(),
      });
    }
  }
}

module.exports = {
  settleManagedTurnFailure,
};
