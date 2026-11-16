(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDestructiveUndoUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* The Undo window is the toast's clock (held on hover); the toast leaving
     for any reason commits, except after Undo drops the entry. */
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
      clearTimeout(entry.fallbackTimer);
      entries.delete(key);
      return entry;
    }

    function commitEntry(key) {
      const entry = dropEntry(key);
      if (!entry) return;
      Promise.resolve()
        .then(function runCommit() { return entry.commit(); })
        .catch(entry.onCommitError);
    }

    registerCleanup(function cancelAllDestructiveUndoTimers() {
      const pending = [...entries.values()];
      entries.clear();
      pending.forEach(function clearEntry(entry) {
        clearTimeout(entry.fallbackTimer);
        if (entry.toastId) dismissToast(entry.toastId);
        if (typeof entry.onDisposeCleanup === 'function') {
          try {
            entry.onDisposeCleanup({ reason: 'dispose' });
          } catch (cleanupError) {
            void cleanupError;
          }
        }
      });
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
        const entry = dropEntry(key);
        if (!entry) return;
        if (entry.toastId) dismissToast(entry.toastId);
        onUndo();
      }

      const entry = {
        fallbackTimer: null,
        toastId: null,
        handleUndo: handleUndo,
        label: String(label || ''),
        commit: commit,
        onCommitError: onCommitError,
        onDisposeCleanup: typeof onDisposeCleanup === 'function' ? onDisposeCleanup : null,
      };
      entries.set(key, entry);
      try {
        markPending();
        const undoWindowSeconds = Math.max(1, Math.round(windowMs / 1000));
        const toastResult = buildToast({ windowMs: windowMs, undoWindowSeconds: undoWindowSeconds, onUndo: handleUndo });
        entry.toastId = toastResult
          ? showToastMessage(toastResult.message, {
            ...(toastResult.options || {}),
            // Never sticky, whatever the tone.
            sticky: false,
            durationMs: Math.max(1, windowMs),
            countdown: true,
            onExpire: function commitOnExpire() { commitEntry(key); },
          }) || null
          : null;
      } catch (error) {
        dropEntry(key);
        throw error;
      }
      if (!entry.toastId && entries.has(key)) {
        entry.fallbackTimer = setTimeout(function commitOnTimeout() { commitEntry(key); }, windowMs);
      }
      return true;
    }

    function list() {
      const out = [];
      entries.forEach(function collect(entry, key) {
        out.push({
          key: key,
          label: entry.label,
          undo: entry.handleUndo,
        });
      });
      return out;
    }

    return { schedule: schedule, list: list };
  }

  return {
    createDestructiveUndoScheduler: createDestructiveUndoScheduler,
  };
});
