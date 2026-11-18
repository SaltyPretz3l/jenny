'use strict';

// Row 179 P3: the local subagent engine. Under a cloud primary (api-provider,
// chatgpt, codex-cli) the owner may keep one managed local server running,
// NInfer or llama-server, for the primary's `delegate` children. This module is
// the one Electron owner of that helper: the setting, when it applies, its
// status, the sidecar description and secret, and starting or stopping it. The
// load path, boot, GPU handoff and re-broker call in here with thin seams.
//
// Fences: never in hosted mode, under a team selection or Force local
// inference, never for a local primary, never Ollama or a user-run endpoint.
// The helper's per-launch key goes only to the sidecar as the secret
// `local_subagent_api_key`, never into the config object, a log or an error.

const { CONFIG_ERROR_CODES } = require('./error-codes');
const { managedModelKey } = require('../shell-config-engines');
const { CLOUD_ENGINE_TYPES } = require('../model-size-class');
const { registerExactSecret } = require('./exact-secret-redaction');
const {
  findNinferArtifactForModel, ninferServerStops, stopManagedServerOrAbort,
} = require('./ninfer-load-path');

const ENGINES = Object.freeze(['ninfer', 'llama-server']);
const DEFAULT_SETTING = Object.freeze({ engine: '', model: '' });
const MAX_MODEL_CHARS = 256;
const MAX_CONTEXT_LENGTH = 4_194_304;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
// stopManagedServerOrAbort labels (its log events and copy).
const STOP_LABELS = Object.freeze({ ninfer: 'ninfer', 'llama-server': 'llama_server' });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validModel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL_CHARS
    && !CONTROL_CHARS.test(value);
}

// Normalize on read: anything but a known engine with a valid model is "none".
function normalizeLocalSubagentEngine(value) {
  if (!isPlainObject(value) || !ENGINES.includes(value.engine)) return { ...DEFAULT_SETTING };
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  return validModel(model) ? { engine: value.engine, model } : { ...DEFAULT_SETTING };
}

// A patch names `engine` and/or `model`; `{ engine: '' }` clears the pick.
function applyLocalSubagentEnginePatch(current, patch) {
  const invalid = () => {
    throw Object.assign(new Error('Local subagent engine settings are invalid.'), { code: CONFIG_ERROR_CODES.INVALID });
  };
  if (!isPlainObject(patch) || Object.keys(patch).some((key) => key !== 'engine' && key !== 'model')) invalid();
  if (Object.hasOwn(patch, 'engine') && patch.engine !== '' && !ENGINES.includes(patch.engine)) invalid();
  if (Object.hasOwn(patch, 'model') && patch.model !== '' && !validModel(patch.model)) invalid();
  const next = { ...normalizeLocalSubagentEngine(current), ...patch };
  if (next.engine === '') return { ...DEFAULT_SETTING };
  if (!validModel(next.model) || next.model !== next.model.trim()) invalid();
  return { engine: next.engine, model: next.model };
}

function flagOn(service) {
  return service?.featureFlags?.local_subagent_engine === true;
}

// Fail closed: a mode that cannot be read counts as Force local on.
function forcedLocal(service) {
  try {
    return service?.offlineIntelligenceService?.getMode?.() === 'local_only';
  } catch (_error) {
    return true;
  }
}

function pickedSetting(service) {
  try {
    return normalizeLocalSubagentEngine(service?.configService?.getState?.()?.localSubagentEngine);
  } catch (_error) {
    return { ...DEFAULT_SETTING };
  }
}

function managerFor(service, engine) {
  if (engine === 'ninfer') return service?.options?.getNinferManager?.() || null;
  if (engine === 'llama-server') return service?.options?.getLlamaServerManager?.() || null;
  return null;
}

// The same manager calls a primary load of that model makes (backend-model-load.js).
function resolveLaunch(service, picked) {
  const manager = managerFor(service, picked.engine);
  if (!manager) return null;
  if (picked.engine === 'ninfer') {
    const artifact = findNinferArtifactForModel(service, picked.model);
    return artifact ? { kind: 'ninfer', manager, spec: { artifactId: artifact.id }, model: picked.model } : null;
  }
  const managed = service?.configService?.getLocalEngines?.()?.openaiCompatible?.managed || null;
  const perModel = managed?.perModel?.[managedModelKey(picked.model)] || null;
  if (managed?.enabled !== true || perModel?.engine !== 'llama-server') return null;
  return {
    kind: 'llama-server',
    manager,
    spec: { modelTag: picked.model, modelPath: perModel.modelPath, profileId: managed.profileId, mtp: perModel.mtp },
    model: picked.model,
  };
}

// `teamSelection` defaults to the live one; a cloud load passes null because it clears it.
// The cheap gates run before the setting is read (a config clone); `picked` is null until then.
function decide(service, { engineType = service?.currentEngineType, teamSelection } = {}) {
  const result = (reason, picked = null, launch = null) => ({ applies: !reason, reason, picked, launch });
  if (!flagOn(service)) return result('flag_off');
  if (service?.hostMode === 'server') return result('hosted');
  if (forcedLocal(service)) return result('forced_local');
  if (!CLOUD_ENGINE_TYPES.has(String(engineType || '').trim().toLowerCase())) return result('primary_local');
  const team = teamSelection === undefined ? service?._teamEngineSelection : teamSelection;
  if (team) return result('team');
  const picked = pickedSetting(service);
  if (!picked.engine) return result('not_picked', picked);
  const launch = resolveLaunch(service, picked);
  return launch ? result('', picked, launch) : result('model_unavailable', picked);
}

function aliasKey(value) {
  return managedModelKey(String(value || '').trim().replace(/:latest$/i, ''));
}

// Does the manager's running server serve the picked model?
function servesPicked(launch, status) {
  if (launch.kind === 'ninfer') return String(status?.artifactId || '') === launch.spec.artifactId;
  return Boolean(status?.alias) && aliasKey(status.alias) === aliasKey(launch.model);
}

function statusReason(state) {
  if (state === 'starting') return 'starting';
  if (state === 'crashed') return 'crashed';
  return 'stopped';
}

function localSubagentEngineApplies(service, engineType = service?.currentEngineType) {
  return decide(service, { engineType }).applies;
}

// The public status plus the decision and manager status it was read from.
function evaluate(service, decision = decide(service)) {
  const picked = decision.picked || pickedSetting(service);
  const manager = decision.launch?.manager || managerFor(service, picked.engine);
  let managerStatus = null;
  try {
    managerStatus = manager?.getStatus?.() || null;
  } catch (_error) { /* a status fault reads as stopped */ }
  const state = String(managerStatus?.state || '');
  const base = { applies: decision.applies, engine: picked.engine, model: picked.model, state };
  let status;
  if (!decision.applies) status = { ...base, ready: false, reason: decision.reason };
  else if (state !== 'ready') status = { ...base, ready: false, reason: statusReason(state) };
  else if (!servesPicked(decision.launch, managerStatus)) status = { ...base, ready: false, reason: 'other_model' };
  else status = { ...base, ready: true, reason: '' };
  return { status, decision, managerStatus };
}

function getLocalSubagentEngineStatus(service) {
  return evaluate(service).status;
}

// `http://127.0.0.1:<port>` (or localhost) from a manager base URL, '' otherwise.
function loopbackOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.port ? url.origin : '';
  } catch (_error) {
    return '';
  }
}

// Config and secret builds run on every stack build: a helper that does not
// apply returns before any manager status or setting is read.
function readyHelper(service) {
  const applying = decide(service);
  if (!applying.applies) return null;
  const { status: helperStatus, decision, managerStatus } = evaluate(service, applying);
  if (!helperStatus.ready) return null;
  const { launch } = decision;
  const baseUrl = loopbackOrigin(launch.manager.getBaseUrl?.());
  return baseUrl ? { launch, status: managerStatus, baseUrl } : null;
}

function launchedContext(kind, status) {
  const candidates = kind === 'ninfer' ? [status.contextSize] : [status.servedContextSize, status.contextSize];
  const value = candidates.find((entry) => Number.isSafeInteger(entry) && entry > 0 && entry <= MAX_CONTEXT_LENGTH);
  return value ?? null;
}

function buildLocalSubagentSidecarConfig(service) {
  const helper = readyHelper(service);
  if (!helper) return {};
  const { launch, status, baseUrl } = helper;
  const llama = launch.kind === 'llama-server';
  return {
    local_subagent_engine: {
      base_url: baseUrl,
      model: String(status.alias || '').trim() || launch.model,
      provider_kind: launch.kind,
      context_length: launchedContext(launch.kind, status),
      ready: true,
      prefill_progress: llama && service.featureFlags?.prefill_progress === true
        && launch.manager.supportsPrefillProgress?.() === true,
      json_schema_response_format: llama,
    },
  };
}

function buildLocalSubagentSidecarSecrets(service) {
  const helper = readyHelper(service);
  if (!helper) return {};
  const key = String(helper.launch.manager.getApiKey?.() || '').trim();
  if (!key) return {};
  registerExactSecret(key);
  return { local_subagent_api_key: key };
}

// What a cloud load does with the helper: null when it does not apply; else
// the launch, plus `starts` when ensureRunning would launch a server.
function localSubagentEngineLoadPlan(service, engineType) {
  const { applies, launch } = decide(service, { engineType, teamSelection: null });
  if (!applies) return null;
  let status = null;
  try {
    status = launch.manager.getStatus?.() || null;
  } catch (_error) { /* unknown status: treat as a launch */ }
  return { ...launch, starts: status?.state !== 'ready' || !servesPicked(launch, status) };
}

function log(service, level, event, details) {
  try {
    service?._emitServiceLog?.(level, event, details);
  } catch (_error) { /* logging never breaks the helper */ }
}

// Starts the helper: the other managed server stops with proof first. Never
// throws; a failure is logged (no secrets) and the manager keeps its lastError.
async function startLocalSubagentEngine(service, launch, reason) {
  const details = { engine: launch.kind, model: launch.model, reason: String(reason || '') };
  try {
    const otherKind = launch.kind === 'ninfer' ? 'llama-server' : 'ninfer';
    const other = managerFor(service, otherKind);
    if (other && ninferServerStops(other)) {
      await stopManagedServerOrAbort(service, other, STOP_LABELS[otherKind], 'local_subagent_engine');
    }
    const status = await launch.manager.ensureRunning(launch.spec);
    if (status?.state !== 'ready') {
      log(service, 'WARN', 'backend.local_subagent_engine_start_failed', {
        ...details, state: String(status?.state || ''), last_error: String(status?.lastError || '').slice(0, 200),
      });
      return null;
    }
    log(service, 'INFO', 'backend.local_subagent_engine_started', details);
    return status;
  } catch (error) {
    log(service, 'WARN', 'backend.local_subagent_engine_start_failed', {
      ...details, error_name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 200),
    });
    return null;
  }
}

// After a settings change while the primary is cloud: stop a helper that no
// longer applies, start a newly picked one, then refresh the sidecar config.
// Under another active stream or a GPU lease it does nothing; the next cloud load applies it.
async function syncLocalSubagentEngine(service, reason = 'local_subagent_engine') {
  const engineType = String(service?.currentEngineType || '').trim().toLowerCase();
  if (!flagOn(service) || !CLOUD_ENGINE_TYPES.has(engineType)) return { synced: false, reason: 'not_cloud' };
  const admission = service.exclusiveGpuCoordinator?.getState?.();
  const streams = Number(service.activeStreams?.size) || 0;
  if (streams > 0 || (admission && admission.state !== 'chat_resident')) {
    log(service, 'INFO', 'backend.local_subagent_engine_sync_deferred', {
      reason: String(reason), active_stream_count: streams, admission: String(admission?.state || ''),
    });
    return { synced: false, reason: streams > 0 ? 'stream_active' : 'gpu_leased' };
  }
  const decision = decide(service, { engineType });
  try {
    for (const kind of ENGINES) {
      const manager = managerFor(service, kind);
      if (decision.launch?.kind !== kind && manager && ninferServerStops(manager)) {
        await stopManagedServerOrAbort(service, manager, STOP_LABELS[kind], 'local_subagent_engine');
      }
    }
  } catch (_error) {
    // stopManagedServerOrAbort logged it; an unconfirmed stop must not double-load the GPU.
    await service.refreshManagedConfig?.('local_subagent_engine');
    return { synced: false, reason: 'stop_unconfirmed' };
  }
  if (decision.applies) await startLocalSubagentEngine(service, decision.launch, reason);
  await service.refreshManagedConfig?.('local_subagent_engine');
  return { synced: true, reason: '' };
}

// Is `kind`'s manager the picked helper under a cloud primary right now? Used
// by the re-broker and status observer; looser than `applies` on purpose, so a
// helper whose model was removed still drops its key on stop.
function localSubagentEngineOwnsManager(service, kind) {
  if (!flagOn(service) || service?.hostMode === 'server') return false;
  if (!CLOUD_ENGINE_TYPES.has(String(service?.currentEngineType || '').trim().toLowerCase())) return false;
  return pickedSetting(service).engine === kind;
}

// GPU handoff under a cloud primary: a ready, owned helper to park, or whether
// a managed server is resident at all (then the GPU is not free by design).
// With no helper picked, the handoff is exactly what it was before row 179.
function residentLocalSubagentEngine(service, { ninferManager, llamaServerManager }) {
  const engineType = String(service?.currentEngineType || '').trim().toLowerCase();
  if (!flagOn(service) || !CLOUD_ENGINE_TYPES.has(engineType) || !pickedSetting(service).engine) {
    return { park: null, resident: false };
  }
  const ninfer = ninferManager?.getStatus?.() || null;
  if (ninfer?.state === 'ready' && Number(ninfer.pid) > 0) {
    return { park: { manager: ninferManager, plan: { engine: 'ninfer', pid: ninfer.pid }, reason: 'ninfer_stop_unconfirmed' }, resident: true };
  }
  const llama = llamaServerManager?.getStatus?.() || null;
  if (llama?.state === 'ready' && !llama.reused && Number(llama.pid) > 0) {
    return { park: { manager: llamaServerManager, plan: { engine: 'llama-server', pid: llama.pid }, reason: 'llama_server_stop_unconfirmed' }, resident: true };
  }
  const live = (status) => ['starting', 'ready', 'stopping'].includes(String(status?.state || ''));
  return { park: null, resident: live(ninfer) || live(llama) };
}

module.exports = {
  applyLocalSubagentEnginePatch,
  buildLocalSubagentSidecarConfig,
  buildLocalSubagentSidecarSecrets,
  getLocalSubagentEngineStatus,
  localSubagentEngineApplies,
  localSubagentEngineLoadPlan,
  localSubagentEngineOwnsManager,
  normalizeLocalSubagentEngine,
  residentLocalSubagentEngine,
  startLocalSubagentEngine,
  syncLocalSubagentEngine,
};
