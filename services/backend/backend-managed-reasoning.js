const {
  inferEngineTypeFromModel,
  getManagedReasoningEffortSupport,
  normalizeManagedReasoningEffort,
  normalizeModelCapabilities,
} = require('./backend-service-utils');

function getManagedReasoningSupportForModel(service, preferredModel = '') {
  const configuredModel = String(preferredModel || '').trim();
  const providerCapabilities =
    service.currentStatus?.provider_capabilities
    && typeof service.currentStatus.provider_capabilities === 'object'
    && !Array.isArray(service.currentStatus.provider_capabilities)
      ? service.currentStatus.provider_capabilities
      : {};
  const engineType = configuredModel
    ? inferEngineTypeFromModel(configuredModel)
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

function normalizeManagedSessionPreferencePatch(service, preferences = {}, sessionId = '') {
  if (!preferences || typeof preferences !== 'object') {
    return preferences;
  }
  const patch = { ...preferences };
  const existing =
    (sessionId ? service.sessionStore.getSession(sessionId) : null)
    || (sessionId ? service.shadowStore.getSession(sessionId) : null)
    || null;
  const preferredModel = Object.prototype.hasOwnProperty.call(patch, 'preferred_model')
    ? String(patch.preferred_model || '').trim()
    : String(existing?.preferred_model || '').trim();
  const activeModel = String(
    service.currentStatus?.model
    || service.currentModel
    || service.defaultModel
    || ''
  ).trim();
  const effectiveModel = preferredModel || activeModel;
  if (
    Object.prototype.hasOwnProperty.call(patch, 'reasoning_effort')
    || String(existing?.reasoning_effort || '').trim()
  ) {
    const engineType = preferredModel
      ? inferEngineTypeFromModel(preferredModel)
      : String(
        service.currentStatus?.engine
        || service.currentEngineType
        || inferEngineTypeFromModel(service.currentModel || service.defaultModel || '')
        || 'mock'
      ).trim().toLowerCase() || 'mock';
    patch.reasoning_effort = normalizeManagedReasoningEffort(
      Object.prototype.hasOwnProperty.call(patch, 'reasoning_effort')
        ? patch.reasoning_effort
        : existing?.reasoning_effort,
      engineType,
      getManagedReasoningSupportForModel(service, preferredModel) === 'unsupported'
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
  }
  return patch;
}

function normalizeManagedReasoningEfforts(service) {
  for (const session of service.sessionStore.listSessions()) {
    const normalizedPatch = normalizeManagedSessionPreferencePatch(service, {
      preferred_model: session.preferred_model,
      reasoning_effort: session.reasoning_effort,
    }, session.id);
    if (normalizedPatch.reasoning_effort !== session.reasoning_effort) {
      service.sessionStore.setSessionPreferences(session.id, {
        reasoning_effort: normalizedPatch.reasoning_effort,
      });
    }
  }

  const shadowSessions = service.shadowStore.summarize();
  for (const [sessionId, session] of Object.entries(shadowSessions || {})) {
    const normalizedPatch = normalizeManagedSessionPreferencePatch(service, {
      preferred_model: session?.preferred_model,
      reasoning_effort: session?.reasoning_effort,
    }, sessionId);
    if (normalizedPatch.reasoning_effort !== session?.reasoning_effort) {
      service.shadowStore.setSessionPreferences(sessionId, {
        reasoning_effort: normalizedPatch.reasoning_effort,
      });
    }
  }
}

module.exports = {
  getManagedReasoningSupportForModel,
  normalizeManagedSessionPreferencePatch,
  normalizeManagedReasoningEfforts,
};
