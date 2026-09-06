(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHardwareRecommendOperations = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createOperationCoordinator(options) {
    var d = options || {};
    var persistModelStep = typeof d.persistModelStep === 'function'
      ? d.persistModelStep : function () { return Promise.resolve(); };
    var onPersistenceFailure = typeof d.onPersistenceFailure === 'function'
      ? d.onPersistenceFailure : function () {};
    var onModelComplete = typeof d.onModelComplete === 'function'
      ? d.onModelComplete : function () {};
    var locked = false;
    var disposed = true;
    var generation = 0;
    var completionPromise = null;

    function isStale(captured) { return disposed || captured !== generation; }

    function completeModel(persistStep, message) {
      if (completionPromise) return completionPromise;
      var captured = generation;
      var pending = (async function settleModel() {
        if (persistStep) {
          try {
            await persistModelStep();
          } catch (_error) {
            if (!isStale(captured)) onPersistenceFailure();
            return;
          }
        }
        if (!isStale(captured)) onModelComplete(message);
      })();
      completionPromise = pending;
      function clearCompletion() {
        if (completionPromise === pending) completionPromise = null;
      }
      pending.then(clearCompletion, clearCompletion);
      return pending;
    }

    return {
      mount: function mount() {
        disposed = false;
        locked = false;
        completionPromise = null;
        generation += 1;
        return generation;
      },
      dispose: function dispose() {
        disposed = true;
        locked = false;
        completionPromise = null;
        generation += 1;
      },
      acquire: function acquire() {
        if (disposed || locked) return false;
        locked = true;
        return true;
      },
      release: function release(capturedGeneration) {
        if (capturedGeneration === undefined || capturedGeneration === generation) locked = false;
      },
      isLocked: function isLocked() { return locked; },
      capture: function capture() { return generation; },
      isStale: isStale,
      completeModel: completeModel,
    };
  }

  return { createOperationCoordinator: createOperationCoordinator };
});
