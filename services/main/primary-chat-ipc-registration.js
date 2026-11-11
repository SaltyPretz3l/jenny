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
  'primaryChat.addRule': 'addActionRule',
  'primaryChat.revokeRule': 'revokeActionRule',
  'primaryChat.reset': 'reset',
  'primaryChat.forgetPreview': 'forgetPreview',
  'primaryChat.undoSettingChange': 'undoSettingChange',
  'primaryChat.undoChatChange': 'undoChatChange',
  'primaryChat.getFullAuto': 'getFullAuto',
  'primaryChat.armFullAuto': 'armFullAuto',
  'primaryChat.disarmFullAuto': 'disarmFullAuto',
});

const APP_VIEW_METHODS = Object.freeze({ 'appView.reportOutcome': 'recordOutcome', 'appView.reportLayout': 'reportLayout' });
// Row 94 P4: terminal_run's report of the terminal the renderer used (services/terminal-tools-service.js).
const TERMINAL_TOOLS_METHODS = Object.freeze({ 'terminalTools.reportRun': 'recordRun' });

// The chat-manage service's undo reasons onto the contract's stable ones; the envelope degrades unknown ones.
const CHAT_UNDO_REASONS = Object.freeze({ unknown: 'not_found', busy: 'session_busy' });
const chatUndo = async (backend, value) => {
  const answer = await backend?.primaryChatManage?.undo?.(value);
  return answer && answer.ok === false && Object.hasOwn(CHAT_UNDO_REASONS, answer.reason)
    ? { ...answer, reason: CHAT_UNDO_REASONS[answer.reason] } : answer;
};

// Row 85 D11: Forget may keep the scheduled checks. The key rides beside the contract's
// closed reset schema (which owns the other three flags): checked as a boolean here,
// forwarded only when present, so the plain request keeps its three-flag shape.
function validateReset(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'delete_scheduled_checks')) {
    return contract.validateResetRequest(raw);
  }
  const { delete_scheduled_checks: deleteChecks, ...rest } = raw;
  const checked = contract.validateResetRequest(rest);
  if (!checked.ok || typeof deleteChecks !== 'boolean') return { ok: false, reason: 'invalid_request' };
  return { ok: true, value: { ...checked.value, delete_scheduled_checks: deleteChecks } };
}

// Full auto: a refusal other than `disabled` is a normal outcome (`no_primary`, `not_auto`), not a failure class the
// contract has a code for, so it rides the success envelope as `{armed:false, reason}` and the renderer words it.
const armFullAuto = async (backend) => {
  const answer = await backend?.primaryFullAuto?.arm?.();
  return answer && answer.ok === false && answer.reason !== 'disabled' ? { ...answer, ok: true } : answer;
};

const control = (method) => (backend, value) => backend?.primaryChatControls?.[method]?.(value);

// handler key -> { validate, call(backendService, value, loadReset) }
const OPERATIONS = Object.freeze({
  getState: { validate: contract.validateEmptyRequest, call: control('getState') },
  pause: { validate: contract.validateEmptyRequest, call: control('pause') },
  resume: { validate: contract.validateEmptyRequest, call: control('resume') },
  grantLaunch: { validate: contract.validateGrantLaunchRequest, call: control('grantLaunch') },
  revokeLaunch: { validate: contract.validateRevokeLaunchRequest, call: control('revokeLaunch') },
  addActionRule: { validate: contract.validateAddRuleRequest, call: control('addActionRule') },
  revokeActionRule: { validate: contract.validateRevokeRuleRequest, call: control('revokeActionRule') },
  activity: { validate: contract.validateActivityRequest, call: (backend, value) => backend?.primaryActivityLog?.list?.(value) },
  permissions: { validate: contract.validateEmptyRequest, call: (backend) => backend?.primaryActivityLog?.permissions?.() },
  reset: {
    validate: validateReset,
    call: (backend, value, loadReset) => loadReset()?.resetPrimaryChat?.(backend, value),
  },
  // Row 88: Activity's Undo of a Jenny-made settings batch (primary-settings-service.js).
  undoSettingChange: {
    validate: contract.validateUndoSettingChangeRequest,
    call: (backend, value) => backend?.primarySettings?.undo?.(value),
  },
  // Row 94: Activity's Undo of a Jenny-made chat change (primary-chat-manage-service.js).
  undoChatChange: { validate: contract.validateUndoChatChangeRequest, call: chatUndo },
  forgetPreview: {
    validate: contract.validateEmptyRequest,
    call: (backend, _value, loadReset) => loadReset()?.forgetPreview?.(backend),
  },
  // Full auto: the in-memory armed state over the Jenny chat's Auto mode (services/primary-full-auto.js).
  getFullAuto: { validate: contract.validateEmptyRequest, call: async (backend) => { const state = await backend?.primaryFullAuto?.getState?.(); return state && { ok: true, ...state }; } },
  armFullAuto: { validate: contract.validateEmptyRequest, call: armFullAuto },
  disarmFullAuto: { validate: contract.validateEmptyRequest, call: (backend) => backend?.primaryFullAuto?.disarm?.('user') },
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
  // Row 94 P3 / P4: app_view's decision reports and the renderer's layout (services/app-view-service.js), and
  // terminal_run's report (services/terminal-tools-service.js). Each service validates the payload itself and answers
  // `{ok}` only; nothing here reaches a write.
  const ported = [...Object.entries(APP_VIEW_METHODS).map(([path, method]) => [path, 'appView', method]),
    ...Object.entries(TERMINAL_TOOLS_METHODS).map(([path, method]) => [path, 'terminalTools', method])];
  for (const [methodPath, port, method] of ported) {
    handlers[methodPath] = (_event, payload) => {
      try {
        return backendService?.[port]?.[method]?.(payload) ?? { ok: false, reason: 'unavailable' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    };
  }
  return registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { APP_VIEW_METHODS, METHODS, TERMINAL_TOOLS_METHODS, registerPrimaryChatIpc };
