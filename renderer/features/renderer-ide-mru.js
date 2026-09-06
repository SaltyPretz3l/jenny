/* renderer/features/renderer-ide-mru.js - runtime MRU of activated file tabs
 * for the Ctrl+E jump list, most-recent first. Extracted from
 * renderer-ide-controller.js (the controller sits at the file-size cap).
 * Non-persisted; recorded from renderTabs (every open/activate/close funnels
 * through it). Diff/preview surfaces are not files, so they never enter the
 * list. getRecentFiles takes the CURRENT openTabs in as a parameter (no
 * closure over controller state). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMru = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Bound the runtime list: closed-tab entries are filtered at read but never
  // evicted at record, so cap well above MAX_OPEN_TABS (64) to keep it from
  // growing across a long session.
  const MRU_CAP = 128;

  function createIdeMru(deps) {
    const isDiffTabId = typeof deps?.isDiffTabId === 'function' ? deps.isDiffTabId : () => false;
    const isPreviewTabId = typeof deps?.isPreviewTabId === 'function' ? deps.isPreviewTabId : () => false;
    const mruPaths = [];

    // Move the active file tab to the front of the runtime MRU.
    function record(path) {
      const normalized = String(path || '');
      if (!normalized || isDiffTabId(normalized) || isPreviewTabId(normalized)) {
        return;
      }
      const index = mruPaths.indexOf(normalized);
      if (index !== -1) {
        mruPaths.splice(index, 1);
      }
      mruPaths.unshift(normalized);
      if (mruPaths.length > MRU_CAP) {
        mruPaths.length = MRU_CAP;
      }
    }

    // Most-recent-first paths that are still open (openTabs = [{ path }]).
    function getRecentFiles(openTabs) {
      const open = new Set((Array.isArray(openTabs) ? openTabs : []).map((tab) => tab && tab.path));
      return mruPaths.filter((path) => open.has(path));
    }

    function clear() {
      mruPaths.length = 0;
    }

    return { record, getRecentFiles, clear };
  }

  return { createIdeMru };
});
