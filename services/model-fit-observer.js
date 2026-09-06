'use strict';

// Wave 4 "record on first load, then self-catalog": watches
// backendService's 'backend-status' events for a newly-active Ollama model
// reaching phase 'ready', then polls getResidentModels() until that model's
// real /api/ps footprint (size / size_vram) shows up, and records it into the
// ModelFitObservationStore (services/model-fit-observation-store.js) so
// services/model-fit-diagnostics.js can serve a source:'observed' fit instead
// of a pure estimate on every subsequent load.
//
// Never throws out of its event handlers or timers — a failure here must
// never affect chat/model-loading behavior.
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 60000;

function _str(value) {
  return String(value == null ? '' : value).trim();
}

function canonicalModelId(value) {
  const modelId = _str(value).toLowerCase();
  if (!modelId) return '';
  const lastSegment = modelId.slice(modelId.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? modelId : `${modelId}:latest`;
}

function createModelFitObserver({
  backendService,
  store,
  getHardwareProfile = () => null,
  logger = null,
  flagEnabled = () => true,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let disposed = false;
  let pollTimer = null;
  let pollDeadline = 0;
  let lastTriggerKey = '';
  let activeTriggerModelId = '';
  // Monotonic run token: incremented every time a poll loop starts (or is
  // stopped) so an in-flight pollOnce that is still awaiting
  // getResidentModels() when a new trigger fires can detect it is stale (the
  // activeTriggerModelId guard alone is not enough for a same-model
  // re-trigger, since the id does not change) and bail instead of scheduling
  // a second, untracked timer.
  let pollRun = 0;

  function log(level, event, data) {
    try {
      if (typeof logger === 'function') logger(level, event, data);
    } catch (_) {
      // logging must never throw
    }
  }

  function stopPolling() {
    pollRun += 1;
    if (pollTimer != null) {
      try {
        clearTimeoutFn(pollTimer);
      } catch (_) {
        // best-effort
      }
      pollTimer = null;
    }
    pollDeadline = 0;
    activeTriggerModelId = '';
  }

  async function resolveGpu() {
    try {
      // getHardwareProfile may be sync or async (offline-intelligence's
      // profile fetch is a network round-trip to the sidecar); await handles
      // both without a separate branch.
      const profile = await getHardwareProfile();
      const gpu = profile && typeof profile === 'object' ? profile.gpu : null;
      if (!gpu || typeof gpu !== 'object') return null;
      const name = _str(gpu.name);
      const vramMb = Number(gpu.vram_mb ?? gpu.vramMb);
      const type = _str(gpu.type).toLowerCase();
      if (!name) return null;
      return { name, vramMb: Number.isFinite(vramMb) && vramMb > 0 ? Math.floor(vramMb) : 0, type };
    } catch (_) {
      return null;
    }
  }

  function buildObservationFromResident(residentEntry, { gpu, contextLength, residentModelCount }) {
    const sizeMb = Math.round(Number(residentEntry.sizeBytes || 0) / (1024 * 1024));
    const vramBytes = Number(residentEntry.vramBytes || 0);
    const vramMb = Math.round(vramBytes / (1024 * 1024));
    // offloadedMb: the portion of the model NOT resident in VRAM (ran partly
    // or fully on CPU). Ollama reports size_vram <= size; the delta is what
    // spilled to system RAM. On a unified-memory (metal) device size_vram
    // tracks size 1:1 so this is always 0 there, which is correct — there is
    // no separate CPU/GPU split to report.
    const offloadedMb = Math.max(0, sizeMb - vramMb);
    const metal = gpu.type === 'metal';
    return {
      modelId: residentEntry.name,
      digest: residentEntry.digest || '',
      engine: 'ollama',
      gpuName: gpu.name,
      gpuVramMb: gpu.vramMb,
      contextLength: Number(residentEntry.contextLength || contextLength || 0),
      sizeMb,
      vramMb,
      offloadedMb,
      residentModelCount: Number(residentModelCount || 0),
      // Recommendation-shaped fields resolveModelFit()/the diagnostics
      // builder expect on an "observation" (see model-fit-estimator.js):
      vramRequiredMb: sizeMb,
      ramRequiredMb: Math.round(sizeMb * 1.2),
      fits: true,
      fitsInVram: offloadedMb === 0 && !metal,
      fitsInAccelerator: metal,
      fitsOnCpu: offloadedMb > 0,
    };
  }

  async function pollOnce(triggerModelId, gpu, contextLength, runToken) {
    if (disposed || activeTriggerModelId !== triggerModelId || runToken !== pollRun) return;
    if (now() > pollDeadline) {
      stopPolling();
      return;
    }
    let residentModels;
    try {
      residentModels = await backendService?.getResidentModels?.();
    } catch (_) {
      residentModels = null;
    }
    if (disposed || activeTriggerModelId !== triggerModelId || runToken !== pollRun) return;
    const canonicalTrigger = canonicalModelId(triggerModelId);
    const match = Array.isArray(residentModels)
      ? residentModels.find((m) => canonicalModelId(m.name) === canonicalTrigger)
      : null;
    const hasFootprint = match && (Number(match.vramBytes) > 0 || Number(match.sizeBytes) > 0);
    if (hasFootprint) {
      stopPolling();
      try {
        const observation = buildObservationFromResident(match, {
          gpu,
          contextLength,
          residentModelCount: Array.isArray(residentModels) ? residentModels.length : 0,
        });
        store?.record?.(observation);
        log('INFO', 'model_fit.observed', {
          modelId: observation.modelId,
          vramMb: observation.vramMb,
          offloadedMb: observation.offloadedMb,
          contextLength: observation.contextLength,
          gpuName: observation.gpuName,
        });
      } catch (error) {
        log('WARN', 'model_fit.observe_failed', { message: String(error?.message || error) });
      }
      return;
    }
    pollTimer = setTimeoutFn(() => {
      pollOnce(triggerModelId, gpu, contextLength, runToken).catch(() => {});
    }, POLL_INTERVAL_MS);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  async function maybeTrigger(status) {
    if (disposed) return;
    try {
      if (typeof flagEnabled === 'function' && flagEnabled() !== true) return;
      if (!status || status.phase !== 'ready') return;
      const engine = _str(status.engine || status.engine_type || status.engineType).toLowerCase();
      if (engine !== 'ollama') return;
      const modelId = _str(status.model);
      if (!modelId) return;
      const contextLength = Number(
        status.effective_context_length ?? status.configured_context_length ?? 0
      );
      const triggerKey = `${canonicalModelId(modelId)}|${contextLength || 0}`;
      if (triggerKey === lastTriggerKey) return;
      const gpu = await resolveGpu();
      if (disposed) return;
      if (!gpu) {
        // Unknown GPU: record nothing (the observation key requires a GPU
        // identity), but still remember the trigger so we don't spin.
        lastTriggerKey = triggerKey;
        return;
      }
      lastTriggerKey = triggerKey;
      stopPolling();
      activeTriggerModelId = modelId;
      pollDeadline = now() + POLL_TIMEOUT_MS;
      const runToken = pollRun;
      pollOnce(modelId, gpu, contextLength, runToken).catch(() => {});
    } catch (error) {
      log('WARN', 'model_fit.observer_trigger_failed', { message: String(error?.message || error) });
    }
  }

  const onBackendStatus = (status) => { maybeTrigger(status).catch(() => {}); };
  if (backendService && typeof backendService.on === 'function') {
    backendService.on('backend-status', onBackendStatus);
  }

  return {
    invalidate(modelId) {
      if (disposed) return;
      const canonical = canonicalModelId(modelId);
      if (canonical && lastTriggerKey.startsWith(`${canonical}|`)) {
        lastTriggerKey = '';
      } else if (!modelId) {
        lastTriggerKey = '';
      }
      try {
        // sidecarManager.getStatus() is the raw child-process status (spawned/
        // stopped) and never carries engine/model — using it here always made
        // maybeTrigger bail. currentStatus/getBackendStatus() carry the
        // engine+model the managed runtime last reported; since invalidate()
        // is only called right after a successful model-tuning apply for the
        // active model, it is safe to force phase:'ready' so maybeTrigger
        // proceeds instead of requiring a fresh lifecycle event.
        const status = backendService?.currentStatus && typeof backendService.currentStatus === 'object'
          ? backendService.currentStatus
          : (typeof backendService?.getBackendStatus === 'function' ? backendService.getBackendStatus() : null);
        const engine = _str(status?.engine || status?.engine_type || status?.engineType);
        const model = _str(status?.model);
        if (status && engine && model) {
          maybeTrigger({ ...status, phase: 'ready', engine, model }).catch(() => {});
        }
      } catch (_) {
        // best-effort re-trigger
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPolling();
      try {
        if (backendService && typeof backendService.off === 'function') {
          backendService.off('backend-status', onBackendStatus);
        } else if (backendService && typeof backendService.removeListener === 'function') {
          backendService.removeListener('backend-status', onBackendStatus);
        }
      } catch (_) {
        // best-effort
      }
    },
  };
}

module.exports = {
  createModelFitObserver,
  canonicalModelId,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
};
