'use strict';
const { registerIpcInvokeHandlers } = require('../ipc-contract');
function registerCommandSandboxIpc(ipcMain, { service, authorization }) {
  const safe = async (operation) => {
    try {
      if (!service) return { ok: false, reason: 'sandbox_service_unavailable' };
      return { ...await operation(), ok: true };
    } catch (error) {
      return { ...service?.getState?.(), ok: false,
        reason: /^[a-z_]{1,100}$/u.test(error?.reason || '') ? error.reason : 'sandbox_operation_failed' };
    }
  };
  return registerIpcInvokeHandlers(ipcMain, {
    'commandSandbox.getState': (_event, payload) => safe(() => {
      if (payload !== undefined) throw new Error('unexpected_payload');
      return service.getState();
    }),
    'commandSandbox.setEnabled': (_event, payload) => safe(() => service.setEnabled(payload)),
    'commandSandbox.retry': (_event, payload) => safe(() => {
      if (payload !== undefined) throw new Error('unexpected_payload');
      return service.retry();
    }),
  }, authorization);
}
module.exports = { registerCommandSandboxIpc };