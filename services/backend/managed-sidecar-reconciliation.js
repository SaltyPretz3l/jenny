const {
  createManagedSessionLifecycleAdapter,
  persistAssistantFailure,
  clearActiveTurn,
} = require('./chat-stream-session-lifecycle');
const {
  SIDECAR_ERROR_CODES,
  SIDECAR_TERMINAL_SUBCODES,
} = require('./error-codes');
const {
  settlePendingApprovalsForStream,
} = require('./chat-stream-tool-handling');
const {
  hasTerminalMessageEvidence,
} = require('./active-turn-terminal-evidence');
const {
  hasActiveStreamRegistry,
  hasRegisteredActiveStream,
} = require('./backend-active-turn-state');

const SIDECAR_CRASH_MESSAGE = 'Jenny lost contact with the managed sidecar before this turn could finish.';

function normalizeActiveTurn(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function mutationAccepted(result) {
  return result && typeof result === 'object' && typeof result.ok === 'boolean'
    ? result.ok
    : Boolean(result);
}

function settleOrphanedManagedTurn(service, sessionId, activeTurn, { emitChatStream = false } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedActiveTurn = normalizeActiveTurn(activeTurn);
  if (!normalizedSessionId || !normalizedActiveTurn) {
    return false;
  }
  const requestId = String(normalizedActiveTurn.request_id || '').trim();
  const streamId = String(
    normalizedActiveTurn.stream_id || normalizedActiveTurn.request_id || ''
  ).trim();
  const traceId = String(normalizedActiveTurn.trace_id || '').trim();
  if (!requestId || !streamId) {
    return false;
  }
  const adapter = createManagedSessionLifecycleAdapter(service, normalizedSessionId);
  // CTL-007 idempotency: a stale active_turn does not necessarily mean the
  // turn never finished -- the crash may have landed AFTER the assistant row
  // durably settled but BEFORE active_turn was cleared (or a previous
  // reconcile already ran and only the clear failed to persist). Check for
  // that evidence before fabricating a failure row.
  const existingMessages = typeof service.sessionStore.getSessionMessages === 'function'
    ? service.sessionStore.getSessionMessages(normalizedSessionId)
    : [];
  const alreadyTerminal = hasTerminalMessageEvidence(existingMessages, streamId);
  settlePendingApprovalsForStream(service, normalizedSessionId, streamId, 'cancelled');
  if (alreadyTerminal) {
    const clearResult = clearActiveTurn(adapter, {
      requestId,
      streamId,
    });
    if (!mutationAccepted(clearResult)) {
      throw new Error('Active turn reconciliation clear was refused.');
    }
    service._emitServiceLog('INFO', 'backend.active_turn_reconcile_already_terminal', {
      sessionId: normalizedSessionId,
      streamId,
      requestId,
      reason: 'already_terminal',
    });
    return true;
  }
  const persistResult = persistAssistantFailure(adapter, {
    messageId: `assistant_${streamId}`,
    errorPayload: {
      message: SIDECAR_CRASH_MESSAGE,
      error_code: SIDECAR_ERROR_CODES.PROCESS_EXIT,
      category: 'process_exit',
      retryable: true,
    },
    parentStreamId: streamId,
    model: String(service.currentModel || service.sessionStore.getSession(normalizedSessionId)?.last_model_used || '').trim(),
    terminalStatus: 'runtime_error',
    terminalSubcode: SIDECAR_TERMINAL_SUBCODES.CRASH,
  });
  if (!mutationAccepted(persistResult)) {
    throw new Error('Active turn reconciliation failure persist was refused.');
  }
  const clearResult = clearActiveTurn(adapter, {
    requestId,
    streamId,
  });
  if (!mutationAccepted(clearResult)) {
    throw new Error('Active turn reconciliation clear was refused.');
  }
  if (emitChatStream === true) {
    service.emit('chat-stream', {
      type: 'error',
      streamId,
      sessionId: normalizedSessionId,
      requestId,
      traceId,
      trace_id: traceId,
      message: SIDECAR_CRASH_MESSAGE,
      category: 'process_exit',
      retryable: true,
      status: 'runtime_error',
      terminal_subcode: SIDECAR_TERMINAL_SUBCODES.CRASH,
      model: String(service.currentModel || '').trim(),
    });
  }
  return true;
}

async function reconcileManagedSidecarActiveTurns(service, { emitChatStream = false } = {}) {
  if (!service?.sessionStore) {
    return { scanned: 0, reconciled: 0 };
  }
  const sessionRecords = typeof service.sessionStore.listSessionRecords === 'function'
    ? service.sessionStore.listSessionRecords()
    : [];
  let scanned = 0;
  let reconciled = 0;
  let registryFailureLogged = false;
  for (const session of sessionRecords) {
    const sessionId = String(session?.id || '').trim();
    const activeTurn = normalizeActiveTurn(session?.active_turn);
    if (!sessionId || !activeTurn) {
      continue;
    }
    scanned += 1;
    if (!hasActiveStreamRegistry(service)) {
      if (!registryFailureLogged) {
        registryFailureLogged = true;
        service._emitServiceLog('WARN', 'backend.active_turn_reconcile_registry_unavailable', {
          scanned,
          reason: 'active_stream_registry_unavailable',
        });
      }
      continue;
    }
    const localRequestId = String(activeTurn.request_id || '').trim();
    const localStreamId = String(activeTurn.stream_id || localRequestId).trim();
    let streamRegistered;
    try {
      streamRegistered = hasRegisteredActiveStream(service, localStreamId);
    } catch (error) {
      service._emitServiceLog('WARN', 'backend.active_turn_reconcile_registry_unavailable', {
        sessionId,
        localRequestId,
        message: String(error?.message || error).slice(0, 300),
      });
      continue;
    }
    if (streamRegistered) {
      service._emitServiceLog('INFO', 'backend.active_turn_reconcile_skipped', {
        sessionId,
        localRequestId,
        streamId: localStreamId,
        reason: 'electron_stream_active',
      });
      continue;
    }
    // One session's settlement failure must not abandon later stale active turns.
    try {
      if (settleOrphanedManagedTurn(service, sessionId, activeTurn, { emitChatStream })) {
        reconciled += 1;
      }
    } catch (settleError) {
      service._emitServiceLog('WARN', 'backend.active_turn_reconcile_settle_failed', {
        sessionId,
        localRequestId,
        message: String(settleError?.message || settleError),
      });
    }
  }
  if (scanned > 0) {
    service._emitServiceLog('INFO', 'backend.active_turn_reconcile_complete', {
      scanned,
      reconciled,
    });
  }
  return { scanned, reconciled };
}

module.exports = {
  settleOrphanedManagedTurn,
  reconcileManagedSidecarActiveTurns,
};
