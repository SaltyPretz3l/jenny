/**
 * renderer/shell/renderer-error-center-store.js
 *
 * EH-W11 subtle error center: a bounded in-memory FIFO of recent
 * warning/danger errors. The logs page stays the durable record —
 * this store only feeds the health-pill badge and its "Recent
 * errors" popover section. Fully removable: when absent, the pill
 * renders exactly as before (UMD, no DOM).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererErrorCenterStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_MAX_ENTRIES = 10;

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeSeverity(value) {
    var token = String(value || '').trim().toLowerCase();
    return token === 'warning' || token === 'danger' ? token : '';
  }

  function createErrorCenterStore(options) {
    var settings = options || {};
    var maxEntries = Number(settings.maxEntries) > 0 ? Math.floor(Number(settings.maxEntries)) : DEFAULT_MAX_ENTRIES;
    var nowFn = typeof settings.now === 'function' ? settings.now : function defaultNow() { return Date.now(); };
    var entries = [];
    var listeners = new Set();

    function emit() {
      listeners.forEach(function notify(listener) {
        try { listener(); } catch (_err) { /* listener owns its failures */ }
      });
    }

    function cloneEntry(entry) {
      return {
        key: entry.key,
        code: entry.code,
        title: entry.title,
        surface: entry.surface,
        severity: entry.severity,
        at: entry.at,
        seen: entry.seen,
      };
    }

    /**
     * Record an error. Accepts an intake envelope (errorCode/title/
     * severity/...) or a plain entry ({code, title, surface, severity}).
     * Only warning and danger severities are kept — info (cancelled /
     * denied) stays out of the center. An optional `key` dedupes:
     * re-recording the same key refreshes the entry in place (its seen
     * state is preserved, so re-renders cannot re-badge the pill).
     * @returns {boolean} true when an entry was recorded or refreshed
     */
    function record(input) {
      var source = input && typeof input === 'object' ? input : {};
      var severity = normalizeSeverity(source.severity);
      if (!severity) return false;
      var entry = {
        key: normalizeText(source.key) || normalizeText(source.dedupeKey),
        code: normalizeText(source.code) || normalizeText(source.errorCode),
        title: normalizeText(source.title) || normalizeText(source.recoveryTitle) || normalizeText(source.message),
        surface: normalizeText(source.surface) || normalizeText(source.origin),
        severity: severity,
        at: Number(source.at) > 0 ? Number(source.at) : nowFn(),
        seen: false,
      };
      if (!entry.title && !entry.code) return false;
      if (entry.key) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].key === entry.key) {
            entry.seen = entries[i].seen;
            entries.splice(i, 1);
            break;
          }
        }
      }
      entries.unshift(entry);
      if (entries.length > maxEntries) {
        entries.length = maxEntries;
      }
      emit();
      return true;
    }

    function list() {
      return entries.map(cloneEntry);
    }

    function clear() {
      if (!entries.length) return;
      entries = [];
      emit();
    }

    function getUnseenCount() {
      var count = 0;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].seen !== true) count += 1;
      }
      return count;
    }

    function markSeen() {
      var changed = false;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].seen !== true) {
          entries[i].seen = true;
          changed = true;
        }
      }
      if (changed) emit();
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function noop() {};
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    }

    return {
      record: record,
      list: list,
      clear: clear,
      getUnseenCount: getUnseenCount,
      markSeen: markSeen,
      subscribe: subscribe,
    };
  }

  return { createErrorCenterStore: createErrorCenterStore };
});
