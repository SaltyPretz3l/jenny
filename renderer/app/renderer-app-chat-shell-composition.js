/* renderer/app/renderer-app-chat-shell-composition.js -- the chat shell controller builder (send, stream, transcript and composer callbacks) */
/**
 * Extracted from renderer-app-controller-composition.js. It returns
 * buildChatShellController(pane): the chat shell controller factory call with its slash
 * dependencies, constants, controllers and callbacks. The root builds pane 0 with it and
 * exports it so the pane composition builds a second pane the same way (each pane handing
 * `{ sessionContext, dom, controllers, factories, overrides }`).
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createChatShellBuilder(ctx) {
  return (pane = {}) => (ctx.window.rendererChatShellControllerUtils || {}).createChatShellController?.({
    state: ctx.state, sessionContext: pane.sessionContext || ctx.paneLayoutController?.createSessionContext?.(0),
    compactionCoordinator: ctx.compactionCoordinator,
    windowRef: ctx.window,
    slashDependencies: {
      contextUsageModule: ctx.contextUsageModule,
      captureToScratchpad: (text, options) => (
        ctx.scratchpadCaptureActions
          ? ctx.scratchpadCaptureActions.captureToScratchpad(text, options)
          : Promise.resolve({ error: jt('app.controller.scratchpadUnavailable', 'Scratchpad is unavailable.') })
      ),
      getMemoryApi: () => ctx.window.jennyShell?.memory || null, // /remember, /forget, /memory
      areInteractiveQuestionsAnswered: ctx.areInteractiveQuestionsAnswered,
      getInteractiveNextUnansweredIndex: ctx.getInteractiveNextUnansweredIndex,
      getInteractiveQuestionOptions: ctx.getInteractiveQuestionOptions,
      isInteractiveQuestionAnswered: ctx.isInteractiveQuestionAnswered,
      isInteractiveOtherTrigger: ctx.isInteractiveOtherTrigger,
      getInteractiveComposerStatusNotice: ctx.getInteractiveComposerStatusNotice,
    },
    dom: pane.dom ? { ...ctx.surfaceDom.chat, ...pane.dom } : ctx.surfaceDom.chat,
    constants: {
      MESSAGE_STATUS: ctx.MESSAGE_STATUS,
      TOAST_SOURCE: ctx.TOAST_SOURCE,
      ACTIVITY_SCOPE: ctx.ACTIVITY_SCOPE,
      MAX_INTERACTIVE_QUESTIONS: ctx.MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS: ctx.MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_GUARDRAIL_PROMPT: ctx.INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_IDLE: ctx.INTERACTIVE_SEQUENCE_IDLE,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: ctx.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: ctx.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    },
    controllers: {
      multiStreamController: ctx.multiStreamController,
      thinkingController: ctx.thinkingController,
      thinkingIndicator: ctx.thinkingIndicator,
      composerToggleModule: ctx.composerToggleModule,
      timelineVirtualizer: ctx.timelineVirtualizer, chatScrollCoordinator: ctx.chatScrollCoordinator, ...pane.controllers,
    },
    callbacks: {
      renderAll: (...a) => ctx.renderAll(...a),
      setToolCallExpansion: (...a) => ctx.setToolCallExpansion(...a),
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      escapeHtml: ctx.escapeHtml,
      showToastMessage: ctx.showToastMessage,
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => ctx.reportErrorWhenActive(...a),
      getCurrentSessionMessages: (...a) => ctx.getCurrentSessionMessages(...a),
      scheduleMessageViewportSync: (...a) => ctx.scheduleMessageViewportSync(...a),
      getCurrentRuntimePreferences: ctx.getCurrentRuntimePreferences, getRuntimePreferencesFromSession: ctx.getRuntimePreferencesFromSession,
      getRuntimePreferenceSnapshot: (...a) => ctx.getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => ctx.runRuntimePreferenceActivity(...a),
      getActiveSession: ctx.getActiveSession,
      getPendingQuestionBatch: (...a) => ctx.getPendingQuestionBatch(...a),
      normalizePendingQuestionBatch: (...a) => ctx.normalizePendingQuestionBatch(...a),
      shouldForceInteractiveGuardrail: (...a) => ctx.shouldForceInteractiveGuardrail(...a),
      getInteractiveSequenceState: (...a) => ctx.getInteractiveSequenceState(...a),
      clearInteractiveDraft: (...a) => ctx.clearInteractiveDraft(...a),
      patchSessionSummary: (...a) => ctx.patchSessionSummary(...a),
      getCurrentVisibleMessages: (...a) => ctx.getCurrentVisibleMessages(...a),
      getSessionTurnEventState: (...a) => ctx.getSessionTurnEventState(...a),
      getSessionMessages: (...a) => ctx.getSessionMessages(...a),
      setSessionMessages: (...a) => ctx.setSessionMessages(...a),
      setSessionTurnEventState: (...a) => ctx.setSessionTurnEventState(...a),
      createNormalizedMessage: (...a) => ctx.createNormalizedMessage(...a),
      resolveSessionId: (...a) => ctx.resolveSessionId(...a),
      buildAttachmentBudget: (...a) => ctx.buildAttachmentBudget(...a),
      resetAttachmentQueue: (...a) => ctx.resetAttachmentQueue(...a),
      clearComposerStatusNotice: (...a) => ctx.clearComposerStatusNotice(...a),
      isSendPreflightPending: (...a) => ctx.isSendPreflightPending(...a),
      showComposerActionError: ctx.showComposerActionError,
      renderComposerState: (...a) => ctx.renderComposerState(...a),
      renderComposerStatusNotice: (...a) => ctx.renderComposerStatusNotice(...a),
      renderLiveThinkingChip: (...a) => ctx.renderLiveThinkingChip(...a),
      renderMessages: (...a) => ctx.renderMessages(...a),
      renderSessions: (...a) => ctx.renderSessions(...a),
      renderSettings: (...a) => ctx.renderSettings(...a),
      renderWorkspaceChrome: (...a) => ctx.renderWorkspaceChrome(...a),
      renderHeader: (...a) => ctx.renderHeader(...a),
      syncComposerInputHeight: (...a) => ctx.syncComposerInputHeight(...a),
      syncComposerVisualState: (...a) => ctx.syncComposerVisualState(...a),
      setFollowLatest: (...a) => ctx.setFollowLatest(...a),
      loadSessions: (...a) => ctx.loadSessionsWithWorkspace(...a),
      refreshSessionSummaries: (...a) => ctx.refreshSessionSummariesWithWorkspace(...a),
      activateWorkspaceSession: (...a) => ctx.activateWorkspaceSession(...a),
      isSendBusy: (...a) => ctx.isSendBusy(...a),
      isAnySendBusy: (...a) => ctx.isAnySendBusy(...a),
      isSessionStreaming: (...a) => ctx.isSessionStreaming(...a),
      hasPendingToolApprovalForSession: (...a) => ctx.hasPendingToolApprovalForSession(...a),
      getCurrentMessageById: (...a) => ctx.getCurrentMessageById(...a),
      getElaboratePrompt: ctx.getElaboratePrompt,
      getLatestReplyAssistantMessageId: ctx.getLatestReplyAssistantMessageId,
      resolveRegenerateRequest: ctx.resolveRegenerateRequest,
      // F2: edit controller deps — projection cache invalidation + replay helpers
      clearProjectionContextCacheForSession: (...a) => ctx.clearProjectionContextCacheForSession(...a),
      invalidateProjectionStateForSession: (...a) => ctx.invalidateProjectionStateForSession(...a),
      showCopyFeedback: (...a) => ctx.showCopyFeedback(...a),
      upsertSessionSummary: (...a) => ctx.upsertSessionSummary(...a),
      removeSessionState: (...a) => ctx.removeSessionState(...a),
      rekeySessionState: (...a) => ctx.rekeySessionState(...a),
      attachPendingOriginToSession: (...a) => ctx.attachPendingOriginToSession(...a),
      rekeySessionOrigin: (...a) => ctx.rekeySessionOrigin(...a),
      onUserSendStarted: (...a) => {
        ctx.sessionAutotitleController?.maybeAutoTitleSession(a[0]?.sessionId, { messageText: a[0]?.prompt });
      },
      getToolPreferences: (...a) => ctx.getToolPreferences(...a),
      setChatSendLifecycle: (...a) => ctx.setChatSendLifecycle(...a),
      clearChatSendLifecycle: (...a) => ctx.clearChatSendLifecycle(...a),
      moveChatSendLifecycle: (...a) => ctx.moveChatSendLifecycle(...a),
      buildInteractiveAnswerPrompt: (...a) => ctx.buildInteractiveAnswerPrompt(...a),
      buildInteractiveSelectedAnswers: (...a) => ctx.buildInteractiveSelectedAnswers(...a),
      ensureInteractiveDraft: (...a) => ctx.ensureInteractiveDraft(...a),
      escapeSelectorValue: (...a) => ctx.escapeSelectorValue(...a),
      getInteractiveDraft: (...a) => ctx.getInteractiveDraft(...a),
      persistRuntimePreferences: (...a) => ctx.persistRuntimePreferences(...a),
      queueInteractiveComposerFocus: (...a) => ctx.queueInteractiveComposerFocus(...a),
      renderComposerInteractivePanel: (...a) => ctx.renderComposerInteractivePanel(...a),
      getActiveSendPreflight: (...a) => ctx.getActiveSendPreflight(...a),
      setComposerStatusNotice: (...a) => ctx.setComposerStatusNotice(...a),
      handleWorkspaceActivityStreamEvent: (...a) => ctx.handleWorkspaceActivityStreamEvent(...a),
      buildInteractiveQuestionBatchVisibleText: (...a) => ctx.buildInteractiveQuestionBatchVisibleText(...a),
      refreshSnapshots: (...a) => ctx.refreshSnapshots(...a),
      refreshObservability: () => (ctx.settingsShellController?.notifyUsageTurnSettled?.(), ctx.observabilityController?.notifyTurnSettled?.(), Promise.resolve(null)),
      // A finishing chat clears its own and app-wide stream toasts, never another chat's.
      dismissStreamErrors: (sessionId) => ctx.toastStore.dismissBySource(ctx.TOAST_SOURCE.chatStream, { sessionId }),
      mergeMessageReasoning: (...a) => ctx.mergeMessageReasoning(...a), publishFirstTokenImpulse: (...a) => (typeof ctx.publishFirstTokenImpulse === 'function' ? ctx.publishFirstTokenImpulse(...a) : undefined),
      publishToolStartImpulse: (...a) => (typeof ctx.publishToolStartImpulse === 'function' ? ctx.publishToolStartImpulse(...a) : undefined),
      updateContextUsage: (...a) => ctx.contextUsageModule?.updateUsage?.(...a),
      getChatSendLifecycle: (...a) => ctx.getChatSendLifecycle(...a), publishCompleteImpulse: (...a) => (typeof ctx.publishCompleteImpulse === 'function' ? ctx.publishCompleteImpulse(...a) : undefined),
      getChatTimelineRowModelEnabled: (...a) => ctx.getChatTimelineRowModelEnabled(...a), publishCancelImpulse: (...a) => (typeof ctx.publishCancelImpulse === 'function' ? ctx.publishCancelImpulse(...a) : undefined),
      recordChatTimelineRolloutSignal: (...a) => ctx.recordChatTimelineRolloutSignal(...a),
      setActivityChangeListener: ctx.setActivityChangeListener,
      handleActivityChange: (...a) => ctx.handleActivityChange(...a),
      renderLogs: (...a) => ctx.renderLogs(...a),
      pushIncomingLog: (...a) => ctx.pushIncomingLog(...a),
      syncBackendActivityFromStatus: (...a) => ctx.syncBackendActivityFromStatus(...a),
      getRendererElapsedMs: (...a) => ctx.getRendererElapsedMs(...a),
      refreshApprovedMemories: (...a) => ctx.refreshApprovedMemoriesSafe(...a),
      refreshComposerToolToggles: (...a) => ctx.refreshComposerToolToggles(...a),
      resetArtifactsState: (...a) => ctx.resetArtifactsState(...a),
      closeComposerPopover: (...a) => ctx.closeComposerPopover(...a),
      openComposerPopover: (...a) => ctx.openComposerPopover(...a),
      hideAssistantSprite: (...a) => ctx.hideAssistantSprite(...a),
      updateAssistantSpritePosition: (...a) => ctx.updateAssistantSpritePosition(...a),
      setActiveView: (...a) => ctx.setActiveView(...a),
      openSetupTile: (...a) => ctx.openSetupTileSafe(...a),
      showSessionActionError: ctx.showSessionActionError,
      handleCreateSession: (...a) => ctx.handleCreateSessionWithWorkspace(...a),
      handleJumpToTop: (...a) => ctx.handleJumpToTop(...a),
      handleJumpToBottom: (...a) => ctx.handleJumpToBottom(...a),
      // Pane 0 never passed this, so More > Back to prompt did nothing there (a split pane passes its own).
      scrollMessageIntoView: (...a) => ctx.scrollMessageIntoView(...a),
      viewportReveal: ctx.viewportReveal,
      syncThreadScrollState: function () {
        if (ctx.chatScrollCoordinator?.scheduleFrame) { ctx.chatScrollCoordinator.scheduleFrame(); return; }
        ctx.syncThreadScrollState();
        ctx.chatWayfinderController?.handleScroll?.();
        ctx.renderComposerJumpControls();
      },
      onUnreadOrientationStateChange: function (nextState) {
        ctx.chatWayfinderController?.setUnreadState?.(nextState);
        ctx.renderComposerJumpControls();
      },
      setUnreadOrientationController: function (nextController) {
        ctx.chatScrollCoordinator?.setUnreadController?.(nextController);
      },
      toggleInteractiveRoundRecap: (...a) => ctx.toggleInteractiveRoundRecap(...a),
      toggleContextCompactionDetails: (...a) => ctx.toggleContextCompactionDetails(...a),
      toggleThreadBranch: (...a) => ctx.toggleThreadBranch(...a),
      handleFollowUpMessage: (...a) => ctx.handleFollowUpMessage(...a),
      setReasoningPhaseExpandedPreference: (...a) => ctx.setReasoningPhaseExpandedPreference(...a),
      syncThinkingBlockNode: (...a) => ctx.syncThinkingBlockNode(...a),
      dismissToast: ctx.dismissToast,
      showShellErrorToast: ctx.showShellErrorToast,
      toErrorMessage: ctx.toErrorMessage,
      beginActivity: ctx.beginActivity,
      resolveActivity: ctx.resolveActivity,
      failActivity: ctx.failActivity,
      handleSaveProactiveSuggestionMessage: (...a) => ctx.handleSaveProactiveSuggestionMessage(...a),
      handleLaterProactiveSuggestionMessage: (...a) => ctx.handleLaterProactiveSuggestionMessage(...a),
      handleUseProactiveSuggestionMessage: (...a) => ctx.handleUseProactiveSuggestionMessageSafe(...a),
      handleLifecycleProgress: (...a) => ctx._handleLifecycleProgress(...a),
      handleLifecycleBackendStatus: (...a) => {
        const result = ctx._handleLifecycleBackendStatus(...a);
        const backendStatus = a[0] || {};
        const normalizedPhase = String(backendStatus?.phase || '').trim().toLowerCase();
        if (normalizedPhase === 'ready') {
          ctx.scheduleBackendStatusTask(() => {
            ctx.runStartupAuditAutoSend().catch((error) => {
              ctx.appendClientLog('WARN', 'startup_audit.auto_send_failed', {
                message: String(error?.message || error),
              });
            });
          });
        }
        if (ctx.healthPillController && typeof ctx.healthPillController.refresh === 'function') {
          ctx.scheduleBackendStatusTask(() => {
            ctx.healthPillController.refresh({ silent: true }).catch(() => null);
          });
        }
        return result;
      },
      beginModelSwitch: (...a) => ctx.beginModelSwitch(...a),
      updateModelSwitch: (...a) => ctx.updateModelSwitch(...a),
      failModelSwitch: (...a) => ctx.failModelSwitch(...a),
      adjustChatZoomPercent: (...a) => ctx.adjustChatZoomPercent(...a),
      resetChatZoomPercent: (...a) => ctx.resetChatZoomPercent(...a),
      openSettingsSection: (...a) => ctx.openSettingsSection(...a),
      handleErrorRecoveryAction: (...a) => ctx.handleErrorRecoveryAction(...a),
      handleArtifactAction: (...a) => ctx.handleArtifactAction(...a),
      handleCodeReviewAction: async (payload) => {
        try {
          return await ctx.openCodeReviewTarget(payload);
        } catch (error) {
          ctx.showComposerActionError?.(error, jt('app.controller.codeReviewFailedTitle', 'Code Review Failed'));
          return false;
        }
      },
      // Diff-rows open-in-editor (ide_chat_dock Commit 2): from main chat the
      // view switches to the Workspace first (same surface rule the spec
      // pins), then the IDE resolves the changeId from its own ledger and
      // opens the diff://change/ review tab.
      handleOpenChangeDiff: async (payload) => {
        const changeId = String(payload?.changeId || '').trim();
        if (!changeId) return false;
        try {
          ctx.setActiveView('ide');
          const opened = await Promise.resolve(ctx.openIdeChangeDiffSafe(changeId));
          // Read/workspace refusals already showed the controller's specific
          // "Jenny's Changes" toast for this click — don't stack a generic one.
          if (opened !== true && opened !== 'read_failed' && opened !== 'workspace_unavailable') {
            ctx.showComposerActionError?.(new Error('Could not find that change in the current session.'), jt('app.controller.openDiffFailedTitle', 'Open Diff Failed'));
          }
          return opened === true;
        } catch (error) {
          ctx.showComposerActionError?.(error, jt('app.controller.openDiffFailedTitle', 'Open Diff Failed'));
          return false;
        }
      },
      handleComposerToggleChange: (...a) => ctx.handleComposerToggleChange(...a),
      openArtifactTarget: (...a) => ctx.openArtifactTarget(...a),
      renderSessionPane: (...a) => ctx.getPaneComposition?.()?.renderSessionPane?.(...a), resetPanes: () => ctx.paneLayoutController?.resetPanes?.(), ...pane.overrides,
    },
    factories: pane.factories ? { ...ctx.composerFactories, ...pane.factories } : ctx.composerFactories,
  }) || null;
  }

  root.rendererAppChatShellComposition = {
    createChatShellBuilder,
  };
})(window);
