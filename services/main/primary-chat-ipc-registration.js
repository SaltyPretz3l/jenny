'use strict';

// primaryChat.* IPC (row 76). Every handler sits behind the trusted-sender
// authorizer. Each payload is validated against the closed schemas in
// primary-chat-contract.js before any service is touched, then dispatched to the
// controls service, the activity log or the reset module. A service answer
// `{ok:false, reason}` maps through the stable reason classes; a missing service,
// a reset module that fails to load, or any throw answers `unavailable`.
// Exception text never crosses the seam. The reset module is required lazily so a
// missing file degrades one operation instead of failing registration; the
// `loadReset` option is the test seam. Desktop only: the hosted router has no
// route to these channels.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const contract = require('../primary-chat-contract');

const { fail, succeed } = contract;

const loadResetModule = () => require('../backend/primary-chat-reset');

// path -> handler key (the controls-service method name where one exists).
const METHODS = Object.freeze({
  'primaryChat.getState': 'getState',
  'primaryChat.activity': 'activity',
  'primaryChat.permissions': 'permissions',
  'primaryChat.pause': 'pause',
  'primaryChat.resume': 'resume',
  'primaryChat.grantLaunch': 'grantLaunch',
  'primaryChat.revokeLaunch': 'revokeLaunch',
  'primaryChat.reset': 'reset',
  'primaryChat.forgetPreview': 'forgetPreview',
});

const control = (method) => (backend, value) => backend?.primaryChatControls?.[method]?.(value);

// handler key -> { validate, call(backendService, value, loadReset) }
const OPERATIONS = Object.freeze({
  getState: { validate: contract.validateEmptyRequest, call: control('getState') },
  pause: { validate: contract.validateEmptyRequest, call: control('pause') },
  resume: { validate: contract.validateEmptyRequest, call: control('resume') },
  grantLaunch: { validate: contract.validateGrantLaunchRequest, call: control('grantLaunch') },
  revokeLaunch: { validate: contract.validateRevokeLaunchRequest, call: control('revokeLaunch') },
  activity: { validate: contract.validateActivityRequest, call: (backend, value) => backend?.primaryActivityLog?.list?.(value) },
  permissions: { validate: contract.validateEmptyRequest, call: (backend) => backend?.primaryActivityLog?.permissions?.() },
  reset: {
    validate: contract.validateResetRequest,
    call: (backend, value, loadReset) => loadReset()?.resetPrimaryChat?.(backend, value),
  },
  forgetPreview: {
    validate: contract.validateEmptyRequest,
    call: (backend, _value, loadReset) => loadReset()?.forgetPreview?.(backend),
  },
});

function envelope(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') return fail('unavailable');
  if (!answer.ok) return fail(answer.reason);
  const { ok: _ok, schema_version: _schemaVersion, ...payload } = answer;
  return succeed(payload);
}

function registerPrimaryChatIpc(ipcMain, { backendService, authorization, loadReset = loadResetModule }) {
  const handlers = {};
  for (const [methodPath, key] of Object.entries(METHODS)) {
    const operation = OPERATIONS[key];
    handlers[methodPath] = async (_event, raw) => {
      const checked = operation.validate(raw);
      if (!checked.ok) return fail('invalid_request');
      try {
        return envelope(await operation.call(backendService, checked.value, loadReset));
      } catch {
        return fail('unavailable');
      }
    };
  }
  return registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { METHODS, registerPrimaryChatIpc };
