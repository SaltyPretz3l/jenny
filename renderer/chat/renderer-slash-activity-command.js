/* renderer/chat/renderer-slash-activity-command.js -- /activity (row 76) and /reset, /forget-chat (row 90): open the Jenny chat's Activity dialog and its Reset / Forget confirms. They are primary-chat surfaces, listed only there; a typed command in any other chat gets a calm toast and nothing opens. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashActivityCommand = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  const { isPrimarySessionId = () => false } = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)) || {};

  function createActivityCommandHandler(deps = {}) {
    const state = deps.state && typeof deps.state === 'object' ? deps.state : {};
    const open = typeof deps.open === 'function' ? deps.open : () => false;
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : null;

    return function handleActivityCommand(invocation) {
      const sessionId = String((invocation && invocation.sessionId) || '').trim();
      if (!sessionId || !isPrimarySessionId(state.sessions, sessionId)) {
        if (showToast) showToast(jt('composer.slash.activityPrimaryOnly', 'Activity is available in the Jenny chat.'));
        return { ok: false, handled: true, code: 'not_primary' };
      }
      if (open({ sessionId, pane: 'activity' }) === false) {
        if (showToast) showToast(jt('chat.primary.unavailable', "Jenny's activity is not available right now."));
        return { ok: false, handled: true, code: 'unavailable' };
      }
      return { ok: true };
    };
  }

  // Row 90: the command only opens the same confirm the chat row's menu
  // opens; nothing is reset or forgotten without that confirm.
  function createPrimaryResetCommandHandler(deps = {}) {
    const state = deps.state && typeof deps.state === 'object' ? deps.state : {};
    const getDialog = typeof deps.getDialog === 'function' ? deps.getDialog : () => null;
    const showToast = typeof deps.showToast === 'function' ? deps.showToast : null;
    const forget = deps.forget === true;

    return function handlePrimaryResetCommand(invocation) {
      const sessionId = String((invocation && invocation.sessionId) || '').trim();
      if (!sessionId || !isPrimarySessionId(state.sessions, sessionId)) {
        if (showToast) showToast(jt('composer.slash.primaryOnly', 'This command works in the Jenny chat.'));
        return { ok: false, handled: true, code: 'not_primary' };
      }
      const dialog = state.features?.featureFlags?.primary_chat_controls === false ? null : getDialog();
      const confirm = dialog && (forget ? dialog.confirmForget : dialog.confirmReset);
      if (typeof confirm !== 'function') {
        if (showToast) showToast(jt('chat.primary.unavailable', "Jenny's activity is not available right now."));
        return { ok: false, handled: true, code: 'unavailable' };
      }
      Promise.resolve(confirm.call(dialog, { sessionId })).then((outcome) => {
        if (outcome && outcome.ok === false && outcome.reason === 'unavailable' && showToast) {
          showToast(jt('chat.primary.unavailable', "Jenny's activity is not available right now."));
        }
      }, () => {});
      return { ok: true };
    };
  }

  return { createActivityCommandHandler, createPrimaryResetCommandHandler };
});
