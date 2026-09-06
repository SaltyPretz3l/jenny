/* renderer/features/renderer-ide-workspace-inventory.js - shared, bounded
 * workspace file-list cache extracted from Quick Open's WIDE-026 remediation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkspaceInventory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RETRY_BACKOFF_MS = 3000;

  function createWorkspaceInventory(deps) {
    const getWorkspaceFsApi = typeof deps?.getWorkspaceFsApi === 'function'
      ? deps.getWorkspaceFsApi
      : () => null;
    const now = typeof deps?.now === 'function' ? deps.now : () => Date.now();
    const onListError = typeof deps?.onListError === 'function' ? deps.onListError : () => {};

    let cachedResult = null;
    let loadingPromise = null;
    let cacheEpoch = 1;
    let loadFailed = false;
    let lastFailureAt = 0;
    let disposed = false;
    const pendingChanges = new Map();
    const counters = {
      listCalls: 0,
      cacheHits: 0,
      invalidations: 0,
    };

    function resultShape(result = null, failed = loadFailed) {
      const truncated = result?.truncated === true;
      return {
        files: Array.isArray(result?.files) ? result.files : [],
        truncated,
        complete: truncated !== true,
        ignoreSource: result?.ignoreSource,
        rootId: result?.rootId,
        generation: result?.generation,
        failed,
      };
    }

    function currentResult() {
      return cachedResult || resultShape(null);
    }

    function mergeChangesIntoFiles(files, changeMap) {
      const set = new Set(files);
      for (const [relPath, kind] of changeMap) {
        if (kind === 'deleted') {
          set.delete(relPath);
        } else {
          set.add(relPath);
        }
      }
      return [...set];
    }

    function invalidate() {
      cacheEpoch += 1;
      cachedResult = null;
      loadingPromise = null;
      loadFailed = false;
      lastFailureAt = 0;
      pendingChanges.clear();
      counters.invalidations += 1;
    }

    function handleExternalChanges(changes, { truncated = false } = {}) {
      if (disposed) {
        return;
      }
      if (truncated) {
        invalidate();
        return;
      }
      const list = Array.isArray(changes) ? changes : [];
      if (!list.length) {
        return;
      }
      for (const change of list) {
        const relPath = String(change?.relPath || '');
        if (!relPath) continue;
        pendingChanges.set(relPath, change?.kind === 'deleted' ? 'deleted' : 'changed');
      }
      if (loadingPromise || !cachedResult) {
        return;
      }
      cachedResult.files = mergeChangesIntoFiles(cachedResult.files, pendingChanges);
      pendingChanges.clear();
    }

    async function fetchFiles(api, epoch) {
      loadFailed = false;
      try {
        counters.listCalls += 1;
        const result = await api.listAllFiles();
        if (epoch !== cacheEpoch) return currentResult();
        let files = Array.isArray(result?.files) ? result.files : [];
        if (pendingChanges.size) {
          files = mergeChangesIntoFiles(files, pendingChanges);
          pendingChanges.clear();
        }
        cachedResult = resultShape({ ...result, files }, false);
        return cachedResult;
      } catch (error) {
        if (epoch !== cacheEpoch) return currentResult();
        cachedResult = null;
        loadFailed = true;
        lastFailureAt = now();
        onListError(error);
        return currentResult();
      }
    }

    // True when getFiles() will answer without starting a new bridge listing:
    // a live snapshot, a fetch already in flight, or a backoff window still open.
    // Callers use it to decide whether to clear their rendered rows for a
    // loading state - control flow must not read the stats() counters, which
    // exist only for benchmarks.
    function isResolvedWithoutListing() {
      if (cachedResult || loadingPromise) return true;
      return loadFailed && (now() - lastFailureAt) < RETRY_BACKOFF_MS;
    }

    async function getFiles() {
      if (cachedResult) {
        counters.cacheHits += 1;
        return cachedResult;
      }
      if (loadingPromise) {
        counters.cacheHits += 1;
        return loadingPromise;
      }
      if (loadFailed && (now() - lastFailureAt) < RETRY_BACKOFF_MS) {
        counters.cacheHits += 1;
        return currentResult();
      }
      const api = getWorkspaceFsApi();
      if (typeof api?.listAllFiles !== 'function') {
        cachedResult = resultShape(null, false);
        return cachedResult;
      }
      const epoch = cacheEpoch;
      let resolveRequest;
      let rejectRequest;
      const request = new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      loadingPromise = request;
      fetchFiles(api, epoch).then(resolveRequest, rejectRequest);
      const clearLoading = () => {
        if (epoch === cacheEpoch && loadingPromise === request) {
          loadingPromise = null;
        }
      };
      request.then(clearLoading, clearLoading);
      return request;
    }

    function dispose() {
      invalidate();
      disposed = true;
    }

    function stats() {
      return {
        listCalls: counters.listCalls,
        cacheHits: counters.cacheHits,
        invalidations: counters.invalidations,
        fileCount: cachedResult?.files.length || 0,
      };
    }

    return {
      getFiles,
      handleExternalChanges,
      isResolvedWithoutListing,
      invalidate,
      dispose,
      stats,
    };
  }

  return {
    createWorkspaceInventory,
  };
});
