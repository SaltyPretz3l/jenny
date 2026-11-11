const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const { stopManagedServerOrAbort } = require('./ninfer-load-path');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('./error-codes');
const { getResidentModels } = require('./backend-resident-models');
const { listModels, listModelsForEngine } = require('./backend-model-list');
const { loadModel, autoLoadDefaultModel } = require('./backend-model-load');

const MODEL_UNLOAD_SHUTDOWN_TIMEOUT_MS = 2000;


async function refreshStatusSnapshot(service) {
  service.currentStatus = service.currentStatus || service._buildManagedStatusSnapshot();
  service.reasoningEffortSupport = String(service.currentStatus?.reasoning_effort_support || 'unknown');
  return service.currentStatus;
}

async function unloadModel(service, { stopManagedServer = false } = {}) {
    // Jenny's own llama-server holds the model and VRAM; the sidecar unload below
    // only clears Python bookkeeping for it. A reused (external) server is never ours to stop.
    const ninferManager = stopManagedServer ? service.options?.getNinferManager?.() : null;
    // A stop whose exit was never confirmed is retried here, so an unload
    // never reports success while ninfer-serve may still hold the GPU.
    if (['ready', 'starting'].includes(ninferManager?.getStatus?.()?.state) || ninferManager?.cleanupUnconfirmed?.()) {
      await stopManagedServerOrAbort(service, ninferManager, 'ninfer', 'unload');
      service._emitServiceLog?.('INFO', 'backend.model_unload_stopped_ninfer', {});
    }
    const manager = stopManagedServer ? service.options?.getLlamaServerManager?.() : null;
    const serverStatus = manager?.getStatus?.() || {};
    if (['ready', 'starting'].includes(serverStatus.state) && serverStatus.reused !== true) {
      let stopFailure;
      try {
        stopFailure = String((await manager.stop())?.lastError || '');
      } catch (error) {
        stopFailure = String(error?.message || error) || 'stop_failed';
      }
      if (stopFailure) {
        throw Object.assign(
          new Error('The managed llama-server could not be confirmed stopped; the model may still be loaded.'),
          { error_code: AI_ERROR_CODES.ENGINE_CONNECTION, retryable: true }
        );
      }
      service._emitServiceLog?.('INFO', 'backend.model_unload_stopped_llama_server', {});
    }
    const status = service.sidecarManager.getStatus();
    if (service.sidecarClient && status.phase === 'ready') {
      await service.sidecarClient.modelsUnload();
    }
    service.currentModel = '';
    service._managedPendingModel = '';
    // Unload frees the model, not the engine: the next turn's lazy load must
    // relaunch the same engine (a managed GGUF goes back to llama-server, not
    // to Ollama as a registry pull of its id; ELC-2).
    service.currentEngineType = String(service.currentEngineType || '').trim()
      || inferEngineTypeFromModel(service.defaultModel || '');
    service.currentStatus = service._buildManagedStatusSnapshot({
      model: '',
      model_loaded: false,
      native_context_length: null,
      configured_context_length: null,
      effective_context_length: null,
      local_runtime: {
        context: {
          native_context_length: null,
          configured_context_length: null,
          effective_context_length: null,
        },
      },
    });
    service.reasoningEffortSupport = String(service.currentStatus?.reasoning_effort_support || 'unknown');
    service._modelLifecycle = {
      ...(service._modelLifecycle || {}),
      state: 'unloaded',
      requested_model: '',
      status: 'No model loaded',
      percent: 0,
      completed_bytes: 0,
      total_bytes: 0,
      error_code: null,
      updated_at: new Date().toISOString(),
      ready_at: null,
    };
    return { status: 'ok', model: '' };
}

async function unloadManagedModelForShutdown(service) {
  const status = service.sidecarManager.getStatus();
  if (status.phase !== 'ready') {
    return false;
  }

  let unloadTimeout = null;
  try {
    await Promise.race([
      service.unloadModel(),
      new Promise((_, reject) => {
        unloadTimeout = setTimeout(() => reject(new Error(
          `Managed model unload timed out after ${MODEL_UNLOAD_SHUTDOWN_TIMEOUT_MS}ms`
        )), MODEL_UNLOAD_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    service._emitServiceLog('INFO', 'backend.model_unloaded_for_shutdown', {
      mode: service.sidecarManager.mode,
    });
    return true;
  } catch (error) {
    service._emitServiceLog('WARN', 'backend.model_unload_on_shutdown_failed', {
      mode: service.sidecarManager.mode,
      message: String(error && error.message || error),
    });
    return false;
  } finally {
    if (unloadTimeout !== null) {
      clearTimeout(unloadTimeout);
    }
  }
}

async function getHardwareProfile(service, opts = {}) {
  const status = service.sidecarManager?.getStatus?.();
  if (String(status?.phase || '') !== 'ready') {
    return null;
  }
  if (!service.sidecarClient) {
    return null;
  }
  try {
    const params = {};
    if (opts && opts.modelCatalog) {
      params.model_catalog = opts.modelCatalog;
    }
    return await service.sidecarClient.hardwareProfile(params);
  } catch (error) {
    service._emitServiceLog?.('WARN', 'backend.hardware_profile_failed', {
      message: String(error?.message || error),
    });
    return null;
  }
}

function normalizeHardwareVramUsagePayload(rawPayload = {}) {
  // JSON-RPC can deliver result: null, which a default parameter does not catch.
  const payload = rawPayload || {};
  const usedMb = Number(payload.used_mb ?? payload.usedMb ?? 0);
  const totalMb = Number(payload.total_mb ?? payload.totalMb ?? 0);
  const utilPercent = Number(payload.util_percent ?? payload.utilPercent ?? Number.NaN);
  const utilAvailable = (
    (payload.util_available ?? payload.utilAvailable) === true
    && Number.isFinite(utilPercent)
    && utilPercent >= 0
    && utilPercent <= 100
  );
  const sampledAt = String(payload.sampled_at ?? payload.sampledAt ?? '').trim();
  return {
    available: payload.available === true && Number.isFinite(totalMb) && totalMb > 0,
    usedMb: Number.isFinite(usedMb) ? Math.max(usedMb, 0) : 0,
    totalMb: Number.isFinite(totalMb) ? Math.max(totalMb, 0) : 0,
    utilAvailable,
    // Zeroed when unavailable so this normalizer agrees with
    // normalizeGpuMemorySample — direct consumers must never see a phantom %.
    utilPercent: utilAvailable ? Math.min(Math.max(utilPercent, 0), 100) : 0,
    gpuType: String(payload.gpu_type ?? payload.gpuType ?? '').trim(),
    source: String(payload.source || '').trim(),
    sampledAt,
  };
}

async function getHardwareVramUsage(service) {
  if (
    service.activeStreams
    && typeof service.activeStreams.size === 'number'
    && service.activeStreams.size > 0
  ) {
    return null;
  }
  const status = service.sidecarManager?.getStatus?.();
  if (String(status?.phase || '') !== 'ready') {
    return null;
  }
  if (!service.sidecarClient) {
    return null;
  }
  try {
    const payload = await service.sidecarClient.hardwareVramUsage();
    // runtime_fallback is the sidecar's internal-exception shape. Returning it
    // would launder the failure into a fresh-looking "GPU unavailable" sample;
    // null instead lets the sample controller fall through to the direct probe.
    if (String(payload?.source || '') === 'runtime_fallback') {
      return null;
    }
    return normalizeHardwareVramUsagePayload(payload);
  } catch (error) {
    const isTimeout = String(error?.error_code || '') === SIDECAR_ERROR_CODES.TIMEOUT;
    service._emitServiceLog?.(isTimeout ? 'DEBUG' : 'WARN', 'backend.hardware_vram_usage_failed', {
      message: String(error?.message || error),
    });
    return null;
  }
}

module.exports = {
  refreshStatusSnapshot,
  listModels,
  listModelsForEngine,
  loadModel,
  autoLoadDefaultModel,
  unloadModel,
  unloadManagedModelForShutdown,
  getHardwareProfile,
  getHardwareVramUsage,
  normalizeHardwareVramUsagePayload,
  getResidentModels,
};
