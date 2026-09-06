const {
  CANCEL_REASON_SERVICE_STOP,
} = require('./chat-stream-terminal-utils');
const {
  reconcileManagedSidecarActiveTurns,
} = require('./managed-sidecar-reconciliation');
const { flushSessionStoresAsync } = require('./session-store-drain');
const {
  abortManagedSidecarInitialization,
  buildObservedBackendStatus,
  setModelLifecycle,
} = require('./local-engine-status');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('./error-codes');
const { SHUTDOWN_TIMEOUT_MS } = require('./sidecar-request-timeouts');
const { abortAndDrainActiveStreams } = require('./active-stream-shutdown-drain');

function handleSidecarStatus(service, status) {
  const currentStatus = status && typeof status === 'object' && !Array.isArray(status)
    ? status
    : {};
  if (currentStatus.phase === 'ready') {
    service._emitServiceLog('INFO', 'backend.managed_sidecar_spawn_ready', {
      baseUrl: String(currentStatus.baseUrl || ''),
      pid: Number(currentStatus.pid || 0) || null,
      startupStage: String(currentStatus.startupStage || ''),
    });
  }
  if (
    currentStatus.phase === 'failed'
    && !service._managedReadyOnce
  ) {
    service._emitServiceLog('WARN', 'backend.managed_sidecar_failed_before_initialize', {
      detail: String(currentStatus.detail || ''),
    });
  }
  if (
    currentStatus.phase === 'failed'
    && service._managedReadyOnce
    && !service._disposed
    && !service.sidecarManager.isStopping
  ) {
    service.emit('sidecar-crash', {
      detail: String(currentStatus.detail || ''),
      status: { ...currentStatus },
    });
  }
  service.emit(
    'backend-status',
    buildObservedBackendStatus(service, currentStatus)
  );
  if (
    currentStatus.phase === 'failed'
    && !service._disposed
    && !service._stopping
    && !service.sidecarManager.isStopping
    && service._managedReadyOnce
    && !service._autoReconnectPending
    && !service._autoReconnectAttempted
  ) {
    if (typeof service._attemptAutoReconnect === 'function') {
      service._attemptAutoReconnect(currentStatus);
    } else {
      attemptAutoReconnect(service, currentStatus);
    }
  }
}

async function attemptAutoReconnect(service, failedStatus) {
  service._autoReconnectPending = true;
  service._autoReconnectAttempted = true;
  setModelLifecycle(service, {
    state: 'unloaded',
    status: 'Sidecar reconnecting',
    percent: 0,
    completed_bytes: 0,
    total_bytes: 0,
    error_code: '',
    ready_at: null,
  }, { emit: false });
  service._emitServiceLog('INFO', 'backend.auto_reconnect_start', {
    detail: String(failedStatus?.detail || ''),
  });
  service.emit('backend-status', buildObservedBackendStatus(service, {
    ...failedStatus,
    phase: 'retrying',
    detail: 'Sidecar exited unexpectedly. Reconnecting...',
  }));
  try {
    const status = await retryStartBackendService(service);
    if (status.phase === 'ready') {
      service._autoReconnectAttempted = false;
      service._emitServiceLog('INFO', 'backend.auto_reconnect_success', {});
    }
  } catch (error) {
    service._emitServiceLog('WARN', 'backend.auto_reconnect_failed', {
      message: String(error?.message || error),
    });
  } finally {
    service._autoReconnectPending = false;
  }
}

function markManagedSidecarInitialized(service) {
  service._managedReadyOnce = true;
  const status = service.sidecarManager.getStatus();
  service._emitServiceLog('INFO', 'backend.managed_sidecar_initialized', {
    baseUrl: String(status?.baseUrl || ''),
    pid: Number(status?.pid || 0) || null,
    phase: String(status?.phase || ''),
  });
}

function handleSidecarLog(service, text) {
  const line = String(text || '').trim();
  if (!line) {
    return;
  }
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (_error) {
    service.emit('diagnostic-drop', {
      source: 'sidecar',
      count: 1,
      reason: 'malformed_record',
    });
    const now = Date.now();
    if (now - Number(service._sidecarDiagnosticParseWarnedAt || 0) >= 60_000) {
      service._sidecarDiagnosticParseWarnedAt = now;
      service.emit('diagnostic-entry', {
        layer: 'sidecar',
        component: 'sidecar.transport',
        level: 'WARN',
        event: 'sidecar.diagnostics.malformed_record',
        message: 'A malformed sidecar diagnostic record was discarded.',
        status: 'degraded',
        data: { remediation: 'Inspect sidecar.log for the local file sink status.' },
        redaction_mode: 'redacted',
      });
    }
    return;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
  service.emit('diagnostic-entry', {
    ...entry,
    layer: 'sidecar',
    source: 'sidecar',
    redaction_mode: 'redacted',
  });
}

async function startBackendService(service, options) {
  service._autoReconnectAttempted = false;
  service._autoReconnectPending = false;
  service._managedReadyOnce = false;
  service._stopping = false;
  service.currentStatus = null;
  setModelLifecycle(service, {
    state: 'unloaded',
    requested_model: service.defaultModel || service.currentModel || '',
    engine: service.currentEngineType,
    status: 'Sidecar starting',
    percent: 0,
    completed_bytes: 0,
    total_bytes: 0,
    error_code: '',
    started_at: null,
    ready_at: null,
  }, { emit: false });
  const onProgress = typeof (options || {}).onProgress === 'function'
    ? options.onProgress : () => {};
  const startedAt = Date.now();
  service._emitServiceLog('INFO', 'backend.start_requested', {
    mode: 'managed-dev',
    defaultModelConfigured: Boolean(service.defaultModel),
  });
  // Kick off the selected local engine while the sidecar process spawns. The
  // initialization coordinator joins it before acquiring/loading the model.
  // vLLM and replay do not use the Ollama daemon.
  let localEngineReadyPromise = null;
  let localServerReadyPromise = (options || {}).localServerReadyPromise || null;
  if (localServerReadyPromise) {
    // Fail-soft is deliberate: a launch-plan failure here (autostart
    // settings, feature flags, acceleration/GGUF/VRAM resolution) must not
    // fail app startup. It leaves a dead openai-compatible engine that only
    // surfaces at first chat, so this is logged at ERROR (not WARN) to stay
    // visible. Nothing reads the resolved value below (see joinLocalEngineReady).
    localServerReadyPromise = Promise.resolve(localServerReadyPromise).catch((error) => {
      service._emitServiceLog('ERROR', 'llama.server.auto_start_failed', {
        message: String(error.message || error),
      });
      return null;
    });
  }
  const engineUsesOllamaDaemon = service.currentEngineType !== 'vllm'
    && service.currentEngineType !== 'replay';
  if (engineUsesOllamaDaemon) {
    onProgress('ollama_start', 'Starting Ollama...');
    localEngineReadyPromise = service.ollamaManager.start().catch((error) => {
      service._emitServiceLog('WARN', 'ollama.auto_start_failed', {
        message: String(error.message || error),
      });
      return { started: false, external: false, failed: true };
    });
  } else if (service.currentEngineType === 'vllm') {
    // Read live vLLM configuration because manager construction precedes
    // these settings.
    const vllm = service.configService?.getLocalEngines?.()?.vllm || null;
    service.vllmManager.configure?.({
      model: service.currentModel || service.defaultModel,
      port: vllm?.port,
      launchArgs: vllm,
    });
    localEngineReadyPromise = service.vllmManager.start().catch((error) => {
      service._emitServiceLog('WARN', 'vllm.auto_start_failed', {
        message: String(error.message || error),
      });
    });
  }

  // Join the overlapped local-server starts just before the sidecar handshake
  // needs it. emit ollama_ready here (after sidecar_ready) so progress stays
  // monotonic; see STARTUP_STEP_INDEX ordering in runtime-shutdown.js.
  const joinLocalEngineReady = async () => {
    const reportOllamaReady = engineUsesOllamaDaemon && Boolean(localEngineReadyPromise);
    const [result] = await Promise.all([
      localEngineReadyPromise,
      localServerReadyPromise,
    ]);
    localEngineReadyPromise = null;
    localServerReadyPromise = null;
    if (reportOllamaReady) {
      // Report Ollama ready only after a successful, already-running, or
      // intentionally skipped result.
      const ready = result?.failed !== true
        && (result?.started === true || result?.external === true
          || result?.ready === true || result?.skipped === true);
      onProgress('ollama_ready', ready
        ? 'Ollama is ready'
        : 'Ollama is unavailable; continuing with the configured runtime');
    }
  };

  // Share post-spawn finalization across initial and retry attempts.
  const finalizeStart = async (status, { retried = false } = {}) => {
    let modelUnavailable = false;
    if (status.phase === 'ready') {
      await joinLocalEngineReady();
      // The join is bounded by max(ollama, llama-server) readiness (up to
      // DEFAULT_READINESS_TIMEOUT_MS for llama-server). A stop() landing in
      // that window must not resume into _initializeManagedSidecar against a
      // torn-down client, nor let a late-resolving join fire a sidecar
      // respawn after shutdown.
      if (service._disposed || service._stopping) {
        return buildObservedBackendStatus(service, status);
      }
      onProgress('sidecar_spawned', 'Sidecar process spawned');
      try {
        await service._initializeManagedSidecar({ reason: 'startup' });
        markManagedSidecarInitialized(service);
        onProgress('model_ready', 'Model ready');
        service._autoLoadDefaultModel();
      } catch (error) {
        const modelInitializationFailed = (
          service._modelLifecycle?.state === 'unavailable'
          && (
            error?.error_code === AI_ERROR_CODES.ENGINE_CONNECTION
            || error?.error_code === SIDECAR_ERROR_CODES.TIMEOUT
          )
        );
        if (!modelInitializationFailed) {
          throw error;
        }
        modelUnavailable = true;
        markManagedSidecarInitialized(service);
        onProgress('model_unavailable', 'Model unavailable');
        service._emitServiceLog('WARN', 'backend.start_model_unavailable', {
          model: String(service._modelLifecycle?.requested_model || service.defaultModel || ''),
          message: String(error?.message || error),
          errorCode: String(error?.error_code || ''),
        });
      }
    }
    if (status.phase === 'ready') {
      // Auth restoration and status refresh are independent, concurrent, and fail-soft.
      await Promise.all([
        service.restoreAuthState().catch(() => null),
        service.refreshStatusSnapshot().catch(() => null),
      ]);
      await reconcileManagedSidecarActiveTurns(service);
    }
    if (!modelUnavailable) {
      onProgress('ready', 'Jenny is ready');
    }
    const observedStatus = buildObservedBackendStatus(service, status);
    // Push the settled observed status: during the init flight every emission
    // reads 'sidecar_spawned', and a lazy boot (no startup model — chatgpt,
    // lazy ollama) has no later lifecycle transition to correct it, leaving
    // the renderer's composer locked on a backend that is actually ready.
    service.emit('backend-status', observedStatus);
    service._emitServiceLog('INFO', 'backend.start_completed', {
      phase: observedStatus.phase,
      elapsedMs: Math.max(Date.now() - startedAt, 0),
      startupStage: status.startupStage || '',
      startupMs: Number(status.startupMs || 0),
      ...(retried ? { retried: true } : {}),
    });
    if (service.setupService && typeof service.setupService.refreshReadiness === 'function') {
      Promise.resolve(service.setupService.refreshReadiness()).catch((error) => {
        service._emitServiceLog('WARN', 'setup.readiness_refresh_after_start_failed', {
          message: String(error?.message || error),
        });
      });
    }
    service._schedulePendingSessionMigrations?.();
    return observedStatus;
  };

  try {
    onProgress('sidecar_spawn', 'Spawning sidecar...');
    const status = await service.sidecarManager.start();
    onProgress('sidecar_spawned', 'Sidecar process spawned');
    return await finalizeStart(status);
  } catch (error) {
    if (service._disposed || service._stopping || service.sidecarManager.isStopping) {
      throw error;
    }
    service._emitServiceLog('WARN', 'backend.start_retrying', {
      message: String(error.message || error),
      detail: String(error.rpc?.data?.detail || ''),
      errorCode: String(error.rpc?.data?.code || error.errorCode || ''),
      elapsedMs: Math.max(Date.now() - startedAt, 0),
    });
    service.emit('backend-status', {
      ...service.sidecarManager.getStatus(),
      phase: 'retrying',
      detail: 'Backend failed to start, retrying once.',
    });
    onProgress('sidecar_spawn', 'Retrying sidecar...');
    const status = await service.sidecarManager.retryStart();
    return await finalizeStart(status, { retried: true });
  }
}

async function stopBackendService(service, options) {
  service._stopping = true;
  const initializationWasActive = abortManagedSidecarInitialization(
    service,
    'Backend service stopping.'
  );
  const onProgress = typeof (options || {}).onProgress === 'function'
    ? options.onProgress : () => {};
  const ollamaShutdownScope =
    options && options.ollamaShutdownScope === 'any_local'
      ? 'any_local'
      : 'app_owned';
  onProgress('streams_abort', 'Cancelling active streams...');
  await abortAndDrainActiveStreams(service, {
    reason: CANCEL_REASON_SERVICE_STOP,
    timeoutMs: Math.min(1500, Math.max(SHUTDOWN_TIMEOUT_MS - 500, 1)),
  });
  service._clearPendingToolApprovals();
  try {
    if (!initializationWasActive) {
      onProgress('model_unload', 'Unloading model from Ollama...');
      try {
        await service._unloadManagedModelForShutdown();
      } catch (error) {
        service._emitServiceLog('WARN', 'backend.model_unload_failed', {
          message: String(error && error.message || error).slice(0, 240),
        });
      }
    }
    onProgress('sidecar_shutdown', 'Shutting down sidecar...');
    const gracefulDeadlineAt = Date.now() + SHUTDOWN_TIMEOUT_MS;
    const emitShutdownStage = (stage, status, startedAt, details = {}) => {
      service._emitServiceLog(status === 'ok' ? 'INFO' : 'WARN', 'backend.sidecar_shutdown_stage', {
        stage,
        status,
        durationMs: Math.max(Date.now() - startedAt, 0),
        remainingBudgetMs: Math.max(gracefulDeadlineAt - Date.now(), 0),
        forced: details.forced === true,
        confirmed: details.confirmed === true,
        activeStreamCount: Math.min(Math.max(Number(details.activeStreamCount) || 0, 0), 1000),
      });
    };

    if (service.sidecarClient && !initializationWasActive) {
      const requestStartedAt = Date.now();
      try {
        await service.sidecarClient.shutdown({
          timeoutMs: Math.max(gracefulDeadlineAt - Date.now(), 1),
        });
        emitShutdownStage('request_acknowledgement', 'ok', requestStartedAt, {
          confirmed: true,
        });
      } catch (error) {
        emitShutdownStage(
          'request_acknowledgement',
          error?.category === 'timeout' ? 'timeout' : 'failed',
          requestStartedAt
        );
      } finally {
        service._disposeSidecarClient();
      }
    } else {
      try {
        service.sidecarClient?.endInput?.();
      } catch (error) {
        service._emitServiceLog('WARN', 'backend.sidecar_input_close_failed', {
          message: String(error && error.message || error).slice(0, 240),
        });
      }
      service._disposeSidecarClient();
    }

    const stopStartedAt = Date.now();
    const stopResult = await service.sidecarManager.stop({ gracefulDeadlineAt }) || {
      exitConfirmed: true,
      forced: false,
    };
    emitShutdownStage('process_exit', stopResult.exitConfirmed ? 'ok' : 'unconfirmed', stopStartedAt, {
      forced: stopResult.forced,
      confirmed: stopResult.exitConfirmed,
      activeStreamCount: service.activeStreams?.size,
    });
    onProgress('sidecar_stopped', 'Sidecar process stopped');
  } catch (error) {
    service._emitServiceLog('WARN', 'backend.sidecar_shutdown_stage', {
      stage: 'process_exit',
      status: 'failed',
      durationMs: 0,
      remainingBudgetMs: 0,
      forced: false,
      confirmed: false,
      activeStreamCount: Math.min(Math.max(Number(service.activeStreams?.size) || 0, 0), 1000),
    });
    service._emitServiceLog('WARN', 'backend.sidecar_stop_failed', {
      message: String(error && error.message || error).slice(0, 240),
    });
    service._disposeSidecarClient();
  } finally {
    onProgress('ollama_stop', 'Stopping Ollama...');
    await service.ollamaManager.stop({ scope: ollamaShutdownScope }).catch(() => null);
    await service.vllmManager.stop().catch(() => null);
    onProgress('ollama_stopped', 'Ollama stopped');
    // Drain any debounced writes from the chat-stream stores so a subsequent
    // process (a restart in the same userDataPath, or a different reader of
    // the file) sees the freshest state. The stores opt into trailing-edge
    // write coalescing in services/backend/file-json-store.js to keep the
    // streaming hot path off the disk.
    await flushSessionStoresAsync(service);
    service._stopping = false;
  }
}

async function retryStartBackendService(service) {
  service._autoReconnectAttempted = false;
  service._stopping = false;
  service.currentStatus = null;
  setModelLifecycle(service, {
    state: 'unloaded',
    requested_model: service.defaultModel || service.currentModel || '',
    status: 'Sidecar restarting',
    percent: 0,
    completed_bytes: 0,
    total_bytes: 0,
    error_code: '',
    ready_at: null,
  }, { emit: false });
  const status = await service.sidecarManager.retryStart();
  if (status.phase === 'ready') {
    try {
      await service._initializeManagedSidecar({ reason: 'retry_start' });
      markManagedSidecarInitialized(service);
    } catch (error) {
      if (error?.error_code !== AI_ERROR_CODES.ENGINE_CONNECTION) {
        throw error;
      }
      markManagedSidecarInitialized(service);
      return buildObservedBackendStatus(service, status);
    }
  }
  if (status.phase === 'ready') {
    await service.restoreAuthState();
    await service.refreshStatusSnapshot().catch(() => null);
    await reconcileManagedSidecarActiveTurns(service, { emitChatStream: true });
  }
  return status.phase === 'ready'
    ? buildObservedBackendStatus(service, status)
    : status;
}

module.exports = {
  attemptAutoReconnect,
  handleSidecarLog,
  handleSidecarStatus,
  markManagedSidecarInitialized,
  retryStartBackendService,
  startBackendService,
  stopBackendService,
};
