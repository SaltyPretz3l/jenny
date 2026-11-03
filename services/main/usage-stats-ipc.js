'use strict';

// usage.getStats IPC (row 98, slice S2): the Home "Usage" widget's one read.
// Pulls the durable daily rollup from UsageHistoryService.getRollupSnapshot()
// and returns every display range computed by services/usage-rollup-stats.js.
// Read-only and input-free. The result mirrors usage.getSnapshot's flat
// `available` envelope (services/auxiliary-ipc-handlers.js usage.getSnapshot): the stats
// fields sit at the top level next to `available`, a thrown read answers
// `{ available: false, error }` with the same shape holding empty stats, and a
// missing usageHistory is an empty rollup rather than an error.

const { registerIpcInvokeHandlers, getBridgeChannel } = require('../ipc-contract');
const { isLocalEngine } = require('../backend/session-lockdown-gate');
const { computeUsageStats } = require('../usage-rollup-stats');

const STATS_METHOD_PATH = 'usage.getStats';
const STATS_ERROR_CODE = 'usage_stats_unavailable';

function noop() {}

// Bounded, content-free reason for the log: the error code if it has a short
// one, else the error class. Never the message or the raw object.
function boundedReason(error) {
  const code = String(error?.code || '').replace(/[^\w.:-]/g, '').slice(0, 40);
  if (code) return code;
  return String(error?.name || 'error').replace(/[^\w.:-]/g, '').slice(0, 40) || 'error';
}

// registerUsageStatsIpc(ipcMain, { usageHistory, logger, authorization,
// isLocalProvider, now }) -> teardown function. `logger` is the shared
// `log(level, event, data)` function; `isLocalProvider` and `now` are test seams.
function registerUsageStatsIpc(ipcMainLike, {
  usageHistory = null,
  logger = null,
  authorization = {},
  isLocalProvider = (provider) => isLocalEngine(provider),
  now = () => new Date(),
} = {}) {
  const log = typeof logger === 'function' ? logger : noop;

  function compute(rollup) {
    return computeUsageStats(rollup, { now: now(), isLocalProvider });
  }

  function getStats() {
    try {
      // computeUsageStats returns plain JSON; the IPC layer serializes it.
      return { available: true, ...compute(usageHistory?.getRollupSnapshot?.() ?? null) };
    } catch (error) {
      log('WARN', 'usage.stats_failed', { reason: boundedReason(error) });
      return { available: false, error: STATS_ERROR_CODE, ...compute(null) };
    }
  }

  registerIpcInvokeHandlers(ipcMainLike, {
    [STATS_METHOD_PATH]: () => getStats(),
  }, authorization);

  let torndown = false;
  return function teardown() {
    if (torndown) return;
    torndown = true;
    try {
      ipcMainLike.removeHandler?.(getBridgeChannel(STATS_METHOD_PATH, 'invoke'));
    } catch (_error) { /* best-effort */ }
  };
}

module.exports = {
  registerUsageStatsIpc,
};
