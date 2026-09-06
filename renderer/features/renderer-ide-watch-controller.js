/* renderer/features/renderer-ide-watch-controller.js
 *
 * External-change watcher for the Workspace IDE (workspaceFs.onChange). Batches
 * are debounced and self-write-suppressed. Clean buffers reload from disk, dirty
 * buffers get a stale badge, and deleted clean buffers close.
 *
 * Degraded lifecycle events retry boundedly, stopped resets the latch, and
 * restarting is ignored. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererIdeWatchController = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

  function noop() {}

  function createIdeWatchController(deps) {
    const options = deps || {};
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const getWorkspaceFsApi = typeof options.getWorkspaceFsApi === 'function'
      ? options.getWorkspaceFsApi
      : () => null;
    const editorHost = options.editorHost || null;
    const fileOperations = options.fileOperations || null;
    const ideStateUtils = options.ideStateUtils || {};
    const showToastMessage = typeof options.showToastMessage === 'function' ? options.showToastMessage : noop;
    const renderTabs = typeof options.renderTabs === 'function' ? options.renderTabs : noop;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const onTreeExternalChanges = typeof options.onTreeExternalChanges === 'function'
      ? options.onTreeExternalChanges
      : noop;
    const refreshChangesPanelIfOpen = typeof options.refreshChangesPanelIfOpen === 'function'
      ? options.refreshChangesPanelIfOpen
      : noop;
    const onExternalDelete = typeof options.onExternalDelete === 'function' ? options.onExternalDelete : noop;
    const onExternalPreviewChange = typeof options.onExternalPreviewChange === 'function'
      ? options.onExternalPreviewChange
      : noop;
    // WIDE-028 retry knobs: injectable for deterministic tests; production
    // defaults give ~1s/2s/4s/8s/16s before the explicit degraded state.
    const setTimeoutImpl = typeof options.setTimeoutImpl === 'function' ? options.setTimeoutImpl : setTimeout;
    const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function' ? options.clearTimeoutImpl : clearTimeout;
    const retryBaseMs = Number.isFinite(options.retryBaseMs) && options.retryBaseMs > 0 ? options.retryBaseMs : 1000;
    const retryMaxAttempts = Number.isSafeInteger(options.retryMaxAttempts) && options.retryMaxAttempts > 0
      ? options.retryMaxAttempts
      : 5;
    const RETRY_DELAY_CAP_MS = 30_000;
    const watchGate = asyncFence.createGenerationGate();

    let watcherActive = false;
    let unsubscribeWatch = null;
    let unsubscribeLifecycle = null;
    let retryTimer = null;
    let retryAttempt = 0;
    let degraded = false;

    async function reconcileExternalChange(change) {
      const requestedPath = ideStateUtils.normalizeIdeRelativePath?.(change?.relPath) || '';
      const path = fileOperations?.resolvePath(requestedPath) || requestedPath;
      if (!path || !editorHost?.hasDocument(path)) {
        return;
      }
      const ide = getIde();
      if (change.kind === 'deleted') {
        if (editorHost.isDirty(path)) {
          ideStateUtils.setTabStale?.(ide, path, true);
          showToastMessage(`${path} was deleted on disk. Its unsaved editor remains open so you can copy the changes.`, {
            dedupeKey: `ide:stale:${path}`,
          });
          renderTabs();
        } else {
          onExternalDelete(path);
        }
        return;
      }
      if (editorHost.isDirty(path)) {
        ideStateUtils.setTabStale?.(ide, path, true);
        showToastMessage(`${path} changed on disk. Your unsaved edits now differ from the file.`, {
          dedupeKey: `ide:stale:${path}`,
        });
        renderTabs();
        return;
      }
      try {
        if (editorHost.getDocumentKind(path) === 'image') {
          if (!fileOperations) return;
          const snapshot = fileOperations.captureReload(path);
          if (!snapshot) return;
          const read = await fileOperations.readImageForReload(snapshot);
          if (read.stale || !read.payload || !fileOperations.canCommitReload(snapshot, read.payload)) {
            ideStateUtils.setTabStale?.(ide, path, true); renderTabs(); return;
          }
          if (!editorHost.openImageDocument(read.payload)
            || !fileOperations.commitReload(snapshot, read.payload)) return;
        } else {
          if (!fileOperations) return;
          const snapshot = fileOperations?.captureReload(path);
          if (!snapshot) return;
          const read = await fileOperations.readForReload(snapshot);
          if (read.stale || !read.payload) {
            if (editorHost.isDirty(path)) {
              ideStateUtils.setTabStale?.(ide, path, true); renderTabs();
            }
            return;
          }
          const applied = await editorHost.openDocument({
            ...read.payload,
            shouldApply: () => fileOperations.canCommitReload(snapshot, read.payload),
            onApplied: () => fileOperations.commitReload(snapshot, read.payload),
          });
          if (!applied) {
            if (editorHost.isDirty(path)) {
              ideStateUtils.setTabStale?.(ide, path, true); renderTabs();
            }
            return;
          }
        }
        if (getIde().activeTabPath === path) {
          editorHost.activateDocument(path);
        }
        ideStateUtils.setTabStale?.(ide, path, false);
        renderTabs();
      } catch (error) {
        appendClientLog('WARN', 'ide.external_reload_failed', {
          message: String(error?.message || error || ''),
        });
      }
    }

    // UIUX-012: the main-process watcher caps a batch at WATCH_MAX_BATCH and
    // marks the rest `truncated: true` — every change past the cap is dropped
    // BEFORE it ever reaches `changes`. An open tab whose change fell outside
    // the cap would otherwise never reconcile until the next unrelated change
    // touched it. Overflow must revalidate the bounded open-tab set instead.
    function revalidateOpenDocuments(skipPaths) {
      const tabs = Array.isArray(getIde().openTabs) ? getIde().openTabs : [];
      for (const tab of tabs) {
        const path = tab && tab.kind === 'file' ? tab.path : null;
        if (path && !skipPaths.has(path)) reconcileExternalChange({ relPath: path, kind: 'changed' });
      }
    }

    function handleExternalChangeBatch(payload) {
      if (fileOperations && !fileOperations.acceptsWatcherPayload(payload)) {
        appendClientLog('DEBUG', 'ide.external_change_stale_context', {});
        return;
      }
      const changes = Array.isArray(payload?.changes) ? payload.changes : [];
      const truncated = payload?.truncated === true;
      onTreeExternalChanges(changes, { truncated });
      const reconciledPaths = new Set();
      for (const change of changes) {
        fileOperations?.noteExternalChange?.(change?.relPath);
        onExternalPreviewChange(change);
        reconcileExternalChange(change);
        reconciledPaths.add(ideStateUtils.normalizeIdeRelativePath?.(change?.relPath) || change?.relPath);
      }
      if (truncated) revalidateOpenDocuments(reconciledPaths);
      // Jenny's tool edits arrive through this same watcher; keep the open
      // changes panel current without any extra plumbing.
      refreshChangesPanelIfOpen();
    }

    function clearRetryTimer() {
      if (retryTimer) {
        clearTimeoutImpl(retryTimer);
        retryTimer = null;
      }
    }

    // Bounded-backoff re-arm after a 'degraded' lifecycle push (or a failing
    // retry). Exhaustion degrades EXPLICITLY: freshness state flips, one toast
    // (deduped) tells the user external changes will not appear, and the log
    // carries the reason. A later manual start() (IDE re-activation, root
    // switch) resets the budget and tries again.
    function scheduleRetry(reason, token) {
      if (!watchGate.isCurrent(token) || retryTimer || degraded) {
        return;
      }
      if (retryAttempt >= retryMaxAttempts) {
        degraded = true;
        appendClientLog('WARN', 'ide.watch_degraded', {
          reason: String(reason || ''),
          attempts: retryAttempt,
        });
        showToastMessage('Workspace file watching is unavailable — external file changes may not appear until you reopen the workspace.', {
          dedupeKey: 'ide:watch:degraded',
        });
        return;
      }
      retryAttempt += 1;
      const delay = Math.min(retryBaseMs * 2 ** (retryAttempt - 1), RETRY_DELAY_CAP_MS);
      retryTimer = setTimeoutImpl(() => {
        retryTimer = null;
        if (watchGate.isCurrent(token)) startWatch({ fromRetry: true, token });
      }, delay);
    }

    function handleWatchLifecycle(payload, token) {
      if (!watchGate.isCurrent(token)) return;
      const phase = String(payload?.phase || '');
      if (phase === 'watching') {
        // Live again (initial start, retry success, or root-switch restart):
        // clear the retry budget and any pending re-arm.
        clearRetryTimer();
        retryAttempt = 0;
        degraded = false;
        watcherActive = true;
        return;
      }
      const reason = String(payload?.reason || '');
      if (phase === 'stopped') {
        // 'restarting' is a root-switch teardown whose 'watching' push follows
        // immediately; a renderer-initiated stop already reset the latch. Only
        // reset the latch so a later activation can re-arm — no auto-retry.
        if (reason !== 'restarting') {
          watcherActive = false;
        }
        return;
      }
      if (phase === 'degraded') {
        // The native watcher died (WIDE-028's silent-stall defect): reset the
        // latch so restart is possible, then retry with bounded backoff.
        watcherActive = false;
        appendClientLog('WARN', 'ide.watch_lifecycle_degraded', { reason });
        scheduleRetry(reason, token);
      }
    }

    function ensureSubscriptions(api, token) {
      if (!unsubscribeWatch && typeof api.onChange === 'function') {
        unsubscribeWatch = api.onChange((payload) => {
          if (watchGate.isCurrent(token)) handleExternalChangeBatch(payload);
        }) || null;
      }
      if (!unsubscribeLifecycle && typeof api.onWatchLifecycle === 'function') {
        unsubscribeLifecycle = api.onWatchLifecycle((payload) => handleWatchLifecycle(payload, token)) || null;
      }
    }

    function startWatch({ fromRetry = false, token = watchGate.capture() } = {}) {
      const api = getWorkspaceFsApi();
      if (!watchGate.isCurrent(token) || watcherActive || typeof api?.watchStart !== 'function') {
        return;
      }
      watcherActive = true;
      ensureSubscriptions(api, token);
      Promise.resolve(api.watchStart()).catch((error) => {
        if (!watchGate.isCurrent(token)) return;
        watcherActive = false;
        appendClientLog('WARN', 'ide.watch_start_failed', {
          message: String(error?.message || error || ''),
        });
        // Root not configured yet is the normal initial case; the next
        // activation retries after the user picks one in Settings. Only a
        // RETRY-path failure keeps consuming the bounded backoff budget.
        if (fromRetry) {
          scheduleRetry('watch_start_failed', token);
        }
      });
    }

    function start() {
      // A manual (re)start re-arms a degraded controller with a fresh budget.
      clearRetryTimer();
      retryAttempt = 0;
      degraded = false;
      startWatch();
    }

    function stop() {
      watchGate.bump();
      clearRetryTimer();
      retryAttempt = 0;
      degraded = false;
      if (unsubscribeWatch) {
        try {
          unsubscribeWatch();
        } catch (_error) {
          /* already gone */
        }
        unsubscribeWatch = null;
      }
      if (unsubscribeLifecycle) {
        try {
          unsubscribeLifecycle();
        } catch (_error) {
          /* already gone */
        }
        unsubscribeLifecycle = null;
      }
      if (!watcherActive) {
        return;
      }
      watcherActive = false;
      const api = getWorkspaceFsApi();
      if (typeof api?.watchStop === 'function') {
        Promise.resolve(api.watchStop()).catch(() => {});
      }
    }

    return { start, stop };
  }

  return { createIdeWatchController };
});
