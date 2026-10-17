'use strict';

// performance.* IPC (row 59 checkpoint 6). Every handler sits behind the
// trusted-sender authorizer. Payloads reach the service raw: it owns the closed
// schema validation (unknown keys, malformed ids and nonfinite values fail
// closed), so nothing is coerced here. A missing service or an unexpected throw
// answers the common failure envelope; exception text never crosses the seam.
// Desktop only: the hosted composition never constructs the service.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { fail } = require('../performance/performance-contract');

const METHODS = Object.freeze({
  'performance.getSnapshot': 'getSnapshot',
  'performance.updateSettings': 'updateSettings',
  'performance.dismissWarning': 'dismissWarning',
});

function registerPerformanceIpc(ipcMain, { backendService, authorization }) {
  const handlers = {};
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = async (_event, raw) => {
      const service = backendService?.performance;
      if (!service) return fail('collection_unavailable');
      try {
        return await service[serviceMethod](raw);
      } catch {
        return fail('collection_unavailable');
      }
    };
  }
  return registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { registerPerformanceIpc };
