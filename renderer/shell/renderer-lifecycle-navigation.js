/* renderer/shell/renderer-lifecycle-navigation.js - boot and view switching of the lifecycle controller.
 *
 * Split out of renderer-lifecycle-utils.js (which creates this once per controller, after the session
 * loaders exist): bootstrap() (boot view restore, first render, backend/auth hydration, session load)
 * and setActiveView() (the single view-switch chokepoint, with the one-shot first-activation marks).
 * Pure plumbing over the controller's own state, fwd renderers and loaders; the call order is unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleNavigation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createLifecycleNavigation(deps) {
    const {
      state,
      fwd,
      chatInput,
      isDisposed,
      appendClientLog,
      markStartupAudit,
      getRendererElapsedMs,
      noteFirstRenderComplete,
      scheduleDeferredVisualStartup,
      attachGlobalErrorBoundary,
      readPersistedActiveView,
      persistActiveView,
      hydrateHomeView,
      refreshDiagnosticsWorkspace,
      loadSessions,
      refreshSnapshots,
    } = deps;

    async function enableStartupAuditIfNeeded() {
      const diagnostics = globalThis?.jennyShell?.diagnostics;
      if (!diagnostics?.getStartupAuditConfig) {
        return null;
      }
      try {
        const config = await diagnostics.getStartupAuditConfig();
        if (config?.enabled === true) {
          globalThis.__jennyStartupAudit?.enable?.(config);
        }
        return config || null;
      } catch (_error) {
        return null;
      }
    }

    // One-shot first-open metrics for hidden surfaces.
    const hiddenSurfaceFirstActivationMarked = new Set();
    function markHiddenSurfaceFirstActivation(viewId) {
      if (hiddenSurfaceFirstActivationMarked.has(viewId)) {
        return;
      }
      hiddenSurfaceFirstActivationMarked.add(viewId);
      markStartupAudit('hidden-surface-first-activation', { view: viewId });
    }
    function setActiveView(viewId) {
      const previousViewId = state.ui.activeView;
      state.ui.activeView = viewId;
      persistActiveView(viewId);
      if (previousViewId === 'settings' && viewId !== 'settings') {
        fwd.syncUsageVisibility();
        // Off-view, renderSettings skips the page pass and only releases the
        // Appearance effect preview (renderAll no longer paints it here).
        fwd.renderSettings();
      }

      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        document.documentElement.dataset.activeView = String(viewId || '').trim() || 'chat';
      }
      fwd.applyViewChrome();
      fwd.renderLayout();
      fwd.renderHeader();
      if (viewId === 'ide') {
        markHiddenSurfaceFirstActivation('ide');
        fwd.renderIde?.();
        fwd.activateIde?.();
      }
      fwd.syncBackendNotice?.();
      if (viewId === 'logs') {
        markHiddenSurfaceFirstActivation('logs');
        fwd.renderLogs();
        refreshDiagnosticsWorkspace().catch(() => {});
      }
      if (viewId === 'settings') {
        markHiddenSurfaceFirstActivation('settings');
        fwd.renderSettings();
        fwd.restoreSettingsNavSection();
        const activeSection = String(state.ui.activeSettingsSection || 'models').trim() || 'models';
        fwd.ensureSettingsSectionReady?.(activeSection);
        fwd.refreshSettingsSection?.(activeSection).catch((error) => {
          if (activeSection === 'personality') {
            state.personality.loadStatus = jt('personality.workspaceRefreshFailed', 'Unable to refresh workspace: {message}', { message: error.message || String(error) });
            fwd.renderPersonalityEditor();
          }
          appendClientLog('WARN', 'settings.refresh_section_failed', {
            section: activeSection,
            message: String(error?.message || error || ''),
          });
        });
      }
      if (viewId === 'home') {
        hydrateHomeView();
      }
      if (viewId === 'chat') {
        const catchup = fwd.flushPendingStreamCommitsForSession(state.currentSessionId);
        fwd.renderMessages({ reason: catchup?.catchupRequired ? 'view_catchup' : 'view_activation' });
        fwd.renderComposerState();
        fwd.renderSessions();
        const activatedSessionId = state.currentSessionId;
        requestAnimationFrame(() => {
          if (isDisposed() || state.ui.activeView !== 'chat' || state.currentSessionId !== activatedSessionId) return;
          // Split view: the focused pane's composer, not pane 0's #chatInput.
          if (!globalThis.rendererAppPaneComposition?.getPaneComposition?.()?.focusComposer?.()) chatInput.focus();
          fwd.updateComposerSafeOffset({
            force: true,
            syncViewport: true,
          });
          fwd.updateAssistantSpritePosition();

          // The rail owns presence. Do not hide it behind a second, timed avatar.
          delete state.ui.morphStartRect;
        });
      } else {
        fwd.hideAssistantSprite();
      }
      fwd.applySurfaceEffect();
      appendClientLog('INFO', 'ui.view_changed', { viewId });
    }

    async function bootstrap({ signalRendererReadyOnce = () => {} } = {}) {
      attachGlobalErrorBoundary();
      // The startup-audit probe buffers marks until this async config enables it.
      void enableStartupAuditIfNeeded();
      markStartupAudit('renderer-bootstrap-started', {
        readyState: typeof document !== 'undefined' ? document.readyState : '',
      });
      appendClientLog('INFO', 'renderer.bootstrap_started', {
        elapsedMs: getRendererElapsedMs(),
      });
      // Restore the last-active top-level view across launches. The render
      // pipeline (renderViewChrome) branches on state.ui.activeView for every
      // view, so seeding it before renderAll lands the user where they left off
      // without forcing a setActiveView() (which would fire premature backend
      // refreshes at cold boot). Fresh profiles read nothing here and keep the
      // 'chat' default until first-run setup completion persists 'home'.
      const restoredActiveView = readPersistedActiveView();
      if (restoredActiveView) {
        state.ui.activeView = restoredActiveView;
      }
      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        document.documentElement.dataset.activeView = String(state.ui?.activeView || '').trim() || 'chat';
      }
      fwd.renderAll();
      noteFirstRenderComplete();
      markStartupAudit('first-render');
      // The curtain lifts after shared shell hydration and the restored view's
      // readiness; backend readiness is not a curtain gate, so the OS window
      // can reveal while hydration is still pending.
      signalRendererReadyOnce();
      scheduleDeferredVisualStartup();

      // The stored active tab, read alongside the status round trip, so the
      // first conversation load opens the chat the user left (the workspace
      // restore that follows then finds it loaded) instead of the newest one.
      const storedWorkspaceActiveSessionIdPromise = Promise.resolve()
        .then(() => window.jennyShell.workspace?.getState?.())
        .then((snapshot) => String(snapshot?.activeSessionId || '').trim())
        .catch(() => '');

      try {
        const [backendStatus, authState, systemStats] = await Promise.all([
          window.jennyShell.backend.getStatus(),
          window.jennyShell.auth.getState(),
          window.jennyShell.system.getStats(),
        ]);
        const currentBackendPhase = String(state.backend?.phase || '').trim().toLowerCase();
        const nextBackendPhase = String(backendStatus?.phase || '').trim().toLowerCase();
        const currentBackendSettled = currentBackendPhase === 'ready' || currentBackendPhase === 'failed';
        const nextBackendTransient = !nextBackendPhase
          || nextBackendPhase === 'starting'
          || nextBackendPhase === 'retrying';
        if (!(currentBackendSettled && nextBackendTransient)) {
          state.backend = backendStatus;
        }
        state.auth = authState;
        state.systemStats = systemStats;
        if (backendStatus && backendStatus.phase === 'ready') {
          appendClientLog('INFO', 'renderer.backend_ready', {
            elapsedMs: getRendererElapsedMs(),
            startupStage: backendStatus.startupStage || '',
            startupMs: Number(backendStatus.startupMs || 0),
          });
        }
      } catch (error) {
        appendClientLog('ERROR', 'bootstrap.failed', { message: error.message || String(error) });
      }

      fwd.renderAll();
      fwd.syncStartupBackendStatus?.(state.backend);
      if (state.ui.activeView === 'logs') {
        // Fine: the refresher reports diagnostics.refresh_failed itself before rethrowing (mirrors :392).
        refreshDiagnosticsWorkspace().catch(() => {});
      }
      if (state.ui.activeView !== 'home') {
        Promise.resolve().then(() => fwd.refreshOfflineState()).catch((error) => {
          appendClientLog('WARN', 'offline.bootstrap_failed', {
            message: error?.message || String(error),
          });
          /* EH-W10: error-center-only intake route (no toast for pollers). */
          fwd.reportError({ message: jt('shell.home.offlineRefreshFailed', 'Offline readiness could not be refreshed.'), dedupeKey: 'offline-refresh:offline' }, { origin: 'offline-refresh' });
        });
      }

      // History lives in the main-process store, not the sidecar, so the chat
      // list and the last-open chat hydrate without waiting for the engine.
      // Only the engine snapshots (status, models) wait for a usable backend
      // (model_unavailable keeps the chat surface usable: send retries the
      // model load); the ready transition reloads both (backendReadyLoadHandled).
      if (state.auth.authenticated) {
        const backendUsable = state.backend.phase === 'ready' || state.backend.phase === 'model_unavailable';
        const storedActiveSessionId = await storedWorkspaceActiveSessionIdPromise;
        const operations = backendUsable ? ['sessions', 'snapshots'] : ['sessions'];
        const results = await Promise.allSettled(backendUsable
          ? [loadSessions(storedActiveSessionId), refreshSnapshots()]
          : [loadSessions(storedActiveSessionId)]);
        operations.forEach((operation, index) => {
          if (results[index].status !== 'rejected') { return; }
          appendClientLog('WARN', 'renderer.bootstrap_session_hydration_failed', {
            operation,
            message: String(results[index].reason?.message || results[index].reason || '').slice(0, 500),
          });
        });
      }

      // Restoring the boot view above set state.ui.activeView directly (skipping
      // setActiveView's refreshes), so Home never ran its activation hydration and
      // would stay stuck on its loading skeleton — the reported "infinite loading".
      // Backend is settled now, so back-fill Home, including its own offline pull.
      if (state.ui.activeView === 'home') {
        hydrateHomeView({ refreshOffline: true });
      } else if (state.ui.activeView === 'ide') {
        // Same latent bug as Home above: the boot path seeds state.ui.activeView
        // directly, so renderAll() only calls renderIde() (chrome paint) and the
        // IDE's one-time activation hydration — re-opening the persisted tabs and
        // ide.activeTabPath — never fires. Without this the restored workspace
        // shows no open files until the user navigates away and back. (Editor
        // *settings* are separately re-applied by the Settings "Editor" section,
        // so the open files are the piece this back-fill restores.) activateIde()
        // is idempotent (guarded by the controller's activated/hydrated flags), so
        // a later manual navigation won't re-hydrate.
        try {
          if (await fwd.ensureIdeLoaded?.() !== false) {
            fwd.renderIde?.();
            await Promise.resolve(fwd.activateIde?.());
          }
        } catch (_error) {
          appendClientLog('WARN', 'ide.boot_activation_failed', { reason: 'persisted_tab_activation_failed' });
        } finally {
          fwd.notifyBootViewReady?.();
        }
      }

      appendClientLog('INFO', 'renderer.bootstrap_complete', {
        elapsedMs: getRendererElapsedMs(),
        backendPhase: state.backend.phase,
        authenticated: Boolean(state.auth && state.auth.authenticated),
      });
      markStartupAudit('renderer-bootstrap-complete', {
        backendPhase: state.backend.phase,
        authenticated: Boolean(state.auth && state.auth.authenticated),
      });
    }

    return { bootstrap, setActiveView };
  }

  return { createLifecycleNavigation };
});
