(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDestructiveUndoUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createDestructiveUndoScheduler(config) {
    const {
      keyFn = function defaultKeyFn(value) { return String(value); },
      registerCleanup = function noopRegisterCleanup() {},
      showToastMessage = function noopShowToast() { return null; },
      dismissToast = function noopDismissToast() {},
    } = config || {};

    const entries = new Map();

    function buildKey(keyParts) {
      const parts = Array.isArray(keyParts) ? keyParts : [keyParts];
      return String(keyFn.apply(null, parts));
    }

    function dropEntry(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      clearTimeout(entry.timeoutId);
      entries.delete(key);
      return entry;
    }

    registerCleanup(function cancelAllDestructiveUndoTimers() {
      entries.forEach(function clearTimer(entry) {
        clearTimeout(entry.timeoutId);
        if (entry.toastId) dismissToast(entry.toastId);
        if (typeof entry.onDisposeCleanup === 'function') {
          try {
            entry.onDisposeCleanup({ reason: 'dispose' });
          } catch (cleanupError) {
            void cleanupError;
          }
        }
      });
      entries.clear();
    });

    function schedule(keyParts, options) {
      const {
        windowMs,
        label = '',
        markPending = function noopMarkPending() {},
        onUndo = function noopOnUndo() {},
        commit = function noopCommit() {},
        onCommitError = function noopOnCommitError() {},
        onDisposeCleanup = null,
        buildToast,
      } = options || {};

      if (!Number.isFinite(windowMs) || windowMs < 0) return false;
      if (typeof buildToast !== 'function') return false;

      const key = buildKey(keyParts);

      if (entries.has(key)) return false;

      function handleUndo() {
        const entry = entries.get(key);
        if (!entry) return;
        clearTimeout(entry.timeoutId);
        entries.delete(key);
        if (entry.toastId) dismissToast(entry.toastId);
        onUndo();
      }

      const undoWindowSeconds = Math.max(1, Math.round(windowMs / 1000));
      const timeoutId = setTimeout(function commitOnTimeout() {
        entries.delete(key);
        Promise.resolve()
          .then(function runCommit() { return commit(); })
          .catch(onCommitError);
      }, windowMs);

      const deadline = Date.now() + windowMs;
      const entry = {
        timeoutId: timeoutId,
        toastId: null,
        handleUndo: handleUndo,
        label: String(label || ''),
        deadline: deadline,
        commit: commit,
        onCommitError: onCommitError,
        onDisposeCleanup: typeof onDisposeCleanup === 'function' ? onDisposeCleanup : null,
      };
      entries.set(key, entry);
      try {
        markPending();
        const toastResult = buildToast({ windowMs: windowMs, undoWindowSeconds: undoWindowSeconds, onUndo: handleUndo });
        entry.toastId = toastResult
          ? showToastMessage(toastResult.message, toastResult.options || {})
          : null;
      } catch (error) {
        dropEntry(key);
        throw error;
      }
      return true;
    }

    /* Run the commit immediately instead of waiting out the undo window
       (e.g. a "Delete now" toast action). */
    function flush(keyParts) {
      const key = buildKey(keyParts);
      const entry = dropEntry(key);
      if (!entry) return false;
      if (entry.toastId) dismissToast(entry.toastId);
      Promise.resolve()
        .then(function runCommit() { return entry.commit(); })
        .catch(entry.onCommitError);
      return true;
    }

    function list() {
      const out = [];
      entries.forEach(function collect(entry, key) {
        out.push({
          key: key,
          label: entry.label,
          deadline: entry.deadline,
          undo: entry.handleUndo,
        });
      });
      return out;
    }

    return { schedule: schedule, flush: flush, list: list };
  }

  return {
    createDestructiveUndoScheduler: createDestructiveUndoScheduler,
  };
});
