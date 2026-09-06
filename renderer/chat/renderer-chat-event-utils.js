(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-chat-event-transcript-bindings'),
      require('./renderer-chat-event-settings-bindings'),
      require('./renderer-chat-event-interactive-bindings'),
      require('./renderer-chat-backend-recovery-utils'),
      require('./renderer-window-controls-utils'),
      require('./renderer-render-pipeline-thread-state'),
      require('../shared/async-fence'),
      require('./renderer-enter-keydown-utils')
    );
    return;
  }
  root.rendererChatEventUtils = factory(
    root.rendererChatEventTranscriptBindings,
    root.rendererChatEventSettingsBindings,
    root.rendererChatEventInteractiveBindings,
    root.rendererChatBackendRecoveryUtils,
    root.rendererWindowControlsUtils,
    root.rendererRenderPipelineThreadStateUtils,
    root.rendererAsyncFence,
    root.rendererEnterKeydownUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  transcriptBindingsFactory,
  settingsBindingsFactory,
  interactiveBindingsFactory,
  backendRecoveryUtils,
  windowControlsUtils,
  threadStateUtils,
  asyncFence,
  enterKeydownUtils
) {
  const motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};
  // IME composition guard for Enter-to-send; the single definition lives in
  // renderer-enter-keydown-utils.js (shared with the ask_user question card).
  // Re-exported below so existing consumers keep importing it from here.
  const { shouldSendOnEnterKeydown } = enterKeydownUtils || {};
  if (typeof shouldSendOnEnterKeydown !== 'function') {
    throw new Error('renderer-enter-keydown-utils must load before renderer-chat-event-utils');
  }
  function clearThreadBranchCollapseState(state) {
    if (typeof threadStateUtils?.clearThreadBranchCollapseState === 'function') {
      return threadStateUtils.clearThreadBranchCollapseState(state);
    }
    const stateUi = state?.ui;
    if (!stateUi || typeof stateUi !== 'object' || Array.isArray(stateUi)) return false;
    if (!Object.prototype.hasOwnProperty.call(stateUi, 'threadBranchesCollapsedBySession')) return false;
    try {
      Map.prototype.clear.call(stateUi.threadBranchesCollapsedBySession);
      return true;
    } catch (_error) {
      stateUi.threadBranchesCollapsedBySession = new Map();
      return false;
    }
  }


  function createChatEventBindings(deps) {
    const { state } = deps;

    const {
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
    } = deps.constants;

    const {
      homeNavButton,
      promptGrid,
      chatInput,
      newChatButton,
      stopStreamButton,
      sendButton,
      jumpToTopButton,
      jumpToLastPromptButton,
      jumpToBottomButton,
      chatView,
      chatThreadScroll,
      composerWrap,
      chatTimeline,
      toastViewport,
      composerModelSelect,
      composerEffortSelect,
      composerSettingsButton,
      openComposerSettingsViewButton,
      composerCommandPopover,
      artifactReviewPanel,
    } = deps.dom;

    const {
      setActivityChangeListener,
      handleActivityChange,
      renderHeader,
      renderAll,
      setToolCallExpansion = function noopSetToolCallExpansion() {},
      renderLogs,
      pushIncomingLog,
      syncBackendActivityFromStatus,
      appendClientLog,
      getRendererElapsedMs,
      loadSessions,
      refreshSnapshots,
      refreshSuggestions,
      refreshApprovedMemories,
      resetArtifactsState,
      resetMemorySuggestionState,
      resetAttachmentQueue,
      closeComposerPopover,
      openComposerPopover,
      closeCommandPopover,
      openCommandPopover,
      hideAssistantSprite,
      setFollowLatest,
      setActiveView,
      syncComposerInputHeight,
      syncComposerVisualState,
      renderComposerState,
      handleCreateSession,
      handleStopActiveStream,
      showSessionActionError,
      handleSend,
      showComposerActionError,
      handleJumpToTop,
      handleJumpToLastPrompt,
      handleJumpToBottom,
      handleComposerPaste = function noopHandleComposerPaste() {
        return { accepted: true, sizeBytes: 0, warned: false };
      },
      syncThreadScrollState,
      getPendingQuestionBatch,
      handleInteractiveOptionSelect,
      handleInteractiveOtherConfirm,
      handleInteractiveSubmit,
      handleInteractiveSkip,
      handleInteractiveSkipQuestion,
      handleInteractiveSkipAll,
      handleInteractiveOtherInputChange,
      toggleInteractiveRoundRecap,
      toggleThreadBranch,
      handleCopyMessage,
      handleElaborateMessage,
      handleRegenerateMessage,
      handleBranchMessage,
      handleEditMessage,
      handleEditCommit,
      handleEditCancel,
      handleFollowUpMessage,
      setReasoningPhaseExpandedPreference,
      setReasoningPhaseExpandedPreferences,
      syncThinkingBlockNode,
      dismissToast,
      showShellErrorToast,
      showToastMessage,
      reportError = null,
      toErrorMessage,
      beginActivity,
      resolveActivity,
      failActivity,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      getCurrentRuntimePreferences,
      handleSaveProactiveSuggestionMessage,
      handleLaterProactiveSuggestionMessage,
      handleUseProactiveSuggestionMessage,
      handleLifecycleProgress,
      handleLifecycleBackendStatus,
      clearChatSendLifecycle = () => false,
      beginModelSwitch,
      updateModelSwitch,
      failModelSwitch,
      adjustChatZoomPercent,
      resetChatZoomPercent,
      openSettingsSection,
      handleErrorRecoveryAction,
      handleArtifactAction,
      handleCodeReviewAction = function noopHandleCodeReviewAction() { return Promise.resolve(); }, handleOpenChangeDiff = function noopHandleOpenChangeDiff() { return Promise.resolve(false); },
      handleComposerToggleChange,
      getCurrentSessionMessages, getSessionTurnEventState = function noopGetSessionTurnEventState() { return { turnEvents: [] }; },
      getSessionMessages, setSessionMessages,
      scrollMessageIntoView, viewportReveal, focusEntryByMessageId,
      setComposerStatusNotice = function noopSetComposerStatusNotice() {},
      clearComposerStatusNotice = function noopClearComposerStatusNotice() {},
      handleSlashCommandSelection = function noopSlashCommandSelection() {},
    } = deps.callbacks;

    const { thinkingController, toastActionHandlers, timelineVirtualizer, chatScrollCoordinator, messageEditController, messageBranchController, selectionController, bulkActionsController, unreadOrientationController } = deps.controllers;

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
      });
    }

    function resolveToolCallId(target) {
      const targetNode = target && typeof target.closest === 'function' ? target : null;
      const toolShell = targetNode?.closest('[data-approval-id], [data-call-id], [data-tool-call-id]');
      return toolShell?.dataset
        ? String(toolShell.dataset.approvalId || toolShell.dataset.toolCallId || toolShell.dataset.callId || '').trim()
        : '';
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

    const cleanupFns = [];
    let bindAbortController = null;
    let bound = false;
    const transitionFence = asyncFence.createDisposalFence();
    const transitionGate = asyncFence.createGenerationGate();
    // Captured from wireChatAccessibility so the command palette's "Keyboard
    // shortcuts" item can open the chat overlay outside the IDE view.
    let chatAccessibility = null;

    function addCleanup(cleanup) {
      if (typeof cleanup === 'function') {
        cleanupFns.push(cleanup);
      }
    }

    function readCssDurationMs(variableName, fallbackMs) {
      if (typeof document === 'undefined' || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return fallbackMs;
      }
      const rawValue = window.getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
      if (!rawValue) {
        return fallbackMs;
      }
      if (rawValue.endsWith('ms')) {
        const parsedMs = Number.parseFloat(rawValue);
        return Number.isFinite(parsedMs) ? parsedMs : fallbackMs;
      }
      if (rawValue.endsWith('s')) {
        const parsedSeconds = Number.parseFloat(rawValue);
        return Number.isFinite(parsedSeconds) ? parsedSeconds * 1000 : fallbackMs;
      }
      return fallbackMs;
    }

    function prefersReducedMotion() {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function getToolDetailsTransitionMs() {
      return prefersReducedMotion()
        ? 0
        : readCssDurationMs('--motion-duration-regular', 220);
    }

    const toolDetailsTimers = new WeakMap();

    function clearToolDetailsTimer(detailsEl) {
      if (!detailsEl) {
        return;
      }
      const timerId = toolDetailsTimers.get(detailsEl);
      if (!timerId) {
        return;
      }
      window.clearTimeout(timerId);
      toolDetailsTimers.delete(detailsEl);
    }

    function resolvePredictionLineHeight(element) {
      if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return 15 * 1.6;
      }
      const parsedLineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      return Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : 15 * 1.6;
    }

    function isChatWheelBlocked(event) {
      return state.ui?.activeView !== 'chat' || isTargetInsideArtifactReview(event.target);
    }

    function toggleToolDetails(toolHeader, nextExpanded) {
      if (!toolHeader) {
        return;
      }
      const expanded = Boolean(nextExpanded);
      toolHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const restoreFocus = document?.activeElement === toolHeader;
      const rowKey = String(toolHeader.dataset?.toolRowKey || '').trim();
      if (rowKey) setToolCallExpansion(rowKey, expanded);
      if (rowKey && typeof chatTimeline?.dispatchEvent === 'function') {
        const CustomEventCtor = document?.defaultView?.CustomEvent || globalThis.CustomEvent;
        if (typeof CustomEventCtor === 'function') {
          chatTimeline.dispatchEvent(new CustomEventCtor('tool-row-user-expansion', {
            detail: { rowKey, expanded },
          }));
        }
      }
      const ownerBlock = toolHeader.closest?.('.tool-call-block') || null;
      if (expanded && ownerBlock?.dataset?.toolDetailsMaterialized === 'false') {
        renderAll({ forceFullRender: true });
        const materializedHeader = Array.from(chatTimeline.querySelectorAll('.tool-call-header'))
          .find((node) => node.dataset?.toolRowKey === rowKey);
        const materialized = materializedHeader
          ?.closest?.('.tool-call-block')?.dataset?.toolDetailsMaterialized === 'true';
        if (materialized) {
          toggleToolDetails(materializedHeader, true);
        }
        if (restoreFocus) materializedHeader?.focus?.({ preventScroll: true });
        return;
      }
      const detailsId = toolHeader.getAttribute('aria-controls');
      const detailsEl = ownerBlock?.querySelector?.('.tool-call-details') || (detailsId ? document.getElementById(detailsId) : null);
      if (!detailsEl) {
        return;
      }
      clearToolDetailsTimer(detailsEl);
      const transitionMs = getToolDetailsTransitionMs();
      let measuredHeight = Math.max(detailsEl.scrollHeight || 0, detailsEl.offsetHeight || 0);
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (measuredHeight === 0 && expanded && _pretextUtils && _pretextUtils.isEnabled(state)) {
        const textContent = String(detailsEl.textContent || '').trim();
        if (textContent) {
          const font = _pretextUtils.resolveFontString(detailsEl)
            || _pretextUtils.resolveDefaultFontString('.chat-bubble');
          const maxWidth = _pretextUtils.resolveElementWidth(detailsEl.parentElement) || 560;
          const lineHeight = resolvePredictionLineHeight(detailsEl);
          const cacheKey = 'tooldetail:' + (String(toolHeader.dataset.messageId || '').trim() || detailsId);
          const prediction = _pretextUtils.predictTextHeight(
            cacheKey,
            textContent,
            font,
            maxWidth,
            lineHeight
          );
          if (prediction && prediction.height > 0) {
            measuredHeight = Math.ceil(prediction.height);
          }
        }
      }

      if (expanded) {
        detailsEl.hidden = false;
        motionHeightUtils.pinHeightForTransition(detailsEl, 0);
        detailsEl.classList.add('expanded');
        requestAnimationFrame(() => {
          detailsEl.style.maxHeight = `${Math.max(detailsEl.scrollHeight || measuredHeight || 0, 0)}px`;
        });
        if (transitionMs === 0) {
          detailsEl.style.maxHeight = 'none';
          return;
        }
        const timerId = window.setTimeout(() => {
          if (toolHeader.getAttribute('aria-expanded') === 'true') {
            detailsEl.style.maxHeight = 'none';
          }
          toolDetailsTimers.delete(detailsEl);
        }, transitionMs);
        toolDetailsTimers.set(detailsEl, timerId);
        return;
      }

      motionHeightUtils.pinHeightForTransition(detailsEl, Math.max(motionHeightUtils.resolveCollapseStartPx(detailsEl), measuredHeight));
      requestAnimationFrame(() => {
        detailsEl.classList.remove('expanded');
        detailsEl.style.maxHeight = '0px';
      });
      if (transitionMs === 0) {
        detailsEl.hidden = true;
        detailsEl.style.maxHeight = '';
        return;
      }
      const timerId = window.setTimeout(() => {
        if (toolHeader.getAttribute('aria-expanded') !== 'true') {
          detailsEl.hidden = true;
          detailsEl.style.maxHeight = '';
        }
        toolDetailsTimers.delete(detailsEl);
      }, transitionMs);
      toolDetailsTimers.set(detailsEl, timerId);
    }

    function registerListener(target, eventName, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return;
      }
      target.addEventListener(eventName, handler, options);
      if (!bindAbortController) {
        addCleanup(() => {
          target.removeEventListener(eventName, handler, options);
        });
      }
    }

    function isTargetInsideArtifactReview(target) {
      if (!artifactReviewPanel || !target || typeof artifactReviewPanel.contains !== 'function') {
        return false;
      }
      return artifactReviewPanel.contains(target);
    }

    // C3 Stage A: recap-fallback + audio helpers + activeAssistantReplyAudio
    // are owned by renderer-chat-event-transcript-bindings.js. The sibling
    // also owns the chatTimeline click/keydown/audio listener registrations
    // (see the bind() call below).
    const transcriptBindings = (transcriptBindingsFactory && typeof transcriptBindingsFactory.createTranscriptEventBindings === 'function')
      ? transcriptBindingsFactory.createTranscriptEventBindings({
          chatTimeline,
          state,
          thinkingController,
          handleCopyMessage,
          handleRegenerateMessage,
          handleElaborateMessage,
          handleEditMessage,
          handleEditCommit,
          handleEditCancel,
          handleFollowUpMessage,
          handleUseProactiveSuggestionMessage,
          handleSaveProactiveSuggestionMessage,
          handleLaterProactiveSuggestionMessage,
          handleBranchMessage,
          handleErrorRecoveryAction,
          handleArtifactAction,
          handleCodeReviewAction, handleOpenChangeDiff,
          toggleInteractiveRoundRecap,
          toggleThreadBranch,
          setReasoningPhaseExpandedPreference,
          setReasoningPhaseExpandedPreferences,
          syncThinkingBlockNode,
          showComposerActionError,
          renderAll,
          setToolCallExpansion,
          refreshRecoveredSession: async ({ payload } = {}) => {
            const sessionId = String(payload?.sessionId || '').trim();
            if (sessionId) state.messagesBySession?.delete?.(sessionId);
            await loadSessions(sessionId, { preserveCurrentSession: true });
            await refreshSnapshots();
          },
          resolveToolCallId,
          toggleToolDetails, getToolDetailsTransitionMs, selectionController, timelineVirtualizer,
          getSessionMessages, setSessionMessages,
        })
      : null;
    if (!transcriptBindings) {
      throw new Error('renderer-chat-event-utils: transcript-bindings factory wire-up failed');
    }

    // C3 Stage B: toast / Composer model+effort selects /
    // composer-popover toggle / plan / web-search bindings
    // are owned by renderer-chat-event-settings-bindings.js.
    const settingsBindings = (settingsBindingsFactory && typeof settingsBindingsFactory.createSettingsEventBindings === 'function')
      ? settingsBindingsFactory.createSettingsEventBindings({
          toastViewport,
          composerModelSelect,
          composerEffortSelect,
          composerSettingsButton,
          openComposerSettingsViewButton,
          state,
          TOAST_SOURCE,
          ACTIVITY_SCOPE,
          dismissToast,
          showShellErrorToast, showToastMessage,
          toErrorMessage,
          beginActivity,
          resolveActivity,
          failActivity,
          appendClientLog,
          refreshSnapshots,
          beginModelSwitch,
          updateModelSwitch,
          failModelSwitch,
          getRuntimePreferenceSnapshot,
          runRuntimePreferenceActivity,
          getCurrentRuntimePreferences,
          showComposerActionError,
          closeComposerPopover,
          openComposerPopover,
          setActiveView,
          setComposerStatusNotice,
          clearComposerStatusNotice,
          toastActionHandlers,
        })
      : null;
    if (!settingsBindings) {
      throw new Error('renderer-chat-event-utils: settings-bindings factory wire-up failed');
    }
    const interactiveBindings = (interactiveBindingsFactory && typeof interactiveBindingsFactory.bindInteractiveComposerEvents === 'function')
      ? interactiveBindingsFactory
      : null;
    if (!interactiveBindings) {
      throw new Error('renderer-chat-event-utils: interactive-bindings factory wire-up failed');
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      transitionGate.bump();
      transitionFence.dispose();
      globalThis.rendererContextMeterDetails?.dispose?.();
      window.rendererPlanUsageMeter?.dispose?.();
      chatAccessibility = null; transcriptBindings.dispose?.();
      setActivityChangeListener(null);
      if (bindAbortController) {
        bindAbortController.abort();
        bindAbortController = null;
      }
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch (error) {
          // Best-effort teardown keeps renderer dispose idempotent.
        }
      }
    }

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
      state.currentSessionId = '';
      state.messagesBySession.clear();
      state.turnEventsBySession?.clear?.();
      state.sessionMessageAccessOrder?.clear?.();
      state.pendingStreams.clear();
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
          includeMemory: true,
        },
      };
      state.memoryManager.memories = [];
      state.memoryManager.loading = false;
      state.memoryManager.loaded = false;
      state.memoryManager.unavailable = false;
      state.memoryManager.status = 'Sign in to load approved memories.';
      state.memoryManager.filter = 'all';
      state.memoryManager.searchQuery = '';
      state.memoryManager.draftsById.clear();
      state.memoryManager.pendingActionById.clear();
      resetMemorySuggestionState?.();
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

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      bindAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      const listenerOptions = bindAbortController ? { signal: bindAbortController.signal } : undefined;
      if (chatScrollCoordinator?.attach) {
        const detachScrollCoordinator = chatScrollCoordinator.attach({ registerListener, listenerOptions });
        if (typeof detachScrollCoordinator === 'function') addCleanup(detachScrollCoordinator);
      }

      setActivityChangeListener((scope) => {
        handleActivityChange(scope);
      });

      addCleanup(window.jennyShell.system.onStats((payload) => {
        state.systemStats = payload;
        // Only the titlebar meters consume system stats; no settings section
        // renders state.systemStats, so re-rendering the whole settings panel on
        // every stats tick (now every 2s) is wasted work. renderHeader() — which
        // owns the CPU/RAM/VRAM display — is the only repaint this needs.
        renderHeader();
      }));
      addCleanup(window.rendererPlanUsageMeter?.install?.({ shell: window.jennyShell, state, onChange: renderAll }) || (() => {}));

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
      const subscribeDiagnostics = window.jennyShell.diagnostics?.logs?.onEntry
        || window.jennyShell.logs.onAppend;
      addCleanup(subscribeDiagnostics((entry) => {
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
              reportError?.({ message: 'Approved memories could not be refreshed.', options: { source: TOAST_SOURCE.memory, dedupeKey: 'settings-refresh:memories' } }, { origin: 'settings-refresh' });
            }
            if (shouldStopAuthenticatedTransition(transitionToken)) return;
          }
          refreshSuggestions().catch((err) => {
            appendClientLog('WARN', 'chat.refresh_suggestions_failed', { message: String(err?.message || err) });
            reportError?.({ message: 'Suggestions could not be refreshed.', options: { source: TOAST_SOURCE.chatStream, dedupeKey: 'settings-refresh:suggestions' } }, { origin: 'settings-refresh' });
          });
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
            reportError?.({ message: 'Approved memories could not be refreshed.', options: { source: TOAST_SOURCE.memory, dedupeKey: 'settings-refresh:memories' } }, { origin: 'settings-refresh' });
          }
          if (shouldStopAuthenticatedTransition(transitionToken)) return;
        } else {
          clearSignedOutRendererState();
        }
        if (!isCurrentTransition(transitionToken)) return;
        renderAll();
      }));

      registerListener(homeNavButton, 'click', () => {
        setActiveView('home');
      }, listenerOptions);

      registerListener(promptGrid, 'click', (event) => {
        const tipChip = event.target.closest('[data-tip-settings]');
        if (tipChip) {
          openSettingsSection(String(tipChip.dataset.tipSettings || 'home').trim() || 'home');
          return;
        }
        const chip = event.target.closest('[data-prompt]');
        if (!chip) {
          return;
        }
        chatInput.value = chip.dataset.prompt;
        syncComposerInputHeight();
        syncComposerVisualState();
        chatInput.focus();
      }, listenerOptions);

      windowControlsUtils?.bindWindowControlEvents?.({
        documentRef: document,
        windowRef: window,
        shell: window.jennyShell,
        registerListener,
        listenerOptions,
        addCleanup,
        appendClientLog,
      });

      registerListener(newChatButton, 'click', () => {
        handleCreateSession().catch((error) => {
          showSessionActionError(error, 'Create Session Failed');
        });
      }, listenerOptions);

      registerListener(sendButton, 'click', () => {
        handleSend().catch((error) => {
          showComposerActionError(error, 'Send Failed');
        });
      }, listenerOptions);

      registerListener(stopStreamButton, 'click', () => {
        handleStopActiveStream().catch((error) => {
          showComposerActionError(error, 'Stop Failed');
        });
      }, listenerOptions);

      registerListener(jumpToTopButton, 'click', () => {
        handleJumpToTop();
      }, listenerOptions);

      registerListener(jumpToLastPromptButton, 'click', () => {
        handleJumpToLastPrompt();
      }, listenerOptions);

      registerListener(jumpToBottomButton, 'click', () => {
        handleJumpToBottom();
      }, listenerOptions);

      registerListener(chatInput, 'keydown', (event) => {
        if (globalThis.rendererPlanModeShortcut?.handleRunModeCycleShortcut?.(event, document)) return;
        if (globalThis.rendererPlanModeShortcut?.handlePlanModeShortcut?.(event, document)) return;
        if (shouldSendOnEnterKeydown(event)) {
          event.preventDefault();
          if (sendButton?.disabled === true) return;
          handleSend().catch((error) => {
            showComposerActionError(error, 'Send Failed');
          });
        }
      }, listenerOptions);

      registerListener(chatInput, 'input', () => {
        syncComposerInputHeight(); syncComposerVisualState(); renderComposerState();
        globalThis.rendererComposerSessionStateController?.captureActive(state.currentSessionId, 'input');
      }, listenerOptions);

      registerListener(chatInput, 'paste', (event) => {
        handleComposerPaste(event);
      }, listenerOptions);

      // Composer right-click: clipboard items plus (when the preload exposes the
      // spellcheck bridge) Chromium's corrections for the word under the cursor.
      // The builder lives in the interactive-composer bindings sibling because
      // this file sits at the modularity ceiling.
      interactiveBindings.bindComposerContextMenu?.({
        chatInput,
        registerListener,
        listenerOptions,
        addCleanup,
        handleComposerPaste,
        appendClientLog,
        showComposerActionError,
        spellcheckApi: (typeof window !== 'undefined' && window.jennyShell)
          ? window.jennyShell.spellcheck
          : null,
      });

      registerListener(composerCommandPopover, 'click', (event) => {
        const btn = event.target.closest('[data-command-name]');
        if (!btn) return;
        if (btn.getAttribute('aria-disabled') === 'true' || btn.dataset.commandAvailable === 'false') {
          showToastMessage(btn.dataset.commandReason || 'That command is unavailable.', {
            title: 'Command unavailable',
            tone: 'warning',
          });
          return;
        }
        handleSlashCommandSelection(btn.dataset.commandName, btn.dataset.commandAction === 'run' ? 'run' : 'insert');
        closeCommandPopover();
        chatInput.focus();
        syncComposerInputHeight();
        syncComposerVisualState();
      }, listenerOptions);

      if (!chatScrollCoordinator?.attach) {
        let pendingLegacyScrollFrame = 0;
        registerListener(chatThreadScroll, 'scroll', () => {
          if (pendingLegacyScrollFrame) return;
          pendingLegacyScrollFrame = requestAnimationFrame(() => {
            pendingLegacyScrollFrame = 0;
            if (bound) syncThreadScrollState();
          });
        }, listenerOptions);
        addCleanup(() => {
          if (pendingLegacyScrollFrame) cancelAnimationFrame(pendingLegacyScrollFrame);
          pendingLegacyScrollFrame = 0;
        });
      }

      const wheelListenerOptions = bindAbortController
        ? { signal: bindAbortController.signal, passive: false }
        : { passive: false };

      registerListener(chatView, 'wheel', (event) => {
        if (!event.ctrlKey || isChatWheelBlocked(event)) {
          return;
        }
        const deltaY = Number(event.deltaY || 0);
        if (deltaY === 0) {
          return;
        }
        event.preventDefault();
        Promise.resolve(adjustChatZoomPercent(deltaY < 0 ? 1 : -1)).catch((error) => {
          appendClientLog('WARN', 'chat.zoom_wheel_failed', {
            message: error?.message || String(error || 'Could not adjust chat zoom.'),
          });
        });
      }, wheelListenerOptions);

      registerListener(window, 'keydown', (event) => {
        const key = String(event.key || '').trim();
        const code = String(event.code || '').trim();
        if (
          !event.ctrlKey
          || !(
            key === '0'
            || code === 'Digit0'
            || code === 'Numpad0'
          )
          || state.ui?.activeView !== 'chat'
          || isTargetInsideArtifactReview(event.target)
        ) {
          return;
        }
        event.preventDefault();
        Promise.resolve(resetChatZoomPercent()).catch((error) => {
          appendClientLog('WARN', 'chat.zoom_reset_failed', {
            message: error?.message || String(error || 'Could not reset chat zoom.'),
          });
        });
      }, listenerOptions);

      registerListener(composerWrap, 'click', (event) => {
        const commandShortcut = event.target.closest('#composerTerminalShortcut');
        if (commandShortcut) {
          event.preventDefault();
          if (state.ui.commandPopoverOpen) {
            closeCommandPopover({ restoreFocus: true });
          } else {
            openCommandPopover();
          }
          return;
        }
      }, listenerOptions);

      interactiveBindings.bindInteractiveComposerEvents({
        composerWrap,
        // B7a: the interactive panel renders as a first-class timeline row, so
        // delegate its click/input/keydown from the timeline container.
        interactiveDelegateRoot: chatTimeline,
        registerListener,
        listenerOptions,
        getPendingQuestionBatch,
        handleInteractiveOptionSelect,
        handleInteractiveOtherConfirm,
        handleInteractiveSubmit,
        handleInteractiveSkip,
        handleInteractiveSkipQuestion,
        handleInteractiveSkipAll,
        handleInteractiveOtherInputChange,
        handleComposerToggleChange,
        showComposerActionError,
        state,
      });

      // C3 Stage A: chatTimeline click / keydown / audio listeners live in the transcript sibling.
      transcriptBindings.bindTranscriptEvents(registerListener, listenerOptions, bindAbortController);

      // C3 Stage B: toast / model / preference / composer-popover listeners live in the settings sibling.
      settingsBindings.bindSettingsEvents(registerListener, listenerOptions);

      // Track E/F/B: keyboard focus, help/search overlays, virtualizer, and message actions.
      chatAccessibility = globalThis.rendererChatKeyboardUtils?.wireChatAccessibility?.({
        state, chatTimeline, chatThreadScroll, chatView, document, registerListener, listenerOptions, addCleanup,
        timelineVirtualizer, chatScrollCoordinator,
        messageEditController, messageBranchController, selectionController, bulkActionsController, unreadOrientationController,
        getCurrentSessionMessages, getSessionTurnEventState, renderAll, scrollMessageIntoView, viewportReveal, focusEntryByMessageId, appendClientLog,
        getActiveView: () => state.ui?.activeView || '',
      }) || null;
    }

    // Opens the chat keyboard-shortcuts overlay (command-palette "Keyboard
    // shortcuts" entry routes here when the IDE view is not active).
    function openHelpOverlay() {
      try { chatAccessibility?.helpOverlay?.open?.(); } catch (_err) { /* best-effort */ }
    }

    return { bind, dispose, openHelpOverlay };
  }

  return { createChatEventBindings, shouldSendOnEnterKeydown, clearThreadBranchCollapseState };
});
