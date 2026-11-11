/* renderer/chat/renderer-chat-shell-subscriptions.js owns pane 0's shell
 * push subscriptions: the diagnostics log stream (rAF-coalesced, deferred
 * while hidden, forwarding Ollama tray conflicts), backend status (ready-time
 * session / snapshot / memory loads and in-flight send recovery), lifecycle
 * progress, and auth state, with the transition fence that stops a stale
 * async load and the signed-out renderer reset. renderer-chat-event-utils.js
 * creates it per chat-event binding and loads after it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatShellSubscriptions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createChatShellSubscriptions(deps) {
    const {
      state,
      callbacks,
      TOAST_SOURCE,
      thinkingController,
      backendRecoveryUtils,
      asyncFence,
      clearThreadBranchCollapseState,
    } = deps;
    const {
      renderAll,
      renderLogs,
      pushIncomingLog,
      syncBackendActivityFromStatus,
      appendClientLog,
      getRendererElapsedMs,
      loadSessions,
      refreshSnapshots,
      refreshApprovedMemories, refreshComposerToolToggles = async () => {},
      resetArtifactsState,
      resetAttachmentQueue,
      closeComposerPopover,
      hideAssistantSprite,
      setFollowLatest,
      dismissToast,
      showToastMessage,
      reportError = null,
      handleLifecycleProgress,
      handleLifecycleBackendStatus,
      clearChatSendLifecycle = () => false,
      openSettingsSection,
    } = callbacks;

    // The optional Ollama tray-remediation module is resolved lazily across the browser/CommonJS seam.
    function resolveOllamaTrayToastModule() {
      const globalScope = typeof globalThis !== 'undefined' ? globalThis : null;
      return (globalScope && globalScope.rendererOllamaTrayToast)
        || (typeof require === 'function'
          ? (() => {
            try {
              return require('../shell/renderer-ollama-tray-toast');
            } catch (_error) {
              return null;
            }
          })()
          : null);
    }

    function forwardOllamaTrayConflictLogEntry(entry) {
      const trayToastModule = resolveOllamaTrayToastModule();
      if (!trayToastModule || typeof trayToastModule.handleOllamaTrayConflictLogEntry !== 'function') {
        return;
      }
      const bridge = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.ollamaTray) || null;
      const featureFlags = (state.features && state.features.featureFlags) || {};
      trayToastModule.handleOllamaTrayConflictLogEntry(entry, {
        showToast: showToastMessage,
        bridge,
        featureFlags,
        navigate: (sectionId) => openSettingsSection(sectionId, { source: 'ollama_tray_remediation' }),
        appendClientLog,
        dismissToast,
      });
    }

    function recoverInflightSendsForUnusableBackend(payload) {
      return backendRecoveryUtils.recoverInflightSendsForUnusableBackend({
        payload,
        state,
        clearChatSendLifecycle,
        getMultiStreamController: () => globalThis.rendererMultiStreamController || null,
        appendClientLog,
        showToastMessage,
        reportError,
        toastSource: TOAST_SOURCE.chatStream,
      });
    }

    const transitionFence = asyncFence.createDisposalFence();
    const transitionGate = asyncFence.createGenerationGate();

    function beginTransition() {
      transitionGate.bump();
      return transitionGate.capture();
    }

    function isCurrentTransition(token) {
      return !transitionFence.isDisposed() && transitionGate.isCurrent(token);
    }

    function clearSignedOutRendererState() {
      globalThis.rendererMultiStreamController?.dispose?.();
      state.sessions = [];
      state.currentSessionId = ''; callbacks?.resetPanes?.(); // split view W1-4c: back to one blank pane
      state.messagesBySession.clear();
      state.turnEventsBySession?.clear?.();
      state.sessionMessageAccessOrder?.clear?.();
      state.pendingStreams.clear();
      state.streamDeltaKindByStream?.clear?.();
      state.streamThinkingStatusByStream.clear();
      state.toolCallsByStream.clear();
      state.pendingToolApprovals.clear();
      state.queuedSendBySession?.clear?.();
      state.turnClockBySession?.clear?.();
      state.sendOutboxController?.clearAll?.();
      state.sendOutboxBySession?.clear?.();
      state.ui?.chatSendLifecycleBySession?.clear?.();
      state.ui?.chatSendFailuresBySession?.clear?.();
      const composerV2 = state.ui?.composerV2;
      if (composerV2 && typeof composerV2 === 'object') {
        composerV2.draftsBySession?.clear?.();
        composerV2.lifecycleBySession?.clear?.();
      }
      state.activeStreamId = '';
      state.activeStreamSessionId = '';
      state.sendPreflight = null;
      state.runtimeDraft = {
        preferredModel: '',
        reasoningEffort: 'default',
        runMode: state.defaultRunMode || 'ask',
        planMode: false,
        contextPreferences: {
          historyScope: 'session',
          includePersonality: true,
          includeMemory: true, memoryOptOut: false,
        },
      };
      state.memoryManager.memories = [];
      state.memoryManager.loading = false;
      state.memoryManager.loaded = false;
      state.memoryManager.unavailable = false;
      state.memoryManager.status = jt('chat.events.signInToLoadMemories', 'Sign in to load approved memories.');
      state.memoryManager.filter = 'all';
      state.memoryManager.searchQuery = '';
      state.memoryManager.draftsById.clear();
      state.memoryManager.pendingActionById.clear();
      state.sendReceiptController?.clearFailedPayloads?.();
      globalThis.rendererComposerSessionStateController?.clearAll?.();
      resetAttachmentQueue();
      state.interactiveDraftsBySession.clear();
      if (
        state.ui?.interactiveRecapExpandedBySession
        && typeof state.ui.interactiveRecapExpandedBySession.clear === 'function'
      ) {
        state.ui.interactiveRecapExpandedBySession.clear();
      }
      resetArtifactsState();
      clearThreadBranchCollapseState(state);
      closeComposerPopover();
      thinkingController.prune([]);
      thinkingController.resumeAutoScroll();
      setFollowLatest(true);
      hideAssistantSprite({ clearTarget: true });
    }

    function shouldStopAuthenticatedTransition(token) {
      if (isCurrentTransition(token) && state.auth?.authenticated === true) return false;
      if (!transitionFence.isDisposed() && state.auth?.authenticated !== true) {
        clearSignedOutRendererState();
      }
      return true;
    }

    // Pane 0 only: renderer-chat-event-utils binds these inside its
    // document-level block, in this order, before its own button listeners.
    function bind(addCleanup) {
      let logRenderRafId = 0;
      let logRenderPendingWhileHidden = false;
      const requestRenderFrame = (cb) => (typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(cb)
        : window.setTimeout(() => cb(), 16));
      const cancelRenderFrame = (id) => {
        if (typeof window.cancelAnimationFrame === 'function') { window.cancelAnimationFrame(id); }
        else { window.clearTimeout(id); }
      };
      /* Coalesce a burst of appends into a single rAF-aligned render, and skip
         rendering entirely while the window is hidden -- flush once it returns. */
      function scheduleLogRender() {
        if (typeof document !== 'undefined' && document.hidden) {
          logRenderPendingWhileHidden = true;
          return;
        }
        if (logRenderRafId) { return; }
        logRenderRafId = requestRenderFrame(() => {
          logRenderRafId = 0;
          renderLogs();
        });
      }
      function flushPendingLogRenderOnVisible() {
        if (logRenderPendingWhileHidden && !document.hidden) {
          logRenderPendingWhileHidden = false;
          if (state.ui.activeView === 'logs') { scheduleLogRender(); }
        }
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', flushPendingLogRenderOnVisible);
        addCleanup(() => document.removeEventListener('visibilitychange', flushPendingLogRenderOnVisible));
      }
      addCleanup(() => {
        if (logRenderRafId) {
          cancelRenderFrame(logRenderRafId);
          logRenderRafId = 0;
        }
      });
      addCleanup(window.jennyShell.diagnostics.logs.onEntry((entry) => {
        pushIncomingLog(entry);
        forwardOllamaTrayConflictLogEntry(entry);
        if (state.ui.activeView === 'logs') {
          scheduleLogRender();
        }
      }));

      addCleanup(window.jennyShell.backend.onStatus(async (payload) => {
        const transitionToken = beginTransition();
        state.backend = payload;
        syncBackendActivityFromStatus(payload);
        handleLifecycleBackendStatus(payload);
        recoverInflightSendsForUnusableBackend(payload);
        if (!payload || payload.phase !== 'ready') { state.backendReadyLoadHandled = false; } // #9: re-arm dedupe guard
        if (payload && payload.phase === 'ready') {
          appendClientLog('INFO', 'renderer.backend_ready', { elapsedMs: getRendererElapsedMs(), startupStage: payload.startupStage || '', startupMs: Number(payload.startupMs || 0) });
          Promise.resolve(refreshComposerToolToggles()).catch(() => {}); // Tools row: built from the sidecar's tools_status, which exists only once ready (the boot read runs first) and changes on each re-init (root switch)
          const authSnapshot = await window.jennyShell.auth.getState();
          if (!isCurrentTransition(transitionToken)) return;
          state.auth = authSnapshot;
          if (state.auth.authenticated) {
            // #9: only one of (this push listener, the bootstrap pull) loads per ready transition.
            if (!state.backendReadyLoadHandled) {
              state.backendReadyLoadHandled = true;
              await loadSessions();
              if (shouldStopAuthenticatedTransition(transitionToken)) return;
              await refreshSnapshots();
              if (shouldStopAuthenticatedTransition(transitionToken)) return;
            }
            try {
              await refreshApprovedMemories({ force: true });
            } catch (err) {
              if (shouldStopAuthenticatedTransition(transitionToken)) return;
              appendClientLog('WARN', 'chat.refresh_memories_failed', { message: String(err?.message || err) });
              /* EH-W10: deduped warning toast when intake routing is on. */
              reportError?.({ message: jt('chat.events.approvedMemoriesRefreshFailed', 'Approved memories could not be refreshed.'), options: { source: TOAST_SOURCE.memory, dedupeKey: 'settings-refresh:memories' } }, { origin: 'settings-refresh' });
            }
            if (shouldStopAuthenticatedTransition(transitionToken)) return;
          }
        }
        if (!isCurrentTransition(transitionToken)) return;
        renderAll();
      }));

      if (window.jennyShell.lifecycle) {
        addCleanup(window.jennyShell.lifecycle.onProgress((payload) => {
          handleLifecycleProgress(payload);
        }));
      }

      addCleanup(window.jennyShell.auth.onState(async (payload) => {
        const transitionToken = beginTransition();
        state.auth = payload;
        if (payload.authenticated) {
          await loadSessions();
          if (shouldStopAuthenticatedTransition(transitionToken)) return;
          await refreshSnapshots();
          if (shouldStopAuthenticatedTransition(transitionToken)) return;
          try {
            await refreshApprovedMemories({ force: true });
          } catch (err) {
            if (shouldStopAuthenticatedTransition(transitionToken)) return;
            appendClientLog('WARN', 'chat.auth_refresh_memories_failed', { message: String(err?.message || err) });
            reportError?.({ message: jt('chat.events.approvedMemoriesRefreshFailed', 'Approved memories could not be refreshed.'), options: { source: TOAST_SOURCE.memory, dedupeKey: 'settings-refresh:memories' } }, { origin: 'settings-refresh' });
          }
          if (shouldStopAuthenticatedTransition(transitionToken)) return;
        } else {
          clearSignedOutRendererState();
        }
        if (!isCurrentTransition(transitionToken)) return;
        renderAll();
      }));
    }

    function dispose() {
      transitionGate.bump();
      transitionFence.dispose();
    }

    return { bind, dispose };
  }

  return { createChatShellSubscriptions };
});
