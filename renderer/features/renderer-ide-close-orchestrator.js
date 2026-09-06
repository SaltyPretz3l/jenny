/* renderer/features/renderer-ide-close-orchestrator.js
 *
 * Async layer over the controller's synchronous force-close primitive. Every
 * user-initiated tab close (×, middle-click, Ctrl+F4, context Close / Close
 * Others / Close All / Close Saved) routes here so dirty buffers get a single
 * batched Save / Don't Save / Cancel prompt instead of being discarded
 * silently.
 *
 * Filesystem rename/delete flows use the non-destructive preflight/commit API:
 * discard is enacted only after the owning backend mutation succeeds. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeCloseOrchestrator = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  function createIdeCloseOrchestrator(deps) {
    const options = deps || {};
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const isDirty = typeof options.isDirty === 'function' ? options.isDirty : () => false;
    const isDiffTabId = typeof options.isDiffTabId === 'function' ? options.isDiffTabId : () => false;
    const isPreviewTabId = typeof options.isPreviewTabId === 'function' ? options.isPreviewTabId : () => false;
    const forceClose = typeof options.forceClose === 'function' ? options.forceClose : noop;
    const saveFile = typeof options.saveFile === 'function' ? options.saveFile : () => Promise.resolve(false);
    const getDocumentRevision = typeof options.getDocumentRevision === 'function' ? options.getDocumentRevision : () => null;
    const confirmClose = typeof options.confirmClose === 'function'
      ? options.confirmClose
      : () => Promise.resolve('discard');

    // One preflight at a time. Keep the guard through Save, not just while the
    // modal is open: a second mutation must not race a deferred write.
    let inFlight = false;
    const pendingPlans = new WeakSet();

    function openTabPaths() {
      return (getIde().openTabs || []).map((tab) => tab.path);
    }

    // Bulk closes (Close Others / Close All) spare pinned tabs - a pin marks a
    // tab the user wants to keep. Filter the tab objects directly (one pass; no
    // path -> re-lookup) and project to paths.
    function unpinnedPaths(extraFilter = () => true) {
      return (getIde().openTabs || [])
        .filter((tab) => tab.pinned !== true && extraFilter(tab))
        .map((tab) => tab.path);
    }

    function dirtySubset(paths) {
      return paths.filter((path) => !isDiffTabId(path) && !isPreviewTabId(path) && isDirty(path));
    }

    // Cheap read of the currently-dirty, closable (non-diff/preview) tabs.
    // Surfaced so the window-exit coordinator can skip the whole prompt path
    // when nothing is unsaved, without re-deriving the dirty set itself.
    function getDirtyPaths() {
      return dirtySubset(openTabPaths());
    }

    function normalizePaths(paths) {
      const seen = new Set();
      const normalized = [];
      for (const value of Array.isArray(paths) ? paths : []) {
        const path = String(value || '');
        if (!path || seen.has(path)) {
          continue;
        }
        seen.add(path);
        normalized.push(path);
      }
      return normalized;
    }

    function failedPreflight(code, extra = {}) {
      return {
        ready: false,
        committed: false,
        canceled: extra.canceled === true,
        blocked: extra.blocked === true,
        code,
        paths: Array.isArray(extra.paths) ? [...extra.paths] : [],
        dirtyPaths: Array.isArray(extra.dirtyPaths) ? [...extra.dirtyPaths] : [],
        ...(extra.failedPath ? { failedPath: extra.failedPath } : {}),
      };
    }

    // Preflight is intentionally non-destructive. Save is safe to perform now,
    // but discard/close stays represented only by the returned single-use plan
    // until the caller explicitly commits after its owning mutation succeeds.
    async function preflight(paths, { allowPrompt = true } = {}) {
      if (inFlight) {
        return failedPreflight('close_preflight_in_progress', { blocked: true });
      }
      const closing = normalizePaths(paths);
      const revisions = new Map(closing.map((path) => [path, getDocumentRevision(path)]));
      const dirtyPaths = allowPrompt ? dirtySubset(closing) : [];
      let decision = dirtyPaths.length ? '' : 'clean';
      inFlight = true;
      try {
        if (dirtyPaths.length) {
          decision = await confirmClose({ dirtyPaths: [...dirtyPaths] });
          if (decision === 'cancel') {
            return failedPreflight('user_canceled', {
              canceled: true,
              paths: closing,
              dirtyPaths,
            });
          }
          if (decision !== 'save' && decision !== 'discard') {
            return failedPreflight('invalid_close_decision', {
              canceled: true,
              paths: closing,
              dirtyPaths,
            });
          }
          if (decision === 'save') {
            for (const path of dirtyPaths) {
              let saved = false;
              try {
                saved = await saveFile(path) === true;
              } catch (_error) {
                saved = false;
              }
              if (!saved) {
                return failedPreflight('save_failed', {
                  canceled: true,
                  paths: closing,
                  dirtyPaths,
                  failedPath: path,
                });
              }
            }
          }
        }
        const plan = {
          ready: true,
          committed: false,
          canceled: false,
          blocked: false,
          decision,
          paths: closing,
          dirtyPaths: [...dirtyPaths],
          revisions,
        };
        pendingPlans.add(plan);
        return plan;
      } finally {
        inFlight = false;
      }
    }

    function commit(plan) {
      if (!plan || typeof plan !== 'object' || !pendingPlans.has(plan) || plan.ready !== true) {
        return { committed: false, code: 'invalid_preflight', closedPaths: [] };
      }
      pendingPlans.delete(plan);
      for (const path of plan.paths) {
        if (!Object.is(getDocumentRevision(path), plan.revisions.get(path))) {
          return { committed: false, code: 'document_changed', changedPath: path, closedPaths: [] };
        }
      }
      const closedPaths = [];
      try {
        for (const path of plan.paths) {
          forceClose(path);
          closedPaths.push(path);
        }
      } catch (_error) {
        return { committed: false, code: 'close_failed', closedPaths };
      }
      plan.committed = true;
      return { committed: true, closedPaths };
    }

    function cancel(plan) {
      if (!plan || typeof plan !== 'object' || !pendingPlans.has(plan)) {
        return { canceled: false, code: 'invalid_preflight' };
      }
      pendingPlans.delete(plan);
      return { canceled: true };
    }

    async function runCloseFlow(paths, options = {}) {
      const plan = await preflight(paths, options);
      if (!plan.ready) {
        return plan;
      }
      return commit(plan);
    }

    function requestClose(path) {
      const normalized = String(path || '');
      if (!normalized) {
        return Promise.resolve();
      }
      return runCloseFlow([normalized]);
    }

    function requestCloseOthers(path) {
      const keep = String(path || '');
      return runCloseFlow(unpinnedPaths((tab) => tab.path !== keep));
    }

    function requestCloseAll() {
      return runCloseFlow(unpinnedPaths());
    }

    // Close clean, non-diff tabs without prompting because no unsaved content can be lost.
    function requestCloseSaved() {
      const paths = openTabPaths().filter((path) => !isDiffTabId(path) && !isDirty(path));
      return runCloseFlow(paths, { allowPrompt: false });
    }

    return {
      preflight,
      commit,
      cancel,
      openTabPaths,
      getDirtyPaths,
      requestClose,
      requestCloseOthers,
      requestCloseAll,
      requestCloseSaved,
    };
  }

  return { createIdeCloseOrchestrator };
});
