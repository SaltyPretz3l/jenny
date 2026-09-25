const {
  inferEngineTypeFromModel,
  getManagedReasoningEffortSupport,
  normalizeManagedReasoningEffort,
  normalizeModelCapabilities,
} = require('./backend-service-utils');
const { normalizeReasoningEffortForModel } = require('../../reasoning-effort-profiles');

// The catalog's engine for a listed model, then the running backend's for the
// model it serves; a bare llama-server alias would otherwise infer as Ollama.
function resolveModelEngineType(service, model) {
  const hinted = String(service._modelEngineHints?.get?.(model) || '').trim().toLowerCase();
  if (hinted) return hinted;
  const current = String(service.currentStatus?.engine || service.currentEngineType || '').trim().toLowerCase();
  const active = String(service.currentStatus?.model || service.currentModel || '').trim();
  return current && active === model ? current : inferEngineTypeFromModel(model);
}

function getManagedReasoningSupportForModel(service, preferredModel = '', requestedEngine = '') {
  const configuredModel = String(preferredModel || '').trim();
  const providerCapabilities =
    service.currentStatus?.provider_capabilities
    && typeof service.currentStatus.provider_capabilities === 'object'
    && !Array.isArray(service.currentStatus.provider_capabilities)
      ? service.currentStatus.provider_capabilities
      : {};
  const explicitEngine = String(requestedEngine || '').trim().toLowerCase();
  const engineType = explicitEngine || configuredModel
    ? resolveModelEngineType(service, configuredModel)
    : String(
    service.currentStatus?.engine
    || service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel || '')
    || 'mock'
    ).trim().toLowerCase() || 'mock';
  const activeModelCapabilities = normalizeModelCapabilities(
    configuredModel && String(service.currentStatus?.model || '').trim() !== configuredModel
      ? {}
      : service.currentStatus?.active_model_capabilities
  );
  const localRuntime = configuredModel && String(service.currentStatus?.model || '').trim() !== configuredModel
    ? null
    : service.currentStatus?.local_runtime;
  const fallback = service.currentStatus?.engine_fallback;
  const fallbackRequestedEngine = String(fallback?.requested_engine || '').trim().toLowerCase();
  const fallbackModel = String(service.currentModel || '').trim();
  if (
    fallbackRequestedEngine
    && fallbackRequestedEngine === engineType
    && (
      !configuredModel
      || !fallbackModel
      || fallbackModel === configuredModel
    )
  ) {
    return 'unsupported';
  }
  return getManagedReasoningEffortSupport(engineType, providerCapabilities, {
    activeModelCapabilities,
    modelId: configuredModel || fallbackModel || service.defaultModel,
    localRuntime,
  });
}

// The catalog entry the composer picker built its effort options from.
function findCatalogEntry(service, modelId, engineType) {
  const entries = service._modelListLastResult?.value?.data;
  if (!modelId || !Array.isArray(entries)) return null;
  return entries.find((entry) => String(entry?.id || '').trim() === modelId
    && (!entry.engine_type || String(entry.engine_type).trim().toLowerCase() === engineType)) || null;
}

// The effort one outgoing request carries: the stored choice clamped to the
// turn's model and engine. Never persisted (gate C4 F5).
function resolveRequestReasoningEffort(service, reasoningEffort, requestedModel = '', requestedEngine = '') {
  const preferredModel = String(requestedModel || '').trim();
  const activeModel = String(
    service.currentStatus?.model
    || service.currentModel
    || service.defaultModel
    || ''
  ).trim();
  const effectiveModel = preferredModel || activeModel;
  const explicitEngine = String(requestedEngine || '').trim().toLowerCase();
  const engineType = explicitEngine || (preferredModel
    ? resolveModelEngineType(service, preferredModel)
    : String(
      service.currentStatus?.engine
      || service.currentEngineType
      || inferEngineTypeFromModel(service.currentModel || service.defaultModel || '')
      || 'mock'
    ).trim().toLowerCase() || 'mock');
  const clamped = normalizeManagedReasoningEffort(
    reasoningEffort,
    engineType,
    getManagedReasoningSupportForModel(service, preferredModel, explicitEngine) === 'unsupported'
      ? {}
      : service.currentStatus?.provider_capabilities,
    {
      activeModelCapabilities:
        preferredModel && String(service.currentStatus?.model || '').trim() !== preferredModel
          ? {}
          : service.currentStatus?.active_model_capabilities,
      modelId: effectiveModel,
      localRuntime:
        preferredModel && String(service.currentStatus?.model || '').trim() !== preferredModel
          ? null
          : service.currentStatus?.local_runtime,
    }
  );
  // A declared ladder (e.g. Bonsai: none/medium/xhigh) is what the picker
  // shows; an effort outside it runs as Automatic, as the picker says.
  const capabilities = findCatalogEntry(service, effectiveModel, engineType)?.capabilities;
  return clamped === 'default' || !Array.isArray(capabilities?.reasoning_efforts)
    ? clamped
    : normalizeReasoningEffortForModel(clamped, effectiveModel, capabilities);
}

function buildRequestReasoningEffortField(service, reasoningEffort, requestedModel = '', requestedEngine = '') {
  const resolved = resolveRequestReasoningEffort(service, reasoningEffort, requestedModel, requestedEngine);
  return resolved === 'default' ? {} : { reasoning_effort: resolved };
}

module.exports = {
  buildRequestReasoningEffortField,
  getManagedReasoningSupportForModel,
  resolveRequestReasoningEffort,
};
