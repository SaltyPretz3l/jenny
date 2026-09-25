'use strict';

// stream.terminal_postwork_slow showed refreshSnapshots (~2.5 s) and
// refreshSessionMetadata (~1.3 s) dominating turn settle (2026-09-22) without
// naming the IPC call or saying whether main was blocked. Every invoke handler
// slower than SLOW_IPC_HANDLER_MS logs ipc.handler_slow: durationMs is the
// full settle, syncMs the part that ran synchronously on the main thread
// (a large syncMs is event-loop blocking felt by every other IPC call).

const SLOW_IPC_HANDLER_MS = 1000;
const INSTALLED = Symbol.for('jenny.ipcHandlerTiming');

function installIpcHandlerTiming(ipcMainLike, { log = () => {}, now = Date.now, thresholdMs = SLOW_IPC_HANDLER_MS } = {}) {
  if (!ipcMainLike || typeof ipcMainLike.handle !== 'function' || ipcMainLike[INSTALLED]) return false;
  const handle = ipcMainLike.handle;
  ipcMainLike.handle = function timedHandle(channel, listener) {
    if (typeof listener !== 'function') return handle.call(this, channel, listener);
    return handle.call(this, channel, function timedListener(...args) {
      const startedAt = now();
      const report = () => {
        const durationMs = now() - startedAt;
        if (durationMs <= thresholdMs) return;
        try {
          log('WARN', 'ipc.handler_slow', { channel: String(channel).slice(0, 80), durationMs, syncMs });
        } catch (_error) { /* timing must never fail the handler */ }
      };
      let syncMs = 0;
      let result;
      try {
        result = listener.apply(this, args);
      } catch (error) {
        syncMs = now() - startedAt;
        report(); // a slow synchronous failure still blocked main
        throw error;
      }
      syncMs = now() - startedAt;
      // The caller keeps the original result (sync value or the same promise).
      if (result && typeof result.then === 'function') result.then(report, report);
      else report();
      return result;
    });
  };
  Object.defineProperty(ipcMainLike, INSTALLED, { value: true });
  return true;
}

module.exports = { SLOW_IPC_HANDLER_MS, installIpcHandlerTiming };
