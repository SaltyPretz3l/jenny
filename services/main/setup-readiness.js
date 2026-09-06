// The backend service is created later in startup, so resolve it lazily through
// the injected accessor.

const SETUP_LOCAL_ENGINES = new Set(['ollama', 'vllm', 'openai-compatible']);
// Mirror of CLOUD_ENGINE_TYPES in services/backend/managed-sidecar-chat-helpers.js.
// Kept local so this probe stays the zero-dependency leaf described in the
// header; tests/setup-readiness.test.js asserts the two sets stay in step.
const SETUP_CLOUD_ENGINES = new Set(['chatgpt', 'codex-cli']);

function normalizeEngineToken(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function normalizeSetupEngineType(value) {
  const token = normalizeEngineToken(value);
  return SETUP_LOCAL_ENGINES.has(token) ? token : '';
}

function entryEngineToken(entry) {
  return normalizeEngineToken(entry?.provider || entry?.engine_type || entry?.engineType);
}

// A cloud engine (ChatGPT / Codex CLI) is a legitimate model route for setup,
// but it is NOT a local engine: it must never satisfy the local_model signals
// or inflate local_model_count. It is reported separately as
// remote_endpoint_available and folded into endpoint readiness by
// SetupService._buildReadiness.
function normalizeSetupCloudEngineType(value) {
  const token = normalizeEngineToken(value);
  return SETUP_CLOUD_ENGINES.has(token) ? token : '';
}

// Entry provenance is authoritative because the managed catalog merges local
// Ollama entries into a cloud engine's model list; the catalog's top-level
// engine says nothing about individual entries.
function countSetupLocalModels(payload, engineType) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!models.length) {
    return 0;
  }
  return models.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const modelId = String(entry.id || entry.name || entry.model || '').trim();
    if (!modelId) return false;
    if (entry.available === false) return false;
    const token = entryEngineToken(entry);
    if (token) {
      return SETUP_LOCAL_ENGINES.has(token);
    }
    return Boolean(engineType);
  }).length;
}

// Strict entry-provenance match, unlike countSetupLocalModels: engine_type is
// supplied by the Electron catalog layer, and a local model must never make an
// unauthenticated cloud route look reachable.
function countSetupCloudModels(payload, engineType) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!models.length || !engineType) {
    return 0;
  }
  return models.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const modelId = String(entry.id || entry.name || entry.model || '').trim();
    if (!modelId) return false;
    const token = entryEngineToken(entry);
    return token === engineType;
  }).length;
}

function createSetupReadinessProbe({
  getBackendService = () => null,
  emitLog = () => {},
} = {}) {
  function warn(event, error) {
    try {
      emitLog('WARN', event, {
        message: String(error?.message || error || 'Unknown readiness failure').slice(0, 500),
      });
    } catch {
      // Readiness must degrade safely even if diagnostics are unavailable.
    }
  }

  function unavailableResult({
    runtimeReady = false,
    runtimeModelLoaded = false,
    runtimeEngine = '',
    catalogPending = false,
    reason = 'Local model backend is unavailable.',
  } = {}) {
    return {
      local_model_available: false,
      local_model_count: 0,
      local_endpoint_available: false,
      remote_endpoint_available: false,
      catalog_available: false,
      catalog_pending: catalogPending,
      catalog_source: '',
      catalog_cached: false,
      catalog_stale: false,
      runtime_ready: runtimeReady,
      runtime_model_loaded: runtimeModelLoaded,
      runtime_engine: runtimeEngine,
      reason,
    };
  }

  async function probeSetupReadiness() {
    let backendService;
    let status;
    try {
      backendService = getBackendService();
      status = backendService && backendService.currentStatus && typeof backendService.currentStatus === 'object'
        ? backendService.currentStatus
        : {};
    } catch (error) {
      warn('setup.readiness_backend_access_failed', error);
      return unavailableResult();
    }
    let statusEngine;
    let cloudEngine;
    let runtimeReady;
    let runtimeModelLoaded;
    try {
      const engineSource = status.engine
        || backendService?.currentEngineType
        || backendService?.defaultModel;
      statusEngine = normalizeSetupEngineType(engineSource);
      cloudEngine = normalizeSetupCloudEngineType(engineSource);
      const readiness = status.local_runtime && typeof status.local_runtime === 'object'
        ? status.local_runtime.readiness || status.local_runtime.status || {}
        : {};
      runtimeReady = status.model_loaded === true
        || readiness.ready === true
        || String(status.phase || '').trim().toLowerCase() === 'ready';
      runtimeModelLoaded = status.model_loaded === true
        || readiness.model_loaded === true;
    } catch (error) {
      warn('setup.readiness_backend_state_failed', error);
      return unavailableResult();
    }
    let backendPhase = String(status.phase || '').trim().toLowerCase();
    try {
      backendPhase = String(
        backendService?.getBackendStatus?.()?.phase || backendPhase
      ).trim().toLowerCase();
    } catch (error) {
      warn('setup.readiness_backend_status_failed', error);
    }
    if (backendService && ['starting', 'retrying', 'spawning', 'sidecar_spawned'].includes(backendPhase)) {
      return unavailableResult({
        runtimeReady,
        runtimeModelLoaded,
        runtimeEngine: statusEngine || cloudEngine,
        catalogPending: true,
        reason: 'Local model catalog is waiting for backend startup.',
      });
    }
    if (!backendService || typeof backendService.listModels !== 'function') {
      return unavailableResult({ runtimeReady, runtimeModelLoaded, runtimeEngine: statusEngine || cloudEngine });
    }
    let catalog;
    try {
      catalog = await backendService.listModels();
    } catch (error) {
      warn('setup.readiness_catalog_failed', error);
      return unavailableResult({
        runtimeReady,
        runtimeModelLoaded,
        runtimeEngine: statusEngine || cloudEngine,
        reason: 'Local model catalog is temporarily unavailable.',
      });
    }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      warn('setup.readiness_catalog_malformed', 'Catalog response was not an object.');
      return unavailableResult({
        runtimeReady,
        runtimeModelLoaded,
        runtimeEngine: statusEngine || cloudEngine,
        reason: 'Local model catalog returned an invalid response.',
      });
    }
    const catalogEngine = normalizeSetupEngineType(catalog?.engine_type || statusEngine);
    const localModelCount = catalog?.available === false
      ? 0
      : countSetupLocalModels(catalog, catalogEngine);
    const catalogAvailable = catalog?.available !== false
      && Boolean(catalogEngine)
      && localModelCount > 0;
    // Cloud route reachability, kept strictly separate from the local signals.
    // A signed-out ChatGPT catalog still lists models, and the Ollama merge can
    // force available true, so primary_available carries the primary engine's
    // own reachability.
    const catalogCloudEngine = normalizeSetupCloudEngineType(catalog?.engine_type || cloudEngine);
    const cloudModelCount = catalog?.available === false || catalog?.primary_available === false
      ? 0
      : countSetupCloudModels(catalog, catalogCloudEngine);
    const remoteEndpointAvailable = Boolean(catalogCloudEngine) && cloudModelCount > 0;
    return {
      local_model_available: localModelCount > 0,
      local_model_count: localModelCount,
      local_endpoint_available: catalogAvailable,
      remote_endpoint_available: remoteEndpointAvailable,
      catalog_available: catalogAvailable,
      catalog_pending: false,
      catalog_source: String(catalog?.source || catalog?.catalog_source || ''),
      catalog_cached: catalog?.cached === true || catalog?.catalog_cached === true,
      catalog_stale: catalog?.stale === true || catalog?.catalog_stale === true,
      runtime_ready: runtimeReady,
      runtime_model_loaded: runtimeModelLoaded,
      runtime_engine: catalogEngine || catalogCloudEngine || statusEngine || cloudEngine,
      reason: String(catalog?.reason || ''),
    };
  }

  return {
    probeSetupReadiness,
    normalizeSetupEngineType,
    normalizeSetupCloudEngineType,
    countSetupLocalModels,
    countSetupCloudModels,
  };
}

module.exports = {
  createSetupReadinessProbe,
  normalizeSetupEngineType,
  normalizeSetupCloudEngineType,
  countSetupLocalModels,
  countSetupCloudModels,
  SETUP_CLOUD_ENGINES,
};
