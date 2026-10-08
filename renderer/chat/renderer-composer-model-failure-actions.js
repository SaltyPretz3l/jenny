/* One document delegation covers the failure actions in every composer pane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/model-load-failure'));
    return;
  }
  root.rendererComposerModelFailureActions = factory(root.jennyModelLoadFailure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultReader) {
  'use strict';

  function bindComposerModelFailureActions(deps) {
    const d = deps || {};
    const reader = d.reader || defaultReader;
    let disposed = false;
    let inFlight = false;
    // The load names the engine that failed, so a llama-server GGUF is not retried on Ollama.
    const loadPayload = (failure) => (failure.engine ? { model: failure.model, engine_type: failure.engine } : failure.model);
    async function onClick(event) {
      const button = event.target?.closest?.('[data-composer-failure-action]');
      if (!button || disposed) return;
      const failure = reader.readModelLoadFailure(d.state.backend);
      if (!failure) return;
      event.preventDefault();
      if (inFlight) return;
      inFlight = true;
      try {
        switch (button.dataset.composerFailureAction) {
          case 'models':
          case 'showFits': return d.openSettingsSection?.('models');
          case 'diagnostics': return d.openLogs?.();
          case 'retry': return await d.loadModel?.(loadPayload(failure));
          case 'loadSmaller': {
            if (typeof d.persistContext !== 'function') return;
            const result = await d.persistContext({ modelId: failure.model, contextLength: reader.retryContext(failure) });
            if (disposed || result?.status !== 'applied') return;
            return await d.loadModel?.(loadPayload(failure));
          }
          default: return;
        }
      } catch (_error) { /* Backend lifecycle owns the failure shown by the composer. */ }
      finally { inFlight = false; }
    }
    d.documentRef.addEventListener('click', onClick);
    d.registerCleanup?.(() => {
      disposed = true;
      d.documentRef.removeEventListener('click', onClick);
    });
  }
  return { bindComposerModelFailureActions };
});
