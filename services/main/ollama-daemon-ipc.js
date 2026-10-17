'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { stopUserOllamaProcess } = require('../backend/ollama-daemon-stop');

function managedOllamaPid(manager) {
  return manager?._getOwnedPid?.(manager?._readOwnedState?.()) || 0;
}

function registerOllamaDaemonIpcHandlers(ipcMain, {
  getManager, authorization, stopImpl = stopUserOllamaProcess,
} = {}) {
  return registerIpcInvokeHandlers(ipcMain, {
    'ollamaDaemon.stopUserProcess': async (_event, payload = {}) => {
      if (!getManager?.()) return { stopped: false, reason: 'engine_unavailable' };
      try {
        return await stopImpl({
          expectedPid: payload?.pid, expectedStartTime: payload?.startTime, expectedProgram: payload?.program,
          getOwnedPid: () => managedOllamaPid(getManager()),
        });
      } catch (_error) {
        return { stopped: false, reason: 'identity_unconfirmed' };
      }
    },
  }, authorization);
}

module.exports = { managedOllamaPid, registerOllamaDaemonIpcHandlers };
