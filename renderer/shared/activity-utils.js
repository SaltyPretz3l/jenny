(function exposeActivityUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(globalScope);
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.activityUtils = factory(globalScope);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function activityUtilsFactory(globalScope) {
  var CLEAR_AFTER_SETTLE_MS = 180;
  var DEFAULT_SETTLE_MS = {
    subtle: 600,
    visible: 1200,
    strong: 1200,
  };
  function normalizeScope(scope) {
    return String(scope || '').trim();
  }

  function normalizeEmphasis(emphasis) {
    var token = String(emphasis || '').trim().toLowerCase();
    if (token === 'visible' || token === 'strong') {
      return token;
    }
    return 'subtle';
  }

  function normalizeDuration(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return Number(fallback || 0);
    }
    return Math.round(parsed);
  }

  function cloneSnapshot(entry, reducedMotion) {
    if (!entry) {
      return null;
    }
    return {
      scope: entry.scope,
      state: entry.state,
      emphasis: entry.emphasis,
      startedAt: entry.startedAt,
      message: entry.message,
      previousValue: entry.previousValue,
      autoClearMs: entry.autoClearMs,
      reducedMotion: Boolean(reducedMotion),
    };
  }

  function createActivityRegistry(options) {
    var settings = options || {};
    var registry = new Map();
    var nowFn = typeof settings.now === 'function' ? settings.now : function defaultNow() {
      return Date.now();
    };
    var setTimeoutFn = typeof settings.setTimeout === 'function' ? settings.setTimeout : setTimeout;
    var clearTimeoutFn = typeof settings.clearTimeout === 'function' ? settings.clearTimeout : clearTimeout;
    var matchMediaFn = typeof settings.matchMedia === 'function'
      ? settings.matchMedia
      : function defaultMatchMedia(query) {
          return globalScope && typeof globalScope.matchMedia === 'function'
            ? globalScope.matchMedia(query)
            : null;
        };
    var changeListener = typeof settings.onChange === 'function' ? settings.onChange : null;

    function isReducedMotionEnabled() {
      var media = matchMediaFn('(prefers-reduced-motion: reduce)');
      return Boolean(media && media.matches);
    }

    function emit(scope, reason) {
      if (typeof changeListener !== 'function') {
        return;
      }
      changeListener(scope, getActivitySnapshot(scope), { reason: String(reason || '') });
    }

    function clearTimers(entry) {
      if (!entry) {
        return;
      }
      if (entry.settleTimer) {
        clearTimeoutFn(entry.settleTimer);
        entry.settleTimer = 0;
      }
      if (entry.clearTimer) {
        clearTimeoutFn(entry.clearTimer);
        entry.clearTimer = 0;
      }
    }

    function getActivitySnapshot(scope) {
      return cloneSnapshot(registry.get(normalizeScope(scope)) || null, isReducedMotionEnabled());
    }

    function getMostRecentActivity(scopes) {
      var winning = null;
      var list = Array.isArray(scopes) ? scopes : [];
      for (var index = 0; index < list.length; index += 1) {
        var snapshot = getActivitySnapshot(list[index]);
        if (!snapshot || snapshot.state === 'idle') {
          continue;
        }
        if (!winning || Number(snapshot.startedAt || 0) > Number(winning.startedAt || 0)) {
          winning = snapshot;
        }
      }
      return winning;
    }

    function scheduleSettle(scope, entry) {
      if (!entry || entry.state === 'idle') {
        return;
      }
      var settleMs = normalizeDuration(entry.autoClearMs, DEFAULT_SETTLE_MS[entry.emphasis]);
      entry.settleTimer = setTimeoutFn(function handleSettle() {
        var current = registry.get(scope);
        if (current !== entry) {
          return;
        }
        current.state = 'settle';
        emit(scope, 'settle');
        current.clearTimer = setTimeoutFn(function handleClear() {
          clearActivity(scope);
        }, CLEAR_AFTER_SETTLE_MS);
      }, settleMs);
    }

    function beginActivity(scope, options) {
      var resolvedScope = normalizeScope(scope);
      if (!resolvedScope) {
        return null;
      }
      var previous = registry.get(resolvedScope);
      clearTimers(previous);
      var settingsForEntry = options || {};
      var entry = {
        scope: resolvedScope,
        state: 'pending',
        emphasis: normalizeEmphasis(settingsForEntry.emphasis),
        startedAt: nowFn(),
        message: String(settingsForEntry.message || '').trim(),
        previousValue: settingsForEntry.previousValue,
        autoClearMs: normalizeDuration(
          settingsForEntry.autoClearMs,
          DEFAULT_SETTLE_MS[normalizeEmphasis(settingsForEntry.emphasis)]
        ),
        settleTimer: 0,
        clearTimer: 0,
      };
      registry.set(resolvedScope, entry);
      emit(resolvedScope, 'begin');
      return getActivitySnapshot(resolvedScope);
    }

    function updateActivity(scope, patch) {
      var resolvedScope = normalizeScope(scope);
      var entry = registry.get(resolvedScope);
      if (!entry) {
        return null;
      }
      var nextPatch = patch || {};
      if (Object.prototype.hasOwnProperty.call(nextPatch, 'message')) {
        entry.message = String(nextPatch.message || '').trim();
      }
      if (Object.prototype.hasOwnProperty.call(nextPatch, 'emphasis')) {
        entry.emphasis = normalizeEmphasis(nextPatch.emphasis);
      }
      if (Object.prototype.hasOwnProperty.call(nextPatch, 'autoClearMs')) {
        entry.autoClearMs = normalizeDuration(nextPatch.autoClearMs, DEFAULT_SETTLE_MS[entry.emphasis]);
      }
      if (Object.prototype.hasOwnProperty.call(nextPatch, 'previousValue')) {
        entry.previousValue = nextPatch.previousValue;
      }
      emit(resolvedScope, 'update');
      return getActivitySnapshot(resolvedScope);
    }

    function resolveActivity(scope, options) {
      var resolvedScope = normalizeScope(scope);
      var entry = registry.get(resolvedScope);
      if (!entry) {
        entry = {
          scope: resolvedScope,
          state: 'pending',
          emphasis: 'subtle',
          startedAt: nowFn(),
          message: '',
          previousValue: undefined,
          autoClearMs: DEFAULT_SETTLE_MS.subtle,
          settleTimer: 0,
          clearTimer: 0,
        };
        registry.set(resolvedScope, entry);
      }
      clearTimers(entry);
      var nextOptions = options || {};
      entry.state = 'success';
      entry.message = Object.prototype.hasOwnProperty.call(nextOptions, 'message')
        ? String(nextOptions.message || '').trim()
        : entry.message;
      entry.emphasis = Object.prototype.hasOwnProperty.call(nextOptions, 'emphasis')
        ? normalizeEmphasis(nextOptions.emphasis)
        : entry.emphasis;
      entry.autoClearMs = normalizeDuration(nextOptions.autoClearMs, DEFAULT_SETTLE_MS[entry.emphasis]);
      emit(resolvedScope, 'resolve');
      scheduleSettle(resolvedScope, entry);
      return getActivitySnapshot(resolvedScope);
    }

    function failActivity(scope, options) {
      var resolvedScope = normalizeScope(scope);
      var entry = registry.get(resolvedScope);
      if (!entry) {
        entry = {
          scope: resolvedScope,
          state: 'pending',
          emphasis: 'subtle',
          startedAt: nowFn(),
          message: '',
          previousValue: undefined,
          autoClearMs: DEFAULT_SETTLE_MS.subtle,
          settleTimer: 0,
          clearTimer: 0,
        };
        registry.set(resolvedScope, entry);
      }
      clearTimers(entry);
      var nextOptions = options || {};
      entry.state = 'error';
      entry.message = Object.prototype.hasOwnProperty.call(nextOptions, 'message')
        ? String(nextOptions.message || '').trim()
        : entry.message;
      entry.emphasis = Object.prototype.hasOwnProperty.call(nextOptions, 'emphasis')
        ? normalizeEmphasis(nextOptions.emphasis)
        : entry.emphasis;
      entry.autoClearMs = normalizeDuration(nextOptions.autoClearMs, DEFAULT_SETTLE_MS[entry.emphasis]);
      emit(resolvedScope, 'fail');
      scheduleSettle(resolvedScope, entry);
      return getActivitySnapshot(resolvedScope);
    }

    function clearActivity(scope) {
      var resolvedScope = normalizeScope(scope);
      var entry = registry.get(resolvedScope);
      if (!entry) {
        return false;
      }
      clearTimers(entry);
      registry.delete(resolvedScope);
      emit(resolvedScope, 'clear');
      return true;
    }

    function setChangeListener(listener) {
      changeListener = typeof listener === 'function' ? listener : null;
    }

    return {
      beginActivity: beginActivity,
      clearActivity: clearActivity,
      createActivityRegistry: createActivityRegistry,
      failActivity: failActivity,
      getActivitySnapshot: getActivitySnapshot,
      getMostRecentActivity: getMostRecentActivity,
      isReducedMotionEnabled: isReducedMotionEnabled,
      resolveActivity: resolveActivity,
      setChangeListener: setChangeListener,
      updateActivity: updateActivity,
    };
  }

  var singleton = createActivityRegistry();

  return {
    beginActivity: singleton.beginActivity,
    clearActivity: singleton.clearActivity,
    createActivityRegistry: createActivityRegistry,
    failActivity: singleton.failActivity,
    getActivitySnapshot: singleton.getActivitySnapshot,
    getMostRecentActivity: singleton.getMostRecentActivity,
    isReducedMotionEnabled: singleton.isReducedMotionEnabled,
    resolveActivity: singleton.resolveActivity,
    setChangeListener: singleton.setChangeListener,
    updateActivity: singleton.updateActivity,
  };
});
