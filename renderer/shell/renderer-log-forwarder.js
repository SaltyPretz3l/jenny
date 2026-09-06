(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLogForwarder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_FLUSH_DELAY_MS = 500;
  const DEFAULT_MAX_BATCH_SIZE = 20;
  const DEFAULT_MAX_BUFFER_SIZE = 200;

  // Batches renderer-originated log entries and ships them to the main
  // process so they land in the on-disk shell.log beside electron-layer
  // entries. Streaming turns emit per-delta DEBUG events, so DEBUG entries
  // are only forwarded when the agent_test_hooks flag is on; INFO and above
  // always forward. Forwarding is strictly best-effort: any failure is
  // swallowed so logging can never break the app.
  function createClientLogForwarder({
    sendBatch,
    isDebugForwardingEnabled = () => false,
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
    setTimeoutFn = (...args) => setTimeout(...args),
    clearTimeoutFn = (handle) => clearTimeout(handle),
  } = {}) {
    let buffer = [];
    let droppedCount = 0;
    let flushTimer = null;
    let disposed = false;

    function flush() {
      if (flushTimer != null) {
        clearTimeoutFn(flushTimer);
        flushTimer = null;
      }
      if (buffer.length === 0 || typeof sendBatch !== 'function') {
        return;
      }
      const entries = buffer;
      const dropped = droppedCount;
      buffer = [];
      droppedCount = 0;
      try {
        sendBatch({ entries, dropped_count: dropped });
      } catch (_error) {
        // Best effort only; never throw from the log path.
      }
    }

    function scheduleFlush() {
      if (flushTimer != null || disposed) {
        return;
      }
      flushTimer = setTimeoutFn(() => {
        flushTimer = null;
        flush();
      }, flushDelayMs);
    }

    function enqueue(entry) {
      if (disposed || !entry || typeof entry !== 'object') {
        return;
      }
      if (String(entry.source || '') !== 'renderer') {
        return;
      }
      const level = String(entry.level || '').toUpperCase();
      let debugEnabled;
      try {
        debugEnabled = isDebugForwardingEnabled() === true;
      } catch (_error) {
        debugEnabled = false;
      }
      if (level === 'DEBUG' && !debugEnabled) {
        return;
      }
      buffer.push(entry);
      if (buffer.length > maxBufferSize) {
        buffer.splice(0, buffer.length - maxBufferSize);
        droppedCount += 1;
      }
      if (buffer.length >= maxBatchSize) {
        flush();
        return;
      }
      scheduleFlush();
    }

    function dispose() {
      if (disposed) {
        return;
      }
      flush();
      disposed = true;
    }

    return Object.freeze({ enqueue, flush, dispose });
  }

  return Object.freeze({
    createClientLogForwarder,
  });
});
