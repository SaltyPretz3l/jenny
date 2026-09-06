(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererPluginSessionController = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const PROVIDER_SLOT_ID = 'pluginSessionProviderActions';
  const PROVIDER_ACTION = 'new-plugin-session';
  const FALLBACK_ID = 'pluginSessionFallback';

  function text(value, max = 120) {
    return String(value || '').trim().slice(0, max);
  }

  function providerRows(snapshot = {}) {
    const rows = [];
    for (const plugin of Array.isArray(snapshot.plugins) ? snapshot.plugins : []) {
      if (!plugin?.publisher_id || !plugin?.plugin_id || !plugin?.generation_id) continue;
      for (const contribution of Array.isArray(plugin.contributions) ? plugin.contributions : []) {
        if (contribution?.kind !== 'session_provider' || contribution.effective_enabled !== true) continue;
        rows.push(Object.freeze({
          publisherId: text(plugin.publisher_id, 64),
          pluginId: text(plugin.plugin_id, 64),
          providerContributionId: text(contribution.contribution_id, 64),
          generationId: text(plugin.generation_id, 96),
          displayName: text(contribution.display_name, 80) || 'Plugin session',
        }));
      }
    }
    return rows;
  }

  function createPluginSessionController(options = {}) {
    const windowRef = options.windowRef || root;
    const documentRef = options.documentRef || windowRef.document;
    const state = options.state || {};
    const viewHost = options.viewHost || null;
    const callbacks = options.callbacks || {};
    let providers = [];
    let disposed = false;
    let unsubscribeChanged = null;
    let refreshEpoch = 0;

    const bridge = () => windowRef.jennyShell?.plugins || null;
    const log = (level, event, details = {}) => {
      try { callbacks.appendClientLog?.(level, event, details); } catch (_error) { /* fail-soft */ }
    };

    function getSession(sessionId = state.currentSessionId) {
      const normalized = text(sessionId, 160);
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === normalized) || null;
    }

    function isPluginSession(sessionId = state.currentSessionId) {
      return getSession(sessionId)?.session_type === 'plugin';
    }

    function renderProviderActions() {
      const slot = documentRef?.getElementById?.(PROVIDER_SLOT_ID);
      const button = root.inventoryActionButton;
      if (!slot || typeof button !== 'function') return;
      const markup = providers.map((provider, index) => button({
        plain: true,
        className: 'new-chat-button plugin-session-provider-button',
        title: `New ${provider.displayName}`,
        ariaLabel: `New ${provider.displayName}`,
        dataset: { 'plugin-session-action': PROVIDER_ACTION, 'provider-index': String(index) },
        trustedHtml: '<svg class="new-chat-icon" viewBox="0 0 16 16" aria-hidden="true">'
          + '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"></rect>'
          + '<circle cx="6" cy="7" r="1"></circle><path d="M13 10.5 10.25 7.75 5.5 12.5"></path>'
          + `</svg><span class="new-chat-label">New ${button.escapeHtml(provider.displayName)}</span>`,
      })).join('');
      if (slot.innerHTML !== markup) slot.innerHTML = markup;
    }

    function syncFallbackNotice() {
      const notice = documentRef?.getElementById?.(FALLBACK_ID);
      const actionSlot = documentRef?.getElementById?.('pluginSessionFallbackAction');
      if (!notice || !actionSlot) return;
      const session = getSession();
      const visible = session?.session_type === 'plugin' && state.ui?.activeView === 'chat';
      notice.hidden = !visible;
      if (!visible) return;
      const provider = resolveCurrentProvider(session);
      const copy = notice.querySelector?.('[data-plugin-session-fallback-copy]');
      if (copy) copy.textContent = provider
        ? 'This transcript is read-only. Open the provider workspace to continue.'
        : 'This transcript is read-only because its plugin is missing, disabled, or incompatible.';
      const button = root.inventoryActionButton;
      if (typeof button === 'function') {
        actionSlot.innerHTML = button({
          label: provider ? 'Open provider' : 'Manage plugins',
          size: 'sm',
          dataset: { 'plugin-session-action': provider ? 'open-current' : 'manage-plugins' },
        });
      }
    }

    async function syncProviders(snapshot = null) {
      if (disposed) return [];
      const epoch = ++refreshEpoch;
      let current = snapshot;
      if (!current) {
        try { current = await bridge()?.getState?.(); }
        catch (_error) { current = null; }
      }
      if (disposed || epoch !== refreshEpoch) return providers;
      providers = current?.ok === true ? providerRows(current) : [];
      renderProviderActions();
      syncFallbackNotice();
      return providers;
    }

    function resolveCurrentProvider(session, snapshotProviders = providers) {
      const binding = session?.plugin_session;
      if (!binding) return null;
      return snapshotProviders.find((provider) => provider.publisherId === binding.publisher_id
        && provider.pluginId === binding.plugin_id
        && provider.providerContributionId === binding.provider_contribution_id) || null;
    }

    async function createSession(provider) {
      if (disposed || !provider) return '';
      const sessionId = text(await callbacks.handleCreateSession?.({
        sessionType: 'plugin',
        title: `New ${provider.displayName}`,
        providerAuthority: {
          publisher_id: provider.publisherId,
          plugin_id: provider.pluginId,
          provider_contribution_id: provider.providerContributionId,
          active_generation_id: provider.generationId,
        },
      }), 160);
      if (!sessionId || disposed) return sessionId;
      await openSessionView(sessionId, { userInitiated: true });
      return sessionId;
    }

    async function openSessionView(sessionId, { userInitiated = true } = {}) {
      const session = getSession(sessionId);
      if (!session || session.session_type !== 'plugin') return { ok: false, reason: 'not_plugin_session' };
      if (!userInitiated) return { ok: true, skipped: true };
      if (viewHost?.getActiveSessionId?.() === session.id && state.ui?.activeView === 'plugin') {
        return { ok: true, already_open: true };
      }
      const currentProviders = await syncProviders();
      if (disposed) return { ok: false, reason: 'plugin_session_controller_disposed' };
      const provider = resolveCurrentProvider(session, currentProviders);
      const binding = session.plugin_session;
      if (!provider || !binding?.view_contribution_id) {
        callbacks.setActiveView?.('chat');
        syncFallbackNotice();
        callbacks.showToastMessage?.(
          'This plugin is unavailable. The saved transcript remains readable.',
          { tone: 'warning' },
        );
        return { ok: false, reason: 'session_provider_unavailable', fallback: true };
      }
      const result = await viewHost?.open?.({
        publisher_id: provider.publisherId,
        plugin_id: provider.pluginId,
        contribution_id: binding.view_contribution_id,
        generation_id: provider.generationId,
        display_name: binding.provider_name || provider.displayName,
        sessionId: session.id,
      });
      if (!result?.ok) {
        callbacks.setActiveView?.('chat');
        callbacks.showToastMessage?.(
          'The provider workspace could not open. The saved transcript remains readable.',
          { tone: 'warning' },
        );
      }
      syncFallbackNotice();
      return result || { ok: false, reason: 'plugin_view_unavailable' };
    }

    async function guardLeaveSession(sessionId, reason = 'session_left') {
      const normalized = text(sessionId, 160);
      if (!normalized || viewHost?.getActiveSessionId?.() !== normalized) return true;
      const result = await viewHost.close(reason, '', { navigate: false });
      if (result?.ok === false) {
        callbacks.showToastMessage?.(
          'Jenny could not verify that the plugin process stopped, so navigation is blocked.',
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
      if (action === 'open-current') {
        void openSessionView(state.currentSessionId, { userInitiated: true });
        return;
      }
      if (action === 'manage-plugins') {
        callbacks.openSettingsSection?.('plugins');
        return;
      }
      if (action !== PROVIDER_ACTION) return;
      const provider = providers[Number(target.dataset.providerIndex)];
      void createSession(provider).catch((error) => {
        log('WARN', 'plugin_session.create_failed', { reason_code: text(error?.code || 'create_failed', 64) });
        callbacks.showToastMessage?.('Could not create the plugin session.', { tone: 'warning' });
      });
    }

    function bind() {
      if (disposed) return;
      documentRef?.addEventListener?.('click', handleClick);
      unsubscribeChanged = bridge()?.onChanged?.(() => { void syncProviders(); }) || null;
      void syncProviders();
      root.rendererPluginSessions = { instance: controller };
      syncFallbackNotice();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      refreshEpoch += 1;
      documentRef?.removeEventListener?.('click', handleClick);
      try { unsubscribeChanged?.(); } catch (_error) { /* ignore */ }
      unsubscribeChanged = null;
      providers = [];
      renderProviderActions();
      syncFallbackNotice();
      if (root.rendererPluginSessions?.instance === controller) root.rendererPluginSessions = null;
    }

    const controller = {
      bind, dispose, syncProviders, isPluginSession, createSession, openSessionView,
      guardLeaveSession, requestClose, syncFallbackNotice,
      getActiveSessionId: () => viewHost?.getActiveSessionId?.() || '',
      listProviders: () => providers.slice(),
    };
    return controller;
  }

  return { createPluginSessionController, providerRows };
});
