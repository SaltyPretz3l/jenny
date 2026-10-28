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

    // Watcher changes carry no file/folder kind. A delete drops the path and
    // everything under it; a change to a path the list already knows is a file
    // edit (no-op). A change to an unknown path may be a new file or a folder,
    // so the list is reported incomplete instead of guessing.
    function applyChanges(files, changeMap) {
      const set = new Set(files);
      const deleted = new Set();
      let complete = true;
      for (const [relPath, kind] of changeMap) {
        if (kind === 'deleted') deleted.add(relPath);
        else if (!set.has(relPath)) complete = false;
      }
      if (!deleted.size) return { files: [...set], complete };
      // One pass over the list (a batch can hold hundreds of deletes): a file
      // goes when it or any ancestor folder was deleted.
      const kept = [];
      for (const path of set) {
        let gone = deleted.has(path);
        for (let cut = path.lastIndexOf('/'); !gone && cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
          gone = deleted.has(path.slice(0, cut));
        }
        if (!gone) kept.push(path);
      }
      return { files: kept, complete };
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
      // Nothing cached and nothing loading: the next listing is fresh anyway.
      if (!list.length || (!cachedResult && !loadingPromise)) {
        return;
      }
      for (const change of list) {
        const relPath = String(change?.relPath || '');
        if (!relPath) continue;
        pendingChanges.set(relPath, change?.kind === 'deleted' ? 'deleted' : 'changed');
      }
      if (loadingPromise) {
        return;
      }
      const patched = applyChanges(cachedResult.files, pendingChanges);
      pendingChanges.clear();
      if (!patched.complete) {
        invalidate();
        return;
      }
      cachedResult.files = patched.files;
    }

    async function fetchFiles(api, epoch) {
      loadFailed = false;
      try {
        counters.listCalls += 1;
        const result = await api.listAllFiles();
        if (epoch !== cacheEpoch) return currentResult();
        let files = Array.isArray(result?.files) ? result.files : [];
        let complete = true;
        if (pendingChanges.size) {
          ({ files, complete } = applyChanges(files, pendingChanges));
          pendingChanges.clear();
        }
        const shaped = resultShape({ ...result, files }, false);
        // An unknown change during the listing: answer this read, re-list the next.
        cachedResult = complete ? shaped : null;
        return shaped;
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
