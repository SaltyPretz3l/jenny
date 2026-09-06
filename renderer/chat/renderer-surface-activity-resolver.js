(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSurfaceActivityResolver = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Effects-facing lifecycle resolver (Background Effects v3, Rev 2 section
  // 3.2.3). The DOM resolver `resolveChatSendLifecycle` in
  // renderer-render-pipeline-surface-state.js returns the explicit lifecycle
  // BEFORE the streaming/approval OR, so a pending tool approval during
  // streaming can never surface as its own phase there. Effects need
  // approval-pending to win over 'streaming' so an awaiting-user visual can
  // exist. This module is intentionally standalone from the DOM resolver so
  // the DOM resolver's public CSS/test surface stays untouched.

  function normalizeChatSendLifecycle(value) {
    var token = String(value || '').trim().toLowerCase();
    if (token === 'preflight' || token === 'streaming' || token === 'settling' || token === 'failed') {
      return token;
    }
    return 'idle';
  }

  function createSurfaceActivityResolver(deps) {
    const {
      getChatSendLifecycle = function () { return 'idle'; },
      isSendPreflightPending = function () { return false; },
      isSessionStreaming = function () { return false; },
      hasPendingToolApprovalForSession = function () { return false; },
      getCurrentSessionId = function () { return ''; },
    } = deps || {};

    function resolveSurfaceActivityPhase(sessionId) {
      var normalizedSessionId = String(sessionId || getCurrentSessionId() || '').trim();
      if (!normalizedSessionId) {
        return 'idle';
      }
      var explicitLifecycle = normalizeChatSendLifecycle(getChatSendLifecycle(normalizedSessionId));
      if (explicitLifecycle === 'failed') {
        return 'failed';
      }
      if (hasPendingToolApprovalForSession(normalizedSessionId)) {
        return 'awaiting-user';
      }
      if (explicitLifecycle !== 'idle') {
        return explicitLifecycle;
      }
      if (isSendPreflightPending() && normalizedSessionId === String(getCurrentSessionId() || '').trim()) {
        return 'preflight';
      }
      if (isSessionStreaming(normalizedSessionId)) {
        return 'streaming';
      }
      return 'idle';
    }

    return { resolveSurfaceActivityPhase };
  }

  return { createSurfaceActivityResolver };
});
