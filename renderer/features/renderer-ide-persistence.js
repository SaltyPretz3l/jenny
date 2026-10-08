/* renderer/features/renderer-ide-persistence.js - root/generation-bound IDE
 * persistence. Debounced writes capture an immutable UI snapshot and root
 * context together; root transitions flush and suspend the old context before
 * target selection, then rehydrate or resume only from an authoritative ready
 * context. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePersistence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const PERSIST_DEBOUNCE_MS = 500;
  const HYDRATE_RETRY_DELAYS_MS = Object.freeze([500, 2000, 8000]);
  const ROOT_STATE_KEYS = new Set([
    'openTabs',
    'activeTabPath',
    'expandedDirs',
    'activeStageSurface',
    'previewPath',
    'replaceJournal',
  ]);

  function noop() {}

  function normalizeContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const generation = Number(value.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) return null;
    const rootId = value.rootId === null ? null : String(value.rootId || '').trim();
    if (value.rootId !== null && !rootId) return null;
    const phase = String(value.phase || '');
    if (!['ready', 'transitioning', 'error'].includes(phase)) return null;
    return {
      rootPath: String(value.rootPath || ''),
      rootId,
      generation,
      phase,
    };
  }

  function isNoRootReadyContext(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
      && !String(value.rootPath || '').trim()
      && !String(value.rootId || '').trim()
      && String(value.phase || '') === 'ready';
  }

  function sameRoot(left, right) {
    return Boolean(left && right && left.rootId === right.rootId && left.rootPath === right.rootPath);
  }

  function sameContext(left, right) {
    return sameRoot(left, right) && left.generation === right.generation && left.phase === right.phase;
  }

  function splitPersistedState(value) {
    const rootState = {};
    const preferences = {};
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const [key, entry] of Object.entries(source)) {
      (ROOT_STATE_KEYS.has(key) ? rootState : preferences)[key] = entry;
    }
    return { preferences, rootState };
  }

  function createIdePersistence(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getWorkspaceIdeApi = typeof deps?.getWorkspaceIdeApi === 'function'
      ? deps.getWorkspaceIdeApi
      : () => null;
    const ideStateUtils = deps?.ideStateUtils || {};
    const getTabRestore = typeof deps?.getTabRestore === 'function' ? deps.getTabRestore : () => null;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const showToastMessage = typeof deps?.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const onHydrated = typeof deps?.onHydrated === 'function' ? deps.onHydrated : noop;
    // A hydrate that lands only on a retry (after the view already rendered
    // defaults): the controller repaints and reopens the restored active tab.
    const onLateHydrated = typeof deps?.onLateHydrated === 'function' ? deps.onLateHydrated : noop;
    const onPreferenceCommitted = typeof deps?.onPreferenceCommitted === 'function' ? deps.onPreferenceCommitted : noop;
    const onPreferenceError = typeof deps?.onPreferenceError === 'function' ? deps.onPreferenceError : noop;
    const setTimeoutImpl = typeof deps?.setTimeoutImpl === 'function' ? deps.setTimeoutImpl : setTimeout;
    const clearTimeoutImpl = typeof deps?.clearTimeoutImpl === 'function' ? deps.clearTimeoutImpl : clearTimeout;

    let persistTimer = null;
    let pendingWrite = null;
    let boundContext = null;
    let hydrated = false;
    let suspended = false;
    let dirtyWhileSuspended = false;
    let hydrateInFlight = null;
    let hydrateRetryTimer = null;
    let hydrateFailures = 0;
    let loadFailureNotified = false;
    let disposed = false;
    let hydrationToken = 0;
    let preferenceWriteQueue = Promise.resolve();

    function logFailure(event, error, fallbackCode) {
      appendClientLog('WARN', event, {
        code: String(error?.code || fallbackCode || 'unknown').slice(0, 80),
        message: String(error?.message || '').slice(0, 240),
      });
    }

    function clearPersistTimer() {
      if (persistTimer !== null) clearTimeoutImpl(persistTimer);
      persistTimer = null;
    }

    function captureWrite(context = boundContext) {
      const current = normalizeContext(context);
      const snapshot = ideStateUtils.toPersistedState?.(getIde());
      const persisted = snapshot && (getTabRestore()?.capture(snapshot, getIde()) || snapshot);
      if (!current || current.phase !== 'ready' || !persisted) return null;
      return {
        expectedRootId: current.rootId,
        expectedGeneration: current.generation,
        ...splitPersistedState(persisted),
      };
    }

    async function writeSnapshot(write) {
      const api = getWorkspaceIdeApi();
      if (typeof api?.updateState !== 'function') {
        const error = new Error('Root-aware Workspace IDE persistence is unavailable.');
        error.code = 'workspace_ide_update_unavailable';
        throw error;
      }
      // Keep the captured tab set/root token, but read positions at the write
      // boundary: cursor and scroll can change after the last tab action.
      if (boundContext?.rootId === write.expectedRootId && boundContext?.generation === write.expectedGeneration) {
        write = { ...write, rootState: getTabRestore()?.capture(write.rootState, getIde()) || write.rootState };
      }
      const result = await api.updateState(write);
      if (!result || result.updated !== true) {
        const error = new Error('Workspace IDE persistence refused the captured root context.');
        error.code = String(result?.code || 'workspace_ide_update_refused');
        throw error;
      }
      return result;
    }

    async function flushPersist({ throwOnError = false, force = false } = {}) {
      clearPersistTimer();
      if (disposed) return { updated: false, code: 'disposed' };
      const write = force ? captureWrite() : (pendingWrite || captureWrite());
      pendingWrite = null;
      if (!write) return { updated: false, skipped: true };
      try {
        return await writeSnapshot(write);
      } catch (error) {
        logFailure('ide.persist_failed', error, 'workspace_ide_persist_failed');
        if (throwOnError) throw error;
        return { updated: false, code: String(error?.code || 'workspace_ide_persist_failed') };
      }
    }

    function schedulePersist() {
      if (disposed || !hydrated) return;
      if (suspended) {
        dirtyWhileSuspended = true;
        return;
      }
      pendingWrite = captureWrite();
      if (!pendingWrite) return;
      clearPersistTimer();
      persistTimer = setTimeoutImpl(() => {
        persistTimer = null;
        void flushPersist();
      }, PERSIST_DEBOUNCE_MS);
    }

    // Global editor preferences use the narrow updateSettings seam rather than
    // a root snapshot. Serialize them so rapid contextual actions cannot settle
    // out of order, and project the normalized value into the live IDE slice
    // only after the main process acknowledges the write.
    function commitPreference(key, value) {
      const preferenceKey = String(key || '').trim();
      const operation = preferenceWriteQueue.catch(noop).then(async () => {
        if (disposed) {
          const error = new Error('Workspace IDE preference persistence is disposed.');
          error.code = 'workspace_ide_preference_disposed';
          throw error;
        }
        const api = getWorkspaceIdeApi();
        if (!preferenceKey || typeof api?.updateSettings !== 'function') {
          const error = new Error('Workspace IDE preference persistence is unavailable.');
          error.code = 'workspace_ide_settings_unavailable';
          throw error;
        }
        const result = await api.updateSettings({ [preferenceKey]: value });
        if (!result || result.updated !== true) {
          const error = new Error('Workspace IDE preference update was refused.');
          error.code = String(result?.code || 'workspace_ide_settings_refused');
          throw error;
        }
        if (disposed) {
          return { updated: false, code: 'disposed' };
        }
        const normalizedValue = Object.prototype.hasOwnProperty.call(result, preferenceKey)
          ? result[preferenceKey]
          : value;
        getIde()[preferenceKey] = normalizedValue;
        onPreferenceCommitted(preferenceKey, normalizedValue);
        return { updated: true, key: preferenceKey, value: normalizedValue };
      });
      preferenceWriteQueue = operation;
      return operation.catch((error) => {
        logFailure('ide.preference_persist_failed', error, 'workspace_ide_settings_failed');
        onPreferenceError(preferenceKey, error);
        return { updated: false, code: String(error?.code || 'workspace_ide_settings_failed') };
      });
    }

    function flushIfPending() {
      if (hydrated && !suspended) void flushPersist({ force: true });
      else if (persistTimer !== null || pendingWrite) void flushPersist();
    }

    // A late (retried) hydrate restores the saved layout but must not drop the tabs
    // opened while it was failing: duplicates keep live state in saved order.
    // Dropping them would also orphan a dirty buffer past the exit prompt.
    // Main persists only the first MAX_OPEN_TABS (64) of a saved list, so a live tab
    // appended past the cap would vanish on restart: every live tab stays and the
    // saved-only tabs (never loaded this session) fill the remaining room in order.
    function keepLiveTabs(ide, live) {
      if (!live.tabs.length) return;
      const savedTabs = ide.openTabs || [];
      const saved = new Set(savedTabs.map((tab) => tab.path));
      const liveTabs = new Map(live.tabs.map((tab) => [tab.path, tab]));
      const livePaths = new Set(liveTabs.keys());
      let room = (ideStateUtils.MAX_OPEN_TABS || 64) - livePaths.size;
      ide.openTabs = savedTabs.filter((tab) => livePaths.has(tab.path) || room-- > 0)
        .map((tab) => liveTabs.get(tab.path) || tab)
        .concat(live.tabs.filter((tab) => !saved.has(tab.path)));
      const kept = new Map(ide.openTabs.map((tab) => [tab.path, tab]));
      const primary = (path) => kept.has(path) && !kept.get(path).group;
      if (!primary(ide.activeTabPath)) ide.activeTabPath = primary(live.active)
        ? live.active : (ide.openTabs.find((tab) => !tab.group)?.path || '');
      const savedGroupActive = ide.groupActive || {};
      ide.groupActive = { ...live.groupActive };
      for (const [group, path] of Object.entries(savedGroupActive)) {
        if (kept.get(path)?.group === group) ide.groupActive[group] = path;
      }
      for (const [group, path] of Object.entries(ide.groupActive)) {
        if (kept.get(path)?.group !== group) delete ide.groupActive[group];
      }
    }

    async function hydrateForContext(expectedContext = null, options = {}) {
      const api = getWorkspaceIdeApi();
      if (typeof api?.getState !== 'function') return { hydrated: false, code: 'bridge_unavailable' };
      const expected = normalizeContext(expectedContext);
      const token = ++hydrationToken;
      const persisted = await api.getState();
      if (!persisted || persisted.ok === false) {
        const error = new Error('Workspace IDE state is unavailable for the active root.');
        error.code = String(persisted?.code || 'workspace_ide_state_unavailable');
        throw error;
      }
      const actual = normalizeContext(persisted.context) || expected;
      if (!actual || actual.phase !== 'ready' || (expected && !sameContext(actual, expected))) {
        const error = new Error('Workspace IDE hydrate returned a stale root context.');
        error.code = 'stale_root_context';
        throw error;
      }
      if (disposed || token !== hydrationToken) return { hydrated: false, code: 'superseded' };
      const probed = await getTabRestore()?.probe(persisted);
      if (disposed || token !== hydrationToken) return { hydrated: false, code: 'superseded' };
      clearPersistTimer();
      pendingWrite = null;
      const ide = getIde();
      const live = options.keepLive && ide
        ? { tabs: (ide.openTabs || []).slice(), active: ide.activeTabPath || '', groupActive: { ...(ide.groupActive || {}) } }
        : null;
      ideStateUtils.applyPersistedState?.(ide, probed?.snapshot || persisted);
      if (live) keepLiveTabs(ide, live);
      getTabRestore()?.hydrate(probed?.snapshot || persisted, probed?.missing);
      if (Number.isFinite(persisted.evictedRootCount) && persisted.evictedRootCount > 0) {
        showToastMessage(
          jt('ide.persistence.evictedWorkspace', "Workspace memory for an older folder was released to make room — its open tabs won't be restored there."),
          { dedupeKey: 'ide:root-lru-evicted', sticky: false }
        );
      }
      boundContext = actual;
      hydrated = true;
      suspended = false;
      dirtyWhileSuspended = false;
      onHydrated(getIde(), actual);
      return { hydrated: true, context: { ...actual } };
    }

    function clearHydrateRetryTimer() {
      if (hydrateRetryTimer !== null) clearTimeoutImpl(hydrateRetryTimer);
      hydrateRetryTimer = null;
    }

    function onHydrateFailed() {
      if (disposed) return;
      hydrateFailures += 1;
      const delay = HYDRATE_RETRY_DELAYS_MS[hydrateFailures - 1];
      if (delay !== undefined) {
        hydrateRetryTimer = setTimeoutImpl(() => {
          hydrateRetryTimer = null;
          void hydratePersistedState();
        }, delay);
        return;
      }
      if (loadFailureNotified) return;
      loadFailureNotified = true;
      showToastMessage(
        jt('ide.persistence.loadFailed', "Workspace layout couldn't be loaded. Panel changes in this session won't be saved."),
        { dedupeKey: 'ide:persistence-load-failed', sticky: false }
      );
    }

    function hydratePersistedState() {
      if (hydrated) return Promise.resolve({ hydrated: true, context: { ...boundContext } });
      if (hydrateInFlight) return hydrateInFlight;
      clearHydrateRetryTimer();
      hydrateInFlight = (async () => {
        try {
          const result = await hydrateForContext(null, { keepLive: hydrateFailures > 0 });
          if (result.hydrated && hydrateFailures > 0) {
            hydrateFailures = 0;
            onLateHydrated(getIde());
          }
          return result;
        } catch (error) {
          logFailure('ide.hydrate_failed', error, 'workspace_ide_hydrate_failed');
          onHydrateFailed();
          return { hydrated: false, code: String(error?.code || 'workspace_ide_hydrate_failed') };
        } finally {
          hydrateInFlight = null;
        }
      })();
      return hydrateInFlight;
    }

    async function prepareTransition(context) {
      const expected = normalizeContext(context);
      if (!expected || expected.phase !== 'ready') {
        // A no-root origin (blank rootPath/rootId, e.g. first-run before any
        // workspace root exists) is a valid transition start with nothing
        // bound to flush: suspend writes and let settle rebind.
        if (isNoRootReadyContext(context)) {
          suspended = true;
          return { updated: false, skipped: true };
        }
        const error = new Error('Workspace root transition has no ready persistence context.');
        error.code = 'invalid_root_context';
        throw error;
      }
      if (!hydrated) {
        // A root switch supersedes a pending retry for the old root: the commit
        // path hydrates the new root itself.
        clearHydrateRetryTimer();
        hydrateFailures = 0;
        suspended = true;
        return { updated: false, skipped: true };
      }
      if (!sameContext(boundContext, expected)) {
        const error = new Error('Workspace IDE state is bound to a different root context.');
        error.code = 'stale_root_context';
        throw error;
      }
      suspended = true;
      dirtyWhileSuspended = false;
      pendingWrite = captureWrite(expected);
      return flushPersist({ throwOnError: true });
    }

    async function settleContext(context, { committed = false } = {}) {
      const settled = normalizeContext(context);
      if (!settled || settled.phase !== 'ready') {
        suspended = true;
        return { settled: false, code: settled?.phase === 'error' ? 'root_recovery_required' : 'invalid_root_context' };
      }
      if (!hydrated) {
        boundContext = settled;
        suspended = false;
        dirtyWhileSuspended = false;
        // Only after a failed hydrate: a settled context is a good moment to retry now.
        if (hydrateFailures > 0) void hydratePersistedState();
        return { settled: true, hydrated: false, context: { ...settled } };
      }
      if (!sameRoot(boundContext, settled)
        || (committed && boundContext.generation !== settled.generation)) {
        try {
          return await hydrateForContext(settled);
        } catch (error) {
          suspended = true;
          logFailure('ide.root_rehydrate_failed', error, 'workspace_ide_hydrate_failed');
          return { settled: false, code: String(error?.code || 'workspace_ide_hydrate_failed') };
        }
      }
      boundContext = settled;
      suspended = false;
      const shouldPersist = dirtyWhileSuspended;
      dirtyWhileSuspended = false;
      if (shouldPersist) schedulePersist();
      return { settled: true, hydrated: true, context: { ...settled } };
    }

    function dispose() {
      disposed = true;
      hydrationToken += 1;
      clearPersistTimer();
      clearHydrateRetryTimer();
      pendingWrite = null;
    }

    function getState() {
      return {
        boundContext: boundContext ? { ...boundContext } : null,
        dirtyWhileSuspended,
        disposed,
        hydrated,
        pending: persistTimer !== null || Boolean(pendingWrite),
        suspended,
      };
    }

    return {
      dispose,
      commitPreference,
      flushIfPending,
      flushPersist,
      getState,
      hydrateForContext,
      hydratePersistedState,
      prepareTransition,
      schedulePersist,
      settleContext,
    };
  }

  return {
    PERSIST_DEBOUNCE_MS,
    createIdePersistence,
    normalizeContext,
    splitPersistedState,
  };
});
