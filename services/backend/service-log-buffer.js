'use strict';

/* Service logs emitted while nothing listens yet. The runtime store and its
 * recovery passes run inside the BackendService constructor, before the host
 * attaches its `service-log` listener, so a latch there (for example the run
 * store opening read-only) was never written anywhere. The buffer is bounded,
 * keeps the original time, and stops holding once it is drained: a host that
 * never drains keeps at most `limit` entries. */
const MAX_EARLY_SERVICE_LOGS = 200;

function createServiceLogBuffer({ limit = MAX_EARLY_SERVICE_LOGS, now = () => new Date().toISOString() } = {}) {
  let entries = [];
  let dropped = 0;
  let drained = false;
  return Object.freeze({
    hold(entry) {
      if (drained) return false;
      if (entries.length >= limit) dropped += 1;
      else {
        const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
        entries.push({ ...entry, details: { ...details, early_log_at: now() } });
      }
      return true;
    },
    drain() {
      drained = true;
      const held = entries;
      if (dropped) held.push({ level: 'WARN', event: 'backend.early_service_logs_dropped', details: { dropped } });
      entries = [];
      dropped = 0;
      return held;
    },
  });
}

module.exports = { MAX_EARLY_SERVICE_LOGS, createServiceLogBuffer };
