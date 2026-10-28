/* renderer/chat/renderer-slash-activity-command.js -- /activity (row 76): opens the Jenny chat's Activity dialog. It is a primary-chat surface, so any other chat gets a calm toast and nothing opens. */
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

  return { createActivityCommandHandler };
});
