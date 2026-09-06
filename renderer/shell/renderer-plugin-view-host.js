(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/async-fence'));
    return;
  }
  root.rendererPluginViewHost = factory(root, root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, asyncFenceModule) {
  'use strict';

  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  // Refusals that name a condition the user can act on get their own copy; every
  // other reason keeps the generic line rather than leaking a raw enum.
  const OPEN_REFUSAL_COPY = Object.freeze({
    view_contribution_not_active: 'This plugin is not running, so its view cannot open.',
  });

  function createPluginViewHostController(options = {}) {
    const windowRef = options.windowRef || root;
    const documentRef = options.documentRef || windowRef.document;
    const state = options.state || {};
    const bridge = () => windowRef.jennyShell?.plugins || null;
    const host = documentRef?.getElementById('pluginView');
    const content = documentRef?.getElementById('pluginViewContentSlot');
    const title = documentRef?.getElementById('pluginViewTitle');
    const identity = documentRef?.getElementById('pluginViewIdentity');
    const status = documentRef?.getElementById('pluginViewStatus');
    const actions = documentRef?.getElementById('pluginViewActions');
    const chrome = documentRef?.getElementById('pluginViewTrustChrome');
    let activeIdentity = null;
    let activeSessionId = '';
    let previousViewId = 'settings';
    let lifecycleEpoch = 0;
    let zoom = 1;
    let resizeObserver = null;
    let unsubscribeHostCommand = null;
    let unsubscribeChanged = null;
    let disposed = false;
    const rendererRefreshGate = asyncFenceModule.createGenerationGate();

    const log = (level, event, detail) => {
      try { options.appendClientLog?.(level, event, detail || {}); } catch (_error) { /* fail-soft */ }
    };

    function setStatus(message, kind = 'info') {
      if (!status) return;
      status.textContent = String(message || '');
      status.dataset.state = kind;
    }

    function renderActions() {
      const button = root.inventoryActionButton;
      if (!actions || typeof button !== 'function') return;
      actions.innerHTML = [
        button({ label: 'Back', ariaLabel: 'Back', title: 'Go back in the plugin view', size: 'sm', variant: 'ghost', dataset: { 'plugin-view-action': 'back' } }),
        button({ label: '−', ariaLabel: 'Zoom out', title: 'Zoom out', size: 'sm', variant: 'ghost', dataset: { 'plugin-view-action': 'zoom-out' } }),
        '<span class="plugin-view-zoom" id="pluginViewZoomLabel">' + Math.round(zoom * 100) + '%</span>',
        button({ label: '+', ariaLabel: 'Zoom in', title: 'Zoom in', size: 'sm', variant: 'ghost', dataset: { 'plugin-view-action': 'zoom-in' } }),
        button({ label: 'Reset', ariaLabel: 'Reset zoom', title: 'Reset zoom', size: 'sm', variant: 'ghost', dataset: { 'plugin-view-action': 'zoom-reset' } }),
        button({ label: 'Close', ariaLabel: 'Close', title: 'Close the plugin view', size: 'sm', dataset: { 'plugin-view-action': 'close' } }),
      ].join('');
    }

    function currentBounds() {
      const rect = content?.getBoundingClientRect?.();
      if (!rect || rect.width < 1 || rect.height < 1) return null;
      return {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    }

    function syncBounds() {
      if (!activeIdentity || state.ui?.activeView !== 'plugin') return;
      const bounds = currentBounds();
      if (bounds) bridge()?.setViewBounds?.({ bounds }).catch?.(() => null);
    }

    function nextPaint() {
      return new Promise((resolve) => windowRef.requestAnimationFrame
        ? windowRef.requestAnimationFrame(() => windowRef.requestAnimationFrame(resolve))
        : windowRef.setTimeout(resolve, 0));
    }

    async function open(raw = {}) {
      if (disposed || !host || !content || !bridge()?.openView) return { ok: false, reason: 'plugin_view_unavailable' };
      const candidate = {
        publisher_id: String(raw.publisher_id || '').trim(),
        plugin_id: String(raw.plugin_id || '').trim(),
        contribution_id: String(raw.contribution_id || '').trim(),
        generation_id: String(raw.generation_id || '').trim(),
      };
      const sessionId = String(raw.sessionId || '').trim();
      if (!candidate.publisher_id || !candidate.plugin_id || !candidate.contribution_id) {
        return { ok: false, reason: 'plugin_view_identity_invalid' };
      }
      const before = String(state.ui?.activeView || 'settings');
      previousViewId = before === 'plugin' ? previousViewId : before;
      activeIdentity = candidate;
      activeSessionId = sessionId;
      lifecycleEpoch += 1;
      zoom = 1;
      if (title) title.textContent = String(raw.display_name || 'Plugin view').trim().slice(0, 96) || 'Plugin view';
      if (identity) identity.textContent = `${candidate.publisher_id} / ${candidate.plugin_id}`.slice(0, 160);
      renderActions();
      setStatus('Opening isolated plugin content…');
      options.setActiveView?.('plugin');
      await nextPaint();
      const bounds = currentBounds();
      if (!bounds || !activeIdentity) return { ok: false, reason: 'plugin_view_bounds_unavailable' };
      const epoch = lifecycleEpoch;
      let result;
      try {
        result = await bridge().openView({ ...candidate, bounds, lifecycle_epoch: epoch,
          ...(sessionId ? { sessionId } : {}),
          ...(typeof raw.artifact_payload_json === 'string'
            ? { artifact_payload_json: raw.artifact_payload_json }
            : {}) });
      } catch (error) {
        result = { ok: false, reason: 'plugin_view_open_failed' };
        log('WARN', 'plugin_view.open_failed', { message: String(error?.message || error) });
      }
      if (epoch !== lifecycleEpoch || !activeIdentity) return { ok: false, reason: 'plugin_view_superseded' };
      if (!result?.ok) {
        activeIdentity = null;
        activeSessionId = '';
        setStatus(OPEN_REFUSAL_COPY[String(result?.reason || '')]
          || 'Jenny could not open this isolated view.', 'error');
        log('WARN', 'plugin_view.open_refused', { reason_code: String(result?.reason || 'unknown') });
        return result || { ok: false, reason: 'plugin_view_open_failed' };
      }
      setStatus('Sandboxed · Network blocked', 'success');
      syncBounds();
      return result;
    }

    async function close(reason = 'user_closed', requestedDestination = '', { navigate = true } = {}) {
      lifecycleEpoch += 1;
      const hadActiveView = Boolean(activeIdentity);
      let result;
      try { result = await bridge()?.closeView?.(); }
      catch (_error) { result = { ok: false, reason: 'plugin_view_close_failed' }; }
      if (activeSessionId && result?.ok === false) {
        setStatus('Jenny could not prove that the provider process stopped. Navigation is blocked.', 'error');
        return result;
      }
      activeIdentity = null;
      activeSessionId = '';
      if (navigate && state.ui?.activeView === 'plugin') {
        const destination = ['home', 'chat', 'ide', 'logs', 'settings'].includes(requestedDestination)
          ? requestedDestination
          : (['home', 'chat', 'ide', 'logs', 'settings'].includes(previousViewId)
            ? previousViewId : 'settings');
        options.setActiveView?.(destination);
        if (destination === 'settings') options.openSettingsSection?.('plugins');
      }
      if (hadActiveView) log('INFO', 'plugin_view.closed', { reason_code: reason });
      return result?.ok === false ? result : { ok: true };
    }

    async function setZoom(next) {
      if (!activeIdentity) return;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(Number(next) * 10) / 10));
      const result = await bridge()?.setViewZoom?.({ zoom_factor: zoom });
      if (result?.ok && Number.isFinite(result.zoom_factor)) zoom = result.zoom_factor;
      renderActions();
      setStatus(`Sandboxed · Network blocked · Zoom ${Math.round(zoom * 100)}%`, 'success');
    }

    function focusChrome() {
      const first = actions?.querySelector?.('[data-plugin-view-action="back"]');
      (first || chrome)?.focus?.();
    }

    function handleClick(event) {
      const target = event.target?.closest?.('[data-plugin-view-action]');
      if (!target) return;
      const action = target.dataset.pluginViewAction;
      if (action === 'back' || action === 'close') void close(action);
      else if (action === 'zoom-in') void setZoom(zoom + 0.1);
      else if (action === 'zoom-out') void setZoom(zoom - 0.1);
      else if (action === 'zoom-reset') void setZoom(1);
    }

    function handleKeydown(event) {
      if (state.ui?.activeView !== 'plugin') return;
      if (event.key === 'F6') {
        event.preventDefault();
        bridge()?.focusView?.();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        void close('back_shortcut');
      } else if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault();
        void setZoom(event.key === '0' ? 1 : zoom + (event.key === '-' ? -0.1 : 0.1));
      }
    }

    function handleHostCommand(payload = {}) {
      if (payload.command === 'focus_chrome') focusChrome();
      else if (payload.command === 'back') void close('back_shortcut');
      else if (payload.command === 'provider_activated') void close('provider_activated', 'chat');
      else if (payload.command === 'zoom_changed' && Number.isFinite(payload.zoom_factor)) {
        zoom = payload.zoom_factor;
        renderActions();
      } else if (payload.command === 'view_state') {
        const states = {
          restarting: ['Plugin content crashed. Jenny is restarting it safely...', 'loading'],
          crashed: ['Plugin content could not be restarted.', 'error'],
          memory_warning: ['Plugin content is using unusually high memory.', 'warning'],
          ready: [`Sandboxed · Network blocked · Zoom ${Math.round(zoom * 100)}%`, 'success'],
        };
        const next = states[payload.state];
        if (next) setStatus(next[0], next[1]);
      }
    }

    async function validateActiveContribution() {
      if (!activeIdentity) return;
      const snapshot = await bridge()?.getState?.().catch?.(() => null);
      const plugin = snapshot?.plugins?.find?.((item) => item.publisher_id === activeIdentity.publisher_id
        && item.plugin_id === activeIdentity.plugin_id);
      const contribution = plugin?.contributions?.find?.((item) => item.contribution_id === activeIdentity.contribution_id);
      if (!contribution?.effective_enabled) void close('authority_withdrawn');
    }

    function renderPluginArtifact(contribution, ctx) {
      const payload = ctx.artifact?.pluginPayload;
      if (payload === undefined) throw new Error('plugin artifact payload missing');
      const serialized = JSON.stringify(payload);
      if (new TextEncoder().encode(serialized).byteLength > 4 * 1024 * 1024) {
        throw new Error('plugin artifact payload exceeds limit');
      }
      const { surface, deps } = ctx;
      surface.editorShell.classList.add('hidden');
      surface.previewContent.classList.remove('hidden');
      surface.previewContent.replaceChildren();
      // The preview surface arrives through ctx, not from this module's own
      // getElementById chrome lookups -- so build into ITS document.
      const surfaceDoc = surface.previewContent.ownerDocument || documentRef;
      const copy = surfaceDoc.createElement('p');
      copy.textContent = `Open this ${ctx.artifact.artifactKind || 'plugin'} artifact in its isolated renderer.`;
      const buttonMarkup = root.inventoryActionButton;
      if (typeof buttonMarkup !== 'function') throw new Error('inventory button unavailable');
      const buttonHost = surfaceDoc.createElement('span');
      buttonHost.innerHTML = buttonMarkup({ label: 'Open isolated renderer', size: 'sm' });
      const button = buttonHost.firstElementChild;
      if (!button) throw new Error('inventory button unavailable');
      button.addEventListener('click', () => void open({ ...contribution, artifact_payload_json: serialized }), { once: true });
      surface.previewContent.append(copy, button);
      deps.setDetailNote(surface, 'Plugin rendering is isolated; Jenny retains navigation and trust controls.');
    }

    async function refreshPluginRenderers(snapshot = null) {
      const registry = root.rendererArtifactsRendererRegistry;
      if (!registry?.registerPluginRenderer) return;
      rendererRefreshGate.bump();
      const refreshToken = rendererRefreshGate.capture();
      const current = snapshot || await bridge()?.getState?.().catch?.(() => null);
      if (disposed || !rendererRefreshGate.isCurrent(refreshToken)) return;
      registry.clearPluginRenderers?.();
      for (const plugin of current?.plugins || []) {
        for (const contribution of plugin.contributions || []) {
          if (!contribution.effective_enabled || contribution.kind !== 'artifact_renderer') continue;
          for (const kind of contribution.view?.artifact_kinds || []) {
            registry.registerPluginRenderer(kind, (ctx) => renderPluginArtifact({
              publisher_id: plugin.publisher_id,
              plugin_id: plugin.plugin_id,
              contribution_id: contribution.contribution_id,
              generation_id: plugin.generation_id,
              display_name: contribution.display_name,
            }, ctx));
          }
        }
      }
    }

    function bind() {
      if (disposed || !host) return;
      renderActions();
      actions?.addEventListener('click', handleClick);
      documentRef.addEventListener('keydown', handleKeydown);
      windowRef.addEventListener('resize', syncBounds);
      if (typeof windowRef.ResizeObserver === 'function' && content) {
        resizeObserver = new windowRef.ResizeObserver(syncBounds);
        resizeObserver.observe(content);
      }
      unsubscribeHostCommand = bridge()?.onViewHostCommand?.(handleHostCommand) || null;
      unsubscribeChanged = bridge()?.onChanged?.(() => {
        void validateActiveContribution();
        void refreshPluginRenderers();
      }) || null;
      void refreshPluginRenderers();
    }

    function dispose() {
      disposed = true;
      rendererRefreshGate.bump();
      lifecycleEpoch += 1;
      activeIdentity = null;
      activeSessionId = '';
      actions?.removeEventListener('click', handleClick);
      documentRef?.removeEventListener('keydown', handleKeydown);
      windowRef.removeEventListener('resize', syncBounds);
      resizeObserver?.disconnect?.();
      root.rendererArtifactsRendererRegistry?.clearPluginRenderers?.();
      try { unsubscribeHostCommand?.(); } catch (_error) { /* ignore */ }
      try { unsubscribeChanged?.(); } catch (_error) { /* ignore */ }
      void bridge()?.closeView?.();
    }

    return { bind, dispose, open, close, setZoom, syncBounds,
      getActiveSessionId: () => activeSessionId };
  }

  return { createPluginViewHostController };
});
