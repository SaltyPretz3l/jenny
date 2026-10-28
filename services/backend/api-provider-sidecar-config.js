'use strict';

// Sidecar handoff for user API-key providers (row 78). The descriptor and the
// resolved limits ride the initialize config; the key rides `secrets` only,
// only for the selected instance, and the sidecar sends it only to that
// instance's endpoint. Fail closed: hosted mode, the kill switch, Force local
// inference, an unknown or disabled model, or a store read error all omit the
// key and the engine falls back instead of reaching a provider.

const {
  buildProviderDescriptor,
  findInstance,
  normalizeApiProvidersConfig,
  parseNamespacedModelId,
} = require('./api-provider-config');
const { defaultApiProviderCatalog } = require('./api-provider-catalog');
const { resolveProviderModelLimits } = require('./api-provider-limits');
const { getApiProviderPreset } = require('./api-provider-presets');
const { registerExactSecret } = require('./exact-secret-redaction');

const API_PROVIDER_ENGINE_TYPE = 'api-provider';

function apiProvidersAvailable(service) {
  return service?.hostMode !== 'server' && service?.featureFlags?.api_providers !== false;
}

function forcedLocalInference(service) {
  try {
    return service.offlineIntelligenceService?.getMode?.() === 'local_only';
  } catch (_error) {
    return true;
  }
}

function readApiProvidersConfig(service) {
  const state = service?.configService?.getState?.() || {};
  return normalizeApiProvidersConfig(state.apiProviders);
}

// The instance and model a namespaced model id names, when both exist and the
// model is enabled; null otherwise.
function resolveApiProviderSelection(service, modelId) {
  if (!apiProvidersAvailable(service)) return null;
  const parsed = parseNamespacedModelId(modelId);
  if (!parsed) return null;
  const instance = findInstance(readApiProvidersConfig(service), parsed.instanceId);
  const enabled = instance?.models.some((model) => model.id === parsed.modelId && model.enabled);
  return enabled ? { instance, modelId: parsed.modelId } : null;
}

// Level 4 is the bundled models.dev snapshot, matched on the exact preset/model id.
function resolveSelectionLimits({ instance, modelId }, { catalog = defaultApiProviderCatalog() } = {}) {
  const preset = getApiProviderPreset(instance.presetId);
  return resolveProviderModelLimits({
    instance,
    modelId,
    presetRow: preset?.modelCatalog.find((row) => row.id === modelId) || null,
    providerRow: instance.discovery.rows.find((row) => row.id === modelId) || null,
    catalogRow: catalog.lookup(instance.presetId, modelId),
  });
}

// USD per million tokens from the snapshot, or null (custom endpoints, unlisted models).
function resolveSelectionCost({ instance, modelId }, { catalog = defaultApiProviderCatalog() } = {}) {
  return catalog.lookup(instance.presetId, modelId)?.costPerMtokUsd || null;
}

function buildApiProviderSidecarConfig(service, engineType, modelId) {
  if (engineType !== API_PROVIDER_ENGINE_TYPE) return {};
  const selection = resolveApiProviderSelection(service, modelId);
  if (!selection) return {};
  return {
    api_provider_descriptor: buildProviderDescriptor(selection.instance),
    api_provider_model_limits: resolveSelectionLimits(selection),
  };
}

function buildApiProviderSidecarSecrets(service, modelId) {
  if (service?.currentEngineType !== API_PROVIDER_ENGINE_TYPE || forcedLocalInference(service)) return {};
  const selection = resolveApiProviderSelection(service, modelId);
  if (!selection || selection.instance.authProfile === 'none') return {};
  let key;
  try {
    key = String(service.secureStore?.getModelProviderApiKey?.(selection.instance.id) || '').trim();
  } catch (error) {
    service._emitServiceLog?.('WARN', 'api_provider.key_read_failed', {
      errorName: String(error?.name || 'Error'),
      errorCode: String(error?.code || ''),
    });
    return {};
  }
  if (!key) return {};
  registerExactSecret(key);
  return { api_provider_key: key };
}

module.exports = {
  API_PROVIDER_ENGINE_TYPE,
  apiProvidersAvailable,
  buildApiProviderSidecarConfig,
  buildApiProviderSidecarSecrets,
  readApiProvidersConfig,
  resolveApiProviderSelection,
  resolveSelectionCost,
  resolveSelectionLimits,
};
