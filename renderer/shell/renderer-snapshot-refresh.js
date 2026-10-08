(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererSnapshotRefresh = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  // A catalog read that came back unavailable ("Managed sidecar is not ready
  // yet." while the backend already reads ready, before the sidecar client
  // attached) or failed is re-read on this bounded backoff (~10 min in all).
  // Nothing else re-reads it: one model-inclusive refresh runs per ready
  // transition and the 15 s poller skips models by design. A picker opened
  // while the list is unavailable re-reads it at once (refreshModelsIfUnavailable).
  const MODEL_RETRY_DELAYS_MS = Object.freeze([
    2000, 4000, 8000, 15000, 30000,
    60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000,
  ]);

  function isModelListUnavailable(list) {
    return !list || typeof list !== 'object' || list.available === false;
  }

  // What the model carriers render from an available catalog; an unavailable
  // one renders nothing new, so it has no signature.
  function catalogSignature(list) {
    if (isModelListUnavailable(list)) return null;
    try {
      return JSON.stringify([list.engine_type, list.active_model, list.data ?? list.models]);
    } catch (_error) {
      return null;
    }
  }

  function createSnapshotRefresh(options = {}) {
    const state = options.state || {};
    const getShell = typeof options.getShell === 'function' ? options.getShell : () => null;
    const render = typeof options.render === 'function' ? options.render : () => {};
    const onModelsUpdated = typeof options.onModelsUpdated === 'function'
      ? options.onModelsUpdated
      : null;
    // A catalog that recovers after an unavailable or failed read, or whose
    // entries changed, needs more than the snapshot render: the model carriers
    // (pane 0's rebuild in renderSettings, a second pane's rail) only rebuild
    // on a full render. The ready handler's own full render can run before a
    // slow models.list answers (a newer backend status supersedes it), so
    // the refresh that commits a changed catalog renders in full itself.
    const onModelCatalogRecovered = typeof options.onModelCatalogRecovered === 'function'
      ? options.onModelCatalogRecovered
      : null;
    const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : globalThis.setTimeout;
    const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : globalThis.clearTimeout;
    // Every refresh owns settings and status; only a model-inclusive refresh
    // owns the catalog. A runtime-only refresh (15 s poll, stream postwork)
    // that overtakes a slow models.list must not discard it: nothing else
    // re-reads an available catalog, so the pickers kept the fallback list.
    const refreshGate = asyncFence.createGenerationGate();
    const modelsGate = asyncFence.createGenerationGate();
    let lastPollSignature = null;
    let lastCatalogSignature = null;
    let catalogDegraded = false;
    let modelRetryTimer = null;
    let modelRetryAttempt = 0;
    let userRefreshInFlight = null;
    let disposed = false;

    function clearModelRetry() {
      if (modelRetryTimer !== null && typeof clearTimer === 'function') clearTimer(modelRetryTimer);
      modelRetryTimer = null;
    }

    function scheduleModelRetry() {
      if (disposed || modelRetryTimer !== null || typeof setTimer !== 'function'
          || modelRetryAttempt >= MODEL_RETRY_DELAYS_MS.length) return;
      const delay = MODEL_RETRY_DELAYS_MS[modelRetryAttempt];
      modelRetryAttempt += 1;
      modelRetryTimer = setTimer(() => {
        modelRetryTimer = null;
        if (disposed) return;
        // A retry that could not reach the models step (backend not ready)
        // keeps the chain going until the budget runs out.
        Promise.resolve(refreshSnapshots()).catch(() => {}).then(() => {
          if (isModelListUnavailable(state.modelList)) scheduleModelRetry();
        });
      }, delay);
      modelRetryTimer?.unref?.();
    }

    async function refreshSnapshots(refreshOptions = {}) {
      const includeModels = refreshOptions.includeModels !== false;
      refreshGate.bump();
      const refreshToken = refreshGate.capture();
      if (includeModels) modelsGate.bump();
      const modelsToken = includeModels ? modelsGate.capture() : null;
      const callerCurrent = () => refreshOptions.signal?.aborted !== true
        && (!refreshOptions.guard
          || typeof refreshOptions.guard.isCurrent !== 'function'
          || refreshOptions.guard.isCurrent() === true);
      const runtimeCurrent = () => refreshGate.isCurrent(refreshToken) && callerCurrent();
      const modelsCurrent = () => modelsToken !== null && modelsGate.isCurrent(modelsToken) && callerCurrent();
      // Overtaken by a runtime-only refresh: skip the settings/status commits
      // (the newer read owns them) but still read and commit the catalog.
      const stillUseful = () => runtimeCurrent() || modelsCurrent();
      const commitWhen = (isCurrent, mutation) => {
        if (!isCurrent()) return false;
        if (refreshOptions.guard && typeof refreshOptions.guard.mutate === 'function') {
          return refreshOptions.guard.mutate(mutation);
        }
        mutation();
        return true;
      };
      const commit = (mutation) => commitWhen(runtimeCurrent, mutation);
      const shell = getShell();
      if (!shell) return;
      // Terminal postwork passes noteStep so a slow refresh names its slow call.
      // Untimed callers keep the exact await sequence (no extra microtasks).
      const timed = (step, call) => {
        if (typeof refreshOptions.noteStep !== 'function') return call();
        const startedAt = Date.now();
        return Promise.resolve(call()).finally(() => refreshOptions.noteStep(step, Date.now() - startedAt));
      };

      let settings = null;
      try {
        settings = await timed('getSettings', () => shell.engines.getSettings());
        if (!commit(() => {
          state.localEngines = settings?.localEngines || null;
          state.preferredEngineType = String(settings?.preferredEngineType || '');
          state.accelerationCatalog = settings?.accelerationCatalog || null;
        }) && !stillUseful()) return;
      } catch (_error) {
        // Keep the previous settings snapshot.
      }
      const backendPhase = state.backend?.phase;
      if (backendPhase !== 'ready' && backendPhase !== 'model_unavailable') return;
      if (state.auth?.authenticated !== true) {
        commitWhen(stillUseful, render);
        return;
      }

      let status = null;
      try { status = await timed('statusGet', () => shell.status.get()); } catch (_error) { /* keep null */ }
      if (!commit(() => { state.status = status; }) && !stillUseful()) return;

      let fullRender = false;
      if (includeModels) {
        let models = null;
        let modelsReadSucceeded = false;
        try {
          models = await timed('modelsList', () => shell.models.list());
          modelsReadSucceeded = true;
        } catch (_error) { /* keep null */ }
        const unavailable = !modelsReadSucceeded || isModelListUnavailable(models);
        // Scheduled even when a newer refresh wins the commit: the retry
        // re-reads whatever the newest catalog is, so it cannot do harm.
        if (unavailable) scheduleModelRetry();
        if (!commitWhen(modelsCurrent, () => { state.modelList = models; })) return;
        const signature = catalogSignature(models);
        fullRender = (catalogDegraded && !unavailable)
          || (signature !== null && signature !== lastCatalogSignature);
        if (signature !== null) lastCatalogSignature = signature;
        catalogDegraded = unavailable;
        if (!unavailable) {
          clearModelRetry();
          modelRetryAttempt = 0;
        }
        if (modelsReadSucceeded) {
          try { onModelsUpdated?.(models); } catch (_error) { /* optional consumer */ }
        }
      }

      if (!includeModels) {
        const pollSignature = JSON.stringify([settings, status]);
        if (pollSignature === lastPollSignature) {
          return;
        }
        if (!commit(() => { lastPollSignature = pollSignature; })) return;
      }
      commitWhen(stillUseful, fullRender && onModelCatalogRecovered ? onModelCatalogRecovered : render);
    }

    // Picker openings refresh ChatGPT metadata and retry unavailable local lists.
    // The host catalog owns discovery TTL/backoff; this gesture re-arms local retries.
    function refreshModelsIfUnavailable() {
      const chatgpt = state.modelList?.engine_type === 'chatgpt'
        || state.preferredEngineType === 'chatgpt';
      if (disposed || (!chatgpt && !isModelListUnavailable(state.modelList))) return Promise.resolve(false);
      if (userRefreshInFlight) return userRefreshInFlight;
      clearModelRetry();
      modelRetryAttempt = 0;
      userRefreshInFlight = Promise.resolve(refreshSnapshots())
        .catch(() => {})
        .then(() => {
          // Same rule as a timed retry: a read that never reached the models
          // step (backend not ready) keeps the backoff going.
          if (isModelListUnavailable(state.modelList)) scheduleModelRetry();
          return true;
        })
        .finally(() => { userRefreshInFlight = null; });
      return userRefreshInFlight;
    }

    function dispose() {
      disposed = true;
      clearModelRetry();
      if (api.instance === controller) api.instance = null;
    }

    const controller = { refreshSnapshots, refreshModelsIfUnavailable, dispose };
    // The model pickers (both panes) reach the app's refresher through this.
    api.instance = controller;
    return controller;
  }

  const api = { createSnapshotRefresh, isModelListUnavailable, MODEL_RETRY_DELAYS_MS, instance: null };
  return api;
});
