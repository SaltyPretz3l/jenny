'use strict';

/*
 * run-view-ipc-registration.js — the Live tab's bridge methods (row 197, R2).
 *
 * Maps `runView.*` (services/ipc-contract/descriptors-addons.js) onto the run
 * service's handlers (services/run-view/run-view-ipc.js, which owns payload
 * validation). Gates come first and answer without building anything:
 *   disabled              the live_run_view flag is off, or this is a hosted server;
 *   unsupported_platform  not Windows (the helper has no window support elsewhere yet);
 *   sandbox_only          commands run only in the container sandbox, so nothing new may
 *                         start on the desktop; stop, show, capture and output still work,
 *                         and `get` answers normally while a run of that project is live.
 */

const { registerIpcInvokeHandlers } = require('../ipc-contract');

const METHODS = Object.freeze({
  'runView.get': { channel: 'run-view:get', starts: false },
  'runView.confirmCommand': { channel: 'run-view:confirm-command', starts: true },
  'runView.start': { channel: 'run-view:start', starts: true },
  'runView.stop': { channel: 'run-view:stop', starts: false },
  'runView.restart': { channel: 'run-view:restart', starts: true },
  'runView.showWindow': { channel: 'run-view:show-window', starts: false },
  'runView.armCapture': { channel: 'run-view:arm-capture', starts: false },
  'runView.output': { channel: 'run-view:output', starts: false },
  'runView.setRestartAfterChanges': { channel: 'run-view:set-restart-after-changes', starts: false },
});

const LIVE_STATES = new Set(['building', 'starting', 'no_window', 'running', 'minimized', 'stopping', 'close_refused']);

function refusal(reason) {
  return { ok: false, reason };
}

const safely = (read, fallback) => {
  try { return read(); } catch { return fallback; }
};

// The reason a program may not start now, or null: the part of the gates that every starting call shares.
// A turn's end uses it too (the holder's startRefusal), so the rules exist once. Every read fails closed.
function startGateFor({ getHolder, isEnabled = () => true, isHostedServer = () => false, isSandboxOnly = () => false } = {}) {
  return () => {
    const holder = safely(getHolder, null);
    if (!holder || safely(isEnabled, false) !== true || safely(isHostedServer, true) !== false) return 'disabled';
    if (holder.platform() !== 'win32') return 'unsupported_platform';
    if (safely(isSandboxOnly, true) === true) return 'sandbox_only';
    return null;
  };
}

function registerRunViewIpc(ipcMain, {
  getHolder, authorization, isEnabled = () => true, isHostedServer = () => false, isSandboxOnly = () => false,
  createHandlers = null,
}) {
  let handlers = null;
  const handlersFor = (service, holder) => {
    if (!handlers) {
      const create = createHandlers || require('../run-view').createRunViewIpcHandlers;
      handlers = create({ runService: service, restartSwitch: holder.restartSwitch, startWarning: holder.startWarning });
    }
    return handlers;
  };
  const runIsLive = (holder, projectId) => {
    const service = holder.peek?.();
    if (!service || typeof projectId !== 'string') return false;
    return safely(() => LIVE_STATES.has(service.peekState?.(projectId)), false);
  };

  // A refusal reason, or null when the call may go through.
  function gate(holder, method, payload) {
    const refused = startGateFor({ getHolder: () => holder, isEnabled, isHostedServer, isSandboxOnly })();
    if (refused !== 'sandbox_only') return refused;
    if (method.starts) return refused;
    if (method.channel === 'run-view:get' && !runIsLive(holder, payload?.projectId)) return refused;
    return null;
  }

  const entries = Object.entries(METHODS).map(([name, method]) => [name, async (_event, payload) => {
    const holder = safely(getHolder, null);
    const blocked = gate(holder, method, payload);
    if (blocked) return refusal(blocked);
    let service;
    try { service = holder.get(); } catch { return refusal('internal_error'); }
    return handlersFor(service, holder)[method.channel](payload);
  }]);
  return registerIpcInvokeHandlers(ipcMain, Object.fromEntries(entries), authorization);
}

module.exports = { METHODS, registerRunViewIpc, startGateFor };
