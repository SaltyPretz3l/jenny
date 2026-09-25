'use strict';
// Settings > Tools > PDF reading add-on. Every handler sits behind the
// trusted-sender authorizer; install/installFromFile forward the payload so the
// service can require an explicit licence acceptance, and the other methods
// take no payload at all.
const { registerIpcInvokeHandlers } = require('../ipc-contract');

function registerPdfAddonIpc(ipcMain, { service, authorization }) {
  const safe = async (operation) => {
    try {
      if (!service) return { ok: false, reason: 'pdf_addon_unavailable' };
      return { ...await operation(), ok: true };
    } catch (error) {
      return { ...service?.getState?.(), ok: false,
        reason: /^[a-z_]{1,100}$/u.test(error?.reason || '') ? error.reason : 'pdf_addon_operation_failed' };
    }
  };
  const noPayload = (method) => (_event, payload) => safe(() => {
    if (payload !== undefined) throw Object.assign(new Error('unexpected_payload'), { reason: 'unexpected_payload' });
    return method();
  });
  return registerIpcInvokeHandlers(ipcMain, {
    'pdfAddon.getState': noPayload(() => service.getState()),
    'pdfAddon.install': (_event, payload) => safe(() => service.install(payload)),
    'pdfAddon.installFromFile': (_event, payload) => safe(() => service.installFromFile(payload)),
    'pdfAddon.cancel': noPayload(() => service.cancel()),
    'pdfAddon.remove': noPayload(() => service.remove()),
  }, authorization);
}

module.exports = { registerPdfAddonIpc };
