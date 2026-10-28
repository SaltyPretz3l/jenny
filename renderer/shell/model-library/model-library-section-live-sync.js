/* Model Library section › live sync on the app's state tick: the catch-up
 * re-read for a load taken before the backend was ready, and the llama-server
 * status reread (sooner while a server is parked). This helper owns the
 * catch-up budget, the in-flight status read and the parked recheck timer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionLiveSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PARKED_RECHECK_MS = 3000;
  var MAX_CATCH_UP_ATTEMPTS = 5;

  // deps: { windowRef, state, source, sourcesModule, isDisposed(),
  //   accelerationFlagEnabled(), getSourceData(), applyLlamaServer(status),
  //   refresh(), rebuildFromState() }
  function createModelLibrarySectionLiveSync(deps) {
    var d = deps || {};
    var windowRef = d.windowRef;
    var state = d.state || {};
    var source = d.source;
    var catchUpAttempts = 0; // re-reads spent on a read taken before the backend was ready

    // The loaded llama-server status is a snapshot, and nothing pushes its
    // changes. The periodic sync rereads it alone, so a server the chat GPU
    // handoff parked for an image render reads paused, then serving again once
    // it is restored (rechecked sooner while parked).
    var statusReadPending = false;
    var parkedRecheckTimer = null;
    function scheduleParkedRecheck(status) {
      if (d.isDisposed() || parkedRecheckTimer || !status || status.state !== 'stopped' || status.identityRetained !== true) return;
      parkedRecheckTimer = windowRef.setTimeout(function () {
        parkedRecheckTimer = null;
        syncLlamaServerStatus();
      }, PARKED_RECHECK_MS);
    }

    function syncLlamaServerStatus() {
      var bridge = windowRef.jennyShell && windowRef.jennyShell.llamaServer;
      if (d.isDisposed() || statusReadPending || !d.accelerationFlagEnabled() || !d.getSourceData()
        || !bridge || typeof bridge.getStatus !== 'function'
        || typeof d.sourcesModule.normalizeLlamaServer !== 'function') return;
      var generation = source.latestGeneration();
      statusReadPending = true;
      Promise.resolve().then(function () { return bridge.getStatus(); }).then(function (payload) {
        statusReadPending = false;
        var sourceData = d.getSourceData();
        if (d.isDisposed() || !sourceData || generation !== source.latestGeneration()
          || !payload || typeof payload !== 'object' || payload.ok === false) return;
        var next = d.sourcesModule.normalizeLlamaServer(payload);
        scheduleParkedRecheck(next);
        if (JSON.stringify(next) === JSON.stringify(sourceData.llamaServer || null)) return;
        d.applyLlamaServer(next);
      }, function () { statusReadPending = false; });
    }

    // A load taken before the managed sidecar attached (the section binds at
    // boot) left the status line on "not ready" and the hardware unprobed, and
    // the tick only re-merged it. Once the app reads the backend ready and its
    // model list available, the tick re-reads the sources (five times at most).
    function catchUpPendingLoad() {
      var list = state.modelList;
      var sourceData = d.getSourceData();
      if (d.isDisposed() || !sourceData || sourceData.backendPending !== true || catchUpAttempts >= MAX_CATCH_UP_ATTEMPTS
        || state.backend?.phase !== 'ready' || !list || typeof list !== 'object' || list.available === false) return false;
      catchUpAttempts += 1;
      void d.refresh();
      return true;
    }

    // A load that found the backend ready restores the catch-up budget.
    function noteLoad(result) {
      if (result.backendPending !== true) catchUpAttempts = 0;
    }

    function syncFromState() {
      if (catchUpPendingLoad()) return;
      d.rebuildFromState();
      syncLlamaServerStatus();
    }

    function dispose() {
      if (parkedRecheckTimer) windowRef.clearTimeout(parkedRecheckTimer);
      parkedRecheckTimer = null;
    }

    return { syncFromState: syncFromState, noteLoad: noteLoad, dispose: dispose };
  }

  return { createModelLibrarySectionLiveSync: createModelLibrarySectionLiveSync };
});
