// Which model the managed sidecar boots with and which openai-compatible
// endpoint it talks to. Split out of managed-sidecar-config.js (the public
// entry point, which re-exports both resolvers).
const { managedServerAlias, ninferManagedOrigin } = require('./managed-server-owner');
const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
} = require('./backend-config');
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const {
  getConfiguredLocalOpenAICompatibleState,
  getHostedModelEndpoint,
} = require('./managed-sidecar-config-readers');

function resolveLastChatgptCatalogModel(service) {
  const lastModel = String(service.configService?.getState?.()?.lastChatgptModel || '').trim();
  if (!lastModel) {
    return '';
  }
  const models = service.chatgptModelCatalogService?.snapshot?.()?.models;
  return Array.isArray(models) && models.some((entry) => entry?.id === lastModel) ? lastModel : '';
}

function resolveManagedStartupModel(service, engineType, fallbackDefaultModel) {
  const pendingModel = String(service._managedPendingModel || '').trim();
  if (pendingModel) {
    return pendingModel;
  }
  const activeModel = String(service.currentModel || '').trim();
  if (activeModel) {
    return activeModel;
  }
  // Ollama loads models on demand, so never request the configured default
  // during startup initialization: booting unloaded keeps the observed phase
  // 'ready' (chat usable immediately) and the first prompt lazy-loads the
  // default via resolveModel. Requesting it here used to latch
  // model_unavailable whenever the engine was not up yet, locking the chat
  // behind a manual model load every session.
  // ChatGPT auth is a per-session OAuth token, not a model to preload. Boot
  // with the model of the last successful ChatGPT load only while the current
  // catalog still lists it (B13); otherwise boot unloaded exactly like ollama
  // and let the composer drive the first turn. A stale id is never sent.
  if (engineType === 'chatgpt') {
    return resolveLastChatgptCatalogModel(service);
  }
  if (engineType === 'ollama') {
    return '';
  }
  // If the configured default model belongs to a different engine than the
  // one being booted (e.g. preferredEngineType='openai-compatible' but the
  // persisted default is an Ollama-style tag), don't pass the mismatched
  // name to the sidecar — it would fail load_model and fall back to mock.
  // Boot the engine unloaded instead; the user picks a model in the UI.
  if (fallbackDefaultModel) {
    const inferredForFallback = inferEngineTypeFromModel(fallbackDefaultModel);
    if (inferredForFallback && inferredForFallback !== engineType) {
      return '';
    }
    return fallbackDefaultModel;
  }
  if (engineType === 'replay') {
    return 'replay-default';
  }
  return 'mock-v1';
}

function resolveManagedConfiguredModel(service) {
  const hostedEndpoint = getHostedModelEndpoint(service);
  if (hostedEndpoint?.model) {
    return String(hostedEndpoint.model).trim();
  }
  const engineType = service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel);
  // Only the endpoint that IS a managed server (llama-server or NInfer) takes
  // its alias; a user's own openai-compatible endpoint keeps the model it was
  // configured with (managed-server-owner.js).
  const managedAlias = engineType === 'openai-compatible'
    ? managedServerAlias(service, resolveOpenAICompatibleApiUrl(service))
    : '';
  if (managedAlias) {
    return managedAlias;
  }
  const configuredDefaultModel = String(service.defaultModel || '').trim();
  const inferredDefaultEngine = inferEngineTypeFromModel(configuredDefaultModel);
  const fallbackDefaultModel = (
    engineType === 'ollama'
    && configuredDefaultModel
    && inferredDefaultEngine !== 'ollama'
  )
    ? DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL
    : configuredDefaultModel;
  return resolveManagedStartupModel(service, engineType, fallbackDefaultModel);
}

// The api_url the sidecar's openai-compatible engine will talk to: a hosted
// endpoint wins, then a serving NInfer (its own port, while it is the active
// managed server), then an explicit endpoint, otherwise the configured port.
function resolveOpenAICompatibleApiUrl(service) {
  const hostedEndpoint = getHostedModelEndpoint(service);
  if (hostedEndpoint?.engine === 'openai-compatible' && hostedEndpoint.apiUrl) {
    return String(hostedEndpoint.apiUrl).trim();
  }
  const ninferOrigin = ninferManagedOrigin(service);
  if (ninferOrigin) {
    return ninferOrigin;
  }
  const openaiCompatState = getConfiguredLocalOpenAICompatibleState(service);
  const explicitUrl = typeof openaiCompatState?.apiUrl === 'string'
    ? openaiCompatState.apiUrl.trim()
    : '';
  if (explicitUrl) {
    return explicitUrl;
  }
  const port = Number(openaiCompatState?.port);
  return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${Math.trunc(port)}` : '';
}

module.exports = {
  resolveManagedConfiguredModel,
  resolveOpenAICompatibleApiUrl,
};
