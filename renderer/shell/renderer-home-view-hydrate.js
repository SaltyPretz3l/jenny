/* renderer/shell/renderer-home-view-hydrate.js — UMD
 *
 * Home-view hydration for view activation and restored boot. Home's open-loops
 * panel and dashboard grid render a
 * loading skeleton until an async companion/dashboard fetch lands; this is the
 * single source of truth for that fetch, driven from both setActiveView('home')
 * and bootstrap() (when Home is the restored boot view — a direct activeView
 * restore otherwise skips it, leaving Home stuck "loading" forever).
 *
 * notifyBootViewReady() fires on success AND failure so the startup overlay can
 * hold until Home's first real render lands (then fade to it) without a failed
 * fetch ever stranding the overlay. The factory closes over the lifecycle
 * controller's forwarded callbacks (fwd) and its client-log appender.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererHomeViewHydrate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createHomeViewHydrator(deps) {
    const fwd = (deps && deps.fwd) || {};
    const appendClientLog = (deps && typeof deps.appendClientLog === 'function')
      ? deps.appendClientLog
      : function noopAppendClientLog() {};

    // refreshOffline defaults true for view activation, and bootstrap now
    // passes true too: it no longer awaits a fresh offline snapshot before
    // reaching Home (the reveal moved earlier -- see F1/F4 in the
    // startup-reveal review), so Home must pull its own offline snapshot
    // rather than trust a stale/absent one.
    function hydrateHomeView({ refreshOffline = true } = {}) {
      fwd.renderHomePanel();
      fwd.renderDashboard();
      fwd.refreshCompanionState().then(() => {
        fwd.renderHomePanel();
        fwd.renderDashboard();
        fwd.notifyBootViewReady();
      }).catch((err) => {
        appendClientLog('WARN', 'home.refresh_companion_failed', { message: String(err?.message || err || '') });
        /* EH-W10: error-center-only intake route (no toast for pollers). */
        fwd.reportError({ message: 'Companion state could not be refreshed.', dedupeKey: 'offline-refresh:companion' }, { origin: 'offline-refresh' });
        // Reveal the shell anyway so a failed fetch never strands the overlay.
        fwd.notifyBootViewReady();
      });
      if (refreshOffline) {
        // state.offline is pull-only; re-pull on activation so the Model &
        // Engine card never shows a stale boot-time snapshot.
        fwd.refreshOfflineState().then(() => fwd.renderDashboard())
          .catch((err) => {
            appendClientLog('WARN', 'home.refresh_offline_failed', { message: String(err?.message || err || '') });
            fwd.reportError({ message: 'Offline readiness could not be refreshed.', dedupeKey: 'offline-refresh:offline' }, { origin: 'offline-refresh' });
          });
      }
    }

    return { hydrateHomeView };
  }

  return { createHomeViewHydrator };
});
