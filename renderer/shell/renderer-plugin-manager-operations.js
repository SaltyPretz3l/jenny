(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); return; }
  root.rendererPluginManagerOperations = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function createOperationCoordinator(deps) {
    var options = deps || {};
    var active = null;
    var disposed = false;

    async function run(key, operation) {
      if (disposed || active) return { ok: false, reason: 'operation_busy' };
      active = key;
      options.onChanged?.(active);
      try { return await operation(); }
      finally {
        active = null;
        if (!disposed) options.onChanged?.('');
      }
    }

    return Object.freeze({
      run: run,
      busy: function () { return Boolean(active); },
      active: function () { return active || ''; },
      dispose: function () { disposed = true; active = null; },
    });
  }

  return Object.freeze({ createOperationCoordinator: createOperationCoordinator });
});
