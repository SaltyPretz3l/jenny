/* Remote phone-control notice above the composer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  root.rendererRemoteControlBanner = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedActionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function normalizeStatus(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      reachable: source.reachable === true,
      sharedSessions: Array.isArray(source.shared_sessions || source.sharedSessions)
        ? (source.shared_sessions || source.sharedSessions).slice(0, 64) : [],
    };
  }

  function createRemoteControlBannerController(options = {}) {
    const state = options.state || {};
    const shell = options.shell || {};
    const remote = shell.remote || {};
    const callbacks = options.callbacks || {};
    const dom = options.dom || {};
    const banner = dom.banner || null;
    const label = dom.label || banner?.querySelector?.('#composerRemoteBannerLabel') || null;
    const actionButton = injectedActionButton;
    const documentRef = banner?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const appendClientLog = typeof callbacks.appendClientLog === 'function'
      ? callbacks.appendClientLog : function noopLog() {};
    const getCurrentSessionId = typeof callbacks.getCurrentSessionId === 'function'
      ? callbacks.getCurrentSessionId : () => state.currentSessionId;
    const isSessionStreaming = typeof callbacks.isSessionStreaming === 'function'
      ? callbacks.isSessionStreaming : () => false;
    const stopActiveStream = typeof callbacks.stopActiveStream === 'function'
      ? callbacks.stopActiveStream : function noopStop() {};
    let status = normalizeStatus(null);
    let disposed = false;
    let pending = false;
    let unsubscribe = null;
    let refreshVersion = 0;

    function materializeButton(candidate, config) {
      if (String(candidate?.tagName || '').toLowerCase() === 'button') return candidate;
      if (!banner || !documentRef || typeof actionButton !== 'function') return null;
      const wrapper = documentRef.createElement('span');
      wrapper.innerHTML = actionButton(config);
      const button = wrapper.firstElementChild;
      if (!button) return null;
      if (candidate?.replaceWith) candidate.replaceWith(button);
      else banner.querySelector?.('.composer-remote-banner-actions')?.appendChild(button);
      return button;
    }

    const takeControlButton = materializeButton(dom.takeControlButton, {
      domId: 'composerRemoteTakeControl', id: 'remote-take-control', label: jt('remote.banner.takeControl', 'Take control'),
      variant: 'secondary', size: 'sm', className: 'composer-remote-banner-button',
    });
    const stopButton = materializeButton(dom.stopButton, {
      domId: 'composerRemoteStop', id: 'remote-stop-response', label: jt('remote.banner.stopResponse', 'Stop response'),
      variant: 'secondary', size: 'sm', className: 'composer-remote-banner-button',
    });

    function currentControlledSession() {
      const sessionId = String(getCurrentSessionId() || '').trim();
      if (!sessionId || !status.reachable) return null;
      const shared = status.sharedSessions.find((session) => String(session?.id || '') === sessionId);
      const controlledBy = String(shared?.controlled_by || '').trim().toLowerCase();
      return shared && controlledBy && controlledBy !== 'desktop' ? { sessionId, shared } : null;
    }

    function update(nextStatus = status) {
      status = normalizeStatus(nextStatus);
      const controlled = currentControlledSession();
      const visible = Boolean(controlled);
      if (banner) {
        banner.hidden = !visible;
        banner.setAttribute('aria-hidden', visible ? 'false' : 'true');
      }
      if (label) label.textContent = jt('remote.banner.controllingConversation', 'Your phone is controlling this conversation');
      if (takeControlButton) takeControlButton.disabled = !visible || pending;
      if (stopButton) {
        const streaming = visible && isSessionStreaming(controlled.sessionId) === true;
        stopButton.hidden = !streaming;
        stopButton.disabled = !streaming;
      }
      return visible;
    }

    function reportRefusal(reason) {
      try {
        appendClientLog('WARN', 'remote.take_control_refused', {
          reason: String(reason || 'operation_failed').slice(0, 160),
        });
      } catch (_error) { /* logging is optional */ }
    }

    async function takeControl() {
      const controlled = currentControlledSession();
      if (disposed || pending || !controlled) return null;
      pending = true;
      update(status);
      try {
        if (typeof remote.takeControl !== 'function') throw new Error('remote_unavailable');
        const result = await remote.takeControl({ session_id: controlled.sessionId });
        if (disposed) return result;
        if (!result || result.ok !== true) reportRefusal(result?.reason);
        return result;
      } catch (error) {
        if (!disposed) reportRefusal(error?.message);
        return null;
      } finally {
        pending = false;
        if (!disposed) update(status);
      }
    }

    function stopResponse() {
      const controlled = currentControlledSession();
      if (!controlled || isSessionStreaming(controlled.sessionId) !== true) return;
      try { stopActiveStream(); } catch (_error) { /* existing stop path owns its error UI */ }
    }

    async function refresh() {
      if (disposed) return null;
      update(status);
      const version = ++refreshVersion;
      try {
        const next = typeof remote.getState === 'function' ? await remote.getState() : null;
        if (disposed || version !== refreshVersion) return null;
        update(next);
        return status;
      } catch (_error) {
        if (!disposed && version === refreshVersion) update(null);
        return null;
      }
    }

    function syncNow() {
      return disposed ? false : update(status);
    }

    takeControlButton?.addEventListener('click', takeControl);
    stopButton?.addEventListener('click', stopResponse);
    if (typeof remote.onStateChanged === 'function') {
      try { unsubscribe = remote.onStateChanged((next) => { if (!disposed) update(next); }); }
      catch (_error) { unsubscribe = null; }
    }
    update(null);
    void refresh();

    function dispose() {
      if (disposed) return;
      disposed = true;
      refreshVersion += 1;
      try { unsubscribe?.(); } catch (_error) { /* best effort */ }
      unsubscribe = null;
      takeControlButton?.removeEventListener('click', takeControl);
      stopButton?.removeEventListener('click', stopResponse);
      if (banner) {
        banner.hidden = true;
        banner.setAttribute('aria-hidden', 'true');
      }
    }

    return { refresh, syncNow, dispose };
  }

  return { createRemoteControlBannerController, normalizeStatus };
});
