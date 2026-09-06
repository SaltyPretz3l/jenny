/* renderer/chat/renderer-chat-shell-controller.js - Internal chat-surface composition. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-slash-command-registry'));
    return;
  }
  root.rendererChatShellControllerUtils = factory(root.rendererSlashCommandRegistryUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (slashCommandUtils) {
  function createChatShellController(deps) {
    const { state, slashDependencies, compactionCoordinator } = deps;
    const dom = deps.dom || {};
    const callbacks = deps.callbacks || {};
    const constants = deps.constants || {};
    const controllers = deps.controllers || {};
    const factories = deps.factories || {};
    const windowRef = deps.windowRef || globalThis;
    const sendUtils = factories.sendUtils || globalThis.rendererSendUtils || {};
    const composerFlowUtils = factories.composerFlowUtils || globalThis.rendererComposerV2Flow || {};
    const streamHandlerUtils = factories.streamHandlerUtils || globalThis.rendererStreamHandlerUtils || {};
    const chatEventUtils = factories.chatEventUtils || globalThis.rendererChatEventUtils || {};
    const turnElapsedClockUtils = factories.turnElapsedClockUtils || globalThis.rendererTurnElapsedClock || {};
    const createSlashCommandRegistry = factories.createSlashCommandRegistry
      || slashCommandUtils.createSlashCommandRegistry || (() => ({
      register() {},
      listCommands() { return []; },
      execute() { return { matched: false }; },
      tryExecute() { return false; },
      injectOutput() {},
    }));
    const registerBuiltInSlashCommands = factories.registerBuiltInSlashCommands
      || slashCommandUtils.registerBuiltInSlashCommands || (() => false);
    const buildCommandInsertion = factories.buildCommandInsertion
      || slashCommandUtils.buildCommandInsertion || (() => ({ ok: false, code: 'unavailable' }));
    const createContextCommand = factories.createContextCommand || (() => async function noopContextCommand() {});
    let _optimisticAppend = function noopOptimisticAppend() { return {}; };
    let _flushBufferedStreamEvents = async function noopFlushBufferedStreamEvents() {
      return { flushedCount: 0, terminal: false };
    };
    let _flushPendingStreamCommitsForSession = function noopFlushPendingStreamCommitsForSession() {
      return { flushedCount: 0, catchupRequired: false };
    };
    let _dropBufferedStreamEvents = function noopDropBufferedStreamEvents() {};
    let _rehydrateSessionFromPersistedTurnEvents = function noopRehydrateSessionFromPersistedTurnEvents() {
      return null;
    };
    const slashCommandRegistry = createSlashCommandRegistry({
      state,
      optimisticAppend: (...args) => _optimisticAppend(...args),
      renderAll: (...args) => callbacks.renderAll(...args),
      appendClientLog: (...args) => callbacks.appendClientLog(...args),
      escapeHtml: callbacks.escapeHtml,
      showToastMessage: callbacks.showToastMessage,
    });
    const contextHandler = createContextCommand({
      state,
      getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
      getSessionMessages: (...args) => callbacks.getSessionMessages(...args),
      contextUsageModule: slashDependencies?.contextUsageModule || null,
      appendClientLog: (...args) => callbacks.appendClientLog(...args),
      injectOutput: (...args) => slashCommandRegistry.injectOutput(...args),
    });
    const createNoteCommandHandler = factories.createNoteCommandHandler
      || windowRef.rendererSlashNoteCommand?.createNoteCommandHandler
      || (() => () => callbacks.showToastMessage?.('Scratchpad is unavailable.', { title: 'Scratchpad', tone: 'warning' }));
    const noteHandler = createNoteCommandHandler({
      captureToScratchpad: slashDependencies && slashDependencies.captureToScratchpad,
      showToastMessage: (...a) => callbacks.showToastMessage?.(...a), appendClientLog: (...a) => callbacks.appendClientLog?.(...a),
    });
    registerBuiltInSlashCommands({
      registry: slashCommandRegistry,
      contextHandler,
      noteHandler,
      compact: (sessionId) => compactionCoordinator?.invoke?.(sessionId, { source: 'slash' }),
      showToastMessage: (...args) => callbacks.showToastMessage?.(...args),
    });
    function insertSlashCommand(prompt) {
      if (!dom.chatInput) return false;
      const insertion = buildCommandInsertion(
        dom.chatInput.value,
        prompt,
        dom.chatInput.selectionStart,
        dom.chatInput.selectionEnd
      );
      if (!insertion.ok) {
        if (insertion.code === 'command_conflict') {
          callbacks.showToastMessage?.('Finish or remove the current command before inserting another.', {
            title: 'Command already present',
            tone: 'warning',
          });
        }
        dom.chatInput.focus?.();
        return false;
      }
      if (insertion.code === 'inserted') {
        dom.chatInput.value = insertion.value;
        dom.chatInput.setSelectionRange?.(insertion.selectionStart, insertion.selectionEnd);
        callbacks.syncComposerInputHeight();
        callbacks.syncComposerVisualState();
      }
      dom.chatInput.focus?.();
      return true;
    }
    function selectSlashCommand(name, action) {
      if (action !== 'run') return insertSlashCommand(name);
      return slashCommandRegistry.execute?.(name) || slashCommandRegistry.tryExecute?.(name);
    }
    var selectionController = null;
    function activateWorkspaceSession(...args) {
      selectionController?.onSessionSwitch?.(args[0]);
      return callbacks.activateWorkspaceSession?.(...args);
    }
    function notifyUserSendStarted(...args) {
      selectionController?.onStreamStarted?.(args[0]);
      return callbacks.onUserSendStarted(...args);
    }
    const sendController = sendUtils.createSendController?.({
      state,
      dom: { chatInput: dom.chatInput },
      slashCommandRegistry,
      multiStreamController: controllers.multiStreamController,
      thinkingIndicator: controllers.thinkingIndicator, compactionCoordinator,
      constants: {
        MESSAGE_STATUS: constants.MESSAGE_STATUS,
        INTERACTIVE_GUARDRAIL_PROMPT: constants.INTERACTIVE_GUARDRAIL_PROMPT,
        INTERACTIVE_SEQUENCE_IDLE: constants.INTERACTIVE_SEQUENCE_IDLE,
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: constants.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        TOAST_SOURCE: constants.TOAST_SOURCE,
        MAX_INTERACTIVE_ROUNDS: constants.MAX_INTERACTIVE_ROUNDS,
      },
      callbacks: {
        getActiveSession: (...args) => callbacks.getActiveSession(...args),
        getPendingQuestionBatch: (...args) => callbacks.getPendingQuestionBatch(...args),
        normalizePendingQuestionBatch: (...args) => callbacks.normalizePendingQuestionBatch(...args),
        shouldForceInteractiveGuardrail: (...args) => callbacks.shouldForceInteractiveGuardrail(...args),
        getInteractiveSequenceState: (...args) => callbacks.getInteractiveSequenceState(...args),
        clearInteractiveDraft: (...args) => callbacks.clearInteractiveDraft(...args),
        patchSessionSummary: (...args) => callbacks.patchSessionSummary(...args),
        getCurrentRuntimePreferences: (...args) => callbacks.getCurrentRuntimePreferences(...args),
        getCurrentVisibleMessages: (...args) => callbacks.getCurrentVisibleMessages(...args),
        getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args), getSessionTurnEventState: (...args) => callbacks.getSessionTurnEventState?.(...args),
        getSessionMessages: (...args) => callbacks.getSessionMessages(...args),
        setSessionMessages: (...args) => callbacks.setSessionMessages(...args),
        createNormalizedMessage: (...args) => callbacks.createNormalizedMessage(...args),
        resolveSessionId: (...args) => callbacks.resolveSessionId(...args),
        buildAttachmentBudget: (...args) => callbacks.buildAttachmentBudget(...args),
        resetAttachmentQueue: (...args) => callbacks.resetAttachmentQueue(...args),
        showToastMessage: (...args) => callbacks.showToastMessage(...args),
        setComposerStatusNotice: (...args) => callbacks.setComposerStatusNotice(...args),
        clearComposerStatusNotice: (...args) => callbacks.clearComposerStatusNotice(...args),
        setTurnStatusPill: (...args) => callbacks.setTurnStatusPill?.(...args),
        clearTurnStatusPill: (...args) => callbacks.clearTurnStatusPill?.(...args),
        clearTurnStatusPillSources: (...args) => callbacks.clearTurnStatusPillSources?.(...args),
        isSendPreflightPending: (...args) => callbacks.isSendPreflightPending(...args),
        showComposerActionError: (...args) => callbacks.showComposerActionError(...args),
        renderComposerState: (...args) => callbacks.renderComposerState(...args),
        renderAll: (...args) => callbacks.renderAll(...args),
        renderMessages: (...args) => callbacks.renderMessages(...args),
        renderSessions: (...args) => callbacks.renderSessions(...args),
        renderHeader: (...args) => callbacks.renderHeader(...args),
        syncComposerInputHeight: (...args) => callbacks.syncComposerInputHeight(...args),
        syncComposerVisualState: (...args) => callbacks.syncComposerVisualState(...args),
        handleSlashCommandSelection: selectSlashCommand,
        setFollowLatest: (...args) => callbacks.setFollowLatest(...args),
        loadSessions: (...args) => callbacks.loadSessions(...args),
        activateWorkspaceSession,
        refreshSessionSummaries: (...args) => callbacks.refreshSessionSummaries(...args),
        thinkingController: controllers.thinkingController,
        flushBufferedStreamEvents: (...args) => _flushBufferedStreamEvents(...args),
        dropBufferedStreamEvents: (...args) => _dropBufferedStreamEvents(...args),
        isSendBusy: (...args) => callbacks.isSendBusy(...args),
        isAnySendBusy: (...args) => callbacks.isAnySendBusy(...args),
        isSessionStreaming: (...args) => callbacks.isSessionStreaming(...args),
        hasPendingToolApprovalForSession: (...args) => callbacks.hasPendingToolApprovalForSession(...args),
        getCurrentMessageById: (...args) => callbacks.getCurrentMessageById(...args),
        getElaboratePrompt: (...args) => callbacks.getElaboratePrompt(...args),
        getLatestReplyAssistantMessageId: (...args) => callbacks.getLatestReplyAssistantMessageId(...args),
        resolveRegenerateRequest: (...args) => callbacks.resolveRegenerateRequest(...args),
        showCopyFeedback: (...args) => callbacks.showCopyFeedback(...args),
        upsertSessionSummary: (...args) => callbacks.upsertSessionSummary(...args),
        removeSessionState: (...args) => callbacks.removeSessionState(...args),
        rekeySessionState: (...args) => callbacks.rekeySessionState(...args),
        attachPendingOriginToSession: (...args) => callbacks.attachPendingOriginToSession(...args),
        rekeySessionOrigin: (...args) => callbacks.rekeySessionOrigin(...args),
        appendClientLog: (...args) => callbacks.appendClientLog(...args),
        optimisticAppend: (...args) => _optimisticAppend(...args),
        onUserSendStarted: notifyUserSendStarted,
        getToolPreferences: (...args) => callbacks.getToolPreferences(...args),
        setChatSendLifecycle: (...args) => callbacks.setChatSendLifecycle(...args),
        clearChatSendLifecycle: (...args) => callbacks.clearChatSendLifecycle(...args),
        moveChatSendLifecycle: (...args) => callbacks.moveChatSendLifecycle(...args),
        clearProjectionContextCacheForSession: (...args) => callbacks.clearProjectionContextCacheForSession?.(...args),
        publishCancelImpulse: (...args) => callbacks.publishCancelImpulse?.(...args),
      },
    }) || null;
    const {
      startPromptSend = async function noopStartPromptSend() {},
      handleStopActiveStream = async function noopHandleStopActiveStream() {},
      getQueuedSend = function noopGetQueuedSend() { return null; },
      clearQueuedSendForSession = function noopClearQueuedSendForSession() {},
      restoreQueuedSendDraft = function noopRestoreQueuedSendDraft() { return null; },
      dispatchQueuedSendForSession = async function noopDispatchQueuedSendForSession() {},
      handleElaborateMessage = async function noopHandleElaborateMessage() {},
      handleRegenerateMessage = async function noopHandleRegenerateMessage() {},
      handleCopyMessage = async function noopHandleCopyMessage() {},
      retryFailedPayload = async function noopRetryFailedPayload() {},
      getFailedPayloadRetryAvailability = function noopGetFailedPayloadRetryAvailability() {
        return { available: false, reason: 'The original failed payload is unavailable.' };
      },
      dismissFailedPayload = function noopDismissFailedPayload() { return false; },
    } = sendController || {};
    if (sendController && controllers && typeof controllers === 'object') {
      const rerenderOutbox = () => {
        callbacks.renderComposerState();
        callbacks.renderSessions();
      };
      controllers.sendOutboxActions = {
        async edit(entry, prompt) {
          dispatchQueuedSendForSession.cancelAutoRetry?.(entry?.sessionId);
          const result = state.sendOutboxController?.edit?.(entry, prompt);
          rerenderOutbox();
          if (!result) return null;
          return dispatchQueuedSendForSession(result.sessionId);
        },
        cancel(entry) {
          dispatchQueuedSendForSession.cancelAutoRetry?.(entry?.sessionId);
          const result = state.sendOutboxController?.remove?.(entry) === true;
          rerenderOutbox();
          return result;
        },
        async retry(entry) {
          dispatchQueuedSendForSession.cancelAutoRetry?.(entry?.sessionId);
          const readyEntry = state.sendOutboxController?.retry?.(entry);
          rerenderOutbox();
          if (!readyEntry) return null;
          return dispatchQueuedSendForSession(readyEntry.sessionId);
        },
      };
    }

    var resumeTurnInteraction = null;
    if (globalThis.rendererResumeTurnInteraction
      && typeof globalThis.rendererResumeTurnInteraction.createResumeTurnInteraction === 'function') {
      resumeTurnInteraction = globalThis.rendererResumeTurnInteraction.createResumeTurnInteraction({
        scopeRoot: dom.chatTimeline,
        chatInput: dom.chatInput,
        startPromptSend: (...args) => startPromptSend(...args),
        getCurrentSessionId: () => state && state.currentSessionId,
        isSessionSendBusy: controllers.multiStreamController?.isSessionSendBusy?.bind(controllers.multiStreamController),
        hasComposerDraftAttachments: () => Boolean(
          Array.isArray(state.attachments?.queued) && state.attachments.queued.length
        ),
        appendClientLog: callbacks.appendClientLog,
        showComposerActionError: callbacks.showComposerActionError,
      });
    }

    // F2: message-edit controller wires the inline edit affordance against
    // the send pipeline so commit() can call startPromptSend right after
    // the backend truncate succeeds. Reuses the same gates as regenerate
    // via resolveFollowUpActionBlock indirectly through showComposerActionError
    // + multiStreamController checks inside the controller.
    var messageEditController = null;
    var messageEditUtilsApi = typeof globalThis !== 'undefined'
      ? globalThis.rendererChatMessageEditUtils
      : null;
    if (messageEditUtilsApi && typeof messageEditUtilsApi.createMessageEditController === 'function') {
      try {
        messageEditController = messageEditUtilsApi.createMessageEditController({
          state: state,
          document: typeof document !== 'undefined' ? document : (windowRef && windowRef.document) || null,
          jennyShellSessions: (windowRef && windowRef.jennyShell && windowRef.jennyShell.sessions) || null,
          getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
          getCurrentSessionId: () => {
            // The send-controller closure-private getCurrentSessionId() isn't
            // exposed; mirror the same source: state.currentSessionId.
            return state && typeof state.currentSessionId === 'string'
              ? state.currentSessionId
              : '';
          },
          startPromptSend: (...args) => startPromptSend(...args),
          renderAll: (...args) => callbacks.renderAll(...args),
          appendClientLog: (...args) => callbacks.appendClientLog(...args),
          showComposerActionError: (...args) => callbacks.showComposerActionError(...args),
          resolveFollowUpActionBlock: () => {
            // Reuse the same busy gate the send controller publishes. The
            // controller itself does not export resolveFollowUpActionBlock,
            // so duplicate the boolean shape here.
            const currentSessionId = state && typeof state.currentSessionId === 'string'
              ? state.currentSessionId
              : '';
            const isBusy = typeof callbacks.isSessionStreaming === 'function'
              && callbacks.isSessionStreaming(currentSessionId);
            const hasApproval = typeof callbacks.hasPendingToolApprovalForSession === 'function'
              && callbacks.hasPendingToolApprovalForSession(currentSessionId);
            if (isBusy || hasApproval) {
              return { blocked: true, reason: 'Wait for the current response to finish before editing.' };
            }
            return { blocked: false };
          },
          clearProjectionContextCacheForSession: (...args) => {
            const fn = callbacks.clearProjectionContextCacheForSession;
            if (typeof fn === 'function') return fn(...args);
            // Fallback: call directly via window if exposed there.
            if (typeof globalThis !== 'undefined'
              && typeof globalThis.clearProjectionContextCacheForSession === 'function') {
              return globalThis.clearProjectionContextCacheForSession(...args);
            }
            return null;
          },
          buildReplayableImageAttachments: (...args) => {
            const fn = callbacks.buildReplayableImageAttachments;
            if (typeof fn === 'function') return fn(...args);
            const utils = typeof globalThis !== 'undefined'
              ? globalThis.chatBubbleActionUtils
              : null;
            if (utils && typeof utils.buildReplayableImageAttachments === 'function') {
              return utils.buildReplayableImageAttachments(...args);
            }
            return [];
          },
          hasTextAttachmentMetadata: (...args) => {
            const fn = callbacks.hasTextAttachmentMetadata;
            if (typeof fn === 'function') return fn(...args);
            const utils = typeof globalThis !== 'undefined'
              ? globalThis.chatBubbleActionUtils
              : null;
            if (utils && typeof utils.hasTextAttachmentMetadata === 'function') {
              return utils.hasTextAttachmentMetadata(...args);
            }
            return false;
          },
          showToastMessage: (...args) => callbacks.showToastMessage(...args),
        });
        // Expose so the keyboard controller / renderer can reach it through the
        // controllers bag that's already plumbed through.
        if (controllers && typeof controllers === 'object') {
          controllers.messageEditController = messageEditController;
        }
      } catch (error) {
        // Best-effort: if the controller fails to construct (missing window,
        // jsdom edge case), F2 simply no-ops — the existing surface keeps
        // working. Log once for diagnosis.
        try {
          callbacks.appendClientLog('WARN', 'chat.edit_controller_init_failed', {
            message: error && error.message ? error.message : String(error),
          });
        } catch (_) { /* ignore */ }
      }
    }

    // F3: message branch controller uses the existing Electron
    // sessions.forkSession IPC seam and then activates the new workspace tab.
    var messageBranchController = null;
    var messageBranchUtilsApi = typeof globalThis !== 'undefined'
      ? globalThis.rendererChatBranchUtils
      : null;
    if (messageBranchUtilsApi && typeof messageBranchUtilsApi.createMessageBranchController === 'function') {
      try {
        messageBranchController = messageBranchUtilsApi.createMessageBranchController({
          state: state,
          jennyShellSessions: (windowRef && windowRef.jennyShell && windowRef.jennyShell.sessions) || null,
          getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
          getCurrentSessionId: () => state && typeof state.currentSessionId === 'string'
            ? state.currentSessionId
            : '',
          loadSessions: (...args) => callbacks.loadSessions(...args),
          activateWorkspaceSession,
          upsertSessionSummary: (...args) => callbacks.upsertSessionSummary(...args),
          renderAll: (...args) => callbacks.renderAll(...args),
          appendClientLog: (...args) => callbacks.appendClientLog(...args),
          showComposerActionError: (...args) => callbacks.showComposerActionError(...args),
          showToastMessage: (...args) => callbacks.showToastMessage(...args),
          isSessionStreaming: (...args) => callbacks.isSessionStreaming(...args),
          hasPendingToolApprovalForSession: (...args) => callbacks.hasPendingToolApprovalForSession(...args),
        });
        if (controllers && typeof controllers === 'object') {
          controllers.messageBranchController = messageBranchController;
        }
      } catch (error) {
        try {
          callbacks.appendClientLog('WARN', 'chat.branch_controller_init_failed', {
            message: error && error.message ? error.message : String(error),
          });
        } catch (_) { /* ignore */ }
      }
    }

    // F4/F5/F6: selection controller + bulk-actions controller. The selection
    // controller owns state.ui.selectionMode + per-session selected sets +
    // Esc-to-exit. The bulk-actions controller wraps the format builders +
    // jennyShell.dialog.saveFile + jennyShell.clipboard.writeText + the
    // existing F2 truncate path (sessions.editAndTruncate with empty patch).
    var bulkActionsController = null;
    var selectionUtilsApi = typeof globalThis !== 'undefined'
      ? globalThis.rendererChatSelectionUtils
      : null;
    var bulkActionsUtilsApi = typeof globalThis !== 'undefined'
      ? globalThis.rendererChatBulkActionsUtils
      : null;
    var bulkDeleteConfirmDialog = null;
    var confirmDialogFactory = windowRef?.rendererIdeConfirmDialog?.createIdeConfirmDialog;
    var helpOverlayFactory = windowRef?.inventoryHelpOverlay?.createHelpOverlay;
    if (typeof confirmDialogFactory === 'function' && typeof helpOverlayFactory === 'function') {
      bulkDeleteConfirmDialog = confirmDialogFactory({
        document: typeof document !== 'undefined' ? document : windowRef?.document,
        actionButton: windowRef?.inventoryActionButton,
        helpOverlayFactory,
        hostId: 'chatBulkDeleteConfirmOverlay',
      });
    }
    function confirmBulkDelete(promptText) {
      if (typeof callbacks.confirmBulkDelete === 'function') {
        return callbacks.confirmBulkDelete(promptText);
      }
      if (typeof bulkDeleteConfirmDialog?.confirm !== 'function') {
        return Promise.resolve(false);
      }
      return bulkDeleteConfirmDialog.confirm({
        title: 'Delete from here?',
        message: promptText,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        variant: 'danger',
      });
    }
    if (selectionUtilsApi && typeof selectionUtilsApi.createSelectionController === 'function') {
      try {
        selectionController = selectionUtilsApi.createSelectionController({
          state: state,
          document: typeof document !== 'undefined' ? document : (windowRef && windowRef.document) || null,
          getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
          getCurrentSessionId: () => state && typeof state.currentSessionId === 'string'
            ? state.currentSessionId
            : '',
          renderAll: (...args) => callbacks.renderAll(...args),
          appendClientLog: (...args) => callbacks.appendClientLog(...args),
          focusEntryByMessageId: (...args) => {
            const fn = callbacks.focusEntryByMessageId;
            if (typeof fn === 'function') return fn(...args);
            return null;
          },
        });
        if (controllers && typeof controllers === 'object') {
          controllers.selectionController = selectionController;
        }
      } catch (error) {
        try {
          callbacks.appendClientLog('WARN', 'chat.selection_controller_init_failed', {
            message: error && error.message ? error.message : String(error),
          });
        } catch (_) { /* ignore */ }
      }
    }
    if (
      selectionController
      && bulkActionsUtilsApi
      && typeof bulkActionsUtilsApi.createBulkActionsController === 'function'
    ) {
      try {
        bulkActionsController = bulkActionsUtilsApi.createBulkActionsController({
          state: state,
          jennyShellSessions: (windowRef && windowRef.jennyShell && windowRef.jennyShell.sessions) || null,
          jennyShellDialog: (windowRef && windowRef.jennyShell && windowRef.jennyShell.dialog) || null,
          jennyShellClipboard: (windowRef && windowRef.jennyShell && windowRef.jennyShell.clipboard) || null,
          getCurrentSessionId: () => state && typeof state.currentSessionId === 'string'
            ? state.currentSessionId
            : '',
          getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
          getCurrentSessionTurnEvents: (...args) => {
            const fn = callbacks.getCurrentSessionTurnEvents;
            if (typeof fn === 'function') return fn(...args);
            return [];
          },
          getCurrentSessionMeta: (...args) => {
            const fn = callbacks.getCurrentSessionMeta;
            if (typeof fn === 'function') return fn(...args);
            return {};
          },
          selectionController: selectionController,
          conversationFormatUtils: typeof globalThis !== 'undefined'
            ? globalThis.conversationFormatUtils
            : null,
          renderAll: (...args) => callbacks.renderAll(...args),
          appendClientLog: (...args) => callbacks.appendClientLog(...args),
          showToastMessage: (...args) => callbacks.showToastMessage(...args),
          clearProjectionContextCacheForSession: (...args) => {
            const fn = callbacks.clearProjectionContextCacheForSession;
            if (typeof fn === 'function') return fn(...args);
            if (typeof globalThis !== 'undefined'
              && typeof globalThis.clearProjectionContextCacheForSession === 'function') {
              return globalThis.clearProjectionContextCacheForSession(...args);
            }
            return null;
          },
          confirmDelete: confirmBulkDelete,
        });
        if (controllers && typeof controllers === 'object') {
          controllers.bulkActionsController = bulkActionsController;
        }
      } catch (error) {
        try {
          callbacks.appendClientLog('WARN', 'chat.bulk_actions_controller_init_failed', {
            message: error && error.message ? error.message : String(error),
          });
        } catch (_) { /* ignore */ }
      }
    }

    // F10: first-unread orientation is renderer-only state. The stream
    // handler notifies this controller when a visible assistant/tool row is
    // appended, while keyboard/accessibility wiring owns the affordance mount.
    var unreadOrientationController = null;
    var unreadOrientationUtilsApi = typeof globalThis !== 'undefined'
      ? globalThis.rendererChatUnreadOrientationUtils
      : null;
    if (unreadOrientationUtilsApi && typeof unreadOrientationUtilsApi.createUnreadOrientationController === 'function') {
      try {
        unreadOrientationController = unreadOrientationUtilsApi.createUnreadOrientationController({
          state: state,
          document: typeof document !== 'undefined' ? document : (windowRef && windowRef.document) || null,
          chatTimeline: dom.chatTimeline,
          chatThreadScroll: dom.chatThreadScroll,
          getCurrentSessionId: () => state && typeof state.currentSessionId === 'string'
            ? state.currentSessionId
            : '',
          getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
          getScrollMetrics: (...args) => {
            const fn = callbacks.getScrollMetrics;
            if (typeof fn === 'function') return fn(...args);
            return {
              scrollTop: Number(dom.chatThreadScroll?.scrollTop || 0),
              scrollHeight: Number(dom.chatThreadScroll?.scrollHeight || 0),
              clientHeight: Number(dom.chatThreadScroll?.clientHeight || 0),
            };
          },
          scrollMessageIntoView: (...args) => {
            const fn = callbacks.scrollMessageIntoView;
            if (typeof fn === 'function') return fn(...args);
            return false;
          },
          viewportReveal: callbacks.viewportReveal || null,
          focusEntryByMessageId: (...args) => {
            const fn = callbacks.focusEntryByMessageId;
            if (typeof fn === 'function') return fn(...args);
            return false;
          },
          timelineVirtualizer: controllers.timelineVirtualizer,
          appendClientLog: (...args) => callbacks.appendClientLog(...args),
          onStateChange: typeof callbacks.onUnreadOrientationStateChange === 'function'
            ? (...args) => callbacks.onUnreadOrientationStateChange(...args)
            : undefined,
        });
        if (controllers && typeof controllers === 'object') {
          controllers.unreadOrientationController = unreadOrientationController;
        }
        if (typeof callbacks.setUnreadOrientationController === 'function') {
          callbacks.setUnreadOrientationController(unreadOrientationController);
        }
      } catch (error) {
        try {
          callbacks.appendClientLog('WARN', 'chat.unread_orientation_controller_init_failed', {
            message: error && error.message ? error.message : String(error),
          });
        } catch (_) { /* ignore */ }
      }
    }

    const composerFlowController = composerFlowUtils.createComposerV2FlowController({
      INTERACTIVE_GUARDRAIL_PROMPT: constants.INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      buildInteractiveAnswerPrompt: (...args) => callbacks.buildInteractiveAnswerPrompt(...args),
      buildInteractiveSelectedAnswers: (...args) => callbacks.buildInteractiveSelectedAnswers(...args),
      chatInput: dom.chatInput,
      clearComposerStatusNotice: (...args) => callbacks.clearComposerStatusNotice(...args),
      setComposerStatusNotice: (...args) => callbacks.setComposerStatusNotice(...args),
      chatTimeline: dom.chatTimeline,
      ensureInteractiveDraft: (...args) => callbacks.ensureInteractiveDraft(...args),
      escapeSelectorValue: (...args) => callbacks.escapeSelectorValue(...args),
      getInteractiveDraft: (...args) => callbacks.getInteractiveDraft(...args),
      getInteractiveQuestionOptions: (...args) => slashDependencies.getInteractiveQuestionOptions(...args),
      getPendingQuestionBatch: (...args) => callbacks.getPendingQuestionBatch(...args),
      isInteractiveQuestionAnswered: (...args) => slashDependencies.isInteractiveQuestionAnswered(...args),
      isSendBusy: (...args) => callbacks.isSendBusy(...args),
      isInteractiveOtherTrigger: (...args) => slashDependencies.isInteractiveOtherTrigger(...args),
      normalizePendingQuestionBatch: (...args) => callbacks.normalizePendingQuestionBatch(...args),
      patchSessionSummary: (...args) => callbacks.patchSessionSummary(...args),
      persistRuntimePreferences: (...args) => callbacks.persistRuntimePreferences(...args),
      queueInteractiveComposerFocus: (...args) => callbacks.queueInteractiveComposerFocus(...args),
      renderComposerInteractivePanel: (...args) => callbacks.renderComposerInteractivePanel(...args),
      setActiveView: (...args) => callbacks.setActiveView(...args),
      openSetupTile: (...args) => (typeof callbacks.openSetupTile === 'function' ? callbacks.openSetupTile(...args) : null),
      startPromptSend,
      syncComposerInputHeight: (...args) => callbacks.syncComposerInputHeight(...args),
      state,
      windowRef,
      appendClientLog: (...args) => callbacks.appendClientLog(...args),
    });

    const {
      handleInteractiveOptionSelect = function noopHandleInteractiveOptionSelect() {},
      handleInteractiveOtherConfirm = function noopHandleInteractiveOtherConfirm() {},
      handleInteractiveOtherInputChange = function noopHandleInteractiveOtherInputChange() {},
      handleInteractiveSkip = function noopHandleInteractiveSkip() {},
      handleInteractiveSkipQuestion = function noopHandleInteractiveSkipQuestion() {},
      handleInteractiveSkipAll = function noopHandleInteractiveSkipAll() {},
      handleInteractiveSubmit = function noopHandleInteractiveSubmit() {},
      handleComposerPaste = function noopHandleComposerPaste() {},
      handleSend = function noopHandleSend() {},
      persistInteractiveFallbackRequest = function noopPersistInteractiveFallbackRequest() {},
      requestInteractiveGuardrailAnswer = function noopRequestInteractiveGuardrailAnswer() {},
    } = composerFlowController || {};

    const turnElapsedClock = turnElapsedClockUtils.createTurnElapsedClock?.({
      getRoot: () => dom.chatTimeline || dom.chatThreadScroll || dom.chatView,
    }) || null;
    const composerTurnElapsedClock = dom.composerWrap
      ? turnElapsedClockUtils.createTurnElapsedClock?.({ getRoot: () => dom.composerWrap }) || null
      : null;
    const syncTurnElapsedClock = () => {
      turnElapsedClock?.sync?.();
      composerTurnElapsedClock?.sync?.();
    };

    const streamHandler = streamHandlerUtils.createStreamHandler?.({
      state,
      thinkingIndicator: controllers.thinkingIndicator,
      // chatTimeline gates the in-place live tool-row patch path (and terminal
      // affordance settle); without it every tool update falls back to a full
      // session re-render. timelineVirtualizer lets the patcher remount
      // virtualizer-stripped rows instead of falling back.
      dom: { chatInput: dom.chatInput, chatTimeline: dom.chatTimeline },
      timelineVirtualizer: controllers.timelineVirtualizer,
      multiStreamController: controllers.multiStreamController,
      constants: {
        MESSAGE_STATUS: constants.MESSAGE_STATUS,
        MAX_INTERACTIVE_QUESTIONS: constants.MAX_INTERACTIVE_QUESTIONS,
        MAX_INTERACTIVE_ROUNDS: constants.MAX_INTERACTIVE_ROUNDS,
        INTERACTIVE_SEQUENCE_IDLE: constants.INTERACTIVE_SEQUENCE_IDLE,
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: constants.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        TOAST_SOURCE: constants.TOAST_SOURCE,
      },
      callbacks: {
        getActiveSendPreflight: (...args) => callbacks.getActiveSendPreflight(...args),
        renderComposerState: (...args) => callbacks.renderComposerState(...args),
        renderMessages: (...args) => callbacks.renderMessages(...args),
        syncTurnElapsedClock,
        renderHeader: (...args) => callbacks.renderHeader(...args),
        renderAll: (...args) => callbacks.renderAll(...args),
        renderComposerStatusNotice: (...args) => callbacks.renderComposerStatusNotice(...args),
        renderLiveThinkingChip: (...args) => callbacks.renderLiveThinkingChip?.(...args),
        renderSessions: (...args) => callbacks.renderSessions(...args),
        renderSettings: (...args) => callbacks.renderSettings(...args),
        renderWorkspaceChrome: (...args) => callbacks.renderWorkspaceChrome(...args),
        getSessionMessages: (...args) => callbacks.getSessionMessages(...args),
        setSessionMessages: (...args) => callbacks.setSessionMessages(...args),
        setSessionTurnEventState: (...args) => callbacks.setSessionTurnEventState?.(...args),
        createNormalizedMessage: (...args) => callbacks.createNormalizedMessage(...args),
        setComposerStatusNotice: (...args) => callbacks.setComposerStatusNotice(...args),
        clearComposerStatusNotice: (...args) => callbacks.clearComposerStatusNotice(...args),
        setTurnStatusPill: (...args) => callbacks.setTurnStatusPill?.(...args),
        clearTurnStatusPill: (...args) => callbacks.clearTurnStatusPill?.(...args),
        clearTurnStatusPillSources: (...args) => callbacks.clearTurnStatusPillSources?.(...args),
        handlePresenceStreamEvent: (...args) => callbacks.handlePresenceStreamEvent?.(...args),
        handleWorkspaceActivityStreamEvent: (...args) => callbacks.handleWorkspaceActivityStreamEvent?.(...args),
        normalizePendingQuestionBatch: (...args) => callbacks.normalizePendingQuestionBatch(...args),
        getInteractiveSequenceState: (...args) => callbacks.getInteractiveSequenceState(...args),
        clearInteractiveDraft: (...args) => callbacks.clearInteractiveDraft(...args),
        ensureInteractiveDraft: (...args) => callbacks.ensureInteractiveDraft(...args),
        patchSessionSummary: (...args) => callbacks.patchSessionSummary(...args),
        buildInteractiveQuestionBatchVisibleText: (...args) => callbacks.buildInteractiveQuestionBatchVisibleText(...args),
        loadSessions: (...args) => callbacks.loadSessions(...args),
        refreshSessionSummaries: (...args) => callbacks.refreshSessionSummaries(...args),
        refreshSnapshots: (...args) => callbacks.refreshSnapshots(...args),
        refreshObservability: (...args) => callbacks.refreshObservability?.(...args) ?? Promise.resolve(null),
        showToastMessage: (...args) => callbacks.showToastMessage(...args),
        dismissStreamErrors: (...args) => callbacks.dismissStreamErrors(...args),
        maybeSuggestMemoryCapture: (...args) => callbacks.maybeSuggestMemoryCapture(...args),
        getInteractiveComposerStatusNotice: (...args) => slashDependencies.getInteractiveComposerStatusNotice(...args),
        persistInteractiveFallbackRequest,
        requestInteractiveGuardrailAnswer,
        queueInteractiveComposerFocus: (...args) => callbacks.queueInteractiveComposerFocus(...args),
        mergeMessageReasoning: (...args) => callbacks.mergeMessageReasoning(...args),
        getQueuedSend,
        clearQueuedSendForSession,
        restoreQueuedSendDraft,
        dispatchQueuedSendForSession,
        appendClientLog: (...args) => callbacks.appendClientLog(...args),
        updateContextUsage: (...args) => callbacks.updateContextUsage(...args),
        setChatSendLifecycle: (...args) => callbacks.setChatSendLifecycle(...args),
        clearChatSendLifecycle: (...args) => callbacks.clearChatSendLifecycle(...args),
        getChatSendLifecycle: (...args) => callbacks.getChatSendLifecycle(...args),
        getChatTimelineRowModelEnabled: (...args) => callbacks.getChatTimelineRowModelEnabled?.(...args),
        recordChatTimelineRolloutSignal: (...args) => callbacks.recordChatTimelineRolloutSignal?.(...args),
        publishFirstTokenImpulse: (...args) => callbacks.publishFirstTokenImpulse?.(...args),
        publishToolStartImpulse: (...args) => callbacks.publishToolStartImpulse?.(...args),
        publishCompleteImpulse: (...args) => callbacks.publishCompleteImpulse?.(...args),
        invalidateProjectionStateForSession: (...args) => callbacks.invalidateProjectionStateForSession?.(...args),
        noteTimelineMessageCreated: (...args) => {
          if (unreadOrientationController && typeof unreadOrientationController.noteTimelineMessageCreated === 'function') {
            return unreadOrientationController.noteTimelineMessageCreated(...args);
          }
          return false;
        },
      },
    }) || null;

    _optimisticAppend = streamHandler ? streamHandler.optimisticAppend : _optimisticAppend;
    _flushBufferedStreamEvents = streamHandler ? streamHandler.flushBufferedStreamEvents : _flushBufferedStreamEvents;
    _flushPendingStreamCommitsForSession = typeof streamHandler?.flushPendingStreamCommitsForSession === 'function'
      ? streamHandler.flushPendingStreamCommitsForSession
      : _flushPendingStreamCommitsForSession;
    _dropBufferedStreamEvents = streamHandler ? streamHandler.dropBufferedStreamEvents : _dropBufferedStreamEvents;
    _rehydrateSessionFromPersistedTurnEvents = typeof streamHandler?.rehydrateSessionFromPersistedTurnEvents === 'function'
      ? streamHandler.rehydrateSessionFromPersistedTurnEvents
      : _rehydrateSessionFromPersistedTurnEvents;

    const chatEventBindings = (typeof chatEventUtils.createChatEventBindings === 'function'
      ? chatEventUtils.createChatEventBindings : () => ({ bind() {}, dispose() {} }))({
      state,
      constants: {
        TOAST_SOURCE: constants.TOAST_SOURCE,
        ACTIVITY_SCOPE: constants.ACTIVITY_SCOPE,
      },
      controllers: {
        thinkingController: controllers.thinkingController,
        toastActionHandlers: controllers.toastActionHandlers,
        // B5: virtualizer instance forwarded so chat-event-utils can
        // hand it to wireChatAccessibility for F1 search pause + E3
        // keyboard ensureMounted integration.
        timelineVirtualizer: controllers.timelineVirtualizer,
        chatScrollCoordinator: controllers.chatScrollCoordinator,
        messageEditController: messageEditController,
        messageBranchController: messageBranchController,
        selectionController: selectionController,
        bulkActionsController: bulkActionsController,
        unreadOrientationController: unreadOrientationController,
      },
      dom: {
        homeNavButton: dom.homeNavButton,
        promptGrid: dom.promptGrid,
        chatInput: dom.chatInput,
        newChatButton: dom.newChatButton,
        stopStreamButton: dom.stopStreamButton,
        sendButton: dom.sendButton,
        jumpToTopButton: dom.jumpToTopButton,
        jumpToLastPromptButton: dom.jumpToLastPromptButton,
        jumpToBottomButton: dom.jumpToBottomButton,
        chatView: dom.chatView,
        chatThreadScroll: dom.chatThreadScroll,
        composerWrap: dom.composerWrap,
        chatTimeline: dom.chatTimeline,
        toastViewport: dom.toastViewport,
        composerModelSelect: dom.composerModelSelect,
        composerEffortSelect: dom.composerEffortSelect,
        composerSettingsButton: dom.composerSettingsButton,
        openComposerSettingsViewButton: dom.openComposerSettingsViewButton,
        composerCommandPopover: dom.composerCommandPopover,
        artifactReviewPanel: dom.artifactReviewPanel,
      },
      callbacks: {
        setActivityChangeListener: (...args) => callbacks.setActivityChangeListener(...args),
        handleActivityChange: (...args) => callbacks.handleActivityChange(...args),
        renderHeader: (...args) => callbacks.renderHeader(...args),
        renderSettings: (...args) => callbacks.renderSettings(...args),
        renderAll: (...args) => callbacks.renderAll(...args),
        setToolCallExpansion: (...args) => callbacks.setToolCallExpansion?.(...args),
        renderLogs: (...args) => callbacks.renderLogs(...args),
        pushIncomingLog: (...args) => callbacks.pushIncomingLog(...args),
        syncBackendActivityFromStatus: (...args) => callbacks.syncBackendActivityFromStatus(...args),
        appendClientLog: (...args) => callbacks.appendClientLog(...args),
        getRendererElapsedMs: (...args) => callbacks.getRendererElapsedMs(...args),
        loadSessions: (...args) => callbacks.loadSessions(...args),
        refreshSnapshots: (...args) => callbacks.refreshSnapshots(...args),
        refreshSuggestions: (...args) => callbacks.refreshSuggestions(...args),
        refreshApprovedMemories: (...args) => callbacks.refreshApprovedMemories(...args),
        resetArtifactsState: (...args) => callbacks.resetArtifactsState(...args),
        resetMemorySuggestionState: (...args) => callbacks.resetMemorySuggestionState(...args),
        resetAttachmentQueue: (...args) => callbacks.resetAttachmentQueue(...args),
        closeComposerPopover: (...args) => callbacks.closeComposerPopover(...args),
        openComposerPopover: (...args) => callbacks.openComposerPopover(...args),
        closeCommandPopover: (...args) => callbacks.closeCommandPopover(...args),
        openCommandPopover: (...args) => callbacks.openCommandPopover(...args),
        handleSlashCommandSelection: selectSlashCommand,
        hideAssistantSprite: (...args) => callbacks.hideAssistantSprite(...args),
        updateAssistantSpritePosition: (...args) => callbacks.updateAssistantSpritePosition?.(...args),
        setFollowLatest: (...args) => callbacks.setFollowLatest(...args),
        setActiveView: (...args) => callbacks.setActiveView(...args),
        syncComposerInputHeight: (...args) => callbacks.syncComposerInputHeight(...args),
        syncComposerVisualState: (...args) => callbacks.syncComposerVisualState(...args),
        renderComposerState: (...args) => callbacks.renderComposerState(...args),
        handleCreateSession: (...args) => callbacks.handleCreateSession(...args),
        handleStopActiveStream,
        showSessionActionError: (...args) => callbacks.showSessionActionError(...args),
        handleSend,
        showComposerActionError: (...args) => callbacks.showComposerActionError(...args),
        setComposerStatusNotice: (...args) => callbacks.setComposerStatusNotice(...args),
        clearComposerStatusNotice: (...args) => callbacks.clearComposerStatusNotice(...args),
        handleJumpToTop: (...args) => callbacks.handleJumpToTop(...args),
        handleJumpToLastPrompt: (...args) => callbacks.handleJumpToLastPrompt(...args),
        handleJumpToBottom: (...args) => callbacks.handleJumpToBottom(...args),
        handleComposerPaste,
        syncThreadScrollState: (...args) => callbacks.syncThreadScrollState(...args),
        getPendingQuestionBatch: (...args) => callbacks.getPendingQuestionBatch(...args),
        handleInteractiveOptionSelect,
        handleInteractiveOtherConfirm,
        handleInteractiveSubmit,
        handleInteractiveSkip,
        handleInteractiveSkipQuestion,
        handleInteractiveSkipAll,
        handleInteractiveOtherInputChange,
        toggleInteractiveRoundRecap: (...args) => callbacks.toggleInteractiveRoundRecap(...args),
        toggleThreadBranch: (...args) => callbacks.toggleThreadBranch?.(...args),
        handleCopyMessage,
        handleElaborateMessage,
        handleRegenerateMessage,
        handleBranchMessage: (...args) => {
          if (messageBranchController && typeof messageBranchController.branchFromMessage === 'function') {
            return messageBranchController.branchFromMessage(...args);
          }
          return Promise.resolve(null);
        },
        // F2 edit handlers — wired from the locally-constructed messageEditController above.
        handleEditMessage: (...args) => {
          if (messageEditController && typeof messageEditController.enterEdit === 'function') {
            return messageEditController.enterEdit(...args);
          }
          return false;
        },
        handleEditCommit: () => {
          if (messageEditController && typeof messageEditController.commitEdit === 'function') {
            return messageEditController.commitEdit();
          }
          return Promise.resolve(null);
        },
        handleEditCancel: () => {
          if (messageEditController && typeof messageEditController.cancelEdit === 'function') {
            messageEditController.cancelEdit();
          }
        },
        handleFollowUpMessage: (...args) => callbacks.handleFollowUpMessage(...args),
        setReasoningPhaseExpandedPreference: (...args) => callbacks.setReasoningPhaseExpandedPreference?.(...args),
        setReasoningPhaseExpandedPreferences: (...args) => callbacks.setReasoningPhaseExpandedPreferences?.(...args),
        syncThinkingBlockNode: (...args) => callbacks.syncThinkingBlockNode(...args),
        dismissToast: (...args) => callbacks.dismissToast(...args),
        showShellErrorToast: (...args) => callbacks.showShellErrorToast(...args),
        showToastMessage: (...args) => callbacks.showToastMessage(...args),
        reportError: (...args) => (typeof callbacks.reportError === 'function'
          ? callbacks.reportError(...args)
          : null),
        guardComposerTextPaste: (...args) => (
          typeof callbacks.guardComposerTextPaste === 'function'
            ? callbacks.guardComposerTextPaste(...args)
            : { allowed: true }
        ),
        toErrorMessage: (...args) => callbacks.toErrorMessage(...args),
        beginActivity: (...args) => callbacks.beginActivity(...args),
        resolveActivity: (...args) => callbacks.resolveActivity(...args),
        failActivity: (...args) => callbacks.failActivity(...args),
        getRuntimePreferenceSnapshot: (...args) => callbacks.getRuntimePreferenceSnapshot(...args),
        runRuntimePreferenceActivity: (...args) => callbacks.runRuntimePreferenceActivity(...args),
        getCurrentRuntimePreferences: (...args) => callbacks.getCurrentRuntimePreferences(...args),
        handleSaveProactiveSuggestionMessage: (...args) => callbacks.handleSaveProactiveSuggestionMessage(...args),
        handleLaterProactiveSuggestionMessage: (...args) => callbacks.handleLaterProactiveSuggestionMessage(...args),
        handleUseProactiveSuggestionMessage: (...args) => callbacks.handleUseProactiveSuggestionMessage(...args),
        handleLifecycleProgress: (...args) => callbacks.handleLifecycleProgress(...args),
        handleLifecycleBackendStatus: (...args) => callbacks.handleLifecycleBackendStatus(...args),
        clearChatSendLifecycle: (...args) => callbacks.clearChatSendLifecycle?.(...args),
        beginModelSwitch: (...args) => callbacks.beginModelSwitch(...args),
        updateModelSwitch: (...args) => callbacks.updateModelSwitch(...args),
        failModelSwitch: (...args) => callbacks.failModelSwitch(...args),
        adjustChatZoomPercent: (...args) => callbacks.adjustChatZoomPercent?.(...args),
        resetChatZoomPercent: (...args) => callbacks.resetChatZoomPercent?.(...args),
        openSettingsSection: (...args) => callbacks.openSettingsSection(...args),
        handleErrorRecoveryAction: (...args) => callbacks.handleErrorRecoveryAction(...args),
        handleArtifactAction: (...args) => callbacks.handleArtifactAction(...args),
        handleCodeReviewAction: (...args) => (callbacks.handleCodeReviewAction || function noopHandleCodeReviewAction() { return Promise.resolve(); })(...args),
        handleOpenChangeDiff: (...args) => (callbacks.handleOpenChangeDiff || function noopHandleOpenChangeDiff() { return Promise.resolve(false); })(...args),
        handleComposerToggleChange: (...args) => callbacks.handleComposerToggleChange(...args),
        getCurrentSessionMessages: (...args) => callbacks.getCurrentSessionMessages(...args),
        getSessionTurnEventState: (...args) => callbacks.getSessionTurnEventState?.(...args),
        scrollMessageIntoView: (...args) => callbacks.scrollMessageIntoView?.(...args),
        viewportReveal: callbacks.viewportReveal || null,
        focusEntryByMessageId: (...args) => callbacks.focusEntryByMessageId?.(...args),
      },
    });

    const cleanupFns = [];
    let bound = false;

    function addCleanup(cleanup) {
      if (typeof cleanup === 'function') {
        cleanupFns.push(cleanup);
      }
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      addCleanup(() => sendController?.dispose?.());
      addCleanup(() => resumeTurnInteraction?.dispose?.());
      addCleanup(() => messageEditController?.dispose?.());
      addCleanup(() => messageBranchController?.dispose?.());
      addCleanup(() => selectionController?.dispose?.());
      addCleanup(() => bulkActionsController?.dispose?.());
      addCleanup(() => bulkDeleteConfirmDialog?.dispose?.());
      addCleanup(() => {
        const outboxElement = (dom.chatInput?.ownerDocument || windowRef?.document)?.getElementById?.('sendOutbox');
        globalThis.rendererSendOutboxRender?.disposeSendOutboxRender?.(outboxElement);
      });
      if (streamHandler) {
        streamHandler.registerStreamHandler(windowRef.jennyShell);
        addCleanup(() => streamHandler.dispose?.());
      }
      syncTurnElapsedClock();
      addCleanup(() => turnElapsedClock?.stop?.());
      addCleanup(() => composerTurnElapsedClock?.stop?.());
      addCleanup(() => unreadOrientationController?.dispose?.());
      chatEventBindings.bind();
      addCleanup(() => chatEventBindings.dispose?.());
      globalThis.rendererTaskSpawnChip?.bindTaskSpawnChip?.(dom.chatTimeline, {
        activateWorkspaceSession,
        getLinkedSessionId: (taskId) => state.sessions.find(
          (session) => String(session?.linked_task_id || '').trim() === String(taskId || '').trim()
        )?.id || '',
        getTaskNotes: (taskId) => String(['active', 'deferred', 'recentResolved', 'archived']
          .flatMap((section) => state.companion?.openLoopsBoard?.[section] || [])
          .find((task) => String(task?.followUpId || '').trim() === String(taskId || '').trim())?.body || ''),
      });
    }

    // Re-checks the stream_envelope_v2 flag against the live subscription and
    // resubscribes on a mode change. Called after the initial feature-state
    // load in bootstrapAppShell: bind() runs before features.getState()
    // resolves, so the first subscription is made against placeholder flags.
    function resyncStreamSubscriptionMode() {
      if (!bound || !streamHandler) {
        return null;
      }
      return streamHandler.resyncStreamSubscriptionMode?.() ?? null;
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch (_error) {
          // Best-effort teardown keeps renderer shutdown idempotent.
        }
      }
    }

    return {
      bind,
      resyncStreamSubscriptionMode,
      dispose,
      startPromptSend,
      dispatchQueuedSendForSession,
      handleStopActiveStream,
      handleSend,
      handleInteractiveOptionSelect,
      handleInteractiveOtherConfirm,
      handleInteractiveOtherInputChange,
      handleInteractiveSkip,
      handleInteractiveSkipQuestion,
      handleInteractiveSkipAll,
      handleInteractiveSubmit,
      handleCopyMessage,
      handleElaborateMessage,
      handleRegenerateMessage,
      retryFailedPayload,
      getFailedPayloadRetryAvailability,
      dismissFailedPayload,
      syncTurnElapsedClock,
      flushPendingStreamCommitsForSession: (...args) => _flushPendingStreamCommitsForSession(...args),
      rehydrateSessionFromPersistedTurnEvents: (...args) => _rehydrateSessionFromPersistedTurnEvents(...args),
      listSlashCommands: () => slashCommandRegistry.listCommands?.() || [],
      tryExecuteSlashCommand: (prompt) => slashCommandRegistry.execute?.(prompt) || slashCommandRegistry.tryExecute?.(prompt) || false,
      insertSlashCommand,
      // Command-palette "Keyboard shortcuts" entry (non-IDE views) opens the
      // chat shortcuts overlay owned by the keyboard-accessibility wiring.
      openKeyboardShortcuts: () => chatEventBindings.openHelpOverlay?.(),
      composerV2: sendController?.composerV2,
    };
  }

  return {
    createChatShellController,
  };
});
