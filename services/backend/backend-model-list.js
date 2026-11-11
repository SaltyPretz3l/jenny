/* services/backend/backend-model-list.js - The model catalog reads behind BackendService.listModels()
 * and listModelsForEngine(): per-engine and aggregate lists, their TTL caches and in-flight
 * coalescing, entry normalization and the model-to-engine hint table.
 *
 * Extracted from backend-runtime.js as a behavior-preserving move; backend-runtime.js
 * re-exports listModels/listModelsForEngine so existing callers keep their require path.
 */
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const { normalizePreferredEngineType } = require('../shell-config-engines');
const { managedServerKindForModel } = require('./ninfer-load-path');
const { t } = require('../i18n-main');
const { chatgptModelsEnabled } = require('./chatgpt-models-enabled');
const {
  apiProviderCatalogKey, apiProviderListPayload, withApiProviderEntries,
} = require('./api-provider-runtime');

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
  if (typeof entry.label === 'string') normalized.label = entry.label;
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
  if (entry.managed === 'ninfer' || entry.managed === 'llama-server') normalized.managed = entry.managed;
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

// Which provider-integration models (Codex CLI) the aggregate would carry and
// whether each is usable: part of the cache key, so a sign-in that lands inside
// the TTL is not served the list read before it.
function providerCatalogKey(service, engineType) {
  const entries = service.providerIntegrationRegistry?.appendModelEntries?.([], {
    engineType, includeAvailable: true,
  }) || [];
  return entries.map((entry) => `${entry.id}:${entry.available === true}`).join('|');
}

function listModels(service) {
  service.chatgptModelCatalogService?.snapshot?.();
  const catalogEpoch = service._modelCatalogEpoch || 0;
  const now = Date.now();
  const desiredEngineType = resolveManagedModelListEngineType(service);
  const providerKey = providerCatalogKey(service, desiredEngineType) + apiProviderCatalogKey(service);
  const lastResult = service._modelListLastResult;
  if (lastResult && lastResult.engineType === desiredEngineType && lastResult.providerKey === providerKey
      && now >= lastResult.at && now - lastResult.at < MODEL_LIST_CACHE_TTL_MS) {
    return Promise.resolve(lastResult.value);
  }
  if (service._modelListInFlightPromise && service._modelListInFlightEngineType === desiredEngineType) {
    return service._modelListInFlightPromise;
  }

  // A read with no sidecar client resolves at once to "not ready yet" and is
  // never cached: caching it for the TTL served it to the first read after
  // the client attached (a fast launch reaches 'ready' inside 2 s), and that
  // is the one catalog read the renderer makes per ready transition.
  const cacheable = Boolean(service.sidecarClient);
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
    // Cloud models (stage 2): signed-in ChatGPT models sit next to the local
    // ones whatever engine runs (picking one switches through its engine tag);
    // with ChatGPT models off none is listed, even from a ChatGPT engine.
    const showChatgpt = chatgptModelsEnabled(service.configService);
    let usesChatgptCatalog = desiredEngineType === 'chatgpt';
    if (showChatgpt && !usesChatgptCatalog
      && service.chatgptAuthService?.hasCredential?.() === true) {
      const chatgptPayload = await service.listModelsForEngine('chatgpt').catch(() => null);
      const chatgptData = tagModelListEntries(chatgptPayload?.data, 'chatgpt');
      if (chatgptPayload?.available !== false && chatgptData.length > 0) {
        data = mergeModelListEntries(data, chatgptData);
        usesChatgptCatalog = true;
      }
    }
    if (!showChatgpt) data = data.filter((entry) => entry?.engine_type !== 'chatgpt');
    if (usesChatgptCatalog && catalogEpoch !== (service._modelCatalogEpoch || 0)) {
      throw new Error('ChatGPT model catalog authority changed.');
    }
    const providerData = service.providerIntegrationRegistry?.appendModelEntries?.(data, {
      engineType: desiredEngineType,
      includeAvailable: true,
    }) || data;
    if (providerData.slice(data.length).some((entry) => entry.available === true)) available = true;
    // API-key provider rows come from config, after the tagger (which would drop their extra fields).
    const taggedData = withApiProviderEntries(service, tagModelListEntries(providerData, desiredEngineType).map((entry) => {
      const managedKind = entry.engine_type === 'openai-compatible' ? managedServerKindForModel(service, entry.id) : '';
      return managedKind ? { ...entry, managed: managedKind } : entry;
    }));
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
      if (cacheable && catalogEpoch === (service._modelCatalogEpoch || 0)) {
        service._modelListLastResult = { at: Date.now(), value, engineType: desiredEngineType, providerKey };
      }
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
    if (String(engineType || '').trim().toLowerCase() === 'api-provider') {
      return Promise.resolve(apiProviderListPayload(service));
    }
    service.chatgptModelCatalogService?.snapshot?.();
    const catalogEpoch = service._modelCatalogEpoch || 0;
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
      reason: t('main.backend.sidecarNotReady', 'Managed sidecar is not ready yet.'),
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
      const catalog = desiredEngineType === 'chatgpt'
        ? await service.chatgptModelCatalogService?.refresh?.() : null;
      if (desiredEngineType === 'chatgpt' && catalogEpoch !== (service._modelCatalogEpoch || 0)) {
        throw new Error('ChatGPT model catalog authority changed.');
      }
      const payload = await service.sidecarClient.modelsList(desiredEngineType, {
        inspectModelId,
        ...(catalog ? { chatgptModelCatalog: catalog.models || [] } : {}),
      });
      if (desiredEngineType === 'chatgpt' && catalogEpoch !== (service._modelCatalogEpoch || 0)) {
        throw new Error('ChatGPT model catalog authority changed.');
      }
      const models = Array.isArray(payload.models) ? payload.models : [];
      const normalized = models.map((entry) => normalizeModelListEntry(entry)).filter(Boolean);
      const metadata = normalizeModelListMetadata(catalog ? { ...payload,
        source: catalog.source, stale: catalog.stale } : payload);
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
        if (catalogEpoch === (service._modelCatalogEpoch || 0)) {
          service._modelListForEngineLastResults.set(cacheKey, { at: Date.now(), value });
        }
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

module.exports = {
  listModels,
  listModelsForEngine,
};
