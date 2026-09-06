const {
  applyManagedInitializePayload,
  initializeManagedSidecar,
  buildManagedStatusSnapshot,
} = require('./managed-sidecar-lifecycle');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('./error-codes');
const { resolveManagedConfiguredModel } = require('./managed-sidecar-config');

// Inactivity watchdog budget for managed model acquisition. During Ollama's
// "verifying sha256 digest" phase the sidecar emits the status once and then
// goes silent for tens of seconds (no runtime.progress) while a multi-GB model
// is hashed. A 15s budget aborted first-run acquisition mid-verify even after
// the sidecar's own socket timeout was widened. Sized to the runtime's
// model_load_grace_seconds default (300s) so a single silent verify gap cannot
// trip the watchdog; the absolute ceiling below still bounds the whole flight.
// Callers may override via options.inactivityTimeoutMs (see normalizePositiveTimeout).
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;
// Absolute ceiling for the whole acquisition flight. Deliberately 15s ABOVE the
// sidecar's own _PULL_TIMEOUT (600s, sidecar/ai/engines/ollama_shared.py) so the
// sidecar always gives up first and surfaces a clean typed failure; this watchdog
// is the backstop for a sidecar that never answers at all. Keep the two in step --
// if this drops to or below 600s, Electron aborts still-running pulls.
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 615_000;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;
const PROGRESS_STAGE = Object.freeze({
  model_acquiring: 1,
  model_loading: 2,
  model_ready: 3,
});

function createManagedInitializeTimeoutError(timeoutMs, kind = 'inactivity') {
  const error = new Error(
    `Managed sidecar initialization ${kind} timed out after ${timeoutMs}ms.`
  );
  error.error_code = SIDECAR_ERROR_CODES.TIMEOUT;
  error.category = 'timeout';
  error.retryable = true;
  return error;
}

function createManagedInitializeCancellationError(reason = 'Managed sidecar initialization cancelled.') {
  const error = reason instanceof Error ? reason : new Error(String(reason || 'Initialization cancelled.'));
  error.error_code = error.error_code || SIDECAR_ERROR_CODES.ABORTED;
  error.category = error.category || 'cancelled';
  error.retryable = false;
  return error;
}

function createModelUnavailableError(model, fallback) {
  const reason = String(
    fallback?.reason || 'The requested model could not be loaded.'
  ).trim().slice(0, 240);
  const error = new Error(`Model "${model}" is unavailable: ${reason}`);
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'model_unavailable';
  error.retryable = true;
  return error;
}

function createInitializeBusyError(activeModel, requestedModel) {
  const error = new Error(
    `Model initialization is already in progress for "${activeModel || 'the active runtime'}"; `
    + `retry "${requestedModel}" after it completes.`
  );
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'model_busy';
  error.retryable = true;
  return error;
}

function normalizePositiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(Math.trunc(parsed), 1) : fallback;
}

function normalizeProgress(message) {
  if (!message || message.method !== 'runtime.progress') {
    return null;
  }
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const state = String(params.state || '').trim().toLowerCase();
  if (!PROGRESS_STAGE[state]) {
    return null;
  }
  const boundedNumber = (value, maximum) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.min(parsed, maximum)
      : 0;
  };
  return {
    state,
    engine: String(params.engine || '').trim().toLowerCase().slice(0, 40),
    model: String(params.model || '').trim().slice(0, 240),
    status: String(params.status || '').trim().slice(0, 160),
    percent: boundedNumber(params.percent, 100),
    completed_bytes: Math.trunc(boundedNumber(params.completed_bytes, MAX_SAFE_BYTES)),
    total_bytes: Math.trunc(boundedNumber(params.total_bytes, MAX_SAFE_BYTES)),
  };
}

function setModelLifecycle(service, patch = {}, { emit = true } = {}) {
  const now = new Date().toISOString();
  const previous = service._modelLifecycle && typeof service._modelLifecycle === 'object'
    ? service._modelLifecycle
    : {};
  const state = String(patch.state || previous.state || 'unloaded').trim().toLowerCase();
  const next = {
    state,
    requested_model: String(
      patch.requested_model ?? previous.requested_model ?? ''
    ).trim().slice(0, 240),
    engine: String(patch.engine ?? previous.engine ?? '').trim().toLowerCase().slice(0, 40),
    status: String(patch.status ?? previous.status ?? '').trim().slice(0, 160),
    percent: Math.min(Math.max(Number(patch.percent ?? previous.percent ?? 0) || 0, 0), 100),
    completed_bytes: Math.min(Math.max(Math.trunc(Number(
      patch.completed_bytes ?? previous.completed_bytes ?? 0
    ) || 0), 0), MAX_SAFE_BYTES),
    total_bytes: Math.min(Math.max(Math.trunc(Number(
      patch.total_bytes ?? previous.total_bytes ?? 0
    ) || 0), 0), MAX_SAFE_BYTES),
    error_code: String(patch.error_code ?? previous.error_code ?? '').trim() || null,
    started_at: patch.started_at ?? previous.started_at ?? now,
    updated_at: now,
    ready_at: state === 'ready' ? (patch.ready_at ?? previous.ready_at ?? now) : null,
  };
  service._modelLifecycle = next;
  if (emit && typeof service.emit === 'function') {
    service.emit('backend-status', buildObservedBackendStatus(service));
  }
  return next;
}

// When no initialize flight is live, reconcile unloaded/acquiring/loading state
// against runtime truth so an abandoned flight cannot leave a persistent
// mid-load status.
function presentModelLifecycle(service, storedLifecycle, runtimeStatus) {
  if (service._managedInitializeFlight) {
    return storedLifecycle;
  }
  const state = String(storedLifecycle.state || '').trim().toLowerCase();
  const modelLoaded = runtimeStatus.model_loaded === true;
  const staleMidLoad = state === 'acquiring' || state === 'loading';
  if ((state === 'unloaded' || staleMidLoad) && modelLoaded) {
    // For a stale mid-load latch the runtime is the authority: an aborted
    // A->B switch leaves B in the stored request fields while A is what is
    // actually loaded. The unloaded->ready promotion keeps its stored-first
    // precedence unchanged.
    return {
      ...storedLifecycle,
      state: 'ready',
      requested_model: staleMidLoad
        ? (String(runtimeStatus.model || '') || storedLifecycle.requested_model)
        : (storedLifecycle.requested_model || String(runtimeStatus.model || '')),
      engine: staleMidLoad
        ? (String(runtimeStatus.engine || '') || storedLifecycle.engine)
        : (storedLifecycle.engine || String(runtimeStatus.engine || '')),
      status: staleMidLoad ? 'Model ready' : (storedLifecycle.status || 'Model ready'),
      percent: 100,
    };
  }
  if (staleMidLoad) {
    return { ...storedLifecycle, state: 'unloaded', status: '', percent: 0 };
  }
  return storedLifecycle;
}

function buildObservedBackendStatus(service, rawStatus = null) {
  const resolvedStatus = rawStatus ?? service.sidecarManager?.getStatus?.() ?? {};
  const status = resolvedStatus && typeof resolvedStatus === 'object' ? resolvedStatus : {};
  const storedLifecycle = service._modelLifecycle || { state: 'unloaded' };
  const runtimeStatus = service.currentStatus && typeof service.currentStatus === 'object'
    ? service.currentStatus
    : {};
  const lifecycle = presentModelLifecycle(service, storedLifecycle, runtimeStatus);
  const sidecarSpawned = status.phase === 'ready';
  const initializedWithoutModel = sidecarSpawned
    && lifecycle.state === 'unloaded'
    && service._managedReadyOnce === true
    && !service._managedInitializeFlight;
  let phase = status.phase;
  if (sidecarSpawned) {
    phase = lifecycle.state === 'ready'
      ? 'ready'
      : lifecycle.state === 'unavailable'
        ? 'model_unavailable'
        : lifecycle.state === 'acquiring'
          ? 'model_acquiring'
          : lifecycle.state === 'loading'
            ? 'model_loading'
            : initializedWithoutModel
              ? 'ready'
              : 'sidecar_spawned';
  }
  // Lifecycle-driven phases must not leak the sidecar's spawn detail
  // ("Managed sidecar process is ready.") into the renderer banner: loading
  // phases surface the model lifecycle status (real progress), and
  // model_unavailable blanks the detail so the renderer's phase copy wins.
  const detail = sidecarSpawned && phase !== 'ready'
    ? (phase === 'model_unavailable' ? '' : String(lifecycle.status || '').trim())
    : status.detail;
  return {
    ...status,
    phase,
    detail,
    sidecar_state: sidecarSpawned ? 'sidecar_spawned' : String(status.phase || 'stopped'),
    model_state: lifecycle.state || 'unloaded',
    model_lifecycle: { ...lifecycle },
    model_acquisition: {
      requested_model: lifecycle.requested_model || '',
      stage: lifecycle.state || 'unloaded',
      status: lifecycle.status || '',
      percent: Number(lifecycle.percent || 0),
      completed_bytes: Number(lifecycle.completed_bytes || 0),
      total_bytes: Number(lifecycle.total_bytes || 0),
      started_at: lifecycle.started_at || null,
      updated_at: lifecycle.updated_at || null,
    },
  };
}

function abortManagedSidecarInitialization(service, reason) {
  const flight = service._managedInitializeFlight;
  if (!flight || flight.controller.signal.aborted) {
    return false;
  }
  flight.controller.abort(createManagedInitializeCancellationError(reason));
  return true;
}

async function initializeManagedSidecarWithTimeout(service, options = {}) {
  const inactivityTimeoutMs = normalizePositiveTimeout(
    options.inactivityTimeoutMs ?? options.timeoutMs,
    DEFAULT_INACTIVITY_TIMEOUT_MS
  );
  const absoluteTimeoutMs = normalizePositiveTimeout(
    options.absoluteTimeoutMs,
    DEFAULT_ABSOLUTE_TIMEOUT_MS
  );
  const processGeneration = service.sidecarManager.process;
  const requestedEngineType = String(
    options.requestedEngineType || service.currentEngineType || ''
  ).trim().toLowerCase();
  const requestedModel = String(
    options.requestedModel
    || resolveManagedConfiguredModel(service)
    || ''
  ).trim();
  const existing = service._managedInitializeFlight;
  if (existing && existing.process === processGeneration) {
    if (
      existing.requestedModel === requestedModel
      && existing.requestedEngineType === requestedEngineType
    ) {
      return existing.promise;
    }
    throw createInitializeBusyError(existing.requestedModel, requestedModel);
  }

  const controller = new AbortController();
  const generation = (Number(service._managedInitializeGeneration) || 0) + 1;
  service._managedInitializeGeneration = generation;
  service.currentEngineType = requestedEngineType;
  service._managedPendingModel = requestedModel;
  setModelLifecycle(service, {
    state: 'unloaded',
    requested_model: requestedModel,
    engine: service.currentEngineType,
    status: requestedModel ? 'Preparing model' : 'Preparing runtime',
    percent: 0,
    completed_bytes: 0,
    total_bytes: 0,
    error_code: '',
    started_at: new Date().toISOString(),
  }, { emit: false });

  let idleTimer = null;
  let absoluteTimer = null;
  let removeExternalAbort = null;
  let removeRaceAbort = null;
  let timeoutError = null;
  let lastStage = 0;
  let lastPercent = 0;
  let lastCompletedBytes = 0;
  let lastStatus = '';
  const isCurrentProcess = () => (
    service._managedInitializeGeneration === generation
    && service.sidecarManager.process === processGeneration
    && !service._disposed
  );
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutError = createManagedInitializeTimeoutError(inactivityTimeoutMs, 'inactivity');
      controller.abort(timeoutError);
    }, inactivityTimeoutMs);
  };
  const handleProgress = (message) => {
    const progress = normalizeProgress(message);
    if (!progress || !isCurrentProcess() || controller.signal.aborted) {
      return;
    }
    const stage = PROGRESS_STAGE[progress.state];
    if (stage < lastStage) {
      return;
    }
    const forward = stage > lastStage
      || progress.percent > lastPercent
      || progress.completed_bytes > lastCompletedBytes
      || (stage === lastStage && Boolean(progress.status) && progress.status !== lastStatus);
    if (!forward) {
      return;
    }
    lastStage = Math.max(lastStage, stage);
    lastPercent = Math.max(lastPercent, progress.percent);
    lastCompletedBytes = Math.max(lastCompletedBytes, progress.completed_bytes);
    lastStatus = progress.status || lastStatus;
    armIdleTimer();
    setModelLifecycle(service, {
      state: progress.state.replace(/^model_/, ''),
      requested_model: progress.model || requestedModel,
      engine: progress.engine || service.currentEngineType,
      status: progress.status,
      percent: lastPercent,
      completed_bytes: lastCompletedBytes,
      total_bytes: Math.max(
        Number(service._modelLifecycle?.total_bytes || 0),
        progress.total_bytes
      ),
      error_code: '',
    });
  };

  if (options.signal && typeof options.signal.addEventListener === 'function') {
    const externalAbort = () => controller.abort(
      createManagedInitializeCancellationError(options.signal.reason)
    );
    if (options.signal.aborted) {
      externalAbort();
    } else {
      options.signal.addEventListener('abort', externalAbort, { once: true });
      removeExternalAbort = () => options.signal.removeEventListener('abort', externalAbort);
    }
  }
  armIdleTimer();
  absoluteTimer = setTimeout(() => {
    timeoutError = createManagedInitializeTimeoutError(absoluteTimeoutMs, 'absolute ceiling');
    controller.abort(timeoutError);
  }, absoluteTimeoutMs);

  const flight = {
    controller,
    generation,
    process: processGeneration,
    requestedModel,
    requestedEngineType,
    promise: null,
  };
  flight.promise = Promise.resolve().then(async () => {
    // Constructed BEFORE the auth phase so the watchdogs bound the token
    // refresh too: a stalled getAccessToken used to sit outside every deadline
    // and pin the flight (and its dedupe joiners) forever.
    const abortPromise = new Promise((_, reject) => {
      const rejectWithReason = () => reject(
        controller.signal.reason || createManagedInitializeCancellationError()
      );
      if (controller.signal.aborted) {
        rejectWithReason();
        return;
      }
      controller.signal.addEventListener('abort', rejectWithReason, { once: true });
      removeRaceAbort = () => controller.signal.removeEventListener('abort', rejectWithReason);
    });
    // REQUIRED: the promise is created eagerly and raced twice, so a rejection
    // landing between the races would otherwise be an unhandled rejection.
    abortPromise.catch(() => {});
    try {
      if (
        requestedEngineType === 'chatgpt'
        && typeof service.chatgptAuthService?.getAccessToken === 'function'
      ) {
        try {
          await Promise.race([
            Promise.resolve(service.chatgptAuthService.getAccessToken()),
            abortPromise,
          ]);
        } catch (error) {
          if (controller.signal.aborted) {
            // The deadline (or an explicit cancel) won the race: fail the
            // flight instead of proceeding with no credential.
            throw error;
          }
          service._emitServiceLog('WARN', 'chatgpt_auth.refresh_at_init_failed', {
            errorName: String(error?.name || 'Error'),
          });
        }
      }
      // Captured BEFORE buildManagedSidecarSecrets runs, so a sign-out landing
      // in this window records an epoch <= the one the token actually came
      // from: the admission gate can only be over-strict, never permissive.
      const authEpochAtSend = Number(service.chatgptAuthService?.getCredentialEpoch?.() ?? 0);
      const initializePromise = initializeManagedSidecar(service, {
        signal: controller.signal,
        timeoutMs: null,
        onProgress: handleProgress,
        applyResult: false,
      });
      const payload = await Promise.race([initializePromise, abortPromise]);
      if (!isCurrentProcess() || controller.signal.aborted) {
        throw createManagedInitializeCancellationError(controller.signal.reason);
      }
      applyManagedInitializePayload(service, payload);
      // The running sidecar now holds the credential generation captured above.
      service._chatgptRuntimeCredentialEpoch = authEpochAtSend;
      if (requestedModel && service._lastEngineFallback) {
        throw createModelUnavailableError(requestedModel, service._lastEngineFallback);
      }
      if (requestedModel && !String(service.currentModel || '').trim()) {
        throw createModelUnavailableError(requestedModel, {
          reason: 'The sidecar did not confirm an active model.',
        });
      }
      service._managedPendingModel = '';
      setModelLifecycle(service, {
        state: requestedModel ? 'ready' : 'unloaded',
        requested_model: requestedModel,
        engine: service.currentEngineType,
        status: requestedModel ? 'Model ready' : 'Runtime ready; no model loaded',
        percent: requestedModel ? 100 : 0,
        error_code: '',
      });
      return payload;
    } catch (error) {
      const finalError = timeoutError || error;
      const mayApplyFailure = (
        service._managedInitializeGeneration === generation
        && service.sidecarManager.process === processGeneration
        && !service._disposed
        && !service._stopping
        && finalError?.error_code !== SIDECAR_ERROR_CODES.ABORTED
      );
      if (mayApplyFailure && requestedModel) {
        service.currentModel = '';
        service.currentEngineType = requestedEngineType;
        service._managedPendingModel = '';
        setModelLifecycle(service, {
          state: 'unavailable',
          requested_model: requestedModel,
          engine: requestedEngineType,
          status: 'Model unavailable',
          error_code: finalError?.error_code || AI_ERROR_CODES.ENGINE_CONNECTION,
        });
        service.currentStatus = buildManagedStatusSnapshot(service, {
          model: '',
          model_loaded: false,
        });
      }
      service._emitServiceLog('WARN', 'backend.managed_sidecar_initialize_failed', {
        message: String(finalError?.message || finalError),
        phase: String(service.sidecarManager?.getStatus?.()?.phase || ''),
        requestedModel,
        errorCode: String(finalError?.error_code || ''),
      });
      throw finalError;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      removeExternalAbort?.();
      removeRaceAbort?.();
      if (service._managedInitializeFlight?.generation === generation) {
        service._managedInitializeFlight = null;
        // Aborted/superseded flights skip the terminal lifecycle write above.
        // Push one corrective status so pushed-event consumers (the top-deck
        // lifecycle pill) settle instead of latching a mid-load phase forever;
        // presentModelLifecycle heals the stale state at read time. Suppressed
        // during shutdown so a healed "ready" cannot overwrite stopping state.
        if (!service._disposed && !service._stopping && typeof service.emit === 'function') {
          service.emit('backend-status', buildObservedBackendStatus(service));
        }
      }
    }
  });
  service._managedInitializeFlight = flight;
  service.emit('backend-status', buildObservedBackendStatus(service));
  return flight.promise;
}

function buildLocalEngineStatusSnapshot(service, overrides = {}) {
  return buildManagedStatusSnapshot(service, overrides);
}

module.exports = {
  DEFAULT_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  abortManagedSidecarInitialization,
  buildLocalEngineStatusSnapshot,
  buildObservedBackendStatus,
  initializeManagedSidecarWithTimeout,
  normalizeProgress,
  setModelLifecycle,
};
