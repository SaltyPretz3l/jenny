(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererPluginSessionController = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const FALLBACK_ID = 'pluginSessionFallback';

  // The plugin platform is retired. A saved plugin session (an old image chat)
  // is an ordinary read-only transcript; this controller only shows its notice.
  function createPluginSessionController(options = {}) {
    const windowRef = options.windowRef || root;
    const documentRef = options.documentRef || windowRef.document;
    const state = options.state || {};
    let disposed = false;

    function getSession(sessionId = state.currentSessionId) {
      const normalized = String(sessionId || '').trim().slice(0, 160);
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === normalized) || null;
    }

    function isPluginSession(sessionId = state.currentSessionId) {
      return getSession(sessionId)?.session_type === 'plugin';
    }

    function syncFallbackNotice() {
      const notice = documentRef?.getElementById?.(FALLBACK_ID);
      if (!notice) return;
      const visible = !disposed && isPluginSession() && state.ui?.activeView === 'chat';
      notice.hidden = !visible;
      if (!visible) return;
      const copy = notice.querySelector?.('[data-plugin-session-fallback-copy]');
      if (copy) copy.textContent = jt('plugins.session.readOnlyUnavailable', 'This chat came from the retired image plugin and is read-only.');
    }

    function bind() {
      if (disposed) return;
      root.rendererPluginSessions = { instance: controller };
      syncFallbackNotice();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      syncFallbackNotice();
      if (root.rendererPluginSessions?.instance === controller) root.rendererPluginSessions = null;
    }

    const controller = { bind, dispose, isPluginSession, syncFallbackNotice };
    return controller;
  }

  return { createPluginSessionController };
});
