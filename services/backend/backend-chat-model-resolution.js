const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('./backend-config');
const { inferEngineTypeFromModel } = require('./backend-service-utils');
const { AI_ERROR_CODES } = require('./error-codes');

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
  await service.loadModel(
    engineType ? { model, engine_type: engineType } : model,
    { ownStreamId: options.ownStreamId }
  );
  service.currentModel = model;
  service._emitServiceLog('INFO', 'backend.model_lazy_load_completed', {
    requestedModel: model,
    reason,
  });
  return model;
}

async function resolveModel(service, preferredModel = '', preferredEngineType = '', ownStreamId = '') {
  const requestedModel = String(preferredModel || '').trim();
  if (requestedModel) {
    if (service.currentModel !== requestedModel) {
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

module.exports = { resolveModel };
