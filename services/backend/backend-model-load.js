/* services/backend/backend-model-load.js - BackendService.loadModel() and the startup
 * default-model load: engine pin/hint resolution, the managed llama-server / NInfer switch with its
 * GPU and active-stream guards, and persisting the switch that took.
 *
 * Extracted from backend-runtime.js as a behavior-preserving move; backend-runtime.js
 * re-exports loadModel/autoLoadDefaultModel so existing callers keep their require path.
 */
const {
  inferEngineTypeFromModel,
  resolveRequestedEngineType,
} = require('./backend-service-utils');
const { managedModelKey, normalizePreferredEngineType: normalizeModelEngineType } = require('../shell-config-engines');
const {
  findNinferArtifactForModel, managedServerKindForModel, stopManagedServerOrAbort, ninferServerStops,
} = require('./ninfer-load-path');
const { t } = require('../i18n-main');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('./error-codes');
const {
  assertApiProviderUsable, persistApiProviderLoad,
} = require('./api-provider-runtime');


function refreshSetupReadinessAfterModelLoad(service) {
  if (service.setupService && typeof service.setupService.refreshReadiness === 'function') {
    Promise.resolve().then(() => service.setupService.refreshReadiness()).catch((error) => {
      service._emitServiceLog?.('WARN', 'setup.readiness_refresh_after_model_load_failed', {
        message: String(error?.message || error),
      });
    });
  }
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
    let requestedEngineType = loadRequest.engineType || resolveRequestedEngineType(
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
    // A managed llama-server / NInfer id never reaches `ollama pull` on a
    // derived engine (gate F27: the chat route fell back to the current engine
    // for a GGUF the backend list did not carry). An explicit request or a
    // validated catalog hint keeps its engine, as in the chat route: the same
    // tag can exist on Ollama too.
    const managedKind = loadRequest.engineSource
      ? '' : managedServerKindForModel(service, requestedModelName, { routing: true });
    if ((managedKind === 'llama-server' || managedKind === 'ninfer') && requestedEngineType !== 'openai-compatible') {
      service._emitServiceLog?.('INFO', 'backend.model_load_engine_hint_overridden', {
        model: requestedModelName,
        requested_engine: requestedEngineType,
        managed_kind: managedKind,
        source: loadRequest.engineSource,
      });
      requestedEngineType = 'openai-compatible';
    }
    // Refuse before anything is switched or stopped: a missing key must not cost a running engine.
    if (requestedEngineType === 'api-provider') assertApiProviderUsable(service, requestedModelName);
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
      && (['ready', 'starting', 'stopping', 'crashed'].includes(llamaServerStatus.state)
        || Boolean(llamaServerStatus.lastError));
    // The managed NInfer runtime (row 54): its own artifact ids load through
    // its manager (which stops llama-server first); every other load stops it.
    const ninferManager = service.options?.getNinferManager?.() || null;
    const ninferArtifact = ninferManager && requestedEngineType === 'openai-compatible'
      ? findNinferArtifactForModel(service, requestedModelName) : null;
    const ninferLoad = Boolean(ninferArtifact);
    const stopsNinfer = !ninferLoad && ninferServerStops(ninferManager);
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
    // A privileged local workload owns the GPU (chat-gpu-handoff.js): a load
    // now would start an engine on a device that is about to be fully used.
    const admission = service.exclusiveGpuCoordinator?.getState?.();
    if (admission && admission.state !== 'chat_resident') {
      service._emitServiceLog?.('WARN', 'backend.model_load_refused_gpu_leased', {
        model: requestedModelName, admission: admission.state,
      });
      throw Object.assign(
        new Error(t('error.gpu.busyPrivilegedWorkload',
          'A privileged local workload is using the GPU. Wait for it to finish or cancel it.')),
        {
          error_code: AI_ERROR_CODES.ENGINE_CONNECTION,
          code: 'gpu_busy_plugin',
          category: 'model_busy',
          retryable: true,
        }
      );
    }
    if ((managedLoad || stopsManagedServer || ninferLoad || stopsNinfer) && otherActiveStreams > 0) {
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
    if (managedLoad || ninferLoad) {
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
          const timedOut = error?.category === 'timeout' || error?.error_code === SIDECAR_ERROR_CODES.TIMEOUT;
          // Only a daemon that is positively down (its port refuses the
          // connection) has nothing to evict; any other failure, a hung daemon
          // included, may leave the old model on the GPU.
          let daemonDown = false;
          if (!timedOut) {
            try {
              daemonDown = (await service.ollamaManager?.isConfirmedDown?.()) === true;
            } catch (_probeError) { /* an unanswered probe proves nothing */ }
          }
          if (daemonDown) {
            service._emitServiceLog?.('WARN', 'backend.engine_switch_unload_skipped_daemon_unreachable', {
              from: 'ollama', model: previousModel,
            });
          } else {
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
      if (ninferLoad) {
        const ninferStatus = await ninferManager.ensureRunning({ artifactId: ninferArtifact.id });
        if (ninferStatus?.state !== 'ready') {
          throw Object.assign(
            new Error(`Could not start NInfer for "${requestedModelName}": ${ninferStatus?.lastError || ninferStatus?.state}`),
            { ninfer_status: ninferStatus || null }
          );
        }
      } else {
        // llama-server's launch gate refuses while NInfer is up: stop it with proof first.
        if (stopsNinfer) await stopManagedServerOrAbort(service, ninferManager, 'ninfer', requestedEngineType);
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
      }
    } else {
      // Any other load (another engine or a user-run openai-compatible endpoint)
      // takes the GPU over: a managed server lives only while it is the active
      // engine. A parked launch failure is cleared too (health pill goes quiet).
      if (stopsManagedServer) await stopManagedServerOrAbort(service, manager, 'llama_server', requestedEngineType);
      if (stopsNinfer) await stopManagedServerOrAbort(service, ninferManager, 'ninfer', requestedEngineType);
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
    // The two managed boot targets are mutually exclusive: a load on either
    // managed server clears the other's.
    const ninferSettings = ninferManager ? service.configService?.getLocalEngines?.()?.ninfer || null : null;
    if (ninferLoad) {
      service.configService?.updatePreferredEngineType?.('openai-compatible');
      service.configService?.updateNinferSettings?.({ lastUsedArtifactId: ninferArtifact.id });
      if (managed?.lastUsedTag) service.configService?.updateManagedLlamaServer?.({ lastUsedTag: '' });
    } else if (ninferSettings?.lastUsedArtifactId) {
      service.configService?.updateNinferSettings?.({ lastUsedArtifactId: '' });
    }
    if (managedLoad) {
      // Re-read the entry: the launch takes seconds, and Tune can change it (a
      // build picked or cleared, the engine moved to Ollama) or remove the model
      // meanwhile. Writing the snapshot back would undo that, or bring a removed
      // model back as the boot autostart target.
      const latest = service.configService?.getLocalEngines?.()?.openaiCompatible?.managed?.perModel?.[token];
      if (latest?.engine === 'llama-server') {
        service.configService?.updatePreferredEngineType?.('openai-compatible');
        service.configService?.updateManagedLlamaServer?.({
          lastUsedTag: token,
          perModel: { [token]: { ...latest, tag: requestedModelName } },
        });
      } else if (service.configService?.getLocalEngines?.()?.openaiCompatible?.managed?.lastUsedTag
        === managed.lastUsedTag) {
        // No boot target at all: an earlier model must not start in its place.
        // A Use that finished meanwhile (a chat send can load a model while this
        // one initialized) recorded its own target, and keeps it.
        service.configService?.updateManagedLlamaServer?.({ lastUsedTag: '' });
      }
    } else if (manager && managed && !ninferLoad) {
      if (managed.lastUsedTag) {
        // Forget the boot autostart target so the next launch cannot reverse this.
        service.configService?.updateManagedLlamaServer?.({ lastUsedTag: '' });
      }
      if (requestedEngineType === 'ollama') {
        // Written even when no server was alive: a stale pin must not outlive the switch.
        service.configService?.updatePreferredEngineType?.('ollama');
      }
    }
    if (requestedEngineType === 'chatgpt') {
      // The next start boots ChatGPT with this model while the catalog still
      // lists it (B13). Loads on any other engine leave it alone. It is a
      // startup hint: a config write that fails must not fail a load that took.
      try {
        service.configService?.updateLastChatgptModel?.(requestedModelName);
      } catch (error) {
        service._emitServiceLog?.('WARN', 'backend.last_chatgpt_model_save_failed', {
          message: String(error?.message || error).slice(0, 200),
        });
      }
    }

    if (requestedEngineType === 'api-provider') persistApiProviderLoad(service, requestedModelName);

    refreshSetupReadinessAfterModelLoad(service);
    return { status: 'ok', model: service.currentModel };
}

function autoLoadDefaultModel(service) {
  const fallback = service._lastEngineFallback;
  if (fallback) {
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
    refreshSetupReadinessAfterModelLoad(service);
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
  const startupModelLoad = service.configService?.getLocalEngines?.()?.startupModelLoad !== false;
  if (startupModelLoad && requestedEngine === 'ollama') {
    service._emitServiceLog('INFO', 'backend.default_model_startup_load', {
      model: configuredDefaultModel,
      engine: requestedEngine,
    });
    service.loadModel(configuredDefaultModel).catch((error) => {
      service._emitServiceLog('WARN', 'backend.default_model_startup_load_failed', {
        model: configuredDefaultModel,
        engine: requestedEngine,
        message: String(error?.message || error),
      });
    });
    return;
  }
  service._emitServiceLog('INFO', 'backend.default_model_deferred', {
    model: configuredDefaultModel,
    engine: requestedEngine,
    reason: 'startup_lazy_load',
  });
}

module.exports = {
  loadModel,
  autoLoadDefaultModel,
};
