(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererSnapshotRefresh = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  function createSnapshotRefresh(options = {}) {
    const state = options.state || {};
    const getShell = typeof options.getShell === 'function' ? options.getShell : () => null;
    const render = typeof options.render === 'function' ? options.render : () => {};
    const onModelsUpdated = typeof options.onModelsUpdated === 'function'
      ? options.onModelsUpdated
      : null;
    const refreshGate = asyncFence.createGenerationGate();
    let lastPollSignature = null;

    async function refreshSnapshots(refreshOptions = {}) {
      refreshGate.bump();
      const refreshToken = refreshGate.capture();
      const canCommit = () => refreshGate.isCurrent(refreshToken)
        && refreshOptions.signal?.aborted !== true
        && (!refreshOptions.guard
          || typeof refreshOptions.guard.isCurrent !== 'function'
          || refreshOptions.guard.isCurrent() === true);
      const commit = (mutation) => {
        if (!canCommit()) return false;
        if (refreshOptions.guard && typeof refreshOptions.guard.mutate === 'function') {
          return refreshOptions.guard.mutate(mutation);
        }
        mutation();
        return true;
      };
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
        })) return;
      } catch (_error) {
        // Keep the previous settings snapshot.
      }
      const backendPhase = state.backend?.phase;
      if (backendPhase !== 'ready' && backendPhase !== 'model_unavailable') return;
      if (state.auth?.authenticated !== true) {
        commit(render);
        return;
      }

      let status = null;
      try { status = await timed('statusGet', () => shell.status.get()); } catch (_error) { /* keep null */ }
      if (!commit(() => { state.status = status; })) return;

      if (refreshOptions.includeModels !== false) {
        let models = null;
        let modelsReadSucceeded = false;
        try {
          models = await timed('modelsList', () => shell.models.list());
          modelsReadSucceeded = true;
        } catch (_error) { /* keep null */ }
        if (!commit(() => { state.modelList = models; })) return;
        if (modelsReadSucceeded) {
          try { onModelsUpdated?.(models); } catch (_error) { /* optional consumer */ }
        }
      }

      if (refreshOptions.includeModels === false) {
        const pollSignature = JSON.stringify([settings, status]);
        if (pollSignature === lastPollSignature) {
          return;
        }
        if (!commit(() => { lastPollSignature = pollSignature; })) return;
      }
      commit(render);
    }

    return { refreshSnapshots };
  }

  return { createSnapshotRefresh };
});
