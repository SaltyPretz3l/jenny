/* renderer/shell/renderer-header-utils.js – the title bar's machine-load read-out, the
   offline-lockdown badge and New Chat gating (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHeaderUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Backend phases where New Chat stays usable: the composer's usable +
  // preparing sets (renderer-render-pipeline-chrome.js backendComposer*).
  const NEW_CHAT_BACKEND_PHASES = new Set([
    'ready', 'model_unavailable',
    'sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying',
  ]);

  // Machine-load read-out slots: [kind, value-slot width class]. The first
  // slot is GPU utilization (CPU without it), the second VRAM (RAM without it).
  const READOUT_SLOTS = [['load', 'percent'], ['memory', 'memory']];
  const UNKNOWN_VALUE = '–';

  function createHeaderController(deps) {
    const { state } = deps;
    const { metricList, newChatButton } = deps.dom || {};
    const {
      escapeHtml = (v) => String(v ?? ''),
      isAnySendBusy = () => false,
      isSendPreflightPending = () => false,
    } = deps.callbacks || {};
    const documentRef = deps.documentRef || metricList?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const shell = deps.shell || (typeof window !== 'undefined' ? window.jennyShell : null) || null;
    // Read lazily: renderer feature flags hydrate asynchronously after
    // controllers are constructed, so a construction-time capture would pin
    // the flag to its pre-hydration value (usually off) for the whole session.
    function isTelemetryFlagOn() {
      return state.features?.featureFlags?.titlebar_gpu_telemetry === true;
    }

    function isReadoutEnabled() {
      return state.ui?.appearance?.titlebarLoad === true;
    }

    function isGpuTelemetryBlocked(arch, platform) {
      const token = String(arch || '').trim().toLowerCase();
      const isArm = token === 'arm' || token === 'arm64';
      return isArm && String(platform || '') !== 'darwin';
    }

    function formatPercent(value) {
      const parsed = value === null || value === undefined || value === '' ? NaN : Number(value);
      return Number.isFinite(parsed) ? `${Math.round(parsed)}%` : UNKNOWN_VALUE;
    }

    function formatVramUsed(gpuMemory) {
      const usedMb = Number(gpuMemory && gpuMemory.usedMb);
      const totalMb = Number(gpuMemory && gpuMemory.totalMb);
      if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
        return '';
      }
      return `${(usedMb / 1024).toFixed(1)} GB`;
    }

    function resolveStaleTitle(telemetryFlagOn, gpuMemory) {
      if (!telemetryFlagOn || !gpuMemory || gpuMemory.stale !== true) return '';
      const staleAgeMs = Number(gpuMemory.ageMs);
      const staleAgeSeconds = Number.isFinite(staleAgeMs) ? Math.max(0, Math.round(staleAgeMs / 10000) * 10) : 0;
      // A 0s bucket means stale-by-failure (or an unparseable timestamp), not
      // stale-by-age: "0s old" would contradict the dimmed visual.
      return staleAgeSeconds > 0
        ? jt('titlebar.gpuSampleAge', 'GPU sample is {seconds}s old', { seconds: staleAgeSeconds })
        : jt('titlebar.gpuSampleStale', 'GPU sample may be stale');
    }

    // The two slot values for the current stats: { label, value, gpuDerived }.
    function resolveReadout(stats) {
      const telemetryFlagOn = isTelemetryFlagOn();
      const blocked = isGpuTelemetryBlocked(stats.arch, telemetryFlagOn ? stats.platform : undefined);
      const gpuMemory = stats.gpuMemory && typeof stats.gpuMemory === 'object' ? stats.gpuMemory : null;
      const load = telemetryFlagOn && !blocked && gpuMemory && gpuMemory.utilAvailable === true
        ? { label: jt('titlebar.metrics.gpu', 'GPU'), value: formatPercent(gpuMemory.utilPercent), gpuDerived: true }
        : { label: jt('titlebar.metrics.cpu', 'CPU'), value: formatPercent(stats.cpuPercent), gpuDerived: false };
      const vram = !blocked && gpuMemory && gpuMemory.available === true ? formatVramUsed(gpuMemory) : '';
      const memory = vram
        ? { label: jt('titlebar.metrics.vram', 'VRAM'), value: vram, gpuDerived: true }
        : { label: jt('titlebar.metrics.ram', 'RAM'), value: formatPercent(stats.ramPercent), gpuDerived: false };
      return { slots: [load, memory], staleTitle: resolveStaleTitle(telemetryFlagOn, gpuMemory) };
    }

    let disposed = false;
    let readoutShown = false;
    let readoutNodes = null; // [{ item, label, value }] per slot, built once
    let lockdownMount = null;
    let lastLockdownState = null;

    function buildReadoutNodes() {
      if (readoutNodes || !documentRef || !metricList) return readoutNodes;
      readoutNodes = READOUT_SLOTS.map(([kind, slot]) => {
        const item = documentRef.createElement('span');
        item.className = 'metric-item';
        item.dataset.metric = kind;
        const label = documentRef.createElement('span');
        label.className = 'metric-item-label';
        const value = documentRef.createElement('span');
        value.className = 'metric-item-value';
        value.dataset.slot = slot;
        item.append(label, ' ', value);
        return { item, label, value };
      });
      metricList.replaceChildren(...readoutNodes.map((node) => node.item));
      return readoutNodes;
    }

    function setText(node, text) {
      if (node.textContent !== text) node.textContent = text;
    }

    function setStale(item, staleTitle) {
      if (staleTitle) {
        if (item.dataset.stale !== 'true') item.dataset.stale = 'true';
        if (item.getAttribute('title') !== staleTitle) item.setAttribute('title', staleTitle);
      } else if (item.dataset.stale !== undefined) {
        delete item.dataset.stale;
        item.removeAttribute('title');
      }
    }

    // The 2 s tick lands here: text nodes only, only while the read-out is on
    // and the document is visible. Off, it touches the DOM once (to hide).
    // Tells main whether the read-out is on screen so the stats tick runs at
    // 2 s only while it is (else 15 s). Sent on change only; never throws.
    let watchSent = null;
    function syncStatsWatch(watched) {
      if (watched === watchSent) return;
      watchSent = watched;
      try {
        Promise.resolve(shell?.system?.setStatsWatch?.({ source: 'titlebar', watched })).catch(() => {});
      } catch (_error) { /* best effort */ }
    }

    function renderSystemLoad() {
      if (disposed || !metricList) return;
      syncStatsWatch(isReadoutEnabled());
      if (!isReadoutEnabled()) {
        if (readoutShown || metricList.hidden !== true) metricList.hidden = true;
        readoutShown = false;
        return;
      }
      if (documentRef && documentRef.hidden === true) return;
      const nodes = buildReadoutNodes();
      if (!nodes) return;
      const { slots, staleTitle } = resolveReadout(state.systemStats || {});
      slots.forEach((slot, index) => {
        setText(nodes[index].label, slot.label);
        setText(nodes[index].value, slot.value);
        setStale(nodes[index].item, slot.gpuDerived ? staleTitle : '');
      });
      if (!readoutShown) {
        metricList.hidden = false;
        readoutShown = true;
      }
    }

    function isOfflineLockdownActive() {
      if (state.features?.featureFlags?.session_offline_lockdown !== true) return false;
      const currentSessionId = String(state.currentSessionId || '').trim();
      return Boolean(currentSessionId && (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => String(session?.id || '').trim() === currentSessionId)?.lockdown === true);
    }

    function ensureLockdownMount() {
      if (lockdownMount || !metricList?.ownerDocument || !metricList.parentNode) return lockdownMount;
      const doc = metricList.ownerDocument;
      const mount = doc.createElement('div');
      mount.className = 'session-lockdown-header';
      mount.innerHTML = '<span class="session-offline-lockdown-badge" title="' + escapeHtml(jt('titlebar.offlineLockdown.title', 'Offline lockdown')) + '">'
        + '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>'
        + '<span>' + escapeHtml(jt('titlebar.offlineLockdown.title', 'Offline lockdown')) + '</span></span>'
        + '<span class="sr-only session-lockdown-announcer" aria-live="polite" aria-atomic="true"></span>';
      metricList.parentNode.insertBefore(mount, metricList);
      lockdownMount = mount;
      return lockdownMount;
    }

    function renderLockdownBadge() {
      const mount = ensureLockdownMount();
      if (!mount) return;
      const active = isOfflineLockdownActive();
      const badge = mount.querySelector('.session-offline-lockdown-badge');
      const announcer = mount.querySelector('.session-lockdown-announcer');
      const view = metricList.ownerDocument?.defaultView;
      const reduceMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      if (badge) badge.hidden = !active;
      badge?.classList.toggle('session-offline-lockdown-badge--fade', active && !reduceMotion);
      if (active !== lastLockdownState && announcer) {
        announcer.textContent = active
          ? jt('titlebar.offlineLockdown.enabledAnnouncement', 'Offline lockdown is on for this session.')
          : (lastLockdownState === true ? jt('titlebar.offlineLockdown.disabledAnnouncement', 'Offline lockdown is off for this session.') : '');
      }
      lastLockdownState = active;
    }

    // Session, settings and backend changes land here (renderAll and its
    // peers); the stats tick does not (renderSystemLoad owns it).
    function renderHeader() {
      renderLockdownBadge();
      if (newChatButton) {
        // New Chat mirrors the composer's backend gate: it stays usable while
        // the model is unavailable (sending retries the load) and while the
        // sidecar (re)initializes. Session creation is owned by Electron main,
        // and a plugin/config refresh briefly re-enters sidecar_spawned; a
        // disabled button silently drops real clicks and every newChatButton
        // .click() caller (strip, palette, IDE dock) (F37).
        newChatButton.disabled =
          !state.auth.authenticated
          || isSendPreflightPending()
          || (!NEW_CHAT_BACKEND_PHASES.has(state.backend.phase) && !isAnySendBusy());
      }
      renderSystemLoad();
    }

    // The header owns its stats feed: the payload lands in state (the health
    // popover and diagnostics read it) and only the read-out repaints.
    let unsubscribeStats = null;
    try {
      const unsubscribe = shell?.system?.onStats?.((payload) => {
        if (disposed) return;
        state.systemStats = payload;
        renderSystemLoad();
      });
      unsubscribeStats = typeof unsubscribe === 'function' ? unsubscribe : null;
    } catch (_error) {
      unsubscribeStats = null;
    }

    function dispose() {
      if (watchSent === true) syncStatsWatch(false);
      disposed = true;
      try { unsubscribeStats?.(); } catch (_error) { /* best effort */ }
      unsubscribeStats = null;
      lockdownMount?.remove?.();
      lockdownMount = null;
    }

    return { renderHeader, renderSystemLoad, dispose };
  }

  return { createHeaderController };
});
