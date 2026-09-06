/* renderer/shared/renderer-live-announcer.js
   Contract:
     createLiveAnnouncer({ dom: { politeRegion, assertiveRegion }, setTimeout, clearTimeout, throttleMs })
       -> { announce(message, opts), reset(key), dispose() }

     announce(message, { politeness: 'polite' | 'assertive', key, dedupe = true })
       - Routes to the polite or assertive region (errors/failures should pass 'assertive'; routine
         confirmations should use the default 'polite').
       - `key` scopes throttling/dedup identity (e.g. `tool-status:${callId}`); defaults to the
         message text itself when omitted.
       - Rapid-fire calls sharing a key inside `throttleMs` collapse to the LAST message only (this
         is the "throttled" half of the fix contract) -- callers do not need their own debounce.
       - `dedupe` (default true) skips announcing the exact same text twice in a row for the same
         key, so a status that flaps back to an already-announced value doesn't re-speak it.
       - This module never announces per-token/streaming content; callers own deciding WHEN a change
         is meaningful enough to announce (see renderer-stream-tool-patch-utils.js for the terminal-
         status-only gate used for tool activity). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLiveAnnouncer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_THROTTLE_MS = 150;
  // Bounds `lastMessageByKey` growth. One `tool-status:${callId}` key is
  // added per tool call and nothing but reset()/dispose() ever removes it --
  // the shared instance calls neither, so without a cap the map grows for
  // the lifetime of the page. 200 comfortably covers any realistic
  // in-session working set of distinct dedupe keys.
  const DEFAULT_MAX_DEDUPE_KEYS = 200;

  function createLiveAnnouncer(options = {}) {
    const dom = options.dom || {};
    const politeRegion = dom.politeRegion || null;
    const assertiveRegion = dom.assertiveRegion || null;
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const setTimeoutRef = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : (typeof globalRef.setTimeout === 'function' ? globalRef.setTimeout.bind(globalRef) : null);
    const clearTimeoutRef = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : (typeof globalRef.clearTimeout === 'function' ? globalRef.clearTimeout.bind(globalRef) : null);
    const throttleMs = Number.isFinite(options.throttleMs) && options.throttleMs >= 0
      ? options.throttleMs
      : DEFAULT_THROTTLE_MS;
    const maxDedupeKeys = Number.isFinite(options.maxDedupeKeys) && options.maxDedupeKeys > 0
      ? Math.floor(options.maxDedupeKeys)
      : DEFAULT_MAX_DEDUPE_KEYS;

    // key -> last message text actually written to a region (dedupe identical repeats).
    const lastMessageByKey = new Map();
    // key -> { timer, message, politeness } for in-flight throttled announcements.
    const pendingByKey = new Map();

    // Insertion-order cap: Map preserves insertion order, so the oldest
    // entry is always map.keys().next().value. Re-touching an existing key
    // (delete-then-set) refreshes its position so actively-used keys survive
    // and only genuinely stale ones get evicted.
    function rememberLastMessage(key, text) {
      if (lastMessageByKey.has(key)) {
        lastMessageByKey.delete(key);
      }
      lastMessageByKey.set(key, text);
      while (lastMessageByKey.size > maxDedupeKeys) {
        const oldestKey = lastMessageByKey.keys().next().value;
        lastMessageByKey.delete(oldestKey);
      }
    }

    function regionFor(politeness) {
      return politeness === 'assertive' ? assertiveRegion : politeRegion;
    }

    function writeToRegion(region, message) {
      if (!region) return false;
      // Clear-then-set: some AT/browser combinations dedupe an unchanged textContent write and
      // never fire the announcement. Clearing first guarantees the mutation always registers even
      // when the new message happens to equal old content left over from a prior announcement.
      region.textContent = '';
      region.textContent = message;
      return true;
    }

    function flush(key) {
      const pending = pendingByKey.get(key);
      if (!pending) return;
      pendingByKey.delete(key);
      rememberLastMessage(key, pending.message);
      writeToRegion(regionFor(pending.politeness), pending.message);
    }

    function announce(message, opts = {}) {
      const text = String(message == null ? '' : message).trim();
      if (!text) return false;
      const politeness = opts.politeness === 'assertive' ? 'assertive' : 'polite';
      const key = String(opts.key || text);
      const dedupe = opts.dedupe !== false;

      if (dedupe && !pendingByKey.has(key) && lastMessageByKey.get(key) === text) {
        return false;
      }

      const existing = pendingByKey.get(key);
      if (existing && existing.timer != null && clearTimeoutRef) {
        clearTimeoutRef(existing.timer);
      }

      if (!setTimeoutRef) {
        // No timer facility available (unlikely outside of a stripped-down test double) --
        // announce synchronously rather than silently dropping the message.
        rememberLastMessage(key, text);
        writeToRegion(regionFor(politeness), text);
        return true;
      }

      const timer = setTimeoutRef(() => flush(key), throttleMs);
      pendingByKey.set(key, { timer, message: text, politeness });
      return true;
    }

    function reset(key) {
      if (key === undefined) {
        pendingByKey.forEach((pending) => {
          if (pending.timer != null && clearTimeoutRef) clearTimeoutRef(pending.timer);
        });
        pendingByKey.clear();
        lastMessageByKey.clear();
        return;
      }
      const pending = pendingByKey.get(key);
      if (pending && pending.timer != null && clearTimeoutRef) {
        clearTimeoutRef(pending.timer);
      }
      pendingByKey.delete(key);
      lastMessageByKey.delete(key);
    }

    function dispose() {
      reset();
    }

    return { announce, reset, dispose };
  }

  return { createLiveAnnouncer };
});
