'use strict';

// The managed llama-server loads its model in main, before the sidecar init
// that confirms it (the openai-compatible load_model is only a /models probe
// with no progress). The manager's state changes are the only load signal, so
// they drive the model lifecycle: 'starting' is a model load stamped with the
// manager's own clock, and the marker (service._managedEngineLoad) lets the
// init that follows keep that clock so its ready write records the duration.
// Split out of local-engine-status.js, which applies the patches built here.

const MANAGED_ENGINE_TYPE = 'openai-compatible';

function ownsStoredLoad(lifecycle, load) {
  return Boolean(load)
    && lifecycle?.state === 'loading'
    && lifecycle.requested_model === load.model
    && lifecycle.started_at === load.started_at;
}

function sameManagedModel(left, right) {
  const key = (value) => String(value || '').trim().replace(/:latest$/i, '').toLowerCase();
  return Boolean(key(left)) && key(left) === key(right);
}

// The lifecycle patch a manager state change implies, or null for none.
function managedLoadPatch(service, managerStatus) {
  if (!service || service._disposed || service._stopping) return null;
  const state = String(managerStatus?.state || '');
  const model = String(managerStatus?.alias || '').trim().slice(0, 240);
  if (state === 'starting') {
    if (!model) return null;
    const changedAt = Number(managerStatus.changedAt);
    const startedAt = new Date(Number.isFinite(changedAt) && changedAt > 0 ? changedAt : Date.now()).toISOString();
    service._managedEngineLoad = { model, started_at: startedAt, serverReady: false };
    return {
      state: 'loading',
      requested_model: model,
      engine: MANAGED_ENGINE_TYPE,
      status: 'Loading model',
      percent: 0,
      completed_bytes: 0,
      total_bytes: 0,
      error_code: '',
      started_at: startedAt,
      ready_at: null,
    };
  }
  const load = service._managedEngineLoad;
  if (!load) return null;
  if (state === 'ready' && managerStatus.reused !== true) {
    if (managerStatus.identityReused === true) {
      // An identity restore (chat GPU handoff) runs no sidecar init after it
      // (runtime-shutdown.js skips the re-broker), so this ready is the
      // confirmation; without it the published phase stays model_loading.
      service._managedEngineLoad = null;
      return ownsStoredLoad(service._modelLifecycle, load) && !service._managedInitializeFlight
        ? { state: 'ready', status: 'Model ready', percent: 100 }
        : null;
    }
    // The weights are up; the sidecar init that follows confirms the model.
    load.serverReady = true;
    return null;
  }
  // Failed, crashed, stopped, or a pre-existing server was reused (nothing
  // loaded): no load to confirm, so the clock must not survive into an init.
  service._managedEngineLoad = null;
  return ownsStoredLoad(service._modelLifecycle, load) && !service._managedInitializeFlight
    ? { state: 'unloaded', status: '', percent: 0 }
    : null;
}

// A load the manager is still running is live, not a stale mid-load latch.
function isPendingManagedLoad(service, storedLifecycle) {
  const load = service._managedEngineLoad;
  return Boolean(load) && !load.serverReady && ownsStoredLoad(storedLifecycle, load);
}

// Called once per init flight: the marker is consumed either way, so a retry
// after an aborted init, or an init for another model, starts a fresh clock.
function claimManagedEngineLoad(service, requestedModel, requestedEngineType) {
  const load = service._managedEngineLoad || null;
  service._managedEngineLoad = null;
  if (!load || requestedEngineType !== MANAGED_ENGINE_TYPE) return null;
  if (!ownsStoredLoad(service._modelLifecycle, load)) return null;
  return sameManagedModel(load.model, requestedModel) ? load : null;
}

module.exports = {
  MANAGED_ENGINE_TYPE,
  claimManagedEngineLoad,
  isPendingManagedLoad,
  managedLoadPatch,
};
