/* renderer/chat/renderer-navigation-intent.js -- user-owned navigation epochs (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererNavigationIntent = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createNavigationIntentOwner(state) {
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    if (!Number.isFinite(Number(state.ui.navigationIntentEpoch))) state.ui.navigationIntentEpoch = 0;

    function beginOperation(source) {
      return Object.freeze({
        epoch: Number(state.ui.navigationIntentEpoch) || 0,
        sessionId: String(state.currentSessionId || '').trim(),
        activeView: String(state.ui.activeView || '').trim(),
        source: String(source || 'operation'),
      });
    }

    function noteUserNavigation() {
      state.ui.navigationIntentEpoch = (Number(state.ui.navigationIntentEpoch) || 0) + 1;
      return state.ui.navigationIntentEpoch;
    }

    function isCurrent(token) {
      return Boolean(token
        && Number(token.epoch) === (Number(state.ui.navigationIntentEpoch) || 0)
        && String(token.activeView || '') === String(state.ui.activeView || ''));
    }

    function notifyDeferredNavigation(targetSessionId, navigate, options) {
      options.showToastMessage?.(options.message || 'Background work finished in another chat.', {
        title: options.title || 'Ready in another chat',
        tone: options.tone || 'info',
        source: options.source,
        dedupeKey: options.dedupeKey,
        actions: [{
          id: `open-session-${String(targetSessionId || '').slice(0, 40)}`,
          label: 'Open',
          kind: 'primary',
          onClick: () => navigate(targetSessionId),
        }],
      });
      return { navigated: false, notified: true };
    }

    async function navigateOrNotify(token, targetSessionId, options = {}) {
      const navigate = typeof options.navigate === 'function' ? options.navigate : async () => {};
      const guard = Object.freeze({ isCurrent: () => isCurrent(token) });
      if (guard.isCurrent()) {
        await navigate(targetSessionId, guard);
        if (guard.isCurrent()) {
          return { navigated: true, notified: false };
        }
      }
      return notifyDeferredNavigation(targetSessionId, navigate, options);
    }

    return { beginOperation, isCurrent, navigateOrNotify, noteUserNavigation };
  }

  function getOrCreateNavigationIntentOwner(state) {
    if (!state.navigationIntentOwner) state.navigationIntentOwner = createNavigationIntentOwner(state);
    return state.navigationIntentOwner;
  }

  return { createNavigationIntentOwner, getOrCreateNavigationIntentOwner };
});
