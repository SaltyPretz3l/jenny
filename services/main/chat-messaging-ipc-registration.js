'use strict';

// chatMessages.* IPC (row 59 checkpoint 4). Every handler sits behind the
// trusted-sender authorizer. Payloads reach the service raw: it owns the closed
// schema validation (unknown keys, malformed ids and nonfinite numbers fail
// closed), so nothing is coerced here. A missing service or an unexpected throw
// answers the common failure envelope; exception text never crosses the seam.
// Desktop only: the hosted router has no route to these channels.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { fail } = require('../chat-messaging-contract');

const METHODS = Object.freeze({
  'chatMessages.listRecipients': 'listRecipients',
  'chatMessages.prepare': 'prepare',
  'chatMessages.send': 'send',
  'chatMessages.retry': 'retry',
  'chatMessages.cancel': 'cancel',
  'chatMessages.list': 'list',
  'chatMessages.markRead': 'markRead',
  'chatMessages.setContextDisposition': 'setContextDisposition',
  'chatMessages.discard': 'discard',
  'chatMessages.confirmRestored': 'confirmRestored',
  'chatMessages.createGrant': 'createGrant',
  'chatMessages.revokeGrant': 'revokeGrant',
  'chatMessages.setReporting': 'setReporting',
});

function registerChatMessagingIpc(ipcMain, { backendService, authorization }) {
  const handlers = {};
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = async (_event, raw) => {
      const service = backendService?.chatMessages;
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

module.exports = { METHODS, registerChatMessagingIpc };
