const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('./backend-config');
const { inferEngineTypeFromModel } = require('./backend-service-utils');
const { AI_ERROR_CODES } = require('./error-codes');
const { managedServerKindForModel } = require('./ninfer-load-path');

const CLOUD_ENGINE_TYPES = new Set(['chatgpt', 'codex-cli', 'api-provider']);

// A chat on "Default" (empty preferred_model) runs on the Settings default for
// local inference (Model Library), not on whatever local model another chat
// loaded last. Only a model the catalog lists or a managed server can serve
// counts (the catalog lists one engine family at a time), and a cloud engine
// keeps its own model; otherwise '' keeps the loaded-model fallback.
// Hosted servers pin their own model. Mirrored by the renderer's picker label.
function resolveDefaultChatModel(service) {
  if (!service || service.hostMode === 'server') return '';
  if (CLOUD_ENGINE_TYPES.has(String(service.currentEngineType || '').trim().toLowerCase())) return '';
  const model = String(service.offlineIntelligenceService?.getPreferredLocalModel?.() || '').trim();
  if (!model) return '';
  if (model === String(service.currentModel || '').trim() || service._modelEngineHints?.get?.(model)) return model;
  return managedServerKindForModel(service, model, { routing: true }) ? model : '';
}

function resolveManagedDefaultModel(service) {
  const activeEngineType = String(service.currentEngineType || '').trim().toLowerCase();
  const configuredDefaultModel = String(service.defaultModel || '').trim();
  if (!configuredDefaultModel) {
    return activeEngineType === 'ollama'
      ? DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL
      : DEFAULT_MANAGED_SHELL_MODEL;
  }
  const inferredDefaultEngine = inferEngineTypeFromModel(configuredDefaultModel);
  if (activeEngineType === 'ollama' && inferredDefaultEngine !== 'ollama') {
    return DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL;
  }
  return configuredDefaultModel;
}

async function loadManagedDefaultModel(service, model, reason, options = {}) {
  const engineType = String(options.engineType || '');
  service._emitServiceLog('INFO', 'backend.model_lazy_load_started', {
    requestedModel: model,
    reason,
  });
  const load = () => service.loadModel(
    engineType ? { model, engine_type: engineType } : model,
    { ownStreamId: options.ownStreamId }
  );
  try {
    await load();
  } catch (error) {
    // Another load holds the runtime (a Settings load, a refresh): wait for it
    // once and retry, instead of failing the turn as "model busy".
    const flight = service._managedInitializeFlight;
    if (error?.category !== 'model_busy' || !flight) throw error;
    await flight.promise.catch(() => null);
    await load();
  }
  service.currentModel = model;
  service._emitServiceLog('INFO', 'backend.model_lazy_load_completed', {
    requestedModel: model,
    reason,
  });
  return model;
}

// A chat's model must be one the catalog carries before anything is switched: an id no engine lists
// (a spawned chat on the short alias `ornith15:9b`, 2026-10-27) otherwise took the current engine,
// stopped NInfer and failed against an unrelated endpoint. Checked against one fresh catalog read;
// it fails open when that read fails or carries nothing for the engine family the turn would load
// on, so a startup race or an unreachable user server never refuses a chat. Kill switch:
// JENNY_ENABLE_MODEL_CATALOG_GUARD=0.
async function assertModelInstalled(service, model, preferredEngineType) {
  if (service.featureFlags?.model_catalog_guard === false || service.hostMode === 'server') return;
  const known = () => Boolean(service._modelEngineHints?.get?.(model));
  const inferred = inferEngineTypeFromModel(model);
  const family = String(preferredEngineType || '').trim().toLowerCase() || inferred;
  if (known() || CLOUD_ENGINE_TYPES.has(inferred) || CLOUD_ENGINE_TYPES.has(family)) return;
  if (managedServerKindForModel(service, model, { routing: true })) return;
  let listing;
  try { listing = await service.listModels(); } catch { return; }
  const entries = Array.isArray(listing?.data) ? listing.data : [];
  if (known() || entries.some((entry) => entry?.id === model)) return;
  if (listing?.primary_available === false || !entries.some((entry) => entry?.engine_type === family)) return;
  service._emitServiceLog?.('WARN', 'backend.model_not_installed', { model, engine: family });
  throw Object.assign(
    new Error(`Model "${model}" is not installed. Choose an installed model for this chat.`),
    { error_code: AI_ERROR_CODES.ENGINE_CONNECTION, category: 'model_unavailable', retryable: false }
  );
}

async function resolveModel(service, preferredModel = '', preferredEngineType = '', ownStreamId = '') {
  const requestedModel = String(preferredModel || '').trim();
  if (requestedModel) {
    if (service.currentModel !== requestedModel) {
      await assertModelInstalled(service, requestedModel, preferredEngineType);
      await loadManagedDefaultModel(service, requestedModel, 'preferred_model', {
        engineType: preferredEngineType, ownStreamId,
      });
    }
    service.currentModel = requestedModel;
    return requestedModel;
  }
  if (service.currentModel) return service.currentModel;
  if (service._modelLifecycle?.state === 'unavailable') {
    // A previous load latched 'unavailable' (engine down, model missing).
    // Retry the configured default on this turn instead of demanding a
    // manual load — the engine may be back by now, and a failed retry
    // simply re-latches and surfaces on the turn as a terminal error.
    const retryModel = resolveManagedDefaultModel(service);
    if (retryModel) {
      return await loadManagedDefaultModel(service, retryModel, 'model_unavailable_retry', { ownStreamId });
    }
    throw Object.assign(
      new Error('The configured model is unavailable. Load a model to continue.'),
      { error_code: AI_ERROR_CODES.ENGINE_CONNECTION, category: 'model_unavailable', retryable: true }
    );
  }

  try {
    const models = await service.listModels();
    if (models.active_model) {
      service.currentModel = String(models.active_model);
      return service.currentModel;
    }
    const managedDefaultModel = resolveManagedDefaultModel(service);
    if (managedDefaultModel) {
      return await loadManagedDefaultModel(service, managedDefaultModel, 'shell_default_model', { ownStreamId });
    }
    if (Array.isArray(models.data) && models.data[0]?.id) {
      service.currentModel = String(models.data[0].id);
      return service.currentModel;
    }
  } catch (error) {
    if (service._modelLifecycle?.state === 'unavailable') throw error;
    const managedDefaultModel = resolveManagedDefaultModel(service);
    if (managedDefaultModel) {
      return await loadManagedDefaultModel(
        service,
        managedDefaultModel,
        'shell_default_model_after_model_probe_failure',
        { ownStreamId }
      );
    }
  }

  const status = await service.refreshStatusSnapshot().catch(() => null);
  if (status?.model) {
    service.currentModel = String(status.model);
    return service.currentModel;
  }
  throw new Error('No model is available for chat.');
}

module.exports = { resolveDefaultChatModel, resolveModel };
