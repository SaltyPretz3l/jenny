(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererPrimarySessionMenu = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  // The primary Jenny chat's group in the Chats row menu (row 76): Pause / Resume (a toggle),
  // Activity, then Reset and Forget. Pure: the caller hands in the store, flags and callbacks.

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };

  const isPrimary = (stringUtils && stringUtils.isPrimarySession) || function (s) { return Boolean(s) && s.session_role === 'primary'; };

  function buildPrimaryMenuItems(options) {
    const o = options || {};
    const { sessionId, summary, store, trigger } = o;
    const jt = typeof o.jt === 'function' ? o.jt : defaultJt;
    const flags = o.flags || {};
    const callbacks = o.callbacks || {};
    if (!isPrimary(summary) || !store) return [];
    const snapshot = typeof store.getSnapshot === 'function' ? store.getSnapshot() : {};
    if (snapshot.status === 'unavailable') return [];
    const backend = snapshot.flags || {};
    const controls = flags.primary_chat_controls !== false && backend.controls !== false;
    const activity = flags.primary_activity_log !== false && backend.activity_log !== false;
    const paused = store.isPaused(sessionId) === true;
    const request = () => ({ sessionId, trigger });
    const first = [];
    if (controls) {
      first.push({
        label: paused ? jt('sidebar.sessionActions.primaryResume', 'Resume Jenny') : jt('sidebar.sessionActions.primaryPause', 'Pause Jenny'),
        description: paused
          ? jt('sidebar.sessionActions.primaryResumeHint', 'Wake it once for the oldest waiting message')
          : jt('sidebar.sessionActions.primaryPauseHint', 'Messages from other chats wait until you resume'),
        toggle: true,
        checked: paused,
        action: () => Promise.resolve(paused ? store.resume() : store.pause()).then((result) => {
          if (!result || result.ok !== true) callbacks.showToastMessage?.(jt('sidebar.sessionActions.primaryPauseFailed', 'Could not change whether Jenny is paused. Try again.'));
        }),
      });
    }
    if (activity) {
      first.push({
        label: jt('sidebar.sessionActions.primaryActivity', 'Activity…'),
        action: () => callbacks.openPrimaryActivity && callbacks.openPrimaryActivity(request()),
      });
    }
    const second = controls
      ? [
          {
            label: jt('sidebar.sessionActions.primaryReset', 'Reset chat…'),
            danger: true,
            action: () => callbacks.confirmPrimaryReset && callbacks.confirmPrimaryReset(request()),
          },
          {
            label: jt('sidebar.sessionActions.primaryForget', 'Forget…'),
            danger: true,
            action: () => callbacks.confirmPrimaryForget && callbacks.confirmPrimaryForget(request()),
          },
        ]
      : [];
    return [first, second].filter((group) => group.length).flatMap((group) => [{ separator: true }, ...group]);
  }

  return { buildPrimaryMenuItems };
});
