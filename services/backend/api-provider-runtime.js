'use strict';

// Runtime seams for user API-key providers (row 78): the model-list entries,
// the load/admission refusals and the session-route identity. The key itself
// is never read here; only its presence is probed.

const { AI_ERROR_CODES } = require('./error-codes');
const { enabledModels, namespacedModelId, parseNamespacedModelId } = require('./api-provider-config');
const { limitsAreUnknown } = require('./api-provider-limits');
const {
  API_PROVIDER_ENGINE_TYPE,
  apiProvidersAvailable,
  readApiProvidersConfig,
  resolveApiProviderSelection,
  resolveSelectionLimits,
} = require('./api-provider-sidecar-config');

// Fail closed: a missing store, a store that is not ready, or a throw all read as no key.
function instanceHasKey(service, instance) {
  if (instance.authProfile === 'none') return true;
  try {
    return service?.secureStore?.hasModelProviderApiKey?.(instance.id) === true;
  } catch (_error) {
    return false;
  }
}

function buildApiProviderModelEntries(service) {
  if (!apiProvidersAvailable(service)) return [];
  const entries = [];
  for (const instance of readApiProvidersConfig(service).instances) {
    const hasKey = instanceHasKey(service, instance);
    for (const model of enabledModels(instance)) {
      const limits = resolveSelectionLimits({ instance, modelId: model.id });
      entries.push({
        id: namespacedModelId(instance.id, model.id),
        label: model.id,
        provider: instance.label,
        engine_type: API_PROVIDER_ENGINE_TYPE,
        available: true,
        contextLength: limits.context_length,
        capabilities: {
          tools: limits.tools,
          vision: limits.vision,
          reasoning: limits.reasoning,
          thinking: limits.reasoning,
        },
        apiProviderInstanceId: instance.id,
        apiProviderModelId: model.id,
        limitsUnknown: limitsAreUnknown(limits),
        hasKey,
      });
    }
  }
  return entries;
}

// The generic list normalizer drops the extra fields, so these rows are
// swapped in after it has run.
function withApiProviderEntries(service, data) {
  const others = (Array.isArray(data) ? data : []).filter((entry) => entry?.engine_type !== API_PROVIDER_ENGINE_TYPE);
  return [...others, ...buildApiProviderModelEntries(service)];
}

function apiProviderListPayload(service) {
  return {
    object: 'list',
    active_model: service.currentModel || '',
    engine_type: API_PROVIDER_ENGINE_TYPE,
    available: true,
    reason: '',
    data: buildApiProviderModelEntries(service),
  };
}

// Part of the model-list cache key: a key saved or a model toggled inside the
// TTL must not be served the list read before it.
function apiProviderCatalogKey(service) {
  return buildApiProviderModelEntries(service)
    .map((entry) => `${entry.id}:${entry.hasKey}:${entry.contextLength}`)
    .join('|');
}

function refusal(code, message) {
  return Object.assign(new Error(message), {
    code,
    error_code: AI_ERROR_CODES.ENGINE_CONNECTION,
    category: 'setup',
    retryable: false,
  });
}

// Throws the typed refusal; returns the resolved selection when the model may be used.
function assertApiProviderUsable(service, modelId) {
  if (!apiProvidersAvailable(service)) {
    throw refusal('api_providers_disabled', 'API-key providers are turned off.');
  }
  const selection = resolveApiProviderSelection(service, modelId);
  if (!selection) {
    throw refusal('api_provider_model_unavailable',
      'That provider model is not available. Enable it in Settings > Models.');
  }
  if (!instanceHasKey(service, selection.instance)) {
    throw refusal('api_provider_key_missing',
      `Add an API key for ${selection.instance.label} in Settings > Models.`);
  }
  return selection;
}

// Re-checked per turn: the config or key may have changed since the model loaded.
// The turn's own model is not on the route, so the per-model checks run only when the
// running engine is already on an api-provider model; a lazy switch is validated by loadModel.
function assertApiProviderAdmissible(service, route = null) {
  const engineType = String((route ? route.engine_type : service.currentEngineType) || '').trim().toLowerCase();
  if (engineType !== API_PROVIDER_ENGINE_TYPE) return;
  const model = String(service.currentModel || '');
  if (service.currentEngineType === API_PROVIDER_ENGINE_TYPE && parseNamespacedModelId(model)) {
    const selection = assertApiProviderUsable(service, model);
    // Backstop for the renderer's first-send notice: no turn reaches a provider before it was acknowledged.
    if (!selection.instance.noticeAcknowledgedAt) {
      throw refusal('api_provider_notice_required',
        `Confirm sending to ${selection.instance.label} first: send a message from Composer.`);
    }
  } else if (!apiProvidersAvailable(service)) {
    throw refusal('api_providers_disabled', 'API-key providers are turned off.');
  }
}

// `turnModelId` is the turn's own model when the caller has one: a Composer pick is a
// lazy switch, so the running engine may still be on another model at admission.
function selectedApiProvider(service, turnModelId = null) {
  return resolveApiProviderSelection(service, String(turnModelId || service?.currentModel || ''));
}

// What the session route revision hashes: connection and model, never the key.
function apiProviderRouteIdentity(service, turnModelId = null) {
  const selection = selectedApiProvider(service, turnModelId);
  const base = { engine_type: API_PROVIDER_ENGINE_TYPE, available: apiProvidersAvailable(service) };
  if (!selection) return { ...base, provider: null };
  const { instance, modelId } = selection;
  return {
    ...base,
    provider: {
      id: instance.id,
      model_id: modelId,
      endpoint: instance.endpoint,
      transport: instance.transport,
      auth_profile: instance.authProfile,
      token_limit_field: instance.tokenLimitField,
      headers: instance.headers.map((header) => ({ name: header.name, value: header.value })),
      limits: resolveSelectionLimits(selection),
    },
  };
}

function apiProviderCredentialState(service, turnModelId = null) {
  const selection = selectedApiProvider(service, turnModelId);
  if (!selection) return Object.freeze({ required: true, available: false, revision: 'unavailable' });
  if (selection.instance.authProfile === 'none') {
    return Object.freeze({ required: false, available: true, revision: 'none' });
  }
  const available = instanceHasKey(service, selection.instance);
  return Object.freeze({ required: true, available, revision: available ? 'present' : 'unavailable' });
}

// Records the model as the config's lastSelected. A hint only: a config write that
// fails must not fail a load that took.
function persistApiProviderLoad(service, modelId) {
  try {
    const selection = resolveApiProviderSelection(service, modelId);
    const config = readApiProvidersConfig(service);
    const last = config.lastSelected;
    if (!selection || (last?.instanceId === selection.instance.id && last?.modelId === selection.modelId)) return;
    service.configService?.updateApiProviders?.({
      ...config,
      lastSelected: { instanceId: selection.instance.id, modelId: selection.modelId },
    });
  } catch (error) {
    service._emitServiceLog?.('WARN', 'backend.last_api_provider_model_save_failed', {
      message: String(error?.message || error).slice(0, 200),
    });
  }
}

module.exports = {
  apiProviderCatalogKey,
  apiProviderCredentialState,
  apiProviderListPayload,
  apiProviderRouteIdentity,
  assertApiProviderAdmissible,
  assertApiProviderUsable,
  buildApiProviderModelEntries,
  persistApiProviderLoad,
  withApiProviderEntries,
};
