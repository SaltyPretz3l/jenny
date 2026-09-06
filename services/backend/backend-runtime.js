const {
  inferEngineTypeFromModel,
  resolveRequestedEngineType,
} = require('./backend-service-utils');
const { managedModelKey, normalizePreferredEngineType } = require('../shell-config-engines');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('./error-codes');
const { getResidentModels } = require('./backend-resident-models');

const MODEL_UNLOAD_SHUTDOWN_TIMEOUT_MS = 2000;
const MODEL_LIST_CACHE_TTL_MS = 2000;
const MODEL_LIST_METADATA_FIELDS = ['source', 'cached_at', 'expires_at', 'last_error', 'daemon_version'];
const MODEL_ENGINE_HINT_LIMIT = 512;

function normalizeModelEngineType(value) {
  return normalizePreferredEngineType(value);
}

function normalizeModelListEntry(entry) {
  if (typeof entry === 'string') {
    const id = String(entry || '').trim();
    return id ? { id } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const id = String(entry.id || entry.name || entry.model || '').trim();
  if (!id) {
    return null;
  }
  const normalized = { id };
  const available = entry.available;
  if (typeof available === 'boolean') {
    normalized.available = available;
  }
  if (typeof entry.reason === 'string' && entry.reason.trim()) {
    normalized.reason = entry.reason.trim();
  }
  if (typeof entry.provider === 'string' && entry.provider.trim()) {
    normalized.provider = entry.provider.trim();
  }
  const engineType = normalizeModelEngineType(entry.engine_type || entry.engineType);
  if (engineType) {
    normalized.engine_type = engineType;
  }
  if (
    entry.capabilities
    && typeof entry.capabilities === 'object'
    && !Array.isArray(entry.capabilities)
  ) {
    normalized.capabilities = { ...entry.capabilities };
  }
  if (typeof entry.template_family === 'string' && entry.template_family.trim()) {
    normalized.template_family = entry.template_family.trim();
  }
  const rawSize = entry.size !== undefined ? entry.size : entry.size_bytes;
  const size = Number(rawSize);
  if (Number.isFinite(size) && size > 0) {
    normalized.size = size;
  }
  // Model-fit estimator inputs (Wave 1): Ollama /api/tags details, carried
  // camelCase through to the Electron-side model list. Additive only.
  // tagModelListEntries() re-runs this normalizer over its own already-
  // normalized output, so the camelCase form must also be accepted as input
  // or a second pass silently drops the field (the size/engine_type fields
  // avoid this because their output key matches one of their input keys).
  const parameterSize = entry.parameter_size ?? entry.parameterSize;
  if (typeof parameterSize === 'string' && parameterSize.trim()) {
    normalized.parameterSize = parameterSize.trim().slice(0, 32);
  }
  const quantizationLevel = entry.quantization_level ?? entry.quantizationLevel;
  if (typeof quantizationLevel === 'string' && quantizationLevel.trim()) {
    normalized.quantizationLevel = quantizationLevel.trim().slice(0, 32);
  }
  if (typeof entry.digest === 'string' && entry.digest.trim()) {
    normalized.digest = entry.digest.trim().slice(0, 128);
  }
  return normalized;
}

function tagModelListEntries(entries, fallbackEngineType) {
  const normalizedFallback = normalizeModelEngineType(fallbackEngineType);
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeModelListEntry(entry))
    .filter(Boolean)
    .map((entry) => ({
      ...entry,
      ...(entry.engine_type || !normalizedFallback ? {} : { engine_type: normalizedFallback }),
    }));
}

function replaceModelEngineHints(service, entries) {
  const hints = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const modelId = String(entry?.id || '').trim();
    const engineType = normalizeModelEngineType(entry?.engine_type || entry?.engineType);
    if (!modelId || !engineType) continue;
    hints.set(modelId, engineType);
    if (hints.size >= MODEL_ENGINE_HINT_LIMIT) break;
  }
  service._modelEngineHints = hints;
}

function normalizeModelLoadRequest(service, request) {
  const source = request && typeof request === 'object' && !Array.isArray(request) ? request : null;
  const model = String(source ? (source.model || source.id || '') : request || '').trim();
  const explicitEngineType = normalizeModelEngineType(
    source && (source.engine_type || source.engineType)
  );
  const hintedEngineType = normalizeModelEngineType(service?._modelEngineHints?.get?.(model));
  return {
    model,
    engineType: explicitEngineType || hintedEngineType,
    engineSource: explicitEngineType ? 'request' : hintedEngineType ? 'catalog' : '',
  };
}

function normalizeModelListMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const metadata = {};
  if (typeof payload.stale === 'boolean') {
    metadata.stale = payload.stale;
  }
  for (const key of MODEL_LIST_METADATA_FIELDS) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      metadata[key] = payload[key].trim();
    }
  }
  return metadata;
}

function normalizeModelInspection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const modelId = String(payload.model_id || '').trim().slice(0, 240);
  const nativeContextLength = Number(payload.native_context_length);
  return {
    modelId,
    available: payload.available === true,
    nativeContextLength: Number.isSafeInteger(nativeContextLength) && nativeContextLength > 0
      ? nativeContextLength
      : null,
    reason: String(payload.reason || '').trim().slice(0, 80),
  };
}

function mergeModelListEntries(primaryEntries, fallbackEntries) {
  const merged = [];
  const seen = new Map();
  for (const entries of [primaryEntries, fallbackEntries]) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      const id = String(entry?.id || '').trim();
      if (!id) {
        continue;
      }
      const existingIndex = seen.get(id);
      if (typeof existingIndex === 'number') {
        if (merged[existingIndex]?.available === false && entry?.available !== false) {
          merged[existingIndex] = entry;
        }
        continue;
      }
      seen.set(id, merged.length);
      merged.push(entry);
    }
  }
  return merged;
}

function resolveManagedModelListEngineType(service) {
  const currentEngineType = String(service.currentEngineType || '').trim().toLowerCase();
  const fallbackRequestedEngineType = String(
    service._lastEngineFallback?.requested_engine || ''
  ).trim().toLowerCase();
  if (
    currentEngineType === 'mock'
    && fallbackRequestedEngineType
    && fallbackRequestedEngineType !== 'mock'
  ) {
    return fallbackRequestedEngineType;
  }
  return String(
    currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel)
    || 'mock'
  ).trim().toLowerCase() || 'mock';
}

async function refreshStatusSnapshot(service) {
  service.currentStatus = service.currentStatus || service._buildManagedStatusSnapshot();
  service.reasoningEffortSupport = String(service.currentStatus?.reasoning_effort_support || 'unknown');
  service._normalizeManagedReasoningEfforts();
  return service.currentStatus;
}

function listModels(service) {
  const now = Date.now();
  const desiredEngineType = resolveManagedModelListEngineType(service);
  const lastResult = service._modelListLastResult;
  if (lastResult && lastResult.engineType === desiredEngineType
      && now >= lastResult.at && now - lastResult.at < MODEL_LIST_CACHE_TTL_MS) {
    return Promise.resolve(lastResult.value);
  }
  if (service._modelListInFlightPromise && service._modelListInFlightEngineType === desiredEngineType) {
    return service._modelListInFlightPromise;
  }

  const inFlightPromise = (async () => {
    const payload = await service.listModelsForEngine(desiredEngineType);
    let data = tagModelListEntries(payload.data, desiredEngineType);
    const primaryHasModels = data.length > 0;
    let available = payload.available !== false;
    let metadata = normalizeModelListMetadata(payload);
    if (desiredEngineType !== 'ollama') {
      const ollamaPayload = await service.listModelsForEngine('ollama').catch(() => null);
      const ollamaData = tagModelListEntries(ollamaPayload?.data, 'ollama');
      if (ollamaPayload?.available !== false && ollamaData.length > 0) {
        data = mergeModelListEntries(data, ollamaData);
        available = true;
        if (payload.available === false || !primaryHasModels) {
          metadata = {
            ...metadata,
            ...normalizeModelListMetadata(ollamaPayload),
          };
        }
      }
    }
    const providerData = service.providerIntegrationRegistry?.appendModelEntries?.(data, {
      engineType: desiredEngineType,
    }) || data;
    const taggedData = tagModelListEntries(providerData, desiredEngineType);
    replaceModelEngineHints(service, taggedData);
    return {
      ...payload,
      ...metadata,
      available,
      primary_available: payload.available !== false,
      data: taggedData,
    };
  })();
  service._modelListInFlightPromise = inFlightPromise;
  service._modelListInFlightEngineType = desiredEngineType;
  inFlightPromise.then(
    (value) => {
      service._modelListLastResult = { at: Date.now(), value, engineType: desiredEngineType };
      if (service._modelListInFlightPromise === inFlightPromise) {
        service._modelListInFlightPromise = null;
      }
    },
    () => {
      if (service._modelListInFlightPromise === inFlightPromise) {
        service._modelListInFlightPromise = null;
      }
    }
  );
  return inFlightPromise;
}

function listModelsForEngine(service, engineType, options = {}) {
    const desiredEngineType = String(engineType || '').trim().toLowerCase() || String(
      service.currentEngineType
      || inferEngineTypeFromModel(service.currentModel || service.defaultModel)
      || 'mock'
    );
    if (!service.sidecarClient) {
      return Promise.resolve({
        object: 'list',
        active_model: service.currentModel || '',
        engine_type: desiredEngineType,
        available: false,
        reason: 'Managed sidecar is not ready yet.',
        data: [],
      });
    }
    const inspectModelId = String(options?.inspectModelId || '').trim();
    const cacheKey = `${desiredEngineType}::${inspectModelId}`;
    const now = Date.now();
    service._modelListForEngineLastResults ||= new Map();
    service._modelListForEngineInFlightPromises ||= new Map();
    // inspectModelId is part of the key, so an unswept map would retain one full
    // catalog payload per model the user ever inspected. Expired entries can never
    // be served again -- drop them on the way past.
    for (const [key, entry] of service._modelListForEngineLastResults) {
      if (now < entry.at || now - entry.at >= MODEL_LIST_CACHE_TTL_MS) {
        service._modelListForEngineLastResults.delete(key);
      }
    }
    const lastResult = service._modelListForEngineLastResults.get(cacheKey);
    if (lastResult) {
      return Promise.resolve(lastResult.value);
    }
    const existingPromise = service._modelListForEngineInFlightPromises.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const inFlightPromise = (async () => {
      const payload = await service.sidecarClient.modelsList(desiredEngineType, { inspectModelId });
      const models = Array.isArray(payload.models) ? payload.models : [];
      const normalized = models.map((entry) => normalizeModelListEntry(entry)).filter(Boolean);
      const metadata = normalizeModelListMetadata(payload);
      const providerData = service.providerIntegrationRegistry?.appendModelEntries?.(normalized, {
        engineType: desiredEngineType,
      }) || normalized;
      const taggedData = tagModelListEntries(providerData, desiredEngineType);
      const modelInspection = normalizeModelInspection(payload.model_inspection);
      replaceModelEngineHints(service, taggedData);
      return {
        object: 'list',
        active_model: service.currentModel,
        engine_type: desiredEngineType,
        available: payload.available !== false,
        reason: payload.reason || '',
        ...metadata,
        ...(modelInspection ? { modelInspection } : {}),
        data: taggedData,
      };
    })();
    service._modelListForEngineInFlightPromises.set(cacheKey, inFlightPromise);
    inFlightPromise.then(
      (value) => {
        service._modelListForEngineLastResults.set(cacheKey, { at: Date.now(), value });
        if (service._modelListForEngineInFlightPromises.get(cacheKey) === inFlightPromise) {
          service._modelListForEngineInFlightPromises.delete(cacheKey);
        }
      },
      () => {
        service._modelListForEngineLastResults.delete(cacheKey);
        if (service._modelListForEngineInFlightPromises.get(cacheKey) === inFlightPromise) {
          service._modelListForEngineInFlightPromises.delete(cacheKey);
        }
      }
    );
    return inFlightPromise;
}

// Streams other than `excludedStreamId`. A chat turn is already registered in
// activeStreams before it resolves its model, so it must not see itself.
function countActiveStreamsExcluding(activeStreams, excludedStreamId) {
  if (!activeStreams || typeof activeStreams.size !== 'number') return 0;
  const excluded = String(excludedStreamId || '');
  if (!excluded || typeof activeStreams.keys !== 'function') return activeStreams.size;
  let count = 0;
  for (const streamId of activeStreams.keys()) {
    if (String(streamId) !== excluded) count += 1;
  }
  return count;
}

async function loadModel(service, model, options = {}) {
  const loadRequest = normalizeModelLoadRequest(service, model);
    const requestedModelName = loadRequest.model;
    const availability = service.providerIntegrationRegistry?.resolveModelAvailability?.(requestedModelName) || { available: true, reason: '' };
    if (availability.available === false) {
      throw new Error(String(availability.reason || `Model "${requestedModelName}" is unavailable.`));
    }
    // Legacy/lazy models.load callers may carry only a model string, so deriving
    // from that string alone unconditionally overwrote the live engine —
    // and discarded an explicit user pin whenever inference fell through to
    // Ollama. Catalog-backed callers add validated engine provenance instead.
    const inferredEngineType = inferEngineTypeFromModel(requestedModelName);
    const requestedEngineType = loadRequest.engineType || resolveRequestedEngineType(
      service.configService?.getState?.()?.preferredEngineType,
      requestedModelName
    );
    if (loadRequest.engineSource) {
      service._emitServiceLog?.('INFO', 'backend.model_load_engine_hint_used', {
        model: requestedModelName,
        requested_engine: requestedEngineType,
        inferred_engine: inferredEngineType,
        source: loadRequest.engineSource,
      });
    } else if (requestedEngineType !== inferredEngineType) {
      service._emitServiceLog?.('INFO', 'backend.model_load_engine_pin_kept', {
        model: requestedModelName,
        pinned_engine: requestedEngineType,
        inferred_engine: inferredEngineType,
      });
    }
    const manager = service.options?.getLlamaServerManager?.() || null;
    const managed = manager
      ? service.configService?.getLocalEngines?.()?.openaiCompatible?.managed || null
      : null;
    const token = managedModelKey(requestedModelName);
    const perModel = managed?.perModel?.[token] || null;
    const managedLoad = requestedEngineType === 'openai-compatible'
      && Boolean(manager)
      && managed?.enabled === true
      && perModel?.engine === 'llama-server';
    const llamaServerStatus = (!managedLoad && manager) ? (manager.getStatus?.() || {}) : null;
    const stopsManagedServer = Boolean(llamaServerStatus)
      && (['ready', 'starting', 'crashed'].includes(llamaServerStatus.state)
        || Boolean(llamaServerStatus.lastError));
    // Starting or stopping llama-server takes the GPU over. Doing that under a live
    // response starves the engine still generating on it (2026-09-04: Ollama fell to
    // 2.58 t/s and its blocking HTTP calls then wedged the sidecar loop), so the
    // switch refuses rather than double-loading. The test is "is anyone ELSE
    // streaming": the chat path reaches loadModel from resolveModel, by which point
    // attachController has already put its own turn in activeStreams, so it passes
    // ownStreamId to exclude itself. It stays guarded against every OTHER session's
    // stream; models.load from the IPC excludes nothing, so any stream refuses it.
    const otherActiveStreams = countActiveStreamsExcluding(
      service.activeStreams,
      options.ownStreamId
    );
    if ((managedLoad || stopsManagedServer) && otherActiveStreams > 0) {
      service._emitServiceLog?.('WARN', 'backend.engine_switch_refused_stream_active', {
        active_stream_count: otherActiveStreams,
        model: requestedModelName,
      });
      throw Object.assign(
        new Error('Stop the active response before switching engines.'),
        {
          error_code: AI_ERROR_CODES.ENGINE_CONNECTION,
          category: 'model_busy',
          retryable: true,
        }
      );
    }
    if (managedLoad) {
      const previousModel = String(service.currentModel || '').trim();
      if (service.currentEngineType === 'ollama' && previousModel) {
        try {
          // sidecar-client.js:129 declares no parameter, so this tag is not sent; the sidecar
          // evicts the stack engine's bound model, which is previousModel during this switch.
          await service.sidecarClient.modelsUnload(previousModel);
          service._emitServiceLog?.('INFO', 'backend.engine_switch_unload', {
            from: 'ollama', model: previousModel,
          });
        } catch (error) {
          service._emitServiceLog?.('WARN', 'backend.engine_switch_unload_failed', {
            from: 'ollama', model: previousModel, message: String(error?.message || error),
          });
          if (error?.category === 'timeout' || error?.error_code === SIDECAR_ERROR_CODES.TIMEOUT) {
            throw Object.assign(
              new Error(
                `Previous model "${previousModel}" could not be confirmed evicted; `
                + 'the engine switch was aborted so the GPU is not double-loaded.'
              ),
              {
                error_code: AI_ERROR_CODES.ENGINE_CONNECTION,
                category: 'engine_switch_aborted',
                retryable: true,
              }
            );
          }
        }
      }
      const llamaStatus = await manager.ensureRunning({
        modelTag: requestedModelName,
        modelPath: perModel.modelPath,
        profileId: managed.profileId,
        mtp: perModel.mtp,
      });
      if (llamaStatus?.state !== 'ready') {
        throw new Error(
          `Could not start llama-server for "${requestedModelName}": ${llamaStatus?.lastError || llamaStatus?.state}`
        );
      }
    } else if (manager) {
      // Any other load (another engine or a user-run openai-compatible endpoint)
      // takes the GPU over: the managed server lives only while it is the active
      // engine. A parked launch failure is cleared too (health pill goes quiet).
      if (stopsManagedServer) {
        try {
          const stopped = await manager.stop();
          if (stopped?.lastError) {
            service._emitServiceLog?.('WARN', 'backend.engine_switch_stop_llama_server_failed', {
              to: requestedEngineType, message: String(stopped.lastError),
            });
          } else {
            service._emitServiceLog?.('INFO', 'backend.engine_switch_stop_llama_server', {
              to: requestedEngineType,
            });
          }
        } catch (error) {
          service._emitServiceLog?.('WARN', 'backend.engine_switch_stop_llama_server_failed', {
            to: requestedEngineType, message: String(error?.message || error),
          });
        }
      }
    }
    await service._initializeManagedSidecar({
      reason: 'model_load',
      requestedModel: requestedModelName,
      requestedEngineType,
    });
    await service.refreshStatusSnapshot().catch(() => null);

    const fallback = service._lastEngineFallback;
    if (fallback) {
      const reason = String(fallback.reason || 'Engine initialization failed');
      const requested = String(fallback.requested_engine || service.currentEngineType);
      service._emitServiceLog('WARN', 'backend.model_load_fallback', {
        requested_engine: requested,
        actual_engine: 'mock',
        reason,
        model: requestedModelName,
      });
      throw new Error(
        `Could not load ${requested} engine for model "${requestedModelName}": ${reason}`
      );
    }
    // Persist only a switch that actually took (pin + autostart/preflight tag).
    if (managedLoad) {
      service.configService?.updatePreferredEngineType?.('openai-compatible');
      service.configService?.updateManagedLlamaServer?.({
        lastUsedTag: token,
        perModel: { [token]: { ...perModel, tag: requestedModelName } },
      });
    } else if (manager && managed) {
      if (managed.lastUsedTag) {
        // Forget the boot autostart target so the next launch cannot reverse this.
        service.configService?.updateManagedLlamaServer?.({ lastUsedTag: '' });
      }
      if (requestedEngineType === 'ollama') {
        // Written even when no server was alive: a stale pin must not outlive the switch.
        service.configService?.updatePreferredEngineType?.('ollama');
      }
    }

    return { status: 'ok', model: service.currentModel };
}

function autoLoadDefaultModel(service) {
  const fallback = service._lastEngineFallback;
  if (fallback) {
    let applyPending;
    try {
      applyPending = service._providerRuntimeApplyPending?.(
        String(fallback.requested_engine || '')
      ) === true;
    } catch (_error) { applyPending = false; }
    if (applyPending) {
      service._emitServiceLog('INFO', 'backend.default_model_load_deferred', {
        model: service.defaultModel,
        requested_engine: fallback.requested_engine,
        message: String(fallback.reason || 'Engine initialization failed'),
      });
      return;
    }
    service._emitServiceLog('WARN', 'backend.default_model_load_failed', {
      model: service.defaultModel,
      message: String(fallback.reason || 'Engine initialization failed'),
    });
    return;
  }
  const activeModel = String(service.currentStatus?.model || '').trim();
  const activeEngine = String(service.currentStatus?.engine || '').trim();
  if (activeModel && activeEngine && activeEngine !== 'mock') {
    service.currentModel = activeModel;
    service.currentEngineType = activeEngine;
    service._emitServiceLog('INFO', 'backend.default_model_loaded', {
      model: activeModel,
      engine: activeEngine,
    });
    return;
  }
  const configuredDefaultModel = String(service.defaultModel || '').trim();
  if (!configuredDefaultModel) {
    return;
  }
  const requestedEngine = String(
    service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || configuredDefaultModel)
    || 'mock'
  ).trim().toLowerCase() || 'mock';
  service._emitServiceLog('INFO', 'backend.default_model_deferred', {
    model: configuredDefaultModel,
    engine: requestedEngine,
    reason: 'startup_lazy_load',
  });
}

async function unloadModel(service) {
    const status = service.sidecarManager.getStatus();
    if (service.sidecarClient && status.phase === 'ready') {
      await service.sidecarClient.modelsUnload();
    }
    service.currentModel = '';
    service._managedPendingModel = '';
    service.currentEngineType = inferEngineTypeFromModel(service.defaultModel || '');
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
    service._normalizeManagedReasoningEfforts();
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
