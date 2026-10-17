'use strict';

// chatWorkspace.* IPC (row 59 checkpoint 2). Every handler sits behind the
// trusted-sender authorizer. Payloads reach the service raw: it owns the closed
// schema validation (unknown keys, malformed ids and nonfinite numbers fail
// closed), so nothing is coerced here. A missing service or an unexpected throw
// answers the common failure envelope; exception text never crosses the seam.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { fail } = require('../chat-workspace-contract');

const METHODS = Object.freeze({
  'chatWorkspace.getSummary': 'getSummary',
  'chatWorkspace.setView': 'setView',
  'chatWorkspace.listChanges': 'listChanges',
  'chatWorkspace.getChangeDiff': 'getChangeDiff',
});

function registerChatWorkspaceIpc(ipcMain, { backendService, authorization }) {
  const handlers = {};
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = async (_event, raw) => {
      const service = backendService?.chatWorkspace;
      if (!service) return fail('unavailable');
      try {
        return await service[serviceMethod](raw);
      } catch {
        return fail('unavailable');
      }
    };
  }
  return registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { registerChatWorkspaceIpc };
