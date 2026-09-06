/* renderer/shell/renderer-header-utils.js – titlebar metric strip + header button state (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHeaderUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createHeaderController(deps) {
    const { state } = deps;
    const {
      metricList,
      sessionActionButton, newChatButton,
    } = deps.dom;
    const {
      escapeHtml = (v) => String(v ?? ''),
      isSendBusy = () => false,
      isAnySendBusy = () => false,
      isSendPreflightPending = () => false,
      updateTokenDisplay = () => {},
      refreshSystemStats = async () => null,
      // Bounds a wedged refresh invoke so one hung promise cannot permanently
      // latch the single-flight guard and kill the affordance for the session.
      refreshTimeoutMs = 10000,
    } = deps.callbacks || {};
    // Read lazily: renderer feature flags hydrate asynchronously after
    // controllers are constructed, so a construction-time capture would pin
    // the flag to its pre-hydration value (usually off) for the whole session.
    function isTelemetryFlagOn() {
      return state.features?.featureFlags?.titlebar_gpu_telemetry === true;
    }

    function isGpuTelemetryBlocked(arch, platform) {
      const token = String(arch || '').trim().toLowerCase();
      const isArm = token === 'arm' || token === 'arm64';
      return isArm && String(platform || '') !== 'darwin';
    }

    function formatPercent(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return '0.0%';
      }
      return `${parsed.toFixed(1)}%`;
    }

    function formatVramGbValue(gpuMemory) {
      const usedMb = Number(gpuMemory && gpuMemory.usedMb);
      const totalMb = Number(gpuMemory && gpuMemory.totalMb);
      if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) {
        return '';
      }
      const usedGb = usedMb / 1024;
      const totalGb = totalMb / 1024;
      return `${usedGb.toFixed(1)}/${totalGb.toFixed(1)} GB`;
    }

    let _lastMetricsMarkup = null;
    let refreshInFlight = false;
    let disposed = false;
    let refreshAttached = false;
    let removeMetricRefresh = () => {};
    let lockdownMount = null;
    let lastLockdownState = null;

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
      mount.innerHTML = '<span class="session-offline-lockdown-badge" title="Offline lockdown">'
        + '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>'
        + '<span>Offline lockdown</span></span>'
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
          ? 'Offline lockdown is on for this session.'
          : (lastLockdownState === true ? 'Offline lockdown is off for this session.' : '');
      }
      lastLockdownState = active;
    }

    function renderHeader() {
      renderLockdownBadge();
      const telemetryFlagOn = isTelemetryFlagOn();
      syncMetricRefresh(telemetryFlagOn);
      const stats = state.systemStats || {};
      const gpuTelemetryBlocked = isGpuTelemetryBlocked(
        stats.arch,
        telemetryFlagOn ? stats.platform : undefined,
      );
      const gpuMemory = stats.gpuMemory && typeof stats.gpuMemory === 'object' ? stats.gpuMemory : null;
      const hasGpuVramMetric = !gpuTelemetryBlocked && gpuMemory && gpuMemory.available === true;
      const vramValue = hasGpuVramMetric ? formatVramGbValue(gpuMemory) : '';
      const memoryMetric = hasGpuVramMetric && vramValue
        ? { label: 'VRAM', value: vramValue, gpuDerived: true }
        : { label: 'RAM', value: formatPercent(stats.ramPercent) };
      const metrics = [
        { label: 'CPU', value: formatPercent(stats.cpuPercent) },
        ...(telemetryFlagOn && !gpuTelemetryBlocked && gpuMemory && gpuMemory.utilAvailable === true
          ? [{
              label: 'GPU',
              value: `${Number.isFinite(Number(gpuMemory.utilPercent)) ? Math.round(Number(gpuMemory.utilPercent)) : 0}%`,
              gpuDerived: true,
            }]
          : []),
        memoryMetric,
      ];

      if (metricList) {
        const metricsMarkup = metrics
          .map((metric) => {
            const staleAgeMs = Number(gpuMemory && gpuMemory.ageMs);
            const staleAgeSeconds = Number.isFinite(staleAgeMs)
              ? Math.max(0, Math.round(staleAgeMs / 10000) * 10)
              : 0;
            // A 0s bucket means stale-by-failure (or unparseable timestamp),
            // not stale-by-age — "0s old" would contradict the dimmed visual.
            const staleTitle = staleAgeSeconds > 0
              ? `GPU sample is ${staleAgeSeconds}s old`
              : 'GPU sample may be stale';
            const staleAttributes = telemetryFlagOn
              && metric.gpuDerived === true
              && gpuMemory
              && gpuMemory.stale === true
              ? ` data-stale="true" title="${staleTitle}"`
              : '';
            return `
            <span class="metric-item"${staleAttributes}>${escapeHtml(metric.label)}: ${escapeHtml(metric.value)}</span>
          `;
          })
          .join('<span class="stat-divider" aria-hidden="true"></span>');
        if (metricsMarkup !== _lastMetricsMarkup) {
          metricList.innerHTML = metricsMarkup;
          _lastMetricsMarkup = metricsMarkup;
        }
      }

      if (sessionActionButton) {
        sessionActionButton.textContent = 'End Session';
        sessionActionButton.disabled =
          !state.auth.authenticated ||
          ((!state.currentSessionId && !isAnySendBusy()) || isSendPreflightPending());
      }
      if (newChatButton) {
        // model_unavailable keeps New Chat usable — the composer is live in
        // that phase (sending retries the model load), so session creation
        // must not stay locked behind a 'ready'-only gate.
        newChatButton.disabled =
          !state.auth.authenticated
          || isSendPreflightPending()
          || (!['ready', 'model_unavailable'].includes(state.backend.phase) && !isAnySendBusy());
      }
      updateTokenDisplay();
    }

    // Attach/detach follows the flag's current value so late flag hydration
    // (or a live flag flip) is picked up on the next render.
    function syncMetricRefresh(flagOn) {
      if (disposed || !metricList || typeof metricList.addEventListener !== 'function') {
        return;
      }
      if (flagOn && !refreshAttached) {
        attachMetricRefresh();
      } else if (!flagOn && refreshAttached) {
        removeMetricRefresh();
      }
    }

    function attachMetricRefresh() {

      async function refreshMetrics() {
        if (refreshInFlight || disposed) return;
        refreshInFlight = true;
        metricList.classList.add('is-refreshing');
        let timeoutId = null;
        try {
          const payload = await Promise.race([
            refreshSystemStats(),
            new Promise((resolve) => {
              timeoutId = setTimeout(() => resolve(null), refreshTimeoutMs);
            }),
          ]);
          if (payload && !disposed) {
            state.systemStats = payload;
            renderHeader();
          }
        } catch (_error) {
          // Refresh is a best-effort titlebar affordance; scheduled polling remains active.
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
          refreshInFlight = false;
          metricList.classList.remove('is-refreshing');
        }
      }

      function onClick() {
        void refreshMetrics();
      }

      function onKeydown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.key === ' ') event.preventDefault();
        void refreshMetrics();
      }

      // No aria-label here: it would override name-from-content and hide every
      // metric value from screen readers. The span text is the accessible name.
      metricList.setAttribute('role', 'button');
      metricList.setAttribute('tabindex', '0');
      metricList.setAttribute('title', 'Click to refresh system stats');
      metricList.addEventListener('click', onClick);
      metricList.addEventListener('keydown', onKeydown);
      refreshAttached = true;
      removeMetricRefresh = () => {
        metricList.removeEventListener?.('click', onClick);
        metricList.removeEventListener?.('keydown', onKeydown);
        metricList.removeAttribute('role');
        metricList.removeAttribute('tabindex');
        metricList.removeAttribute('title');
        metricList.classList.remove('is-refreshing');
        refreshAttached = false;
      };
    }

    function dispose() {
      disposed = true;
      refreshInFlight = false;
      removeMetricRefresh();
      lockdownMount?.remove?.();
      lockdownMount = null;
    }

    syncMetricRefresh(isTelemetryFlagOn());
    return { renderHeader, dispose };
  }

  return { createHeaderController };
});
