'use strict';

// sessionProposals.* IPC (row 59 checkpoint 3). Every handler sits behind the
// trusted-sender authorizer. Payloads reach the service raw: it owns the closed
// schema validation (unknown keys, malformed ids and nonfinite numbers fail
// closed), so nothing is coerced here. A missing service or an unexpected throw
// answers the common failure envelope; exception text never crosses the seam.
// Desktop only: the hosted router has no route to these channels.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { fail } = require('../chat-proposal-contract');

const METHODS = Object.freeze({
  'sessionProposals.get': 'get',
  'sessionProposals.list': 'list',
  'sessionProposals.decide': 'decide',
  'sessionProposals.cancel': 'cancel',
  'sessionProposals.retry': 'retry',
  'sessionProposals.getCapabilities': 'getCapabilities',
  'sessionProposals.setOptions': 'setOptions',
  'sessionProposals.startAll': 'startAll',
  'sessionProposals.confirmRestored': 'confirmRestored',
  'sessionProposals.authorizeLaunch': 'authorizeLaunch',
});

function registerChatProposalIpc(ipcMain, { backendService, authorization }) {
  const handlers = {};
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = async (_event, raw) => {
      const service = backendService?.chatProposals;
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

module.exports = { METHODS, registerChatProposalIpc };
