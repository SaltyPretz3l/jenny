(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.rendererStreamPendingCommitUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FALLBACK_COMMIT_TIMEOUT_MS = 32;
  const TIMING_STATE_MAX = 64;

  function createPendingStreamCommitQueue(options) {
    const opts = options || {};
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const commit = typeof opts.commit === 'function' ? opts.commit : function noopCommit() {};
    const requestFrame = typeof opts.requestAnimationFrame === 'function'
      ? opts.requestAnimationFrame
      : (typeof globalRef.requestAnimationFrame === 'function'
        ? globalRef.requestAnimationFrame.bind(globalRef)
        : function fallbackFrame(callback) { return setTimeout(function () { callback(Date.now()); }, 0); });
    const cancelFrame = typeof opts.cancelAnimationFrame === 'function'
      ? opts.cancelAnimationFrame
      : (typeof globalRef.cancelAnimationFrame === 'function'
        ? globalRef.cancelAnimationFrame.bind(globalRef)
        : function fallbackCancel(handle) { clearTimeout(handle); });
    const scheduleTimeout = typeof opts.setTimeout === 'function'
      ? opts.setTimeout
      : (typeof globalRef.setTimeout === 'function' ? globalRef.setTimeout.bind(globalRef) : null);
    const clearScheduledTimeout = typeof opts.clearTimeout === 'function'
      ? opts.clearTimeout
      : (typeof globalRef.clearTimeout === 'function' ? globalRef.clearTimeout.bind(globalRef) : function noopClearTimeout() {});
    const now = typeof opts.now === 'function' ? opts.now : function readNow() { return Date.now(); };
    const configuredMinimumIntervalMs = Number(opts.minimumIntervalMs);
    const minimumIntervalMs = Number.isFinite(configuredMinimumIntervalMs) && configuredMinimumIntervalMs > 0
      ? configuredMinimumIntervalMs
      : 0;
    const entries = new Map();
    const lastCommittedAtByKey = new Map();

    function resolveFallbackDelayMs() {
      const candidate = Number(opts.fallbackDelayMs);
      return Number.isFinite(candidate) && candidate >= 0 ? candidate : FALLBACK_COMMIT_TIMEOUT_MS;
    }

    function clearEntrySchedule(entry) {
      if (!entry) {
        return;
      }
      if (entry.rafId != null) {
        cancelFrame(entry.rafId);
        entry.rafId = null;
      }
      if (entry.timeoutId != null) {
        clearScheduledTimeout(entry.timeoutId);
        entry.timeoutId = null;
      }
    }

    function rememberCommitTime(key) {
      if (!minimumIntervalMs) return;
      if (lastCommittedAtByKey.has(key)) lastCommittedAtByKey.delete(key);
      lastCommittedAtByKey.set(key, now());
      while (lastCommittedAtByKey.size > TIMING_STATE_MAX) {
        lastCommittedAtByKey.delete(lastCommittedAtByKey.keys().next().value);
      }
    }

    function scheduleEntry(key, entry) {
      const lastCommittedAt = lastCommittedAtByKey.get(key);
      const elapsed = Number.isFinite(lastCommittedAt) ? Math.max(0, now() - lastCommittedAt) : minimumIntervalMs;
      const remaining = Math.max(0, minimumIntervalMs - elapsed);
      if (remaining > 0 && scheduleTimeout) {
        entry.timeoutId = scheduleTimeout(function () { flush(key); }, remaining);
        return;
      }
      entry.rafId = requestFrame(function () { flush(key); });
      if (scheduleTimeout && entries.get(key) === entry) {
        entry.timeoutId = scheduleTimeout(function () { flush(key); }, resolveFallbackDelayMs());
      }
    }

    function flush(key) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) {
        return null;
      }
      const entry = entries.get(normalizedKey);
      if (!entry) {
        return null;
      }
      clearEntrySchedule(entry);
      entries.delete(normalizedKey);
      rememberCommitTime(normalizedKey);
      return commit(entry.value);
    }

    function stage(key, value, merger) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) {
        return commitNow(value);
      }
      const existing = entries.get(normalizedKey);
      if (existing) {
        existing.value = typeof merger === 'function'
          ? merger(existing.value, value)
          : value;
        return null;
      }
      const entry = { value, rafId: null, timeoutId: null };
      entries.set(normalizedKey, entry);
      scheduleEntry(normalizedKey, entry);
      return null;
    }

    function peek(key) {
      const normalizedKey = String(key || '').trim();
      const entry = entries.get(normalizedKey);
      return entry ? entry.value : null;
    }

    function commitNow(value) {
      return commit(value);
    }

    function flushWhere(predicate) {
      const matcher = typeof predicate === 'function' ? predicate : function matchNone() { return false; };
      const keys = Array.from(entries.keys());
      const flushed = [];
      keys.forEach((key) => {
        const entry = entries.get(key);
        if (entry && matcher(entry.value, key)) {
          const result = flush(key);
          if (result) {
            flushed.push(result);
          }
        }
      });
      return flushed;
    }

    function drop(key) {
      const normalizedKey = String(key || '').trim();
      const entry = entries.get(normalizedKey);
      clearEntrySchedule(entry);
      entries.delete(normalizedKey);
      lastCommittedAtByKey.delete(normalizedKey);
    }

    function dispose() {
      for (const entry of entries.values()) {
        clearEntrySchedule(entry);
      }
      entries.clear();
      lastCommittedAtByKey.clear();
    }

    return {
      stage,
      peek,
      commitNow,
      flush,
      flushWhere,
      drop,
      dispose,
      pendingCount() {
        return entries.size;
      },
      timingStateCount() {
        return lastCommittedAtByKey.size;
      },
    };
  }

  return {
    createPendingStreamCommitQueue,
  };
});
