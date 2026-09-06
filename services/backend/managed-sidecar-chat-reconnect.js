const {
  AI_ERROR_CODES,
  SIDECAR_ERROR_CODES,
  SIDECAR_TERMINAL_SUBCODES,
} = require('./error-codes');
const { managedModelKey } = require('../shell-config-engines');

const PREFLIGHT_RECONNECT_TERMINAL_SUBCODES = new Set([
  SIDECAR_TERMINAL_SUBCODES.RECONNECT_FAILED,
  SIDECAR_TERMINAL_SUBCODES.RECONNECT_IN_PROGRESS,
]);

function createReconnectError(message, terminalSubcode = SIDECAR_TERMINAL_SUBCODES.RECONNECT_FAILED) {
  const error = new Error(String(message || '').trim() || 'Managed sidecar reconnect failed.');
  error.error_code = SIDECAR_ERROR_CODES.PROCESS_EXIT;
  error.category = 'process_exit';
  error.retryable = true;
  error.terminal_subcode = terminalSubcode;
  return error;
}

function createOllamaPreflightError(message) {
  const normalizedMessage = String(message || '').trim()
    || 'Ollama is unavailable before chat.';
  const error = new Error(normalizedMessage);
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'provider';
  error.retryable = true;
  error.error_type = 'EngineConnectionError';
  error.error_message = normalizedMessage;
  return error;
}

// Compose a specific, user-facing reason from the manager's failure detail so
// the chat error names *why* Ollama is down (port conflict, GPU, crash, etc.)
// instead of the generic "unavailable" line. Falls back to the generic text
// when no structured detail is available.
function describeOllamaFailure(failure) {
  const generic = 'Ollama is unavailable after the preflight start attempt.';
  if (!failure || typeof failure !== 'object') {
    return generic;
  }
  const parts = [];
  if (failure.reason === 'crash' && (failure.code != null || failure.signal)) {
    const detail = failure.signal
      ? `signal ${failure.signal}`
      : `exit code ${failure.code}`;
    parts.push(`Ollama exited unexpectedly (${detail}).`);
  } else if (failure.reason === 'not_found') {
    parts.push('Ollama could not be started.');
  } else if (failure.reason === 'spawn_error') {
    parts.push('Ollama could not be launched.');
  } else if (failure.reason === 'startup_timeout') {
    parts.push('Ollama did not become ready in time.');
  } else {
    parts.push(generic);
  }
  const remediation = String(failure.remediation || '').trim();
  if (remediation) {
    parts.push(remediation);
  }
  return parts.join(' ');
}

function createEngineFallbackError(requestedEngine, reason) {
  const error = new Error(
    `The ${requestedEngine} engine is not active (chat would run against the mock fallback): ${reason}`
  );
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'provider';
  error.retryable = true;
  error.error_type = 'EngineFallbackActiveError';
  error.error_message = error.message;
  return error;
}

async function ensureManagedEngineNotFallbackForChat(
  service,
  { sessionId, streamId, traceId } = {}
) {
  if (!service?._lastEngineFallback) {
    return false;
  }
  // One recovery attempt per send: the requested engine may have come back
  // since the boot-time fallback (e.g. Ollama started after launch) — mirror
  // loadModel's re-initialize-then-check instead of failing on stale state.
  if (typeof service._initializeManagedSidecar === 'function') {
    try {
      await service._initializeManagedSidecar();
      if (typeof service.refreshStatusSnapshot === 'function') {
        await service.refreshStatusSnapshot().catch(() => null);
      }
    } catch (error) {
      service._emitServiceLog('WARN', 'chat.engine_fallback_reinitialize_failed', {
        sessionId,
        streamId,
        traceId,
        message: String(error?.message || error || ''),
      });
    }
  }
  const fallback = service._lastEngineFallback;
  if (!fallback) {
    service._emitServiceLog('INFO', 'chat.engine_fallback_recovered', {
      sessionId,
      streamId,
      traceId,
    });
    return true;
  }
  const requested = String(fallback.requested_engine || '').trim() || 'requested';
  const reason = String(fallback.reason || 'Engine initialization failed').trim();
  service._emitServiceLog('WARN', 'chat.engine_fallback_preflight_blocked', {
    sessionId,
    streamId,
    traceId,
    requestedEngine: requested,
    reason,
  });
  throw createEngineFallbackError(requested, reason);
}

function needsManagedSidecarChatReconnect(service) {
  if (!service?.sidecarManager) {
    return false;
  }
  const status = typeof service.sidecarManager.getStatus === 'function'
    ? service.sidecarManager.getStatus()
    : {};
  if (String(status?.phase || '').trim() !== 'ready') {
    return true;
  }
  if (!service.sidecarManager.process) {
    return true;
  }
  return !service.sidecarClient || service.sidecarClient.connected === false;
}

async function ensureManagedSidecarReadyForChat(service, { sessionId, streamId, traceId }) {
  if (!needsManagedSidecarChatReconnect(service)) {
    return false;
  }
  if (service._autoReconnectPending) {
    service._emitServiceLog('WARN', 'chat.sidecar_preflight_reconnect_pending', {
      sessionId,
      streamId,
      traceId,
    });
    throw createReconnectError(
      'Managed sidecar reconnect is already in progress.',
      SIDECAR_TERMINAL_SUBCODES.RECONNECT_IN_PROGRESS
    );
  }
  if (typeof service._restartManagedSidecar !== 'function') {
    throw createReconnectError('Managed sidecar reconnect is unavailable.');
  }
  service._emitServiceLog('WARN', 'chat.sidecar_preflight_reconnect', {
    sessionId,
    streamId,
    traceId,
  });
  const reconnected = await service._restartManagedSidecar('chat.preflight_reconnect');
  if (!reconnected || needsManagedSidecarChatReconnect(service)) {
    throw createReconnectError('Managed sidecar is unavailable after reconnect.');
  }
  service._emitServiceLog('INFO', 'chat.sidecar_preflight_reconnected', {
    sessionId,
    streamId,
    traceId,
  });
  return true;
}

async function ensureManagedOllamaReadyForChat(
  service,
  { engineType, sessionId, streamId, traceId } = {}
) {
  if (String(engineType || '').trim().toLowerCase() !== 'ollama') {
    return false;
  }
  const manager = service.ollamaManager;
  const ensureRunning = typeof manager?.ensureRunning === 'function'
    ? manager.ensureRunning
    : (typeof manager?.start === 'function' ? manager.start : null);
  if (!ensureRunning) {
    return false;
  }
  let result;
  try {
    result = await ensureRunning.call(manager);
  } catch (error) {
    const message = String(error?.message || error || 'Ollama start failed.');
    service._emitServiceLog('WARN', 'chat.ollama_preflight_failed', {
      sessionId,
      streamId,
      traceId,
      message,
    });
    throw createOllamaPreflightError(`Could not start Ollama before chat: ${message}`);
  }
  const ready = result?.ready === true
    || (result?.ready == null && (result?.started === true || result?.external === true));
  if (!ready) {
    const failure = result?.failure || null;
    service._emitServiceLog('WARN', 'chat.ollama_preflight_unavailable', {
      sessionId,
      streamId,
      traceId,
      started: Boolean(result?.started),
      external: Boolean(result?.external),
      reason: failure?.reason || null,
      likelyCause: failure?.likelyCause || null,
    });
    throw createOllamaPreflightError(describeOllamaFailure(failure));
  }
  service._emitServiceLog('INFO', 'chat.ollama_preflight_ready', {
    sessionId,
    streamId,
    traceId,
    started: Boolean(result?.started),
    external: Boolean(result?.external),
  });
  return true;
}

async function ensureManagedLlamaServerReadyForChat(
  service,
  { engineType, sessionId, streamId, traceId } = {}
) {
  if (String(engineType || '').trim().toLowerCase() !== 'openai-compatible') {
    return false;
  }
  const manager = service.options?.getLlamaServerManager?.() || null;
  const managed = service.configService?.getLocalEngines?.()?.openaiCompatible?.managed || null;
  const key = String(managed?.lastUsedTag || '').trim();
  const entry = key ? managed?.perModel?.[key] || null : null;
  if (!manager || managed?.enabled !== true || !entry || entry.engine !== 'llama-server') {
    return false;
  }
  // Only the managed model's own chats relaunch the server; a user's other
  // openai-compatible endpoint is left alone.
  const currentModel = String(service.currentModel || '').trim();
  if (currentModel && managedModelKey(currentModel) !== key) {
    return false;
  }
  let status = manager.getStatus?.() || {};
  if (status.state === 'ready' && typeof manager.settled === 'function') {
    // A launch that just reached ready may still be re-brokering its key to
    // the sidecar; the manager's chain settles only after that.
    status = (await manager.settled()) || status;
  }
  if (status.state === 'ready') {
    return true;
  }
  if (!['crashed', 'stopped', 'stopping', 'starting'].includes(status.state)) {
    return false;
  }
  if (status.state !== 'starting') {
    service._emitServiceLog('WARN', 'chat.llama_server_preflight_restart', {
      sessionId, streamId, traceId, state: status.state,
    });
  }
  let readyStatus;
  try {
    readyStatus = await manager.ensureRunning({
      modelTag: entry.tag || key,
      modelPath: entry.modelPath,
      profileId: managed.profileId,
      mtp: entry.mtp,
    });
  } catch (error) {
    readyStatus = { state: status.state, lastError: String(error?.message || error) };
  }
  if (readyStatus?.state !== 'ready') {
    const detail = readyStatus?.lastError || readyStatus?.state;
    service._emitServiceLog('WARN', 'chat.llama_server_preflight_unavailable', {
      sessionId, streamId, traceId, state: readyStatus?.state, message: detail,
    });
    throw createOllamaPreflightError(`llama-server is unavailable: ${detail}`);
  }
  service._emitServiceLog('INFO', 'chat.llama_server_preflight_ready', {
    sessionId, streamId, traceId,
  });
  return true;
}

function resolveReconnectReason(errorPayload) {
  const payload = errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)
    ? errorPayload
    : {};
  const category = String(payload.category || '').trim().toLowerCase();
  const code = String(payload.error_code || payload.code || '').trim();
  const terminalSubcode = String(payload.terminal_subcode || '').trim().toLowerCase();
  if (PREFLIGHT_RECONNECT_TERMINAL_SUBCODES.has(terminalSubcode)) {
    return '';
  }
  if (
    category === 'process_exit'
    || terminalSubcode === SIDECAR_TERMINAL_SUBCODES.CRASH
    || code === SIDECAR_ERROR_CODES.PROCESS_EXIT
  ) {
    return 'chat.process_exit';
  }
  if (category === 'transport' || code === SIDECAR_ERROR_CODES.TRANSPORT) {
    return 'chat.transport_failure';
  }
  return '';
}

function scheduleManagedSidecarReconnectAfterFailure(
  service,
  errorPayload,
  { streamTimeout = false, visibleCompletionEmitted = false, sessionId, streamId, traceId } = {}
) {
  if (streamTimeout || visibleCompletionEmitted) {
    return '';
  }
  const reason = resolveReconnectReason(errorPayload);
  if (!reason) {
    return '';
  }
  service._emitServiceLog('WARN', 'chat.sidecar_failure_reconnect_scheduled', {
    sessionId,
    streamId,
    traceId,
    reason,
    errorCode: String(errorPayload?.error_code || ''),
    category: String(errorPayload?.category || ''),
  });
  return reason;
}

module.exports = {
  describeOllamaFailure,
  ensureManagedEngineNotFallbackForChat,
  ensureManagedLlamaServerReadyForChat,
  ensureManagedOllamaReadyForChat,
  ensureManagedSidecarReadyForChat,
  scheduleManagedSidecarReconnectAfterFailure,
};
