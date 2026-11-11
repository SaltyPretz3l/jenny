(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-chat-event-transcript-bindings'),
      require('./renderer-chat-event-settings-bindings'),
      require('./renderer-chat-event-interactive-bindings'),
      require('./renderer-chat-backend-recovery-utils'),
      require('./renderer-render-pipeline-thread-state'),
      require('../shared/async-fence'),
      require('./renderer-enter-keydown-utils'),
      require('./renderer-chat-ctrl-wheel-gate'),
      require('./renderer-chat-tool-row-toggles'),
      require('./renderer-chat-shell-subscriptions')
    );
    return;
  }
  root.rendererChatEventUtils = factory(
    root.rendererChatEventTranscriptBindings,
    root.rendererChatEventSettingsBindings,
    root.rendererChatEventInteractiveBindings,
    root.rendererChatBackendRecoveryUtils,
    root.rendererRenderPipelineThreadStateUtils,
    root.rendererAsyncFence,
    root.rendererEnterKeydownUtils,
    root.rendererChatCtrlWheelGate,
    root.rendererChatToolRowToggles,
    root.rendererChatShellSubscriptions
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  transcriptBindingsFactory,
  settingsBindingsFactory,
  interactiveBindingsFactory,
  backendRecoveryUtils,
  threadStateUtils,
  asyncFence,
  enterKeydownUtils,
  ctrlWheelGate,
  toolRowToggles,
  shellSubscriptionsFactory
) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
    // Split view W1-4b: the session this composer's pane holds; built standalone with no
    // context module (browser-shaped tests), it reads the focused session as before.
    const paneSessionContextUtils = globalThis.rendererPaneSessionContext
      || (typeof require === 'function' ? require('./renderer-pane-session-context') : null);
    const sessionContext = deps.sessionContext
      || paneSessionContextUtils?.createPaneSessionContext?.({ state, paneId: deps.paneId })
      || { getSessionId: () => state.currentSessionId };
    // Split view W2-3: a second pane binds its own composer, scroll and timeline only (document-level stays pane 0's).
    const documentLevel = (sessionContext.paneId ?? 0) === 0;

    const {
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
    } = deps.constants;

    const {
      homeNavButton,
      chatInput,
      newChatButton,
      stopStreamButton,
      sendButton,
      jumpToTopButton,
      jumpToBottomButton,
      chatView,
      chatThreadScroll,
      composerWrap,
      chatTimeline,
      toastViewport,
      composerModelSelect,
      composerEffortSelect,
      composerRunModeSlot,
      artifactReviewPanel, chatSelectionOverlayHost,
    } = deps.dom;

    const {
      setActivityChangeListener,
      handleActivityChange,
      renderAll,
      setToolCallExpansion = function noopSetToolCallExpansion() {},
      appendClientLog,
      loadSessions,
      refreshSnapshots,
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
      toggleContextCompactionDetails,
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
      syncThinkingBlockNode,
      dismissToast,
      showShellErrorToast,
      showToastMessage,
      toErrorMessage,
      beginActivity,
      resolveActivity,
      failActivity,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
      handleSaveProactiveSuggestionMessage,
      handleLaterProactiveSuggestionMessage,
      handleUseProactiveSuggestionMessage,
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
      getSessionMessages, setSessionMessages, getCurrentVisibleMessages = () => [],
      scrollMessageIntoView, viewportReveal, focusEntryByMessageId,
      setComposerStatusNotice = function noopSetComposerStatusNotice() {},
      clearComposerStatusNotice = function noopClearComposerStatusNotice() {},
    } = deps.callbacks;

    const { thinkingController, toastActionHandlers, timelineVirtualizer, chatScrollCoordinator, messageEditController, messageBranchController, selectionController, bulkActionsController, unreadOrientationController } = deps.controllers;

    // Pane 0's shell push subscriptions (logs, backend status, lifecycle,
    // auth) and the signed-out reset: renderer-chat-shell-subscriptions.js.
    const shellSubscriptions = shellSubscriptionsFactory.createChatShellSubscriptions({
      state,
      callbacks: deps.callbacks,
      TOAST_SOURCE,
      thinkingController,
      backendRecoveryUtils,
      asyncFence,
      clearThreadBranchCollapseState,
    });

    function resolveToolCallId(target) {
      const targetNode = target && typeof target.closest === 'function' ? target : null;
      const toolShell = targetNode?.closest('[data-approval-id], [data-call-id], [data-tool-call-id]');
      return toolShell?.dataset
        ? String(toolShell.dataset.approvalId || toolShell.dataset.toolCallId || toolShell.dataset.callId || '').trim()
        : '';
    }

    const cleanupFns = [];
    let bindAbortController = null;
    let bound = false;
    // Captured from wireChatAccessibility so the command palette's "Keyboard
    // shortcuts" item can open the chat overlay outside the IDE view.
    let chatAccessibility = null;

    function addCleanup(cleanup) {
      if (typeof cleanup === 'function') {
        cleanupFns.push(cleanup);
      }
    }

    // The legacy .tool-call-header disclosure: renderer-chat-tool-row-toggles.js.
    const { toggleToolDetails, getToolDetailsTransitionMs } = toolRowToggles.createToolDetailsToggle({
      state, chatTimeline, renderAll, setToolCallExpansion,
    });

    function isChatWheelBlocked(event) {
      return state.ui?.activeView !== 'chat' || isTargetInsideArtifactReview(event.target);
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
          getSessionId: sessionContext.getSessionId, // the pane's session for the transcript view control
          ownsFileDiffRegistry: documentLevel, // W2-3: pane 1's dispose must not clear pane 0's registry
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
          handleStopActiveStream,
          handleCodeReviewAction, handleOpenChangeDiff,
          toggleInteractiveRoundRecap,
          toggleContextCompactionDetails,
          toggleThreadBranch,
          setReasoningPhaseExpandedPreference,
          syncThinkingBlockNode,
          appendClientLog,
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
          promptJump: { // the More menu's Back to prompt, in this pane
            targetId: () => globalThis.chatScrollUtils?.getLatestUserMessageId?.(getCurrentVisibleMessages()) || '',
            jump: (id) => scrollMessageIntoView(id, { block: 'start', followLatest: false }),
          },
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
          getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
          showComposerActionError,
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
      shellSubscriptions.dispose();
      if (documentLevel) globalThis.rendererContextMeterDetails?.dispose?.();
      if (documentLevel) window.rendererPlanUsageMeter?.dispose?.();
      chatAccessibility = null; transcriptBindings.dispose?.();
      if (documentLevel) setActivityChangeListener(null);
      if (documentLevel) ctrlWheelGate.releaseCtrlKeyTracker(window);
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

      if (documentLevel) {
        setActivityChangeListener((scope) => {
          handleActivityChange(scope);
        });

        // System stats: the header controller owns that subscription (it
        // repaints only the title-bar read-out's text nodes per tick).
        addCleanup(window.rendererPlanUsageMeter?.install?.({ shell: window.jennyShell, state, onChange: renderAll }) || (() => {}));

        shellSubscriptions.bind(addCleanup);

        registerListener(homeNavButton, 'click', () => {
          setActiveView('home');
        }, listenerOptions);

        registerListener(newChatButton, 'click', () => {
          handleCreateSession().catch((error) => {
            showSessionActionError(error, jt('chat.events.createSessionFailedTitle', 'Create Session Failed'));
          });
        }, listenerOptions);
      }

      registerListener(sendButton, 'click', () => {
        handleSend().catch((error) => {
          showComposerActionError(error, jt('chat.events.sendFailedTitle', 'Send Failed'));
        });
      }, listenerOptions);

      registerListener(stopStreamButton, 'click', () => {
        handleStopActiveStream().catch((error) => {
          showComposerActionError(error, jt('chat.events.stopFailedTitle', 'Stop Failed'));
        });
      }, listenerOptions);

      if (documentLevel) {
        registerListener(jumpToTopButton, 'click', () => {
          handleJumpToTop();
        }, listenerOptions);
      }

      // One bottom-edge control per pane. Pane 0's also runs the wayfinder's first-unread pick when it names
      // this session; every other press is the plain jump to the live end ("Latest").
      registerListener(jumpToBottomButton, 'click', globalThis.rendererChatWayfinderUtils.createJumpClickHandler({
        getModel: () => (documentLevel ? state.ui?.chatWayfinder : null),
        getSessionId: () => sessionContext.getSessionId(),
        getHandlers: () => ({
          unreadController: unreadOrientationController,
          onError: (error) => appendClientLog?.('WARN', 'chat.wayfinder_action_failed', { message: String(error?.message || error).slice(0, 160) }),
        }),
        jumpToLatest: () => handleJumpToBottom(),
      }), listenerOptions);

      registerListener(chatInput, 'keydown', (event) => {
        if (globalThis.rendererPlanModeShortcut?.handleRunModeCycleShortcut?.(event, document)) return;
        if (globalThis.rendererPlanModeShortcut?.handlePlanModeShortcut?.(event, document)) return;
        // Up in an empty composer takes the queued sends back as a draft (Claude Code parity).
        const queueView = globalThis.rendererRuntimeQueueView;
        if (queueView?.handleTakeBackKeydown?.(event, { input: chatInput,
          rows: state.runtimeSendController?.listPending?.(sessionContext.getSessionId()) || [],
          actions: { withdraw: row => state.runtimeSendController?.withdraw?.(row.key),
            putDraft: texts => queueView.putBackInComposer(chatInput, texts) } })) return;
        if (shouldSendOnEnterKeydown(event)) {
          event.preventDefault();
          if (sendButton?.disabled === true) return;
          handleSend().catch((error) => {
            showComposerActionError(error, jt('chat.events.sendFailedTitle', 'Send Failed'));
          });
        }
      }, listenerOptions);

      registerListener(chatInput, 'input', () => {
        // Pane 0's renderComposerState (the chrome pipeline) ends with the
        // height and visual syncs; running them here too doubled the forced
        // layouts per keystroke. A split pane's renderComposerState does not.
        if (!documentLevel) { syncComposerInputHeight(); syncComposerVisualState(); }
        renderComposerState();
        if (documentLevel) globalThis.rendererComposerSessionStateController?.captureActive(sessionContext.getSessionId(), 'input'); // reads #chatInput
        else globalThis.rendererComposerSessionStateController?.capturePaneDraft(sessionContext.getSessionId(), chatInput);
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

      // Ctrl+wheel zoom (timeline-perf 2026-09-30): renderer-chat-ctrl-wheel-gate.js
      // attaches this non-passive listener only while Ctrl is held, so wheel
      // scrolling never waits on the main thread while a turn streams.
      ctrlWheelGate.bindCtrlGatedWheelZoom({
        chatView, windowRef: window, documentLevel, registerListener, listenerOptions, addCleanup, bindAbortController,
        onWheel: (event) => {
          if (!event.ctrlKey || isChatWheelBlocked(event)) {
            return;
          }
          const deltaY = Number(event.deltaY || 0);
          if (deltaY === 0) {
            return;
          }
          event.preventDefault();
          Promise.resolve(adjustChatZoomPercent(deltaY < 0 ? 1 : -1)).catch((error) => {
            appendClientLog('WARN', 'app.zoom_wheel_failed', {
              message: error?.message || String(error || 'Could not adjust app zoom.'),
            });
          });
        },
      });

      if (documentLevel) {
        // Ctrl+0 / Ctrl+= / Ctrl+- drive app zoom (the one magnification axis;
        // Text size lives in Settings). Artifact review keeps its own Ctrl+0.
        registerListener(window, 'keydown', (event) => {
          if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey
            || isTargetInsideArtifactReview(event.target)) {
            return;
          }
          const key = String(event.key || '').trim();
          const code = String(event.code || '').trim();
          const reset = key === '0' || code === 'Digit0' || code === 'Numpad0';
          const zoomIn = key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd';
          const zoomOut = key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract';
          if (!reset && !zoomIn && !zoomOut) return;
          event.preventDefault();
          const pending = reset ? resetChatZoomPercent() : adjustChatZoomPercent(zoomIn ? 1 : -1);
          Promise.resolve(pending).catch((error) => {
            appendClientLog('WARN', 'app.zoom_shortcut_failed', {
              message: error?.message || String(error || 'Could not change app zoom.'),
            });
          });
        }, listenerOptions);
      }

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
        openSettingsSection,
        showComposerActionError,
        state,
      });

      // C3 Stage A: chatTimeline click / keydown / audio listeners live in the transcript sibling.
      // A second pane's transcript binds inside its own root (the sibling mounts the transcript view control in that pane's own utility cluster via rendererTranscriptViewUtils.mountTranscriptViewControl).
      const transcriptRegister = documentLevel ? registerListener : (target, ...rest) => { if (chatView?.contains?.(target)) registerListener(target, ...rest); };
      transcriptBindings.bindTranscriptEvents(transcriptRegister, listenerOptions, bindAbortController);

      // C3 Stage B: toast / model / preference / composer-popover listeners live in the settings sibling.
      if (documentLevel) settingsBindings.bindSettingsEvents(registerListener, listenerOptions);
      else settingsBindings.bindComposerRailEvents?.({ registerListener: transcriptRegister, listenerOptions, dom: { composerModelSelect, composerEffortSelect, composerRunModeSlot }, getSessionId: sessionContext.getSessionId }); // W2-2a: pane 1's own rail

      // Track E/F/B: keyboard focus, help/search overlays, virtualizer, and message actions.
      chatAccessibility = globalThis.rendererChatAccessibilityWiring?.wireChatAccessibility?.({
        state, chatTimeline, chatThreadScroll, chatView, document, registerListener, listenerOptions, addCleanup, documentLevel, selectionOverlayHost: chatSelectionOverlayHost, getSessionId: sessionContext.getSessionId,
        timelineVirtualizer, chatScrollCoordinator,
        messageEditController, messageBranchController, selectionController, bulkActionsController, unreadOrientationController,
        getCurrentSessionMessages, getSessionMessages, getSessionTurnEventState, renderAll, scrollMessageIntoView, viewportReveal, focusEntryByMessageId, appendClientLog,
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
