'use strict';

// Main-process owner of the apiProviders.* IPC (row 78). The renderer sees
// provider instances, resolved limits and a per-instance `hasKey` boolean; a
// key goes in through the write-only setKey and never comes back out. Every
// mutation is serialized, re-normalized and written through
// shellConfigService.updateApiProviders. A change to the instance the active
// engine uses re-initializes the sidecar so the next turn runs on it.

const {
  MAX_INSTANCES,
  enabledModels,
  findInstance,
  generateInstanceId,
  normalizeApiProvidersConfig,
  parseNamespacedModelId,
  validModelId,
} = require('./api-provider-config');
const { fetchModelListing } = require('./api-provider-discovery');
const { validateProviderEndpoint } = require('./api-provider-endpoint');
const { limitsAreUnknown } = require('./api-provider-limits');
const {
  API_PROVIDER_PRESETS,
  API_PROVIDER_TRANSPORT_AUTH,
  CUSTOM_ENDPOINT_PRESET_ID,
  getApiProviderPreset,
} = require('./api-provider-presets');
const {
  API_PROVIDER_ENGINE_TYPE,
  apiProvidersAvailable,
  resolveSelectionCost,
  resolveSelectionLimits,
} = require('./api-provider-sidecar-config');
const { registerExactSecret } = require('./exact-secret-redaction');

const MAX_KEY_CHARS = 4096;
// A key is one token: no whitespace, no control characters.
const KEY_RE = /^[\x21-\x7e]+$/;

const failure = (code) => ({ ok: false, code });

// The enable list is every model the user touched plus every discovered row,
// each with its resolved limits, so Settings can show what a toggle would give.
function listedModels(instance) {
  const listed = new Map(instance.models.map((model) => [model.id, model]));
  for (const row of instance.discovery.rows) {
    if (!listed.has(row.id)) listed.set(row.id, { id: row.id, enabled: false, pin: {} });
  }
  return [...listed.values()];
}

function publicInstance(instance, hasKey) {
  const discoveredIds = new Set(instance.discovery.rows.map((row) => row.id));
  return {
    id: instance.id,
    presetId: instance.presetId,
    label: instance.label,
    endpoint: instance.endpoint,
    transport: instance.transport,
    authProfile: instance.authProfile,
    tokenLimitField: instance.tokenLimitField,
    hasKey,
    noticeAcknowledgedAt: instance.noticeAcknowledgedAt,
    models: listedModels(instance).map((model) => {
      const selection = { instance, modelId: model.id };
      const limits = resolveSelectionLimits(selection);
      return {
        ...model,
        discovered: discoveredIds.has(model.id),
        limits,
        limitsUnknown: limitsAreUnknown(limits),
        costPerMtokUsd: resolveSelectionCost(selection),
      };
    }),
    discovery: {
      fetchedAt: instance.discovery.fetchedAt,
      error: instance.discovery.error,
      rows: instance.discovery.rows,
    },
  };
}

function createApiProviderService({
  shellConfigService,
  secureStore,
  backendService = null,
  sendBridgeEvent = () => {},
  fetchImpl = globalThis.fetch,
  lookup,
  nowProvider = () => new Date(),
  log = () => {},
} = {}) {
  let chain = Promise.resolve();
  const service = () => backendService || { hostMode: shellConfigService?.hostMode, featureFlags: {} };
  const available = () => apiProvidersAvailable(service());
  const readConfig = () => normalizeApiProvidersConfig(shellConfigService?.getState?.()?.apiProviders);

  function hasKey(instance) {
    if (instance.authProfile === 'none') return false;
    try {
      return secureStore?.hasModelProviderApiKey?.(instance.id) === true;
    } catch (_error) {
      return false;
    }
  }

  function getState() {
    const enabled = available();
    const config = enabled ? readConfig() : { instances: [], lastSelected: null };
    return {
      enabled,
      localOnly: shellConfigService?.getState?.()?.offlineIntelligence?.mode === 'local_only',
      presets: API_PROVIDER_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        keyHelpHost: preset.keyHelpHost,
        recommendedModel: preset.recommendedModel,
      })),
      maxInstances: MAX_INSTANCES,
      instances: config.instances.map((instance) => publicInstance(instance, hasKey(instance))),
      lastSelected: config.lastSelected,
    };
  }

  function pushState() {
    sendBridgeEvent('apiProviders.onChanged', getState());
  }

  // The active engine runs on this instance (and, for a per-model change, on that model):
  // re-initialize so it picks up the change. Other edits never restart the running engine.
  function reinitIfActive(instanceId, reason, modelId = null) {
    const backend = backendService;
    if (backend?.currentEngineType !== API_PROVIDER_ENGINE_TYPE) return;
    const active = parseNamespacedModelId(backend.currentModel);
    if (active?.instanceId !== instanceId) return;
    if (modelId !== null && active.modelId !== modelId) return;
    if (typeof backend.refreshManagedConfig !== 'function') return;
    Promise.resolve(backend.refreshManagedConfig(reason, { requestedEngineType: API_PROVIDER_ENGINE_TYPE }))
      .catch((error) => log('WARN', 'api_provider.reinit_failed', { errorName: String(error?.name || 'Error') }));
  }

  function writeConfig(config) {
    shellConfigService.updateApiProviders(config);
  }

  // Serializes every mutation; a throwing step reports a code, never a message.
  function mutate(work) {
    const run = chain.then(async () => {
      if (!available()) return failure('disabled');
      try {
        return await work();
      } catch (error) {
        log('WARN', 'api_provider.mutation_failed', {
          errorName: String(error?.name || 'Error'),
          errorCode: String(error?.code || error?.reason || ''),
        });
        return failure(error?.code === 'storage_unavailable' ? 'storage_unavailable' : 'write_failed');
      }
    });
    chain = run.catch(() => null);
    return run.then((result) => {
      pushState();
      return result;
    });
  }

  function withInstance(instanceId, work) {
    return mutate(() => {
      const config = readConfig();
      const instance = findInstance(config, instanceId);
      return instance ? work(config, instance) : failure('unknown_instance');
    });
  }

  async function buildCustomInstance(request, id) {
    const label = typeof request.label === 'string' ? request.label.trim() : '';
    if (!label || label.length > 64) return failure('invalid_label');
    const transport = request.transport === undefined ? 'openai_chat_completions_v1' : request.transport;
    if (!API_PROVIDER_TRANSPORT_AUTH[transport]?.includes(request.authProfile)) return failure('invalid_request');
    let endpoint;
    try {
      endpoint = await validateProviderEndpoint(request.endpoint, { lookup });
    } catch (_error) {
      return failure('invalid_endpoint');
    }
    return {
      id,
      presetId: null,
      label,
      endpoint,
      transport,
      authProfile: request.authProfile,
      tokenLimitField: request.tokenLimitField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
      headers: [],
      models: [],
    };
  }

  function addInstance(request = {}) {
    return mutate(async () => {
      const config = readConfig();
      if (config.instances.length >= MAX_INSTANCES) return failure('limit_reached');
      const presetId = String(request?.presetId || '');
      const preset = presetId === CUSTOM_ENDPOINT_PRESET_ID ? null : getApiProviderPreset(presetId);
      if (!preset && presetId !== CUSTOM_ENDPOINT_PRESET_ID) return failure('invalid_request');
      const ids = config.instances.map((instance) => instance.id);
      const id = generateInstanceId(preset ? preset.id : request.label, ids);
      const candidate = preset
        // The recommended model starts enabled: until a listing loads it is the one Composer offers.
        ? { id, presetId: preset.id, label: preset.label, models: [{ id: preset.recommendedModel, enabled: true }] }
        : await buildCustomInstance(request, id);
      if (candidate.ok === false) return candidate;
      const next = normalizeApiProvidersConfig({ ...config, instances: [...config.instances, candidate] });
      if (!findInstance(next, id)) return failure('invalid_request');
      writeConfig(next);
      return { ok: true, instanceId: id };
    });
  }

  function removeInstance(instanceId) {
    return withInstance(instanceId, (config) => {
      writeConfig({ ...config, instances: config.instances.filter((entry) => entry.id !== instanceId) });
      secureStore?.deleteModelProviderApiKey?.(instanceId);
      reinitIfActive(instanceId, 'api_provider_removed');
      return { ok: true };
    });
  }

  function renameInstance(instanceId, label) {
    return withInstance(instanceId, (config, instance) => {
      const text = typeof label === 'string' ? label.trim() : '';
      if (!text || text.length > 64) return failure('invalid_label');
      writeConfig({ ...config, instances: config.instances.map((entry) => (entry === instance ? { ...entry, label: text } : entry)) });
      return { ok: true };
    });
  }

  // Write-only: the key is validated, stored and registered for redaction; it
  // is never echoed, logged or returned.
  function setKey(instanceId, value) {
    return withInstance(instanceId, (_config, instance) => {
      if (instance.authProfile === 'none') return failure('invalid_request');
      const key = typeof value === 'string' ? value.trim() : '';
      if (!key || key.length > MAX_KEY_CHARS || !KEY_RE.test(key)) return failure('invalid_key');
      registerExactSecret(key);
      secureStore.setModelProviderApiKey(instanceId, key);
      reinitIfActive(instanceId, 'api_provider_key_updated');
      return { ok: true };
    });
  }

  function clearKey(instanceId) {
    return withInstance(instanceId, () => {
      secureStore.deleteModelProviderApiKey(instanceId);
      reinitIfActive(instanceId, 'api_provider_key_cleared');
      return { ok: true };
    });
  }

  function replaceInstance(config, instance, patch) {
    return { ...config, instances: config.instances.map((entry) => (entry === instance ? { ...entry, ...patch } : entry)) };
  }

  function discover(instanceId) {
    return withInstance(instanceId, async (_config, instance) => {
      const apiKey = instance.authProfile === 'none' ? '' : String(secureStore?.getModelProviderApiKey?.(instanceId) || '');
      const result = await fetchModelListing({
        endpoint: instance.endpoint,
        transport: instance.transport,
        authProfile: instance.authProfile,
        apiKey,
        headers: instance.headers,
        fetchImpl,
        lookup,
      });
      // Re-read: the instance may have changed while the listing was in flight.
      const latest = readConfig();
      const current = findInstance(latest, instanceId);
      if (!current) return failure('unknown_instance');
      const discovery = result.ok
        ? { fetchedAt: result.fetchedAt, rows: result.rows, error: null }
        : { ...current.discovery, error: result.error };
      writeConfig(replaceInstance(latest, current, { discovery }));
      if (result.ok) reinitIfActive(instanceId, 'api_provider_discovered');
      return result.ok ? { ok: true, count: result.rows.length } : { ok: false, code: result.error.code, status: result.error.status };
    });
  }

  function upsertModel(instance, modelId, update) {
    const models = instance.models.some((model) => model.id === modelId)
      ? instance.models.map((model) => (model.id === modelId ? update(model) : model))
      : [...instance.models, update({ id: modelId, enabled: false, pin: {} })];
    return models;
  }

  function setModelEnabled(instanceId, modelId, enabled) {
    return withInstance(instanceId, (config, instance) => {
      const id = validModelId(modelId);
      if (!id || typeof enabled !== 'boolean') return failure('invalid_model');
      if (enabled && enabledModels(instance).length >= 64 && !enabledModels(instance).some((model) => model.id === id)) {
        return failure('limit_reached');
      }
      writeConfig(replaceInstance(config, instance, { models: upsertModel(instance, id, (model) => ({ ...model, enabled })) }));
      reinitIfActive(instanceId, 'api_provider_models_updated', id);
      return { ok: true };
    });
  }

  function setModelPin(instanceId, modelId, pin) {
    return withInstance(instanceId, (config, instance) => {
      const id = validModelId(modelId);
      if (!id) return failure('invalid_model');
      const nextPin = pin && typeof pin === 'object'
        ? { contextLength: pin.contextLength, maxOutputTokens: pin.maxOutputTokens }
        : {};
      writeConfig(replaceInstance(config, instance, { models: upsertModel(instance, id, (model) => ({ ...model, pin: nextPin })) }));
      reinitIfActive(instanceId, 'api_provider_limits_updated', id);
      return { ok: true };
    });
  }

  function acknowledgeNotice(instanceId) {
    return withInstance(instanceId, (config, instance) => {
      writeConfig(replaceInstance(config, instance, { noticeAcknowledgedAt: nowProvider().toISOString() }));
      return { ok: true };
    });
  }

  // Startup: drop keys whose instance no longer exists. Never throws.
  function purgeOrphanKeys() {
    try {
      const live = readConfig().instances.map((instance) => instance.id);
      const removed = secureStore?.purgeOrphanModelProviderApiKeys?.(live) || [];
      if (removed.length > 0) log('INFO', 'api_provider.orphan_keys_purged', { count: removed.length });
    } catch (error) {
      log('WARN', 'api_provider.orphan_purge_failed', { errorName: String(error?.name || 'Error') });
    }
  }

  return {
    acknowledgeNotice,
    addInstance,
    clearKey,
    discover,
    getState,
    purgeOrphanKeys,
    removeInstance,
    renameInstance,
    setKey,
    setModelEnabled,
    setModelPin,
  };
}

module.exports = { MAX_KEY_CHARS, createApiProviderService };
