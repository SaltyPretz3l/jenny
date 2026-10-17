(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDiagnosticsPage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Shared by the Diagnostics render modules: the markup memo, the status announcer, and the
  // selectors for the view state, the selected launch and the live backend.
  var markupCache = new WeakMap();

  function paintMarkup(node, markup) {
    if (!node || markupCache.get(node) === markup) return false;
    node.innerHTML = markup;
    markupCache.set(node, markup);
    return true;
  }

  // A node changed outside paintMarkup (rows appended, a list rebuilt): its memo no longer
  // describes it, so the next paintMarkup must write.
  function forgetMarkup(node) {
    if (node) markupCache.delete(node);
  }

  function announce(message, signature) {
    var node = document.getElementById('diagnosticsStatusAnnouncer');
    if (!node || node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.textContent = message;
  }

  function diagnosticsState(state) {
    return globalThis.rendererDiagnosticsViewState?.ensureDiagnosticsViewState?.(state) || state.ui.logs;
  }

  function activeRunId(state) {
    return String(state.diagnosticsSnapshot?.active_run?.run_id || '');
  }

  function selectedRunId(state) {
    return diagnosticsState(state).selectedRunId || activeRunId(state);
  }

  // Live shell state wins over the diagnostics status fetched when the view opened, so the
  // headline, health pane and performance summary never disagree about the backend.
  function liveBackend(state) {
    var status = state.diagnosticsStatus || {};
    return state.backend?.phase ? state.backend : (status.backend || state.backend || {});
  }

  return Object.freeze({
    activeRunId: activeRunId,
    announce: announce,
    diagnosticsState: diagnosticsState,
    forgetMarkup: forgetMarkup,
    liveBackend: liveBackend,
    paintMarkup: paintMarkup,
    selectedRunId: selectedRunId,
  });
});
