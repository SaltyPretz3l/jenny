(function exposeToastUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.toastUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function toastUtilsFactory() {
  var _stringUtils = typeof globalThis !== 'undefined' && globalThis.stringUtils
    ? globalThis.stringUtils
    : (typeof require === 'function' ? require('./string-utils') : null);
  if (!_stringUtils || typeof _stringUtils.normalizeString !== 'function') {
    throw new Error('string-utils must load before renderer/shared/toast-utils.js');
  }
  var normalizeString = _stringUtils.normalizeString;
  // Danger stays sticky (0): it reports a user action that failed and must
  // survive until acknowledged. Every other tone expires on its own.
  var DEFAULT_DURATION_BY_TONE = {
    info: 5000,
    success: 4000,
    warning: 8000,
    danger: 0,
  };
  // Entries beyond maxVisible stay queued with their timers running and
  // promote into view as visible ones leave. This bound stops an unattended
  // error loop from growing the queue without limit.
  var HARD_RETENTION_BOUND = 12;
  // A toast paused with only a sliver of time left would otherwise vanish the
  // instant the pointer leaves it.
  var RESUME_FLOOR_MS = 600;

  function normalizeTone(tone) {
    var token = String(tone || '').trim().toLowerCase();
    if (token === 'success' || token === 'warning' || token === 'danger') {
      return token;
    }
    return 'info';
  }

  function normalizeDuration(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return Number(fallback || 0);
    }
    return Math.round(parsed);
  }

  function normalizeActions(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map(function toAction(action, index) {
        var source = action && typeof action === 'object' ? action : {};
        var label = normalizeString(source.label);
        if (!label) {
          return null;
        }
        return {
          id: normalizeString(source.id) || 'toast_action_' + String(index + 1),
          label: label,
          kind: normalizeString(source.kind) === 'primary' ? 'primary' : 'secondary',
        };
      })
      .filter(Boolean);
  }

  function cloneToast(toast) {
    return toast
      ? {
          id: toast.id,
          title: toast.title,
          message: toast.message,
          tone: toast.tone,
          source: toast.source,
          createdAt: toast.createdAt,
          dismissible: toast.dismissible,
          durationMs: toast.durationMs,
          sticky: toast.sticky,
          dedupeKey: toast.dedupeKey,
          repeatCount: toast.repeatCount,
          actions: toast.actions.map(function cloneAction(action) {
            return {
              id: action.id,
              label: action.label,
              kind: action.kind,
            };
          }),
        }
      : null;
  }

  function createToastStore(options) {
    var settings = options || {};
    var maxVisible = Math.max(Number(settings.maxVisible) || 4, 1);
    var nowFn = typeof settings.now === 'function' ? settings.now : function defaultNow() {
      return Date.now();
    };
    var setTimeoutFn = typeof settings.setTimeout === 'function' ? settings.setTimeout : setTimeout;
    var clearTimeoutFn = typeof settings.clearTimeout === 'function' ? settings.clearTimeout : clearTimeout;
    var nextId = 1;
    var toasts = [];
    var timers = new Map();
    var listeners = new Set();
    var paused = false;
    var snapshotCache = null;

    function invalidateSnapshot() {
      snapshotCache = null;
    }

    function getSnapshot() {
      if (!snapshotCache) {
        snapshotCache = toasts.slice(0, maxVisible).map(cloneToast);
      }
      return snapshotCache;
    }

    function getOverflowCount() {
      return Math.max(0, toasts.length - maxVisible);
    }

    function emit() {
      var snapshot = getSnapshot();
      listeners.forEach(function notify(listener) {
        listener(snapshot);
      });
    }

    function clearTimer(id) {
      var timer = timers.get(id);
      if (!timer) {
        return;
      }
      if (timer.handle !== null) {
        clearTimeoutFn(timer.handle);
      }
      timers.delete(id);
    }

    function dismiss(id) {
      var toastId = normalizeString(id);
      if (!toastId) {
        return;
      }
      var nextToasts = toasts.filter(function keepToast(entry) {
        return entry.id !== toastId;
      });
      if (nextToasts.length === toasts.length) {
        return;
      }
      toasts = nextToasts;
      clearTimer(toastId);
      invalidateSnapshot();
      emit();
    }

    function scheduleDismiss(toast) {
      if (!toast || toast.sticky || toast.durationMs <= 0) {
        return;
      }
      clearTimer(toast.id);
      // Enqueued while the stack is hovered: bank the full duration and let
      // resumeAll start the clock.
      if (paused) {
        timers.set(toast.id, { handle: null, startedAt: 0, remainingMs: toast.durationMs });
        return;
      }
      timers.set(toast.id, {
        handle: setTimeoutFn(function handleAutoDismiss() {
          dismiss(toast.id);
        }, toast.durationMs),
        startedAt: nowFn(),
        remainingMs: toast.durationMs,
      });
    }

    function pauseAll() {
      if (paused) {
        return;
      }
      paused = true;
      var at = nowFn();
      timers.forEach(function pauseTimer(timer) {
        if (timer.handle === null) {
          return;
        }
        clearTimeoutFn(timer.handle);
        timer.handle = null;
        timer.remainingMs = Math.max(0, timer.remainingMs - (at - timer.startedAt));
      });
    }

    function resumeAll() {
      if (!paused) {
        return;
      }
      paused = false;
      var at = nowFn();
      timers.forEach(function resumeTimer(timer, toastId) {
        if (timer.handle !== null) {
          return;
        }
        timer.startedAt = at;
        timer.remainingMs = Math.max(timer.remainingMs, RESUME_FLOOR_MS);
        timer.handle = setTimeoutFn(function handleAutoDismiss() {
          dismiss(toastId);
        }, timer.remainingMs);
      });
    }

    function buildToastRecord(input, preservedId, repeatCount) {
      var source = input && typeof input === 'object' ? input : {};
      var tone = normalizeTone(source.tone);
      var defaultDuration = DEFAULT_DURATION_BY_TONE[tone];
      var sticky = Object.prototype.hasOwnProperty.call(source, 'sticky')
        ? Boolean(source.sticky)
        : defaultDuration <= 0;
      var durationMs = sticky ? 0 : normalizeDuration(source.durationMs, defaultDuration);

      return {
        id: preservedId || 'toast_' + String(nextId++),
        title: normalizeString(source.title),
        message: normalizeString(source.message),
        tone: tone,
        source: normalizeString(source.source),
        createdAt: nowFn(),
        dismissible: Object.prototype.hasOwnProperty.call(source, 'dismissible')
          ? Boolean(source.dismissible)
          : true,
        durationMs: durationMs,
        sticky: sticky,
        dedupeKey: normalizeString(source.dedupeKey),
        repeatCount: Math.max(1, Number(repeatCount) || 1),
        actions: normalizeActions(source.actions),
      };
    }

    // Sticky entries are never sacrificed to make room for a newer toast; only
    // the hard retention bound drops anything, and then non-sticky first.
    function enforceRetentionBound() {
      while (toasts.length > HARD_RETENTION_BOUND) {
        var dropIndex = -1;
        for (var index = toasts.length - 1; index >= 0; index -= 1) {
          if (!toasts[index].sticky) {
            dropIndex = index;
            break;
          }
        }
        if (dropIndex === -1) {
          dropIndex = toasts.length - 1;
        }
        clearTimer(toasts[dropIndex].id);
        toasts.splice(dropIndex, 1);
      }
    }

    function enqueue(input) {
      var candidate = input && typeof input === 'object' ? input : {};
      var message = normalizeString(candidate.message);
      if (!message) {
        return '';
      }

      var dedupeKey = normalizeString(candidate.dedupeKey);
      var duplicateIndex = dedupeKey
        ? toasts.findIndex(function matchToast(entry) {
            return entry.dedupeKey === dedupeKey;
          })
        : -1;
      var preservedId = '';
      var repeatCount = 1;

      if (duplicateIndex !== -1) {
        var previous = toasts[duplicateIndex];
        preservedId = previous.id;
        // The same words arriving again is a repeat; different words are a new
        // event that merely shares a coalescing key.
        repeatCount = previous.message === message ? previous.repeatCount + 1 : 1;
        clearTimer(preservedId);
        toasts.splice(duplicateIndex, 1);
      }

      var nextToast = buildToastRecord(candidate, preservedId, repeatCount);
      toasts.unshift(nextToast);
      enforceRetentionBound();
      scheduleDismiss(nextToast);
      invalidateSnapshot();
      emit();
      return nextToast.id;
    }

    function dismissBySource(source) {
      var token = normalizeString(source);
      if (!token) {
        return;
      }
      var removed = false;
      toasts = toasts.filter(function keepToast(entry) {
        if (entry.source !== token) {
          return true;
        }
        removed = true;
        clearTimer(entry.id);
        return false;
      });
      if (removed) {
        invalidateSnapshot();
        emit();
      }
    }

    function dismissAll() {
      if (!toasts.length) {
        return;
      }
      toasts.forEach(function clearEntry(entry) {
        clearTimer(entry.id);
      });
      toasts = [];
      invalidateSnapshot();
      emit();
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') {
        return function noop() {};
      }
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    }

    return {
      dismiss: dismiss,
      dismissAll: dismissAll,
      dismissBySource: dismissBySource,
      enqueue: enqueue,
      getOverflowCount: getOverflowCount,
      getSnapshot: getSnapshot,
      pauseAll: pauseAll,
      resumeAll: resumeAll,
      subscribe: subscribe,
    };
  }

  return {
    createToastStore: createToastStore,
  };
});
