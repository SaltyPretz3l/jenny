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

  function text(value, max = 120) {
    return String(value || '').trim().slice(0, max);
  }

  function createPluginSessionController(options = {}) {
    const windowRef = options.windowRef || root;
    const documentRef = options.documentRef || windowRef.document;
    const state = options.state || {};
    const viewHost = options.viewHost || null;
    const callbacks = options.callbacks || {};
    let disposed = false;

    function getSession(sessionId = state.currentSessionId) {
      const normalized = text(sessionId, 160);
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === normalized) || null;
    }

    function isPluginSession(sessionId = state.currentSessionId) {
      return getSession(sessionId)?.session_type === 'plugin';
    }

    function syncFallbackNotice() {
      const notice = documentRef?.getElementById?.(FALLBACK_ID);
      const actionSlot = documentRef?.getElementById?.('pluginSessionFallbackAction');
      if (!notice || !actionSlot) return;
      const session = getSession();
      const visible = session?.session_type === 'plugin' && state.ui?.activeView === 'chat';
      notice.hidden = !visible;
      if (!visible) return;
      // Session providers are retired: a saved plugin session (an old image
      // chat) is always an ordinary read-only transcript.
      const copy = notice.querySelector?.('[data-plugin-session-fallback-copy]');
      if (copy) copy.textContent = jt('plugins.session.readOnlyUnavailable', 'This transcript is read-only because its plugin is missing, disabled, or incompatible.');
      const button = root.inventoryActionButton;
      if (typeof button === 'function') {
        actionSlot.innerHTML = button({
          label: jt('plugins.session.managePlugins', 'Manage plugins'),
          size: 'sm',
          dataset: { 'plugin-session-action': 'manage-plugins' },
        });
      }
    }

    async function openSessionView(sessionId, { userInitiated = true } = {}) {
      const session = getSession(sessionId);
      if (!session || session.session_type !== 'plugin') return { ok: false, reason: 'not_plugin_session' };
      if (!userInitiated) return { ok: true, skipped: true };
      if (disposed) return { ok: false, reason: 'plugin_session_controller_disposed' };
      callbacks.setActiveView?.('chat');
      syncFallbackNotice();
      callbacks.showToastMessage?.(
        jt('plugins.session.unavailableToast', 'This plugin is unavailable. The saved transcript remains readable.'),
        { tone: 'warning' },
      );
      return { ok: false, reason: 'session_provider_unavailable', fallback: true };
    }

    async function guardLeaveSession(sessionId, reason = 'session_left') {
      const normalized = text(sessionId, 160);
      if (!normalized || viewHost?.getActiveSessionId?.() !== normalized) return true;
      const result = await viewHost.close(reason, '', { navigate: false });
      if (result?.ok === false) {
        callbacks.showToastMessage?.(
          jt('plugins.session.stopUnverifiedToast', 'Jenny could not verify that the plugin process stopped, so navigation is blocked.'),
          { tone: 'warning' },
        );
        return false;
      }
      return true;
    }

    async function requestClose(reason = 'user_closed', destination = '') {
      const result = await viewHost?.close?.(reason, destination);
      return result?.ok !== false;
    }

    function handleClick(event) {
      const target = event.target?.closest?.('[data-plugin-session-action]');
      if (!target) return;
      const action = target.dataset.pluginSessionAction;
      event.preventDefault();
      if (action === 'manage-plugins') callbacks.openSettingsSection?.('plugins');
    }

    function bind() {
      if (disposed) return;
      documentRef?.addEventListener?.('click', handleClick);
      root.rendererPluginSessions = { instance: controller };
      syncFallbackNotice();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      documentRef?.removeEventListener?.('click', handleClick);
      syncFallbackNotice();
      if (root.rendererPluginSessions?.instance === controller) root.rendererPluginSessions = null;
    }

    const controller = {
      bind, dispose, isPluginSession, openSessionView,
      guardLeaveSession, requestClose, syncFallbackNotice,
      getActiveSessionId: () => viewHost?.getActiveSessionId?.() || '',
    };
    return controller;
  }

  return { createPluginSessionController };
});
