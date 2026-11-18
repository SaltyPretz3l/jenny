const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('./backend-config');
const { inferEngineTypeFromModel } = require('./backend-service-utils');
const { AI_ERROR_CODES } = require('./error-codes');
const { managedServerKindForModel } = require('./ninfer-load-path');
const { assertTeamModelUsable, isReservedTeamModelId, liveTeamSelection, otherChatRefusal } = require('./team-engine-models');

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

// 'installed' | 'missing' | 'unknown' ('unknown': the catalog read failed or lists nothing for the
// engine family, so it cannot vouch either way). `listing` reuses a catalog read the caller holds.
async function modelInstallState(service, model, { engineType = '', listing = null } = {}) {
  const id = String(model || '').trim();
  if (!id) return 'missing';
  if (service.hostMode === 'server') return 'installed';
  const known = () => Boolean(service._modelEngineHints?.get?.(id));
  const inferred = inferEngineTypeFromModel(id);
  const family = String(engineType || '').trim().toLowerCase() || inferred;
  if (known() || CLOUD_ENGINE_TYPES.has(inferred) || CLOUD_ENGINE_TYPES.has(family)) return 'installed';
  if (managedServerKindForModel(service, id, { routing: true })) return 'installed';
  let read = listing;
  if (!read) {
    try { read = await service.listModels(); } catch { return 'unknown'; }
  }
  const entries = Array.isArray(read?.data) ? read.data : [];
  if (known() || entries.some((entry) => entry?.id === id)) return 'installed';
  if (read?.primary_available === false || !entries.some((entry) => entry?.engine_type === family)) return 'unknown';
  return 'missing';
}

// A chat's model must be one the catalog carries before anything is switched: an id no engine lists
// (a spawned chat on the short alias `ornith15:9b`, 2026-10-27) otherwise took the current engine,
// stopped NInfer and failed against an unrelated endpoint. Checked against one fresh catalog read;
// it fails open when the catalog cannot vouch, so a startup race or an unreachable user server
// never refuses a chat the user chose a model for. Kill switch: JENNY_ENABLE_MODEL_CATALOG_GUARD=0.
async function assertModelInstalled(service, model, preferredEngineType) {
  if (service.featureFlags?.model_catalog_guard === false) return;
  if (await modelInstallState(service, model, { engineType: preferredEngineType }) !== 'missing') return;
  const family = String(preferredEngineType || '').trim().toLowerCase() || inferEngineTypeFromModel(model);
  service._emitServiceLog?.('WARN', 'backend.model_not_installed', { model, engine: family });
  throw Object.assign(
    new Error(`Model "${model}" is not installed. Choose an installed model for this chat.`),
    { error_code: AI_ERROR_CODES.ENGINE_CONNECTION, category: 'model_unavailable', retryable: false }
  );
}

// The defaults a turn with no model of its own (or startup) may load, in order: the Settings default
// for local inference, then the built-in default.
function defaultModelCandidates(service) {
  const settingsDefault = service.hostMode === 'server'
    ? ''
    : String(service.offlineIntelligenceService?.getPreferredLocalModel?.() || '').trim();
  const builtIn = resolveManagedDefaultModel(service);
  return [...new Set([settingsDefault, builtIn].filter((model) => model && !isReservedTeamModelId(service, model)))];
}

// Loading a default the engine does not have makes Ollama pull it: a multi-GB download nobody asked
// for (2026-11-13). Only an installed default is ever picked; downloads happen from setup or the
// Model Library. Returns { model } or { missing, unconfirmed } (the first candidate, for the
// message; unconfirmed when no catalog read could say either way).
// Kill switch: JENNY_ENABLE_NO_SILENT_MODEL_PULL=0 restores the first candidate unchecked.
async function pickInstalledDefaultModel(service, { listing = null } = {}) {
  const candidates = defaultModelCandidates(service);
  if (!candidates.length) return { model: '', missing: '', unconfirmed: false };
  if (service.featureFlags?.no_silent_model_pull === false) return { model: candidates[0], missing: '', unconfirmed: false };
  let unconfirmed = true;
  for (const model of candidates) {
    const state = await modelInstallState(service, model, { listing });
    if (state === 'installed') return { model, missing: '', unconfirmed: false };
    if (state === 'missing') unconfirmed = false;
  }
  return { model: '', missing: candidates[0], unconfirmed };
}

function defaultModelMissingError(service, model, reason, unconfirmed) {
  service._emitServiceLog?.('WARN', 'backend.default_model_not_installed', { model, reason, unconfirmed });
  const message = unconfirmed
    ? `Jenny could not confirm the default model "${model}" is installed, so it was not loaded. Pick a model for this chat, or check Settings › Models.`
    : `The default model "${model}" is not installed. Pick an installed model for this chat, or download it in Settings › Models.`;
  return Object.assign(new Error(message), {
    error_code: AI_ERROR_CODES.ENGINE_CONNECTION, category: 'model_unavailable', retryable: unconfirmed,
  });
}

async function loadInstalledDefaultModel(service, reason, options = {}) {
  const { model, missing, unconfirmed } = await pickInstalledDefaultModel(service, { listing: options.listing });
  if (model) return await loadManagedDefaultModel(service, model, reason, { ownStreamId: options.ownStreamId });
  if (missing) throw defaultModelMissingError(service, missing, reason, unconfirmed);
  return '';
}

async function resolveModel(service, preferredModel = '', preferredEngineType = '', ownStreamId = '') {
  const requestedModel = String(preferredModel || '').trim();
  if (requestedModel) {
    // A team model is re-checked on every send, and its selection must be live, not only its id current
    // (TEAM_NODE_PROTOCOL_SPEC "4b member wiring as built", items 1 and 4).
    const team = isReservedTeamModelId(service, requestedModel);
    if (team) assertTeamModelUsable(service, requestedModel);
    if (service.currentModel !== requestedModel || (team && liveTeamSelection(service)?.id !== requestedModel)) {
      await assertModelInstalled(service, requestedModel, preferredEngineType);
      await loadManagedDefaultModel(service, requestedModel, 'preferred_model', {
        engineType: preferredEngineType, ownStreamId,
      });
    }
    service.currentModel = requestedModel;
    return requestedModel;
  }
  if (isReservedTeamModelId(service, service.currentModel)) {
    // A turn with no model of its own never runs on another chat's team model: it loads the default.
    if (!defaultModelCandidates(service).length) throw otherChatRefusal();
    return await loadInstalledDefaultModel(service, 'team_model_not_chosen', { ownStreamId });
  }
  if (service.currentModel) return service.currentModel;
  const idleByChoice = service._startupIdleByChoice === true;
  if (idleByChoice || service._modelLifecycle?.state === 'unavailable') {
    // A previous load latched 'unavailable' (engine down, model missing), or
    // the boot started no server by choice ("Load model at startup" off) and
    // the sidecar holds only its fallback engine. Load the configured default
    // on this turn instead of demanding a manual load or listing the fallback's
    // models; a failed load latches and surfaces on the turn as a terminal error.
    const retried = await loadInstalledDefaultModel(
      service, idleByChoice ? 'startup_model_load_off' : 'model_unavailable_retry', { ownStreamId }
    );
    if (retried) return retried;
    throw Object.assign(
      new Error('The configured model is unavailable. Load a model to continue.'),
      { error_code: AI_ERROR_CODES.ENGINE_CONNECTION, category: 'model_unavailable', retryable: true }
    );
  }

  let models;
  try {
    models = await service.listModels();
  } catch (error) {
    if (service._modelLifecycle?.state === 'unavailable') throw error;
    const loaded = await loadInstalledDefaultModel(
      service, 'shell_default_model_after_model_probe_failure', { ownStreamId }
    );
    if (loaded) return loaded;
  }
  if (models?.active_model) {
    service.currentModel = String(models.active_model);
    return service.currentModel;
  }
  if (models) {
    const loaded = await loadInstalledDefaultModel(service, 'shell_default_model', { ownStreamId, listing: models });
    if (loaded) return loaded;
    if (Array.isArray(models.data) && models.data[0]?.id) {
      service.currentModel = String(models.data[0].id);
      return service.currentModel;
    }
  }

  const status = await service.refreshStatusSnapshot().catch(() => null);
  if (status?.model) {
    service.currentModel = String(status.model);
    return service.currentModel;
  }
  throw new Error('No model is available for chat.');
}

module.exports = { modelInstallState, pickInstalledDefaultModel, resolveDefaultChatModel, resolveModel };
