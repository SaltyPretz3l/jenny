/* renderer/app/renderer-app-chat-shell-composition.js -- the chat shell controller builder (send, stream, transcript and composer callbacks) */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-controller-composition.js (a with(ctx) section). It returns
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
    with (ctx) {
  return (pane = {}) => (window.rendererChatShellControllerUtils || {}).createChatShellController?.({
    state, sessionContext: pane.sessionContext || ctx.paneLayoutController?.createSessionContext?.(0),
    compactionCoordinator,
    windowRef: window,
    slashDependencies: {
      contextUsageModule,
      captureToScratchpad: (text, options) => (
        scratchpadCaptureActions
          ? scratchpadCaptureActions.captureToScratchpad(text, options)
          : Promise.resolve({ error: jt('app.controller.scratchpadUnavailable', 'Scratchpad is unavailable.') })
      ),
      getMemoryApi: () => window.jennyShell?.memory || null, // /remember, /forget, /memory
      areInteractiveQuestionsAnswered,
      getInteractiveNextUnansweredIndex,
      getInteractiveQuestionOptions,
      isInteractiveQuestionAnswered,
      isInteractiveOtherTrigger,
      getInteractiveComposerStatusNotice,
    },
    dom: pane.dom ? { ...surfaceDom.chat, ...pane.dom } : surfaceDom.chat,
    constants: {
      MESSAGE_STATUS,
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_IDLE,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    },
    controllers: {
      multiStreamController,
      thinkingController,
      thinkingIndicator,
      composerToggleModule,
      toastActionHandlers,
      timelineVirtualizer, chatScrollCoordinator, ...pane.controllers,
    },
    callbacks: {
      renderAll: (...a) => renderAll(...a),
      setToolCallExpansion: (...a) => setToolCallExpansion(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      escapeHtml,
      showToastMessage,
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => reportErrorWhenActive(...a),
      getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
      scheduleMessageViewportSync: (...a) => scheduleMessageViewportSync(...a),
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
      getRuntimePreferenceSnapshot: (...a) => getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => runRuntimePreferenceActivity(...a),
      getActiveSession,
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a),
      normalizePendingQuestionBatch: (...a) => normalizePendingQuestionBatch(...a),
      shouldForceInteractiveGuardrail: (...a) => shouldForceInteractiveGuardrail(...a),
      getInteractiveSequenceState: (...a) => getInteractiveSequenceState(...a),
      clearInteractiveDraft: (...a) => clearInteractiveDraft(...a),
      patchSessionSummary: (...a) => patchSessionSummary(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      getSessionTurnEventState: (...a) => getSessionTurnEventState(...a),
      getSessionMessages: (...a) => getSessionMessages(...a),
      setSessionMessages: (...a) => setSessionMessages(...a),
      setSessionTurnEventState: (...a) => setSessionTurnEventState(...a),
      createNormalizedMessage: (...a) => createNormalizedMessage(...a),
      resolveSessionId: (...a) => resolveSessionId(...a),
      buildAttachmentBudget: (...a) => buildAttachmentBudget(...a),
      resetAttachmentQueue: (...a) => resetAttachmentQueue(...a),
      clearComposerStatusNotice: (...a) => clearComposerStatusNotice(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a),
      showComposerActionError,
      renderComposerState: (...a) => renderComposerState(...a),
      renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
      renderLiveThinkingChip: (...a) => renderLiveThinkingChip(...a),
      renderMessages: (...a) => renderMessages(...a),
      renderSessions: (...a) => renderSessions(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      renderHeader: (...a) => renderHeader(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      syncComposerVisualState: (...a) => syncComposerVisualState(...a),
      setFollowLatest: (...a) => setFollowLatest(...a),
      loadSessions: (...a) => loadSessionsWithWorkspace(...a),
      refreshSessionSummaries: (...a) => refreshSessionSummariesWithWorkspace(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      isSendBusy: (...a) => isSendBusy(...a),
      isAnySendBusy: (...a) => isAnySendBusy(...a),
      isSessionStreaming: (...a) => isSessionStreaming(...a),
      hasPendingToolApprovalForSession: (...a) => hasPendingToolApprovalForSession(...a),
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      getElaboratePrompt,
      getLatestReplyAssistantMessageId,
      resolveRegenerateRequest,
      // F2: edit controller deps — projection cache invalidation + replay helpers
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      invalidateProjectionStateForSession: (...a) => invalidateProjectionStateForSession(...a),
      showCopyFeedback: (...a) => showCopyFeedback(...a),
      upsertSessionSummary: (...a) => upsertSessionSummary(...a),
      removeSessionState: (...a) => removeSessionState(...a),
      rekeySessionState: (...a) => rekeySessionState(...a),
      attachPendingOriginToSession: (...a) => attachPendingOriginToSession(...a),
      rekeySessionOrigin: (...a) => rekeySessionOrigin(...a),
      onUserSendStarted: (...a) => {
        sessionAutotitleController?.maybeAutoTitleSession(a[0]?.sessionId, { messageText: a[0]?.prompt });
      },
      getToolPreferences: (...a) => getToolPreferences(...a),
      setChatSendLifecycle: (...a) => setChatSendLifecycle(...a),
      clearChatSendLifecycle: (...a) => clearChatSendLifecycle(...a),
      moveChatSendLifecycle: (...a) => moveChatSendLifecycle(...a),
      buildInteractiveAnswerPrompt: (...a) => buildInteractiveAnswerPrompt(...a),
      buildInteractiveSelectedAnswers: (...a) => buildInteractiveSelectedAnswers(...a),
      ensureInteractiveDraft: (...a) => ensureInteractiveDraft(...a),
      escapeSelectorValue: (...a) => escapeSelectorValue(...a),
      getInteractiveDraft: (...a) => getInteractiveDraft(...a),
      persistRuntimePreferences: (...a) => persistRuntimePreferences(...a),
      queueInteractiveComposerFocus: (...a) => queueInteractiveComposerFocus(...a),
      renderComposerInteractivePanel: (...a) => renderComposerInteractivePanel(...a),
      getActiveSendPreflight: (...a) => getActiveSendPreflight(...a),
      setComposerStatusNotice: (...a) => setComposerStatusNotice(...a),
      handleWorkspaceActivityStreamEvent: (...a) => handleWorkspaceActivityStreamEvent(...a),
      buildInteractiveQuestionBatchVisibleText: (...a) => buildInteractiveQuestionBatchVisibleText(...a),
      refreshSnapshots: (...a) => refreshSnapshots(...a),
      refreshObservability: () => (settingsShellController?.notifyUsageTurnSettled?.(), observabilityController?.notifyTurnSettled?.(), Promise.resolve(null)),
      // A finishing chat clears its own and app-wide stream toasts, never another chat's.
      dismissStreamErrors: (sessionId) => toastStore.dismissBySource(TOAST_SOURCE.chatStream, { sessionId }),
      mergeMessageReasoning: (...a) => mergeMessageReasoning(...a), publishFirstTokenImpulse: (...a) => (typeof publishFirstTokenImpulse === 'function' ? publishFirstTokenImpulse(...a) : undefined),
      publishToolStartImpulse: (...a) => (typeof publishToolStartImpulse === 'function' ? publishToolStartImpulse(...a) : undefined),
      updateContextUsage: (...a) => contextUsageModule?.updateUsage?.(...a),
      getChatSendLifecycle: (...a) => getChatSendLifecycle(...a), publishCompleteImpulse: (...a) => (typeof publishCompleteImpulse === 'function' ? publishCompleteImpulse(...a) : undefined),
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a), publishCancelImpulse: (...a) => (typeof publishCancelImpulse === 'function' ? publishCancelImpulse(...a) : undefined),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      setActivityChangeListener,
      handleActivityChange: (...a) => handleActivityChange(...a),
      renderLogs: (...a) => renderLogs(...a),
      pushIncomingLog: (...a) => pushIncomingLog(...a),
      syncBackendActivityFromStatus: (...a) => syncBackendActivityFromStatus(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshComposerToolToggles: (...a) => refreshComposerToolToggles(...a),
      resetArtifactsState: (...a) => resetArtifactsState(...a),
      closeComposerPopover: (...a) => closeComposerPopover(...a),
      openComposerPopover: (...a) => openComposerPopover(...a),
      hideAssistantSprite: (...a) => hideAssistantSprite(...a),
      updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a),
      setActiveView: (...a) => setActiveView(...a),
      openSetupTile: (...a) => openSetupTileSafe(...a),
      showSessionActionError,
      handleCreateSession: (...a) => handleCreateSessionWithWorkspace(...a),
      handleJumpToTop: (...a) => handleJumpToTop(...a),
      handleJumpToBottom: (...a) => handleJumpToBottom(...a),
      // Pane 0 never passed this, so More > Back to prompt did nothing there (a split pane passes its own).
      scrollMessageIntoView: (...a) => ctx.scrollMessageIntoView(...a),
      viewportReveal,
      syncThreadScrollState: function () {
        if (chatScrollCoordinator?.scheduleFrame) { chatScrollCoordinator.scheduleFrame(); return; }
        syncThreadScrollState();
        chatWayfinderController?.handleScroll?.();
        renderComposerJumpControls();
      },
      onUnreadOrientationStateChange: function (nextState) {
        chatWayfinderController?.setUnreadState?.(nextState);
        renderComposerJumpControls();
      },
      setUnreadOrientationController: function (nextController) {
        chatScrollCoordinator?.setUnreadController?.(nextController);
      },
      toggleInteractiveRoundRecap: (...a) => toggleInteractiveRoundRecap(...a),
      toggleContextCompactionDetails: (...a) => toggleContextCompactionDetails(...a),
      toggleThreadBranch: (...a) => toggleThreadBranch(...a),
      handleFollowUpMessage: (...a) => handleFollowUpMessage(...a),
      setReasoningPhaseExpandedPreference: (...a) => setReasoningPhaseExpandedPreference(...a),
      syncThinkingBlockNode: (...a) => syncThinkingBlockNode(...a),
      dismissToast,
      showShellErrorToast,
      toErrorMessage,
      beginActivity,
      resolveActivity,
      failActivity,
      handleSaveProactiveSuggestionMessage: (...a) => handleSaveProactiveSuggestionMessage(...a),
      handleLaterProactiveSuggestionMessage: (...a) => handleLaterProactiveSuggestionMessage(...a),
      handleUseProactiveSuggestionMessage: (...a) => handleUseProactiveSuggestionMessageSafe(...a),
      handleLifecycleProgress: (...a) => _handleLifecycleProgress(...a),
      handleLifecycleBackendStatus: (...a) => {
        const result = _handleLifecycleBackendStatus(...a);
        const backendStatus = a[0] || {};
        const normalizedPhase = String(backendStatus?.phase || '').trim().toLowerCase();
        if (normalizedPhase === 'ready') {
          scheduleBackendStatusTask(() => {
            runStartupAuditAutoSend().catch((error) => {
              appendClientLog('WARN', 'startup_audit.auto_send_failed', {
                message: String(error?.message || error),
              });
            });
          });
        }
        if (healthPillController && typeof healthPillController.refresh === 'function') {
          scheduleBackendStatusTask(() => {
            healthPillController.refresh({ silent: true }).catch(() => null);
          });
        }
        return result;
      },
      beginModelSwitch: (...a) => beginModelSwitch(...a),
      updateModelSwitch: (...a) => updateModelSwitch(...a),
      failModelSwitch: (...a) => failModelSwitch(...a),
      adjustChatZoomPercent: (...a) => adjustChatZoomPercent(...a),
      resetChatZoomPercent: (...a) => resetChatZoomPercent(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      handleErrorRecoveryAction: (...a) => handleErrorRecoveryAction(...a),
      handleArtifactAction: (...a) => handleArtifactAction(...a),
      handleCodeReviewAction: async (payload) => {
        try {
          return await openCodeReviewTarget(payload);
        } catch (error) {
          showComposerActionError?.(error, jt('app.controller.codeReviewFailedTitle', 'Code Review Failed'));
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
          setActiveView('ide');
          // A click in the Workspace's second chat looks in that chat's changes (row 40 W6b).
          const opened = await Promise.resolve(openIdeChangeDiffSafe(changeId, { secondChat: Boolean(payload?.contextNode?.closest?.('[data-pane-hosted]')) }));
          // Read/workspace refusals already showed the controller's specific
          // "Jenny's Changes" toast for this click — don't stack a generic one.
          if (opened !== true && opened !== 'read_failed' && opened !== 'workspace_unavailable') {
            showComposerActionError?.(new Error('Could not find that change in the current session.'), jt('app.controller.openDiffFailedTitle', 'Open Diff Failed'));
          }
          return opened === true;
        } catch (error) {
          showComposerActionError?.(error, jt('app.controller.openDiffFailedTitle', 'Open Diff Failed'));
          return false;
        }
      },
      handleComposerToggleChange: (...a) => handleComposerToggleChange(...a),
      openArtifactTarget: (...a) => openArtifactTarget(...a),
      renderSessionPane: (...a) => ctx.getPaneComposition?.()?.renderSessionPane?.(...a), resetPanes: () => ctx.paneLayoutController?.resetPanes?.(), ...pane.overrides,
    },
    factories: pane.factories ? { ...composerFactories, ...pane.factories } : composerFactories,
  }) || null;
    }
  }

  root.rendererAppChatShellComposition = {
    createChatShellBuilder,
  };
})(window);
