/* renderer/chat/renderer-chat-shell-controller.js - Internal chat-surface composition. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-slash-command-registry'), require('./renderer-pane-session-context'), require('./renderer-mcp-prompt-slash-commands'));
    return;
  }
  root.rendererChatShellControllerUtils = factory(root.rendererSlashCommandRegistryUtils || {}, root.rendererPaneSessionContext, root.rendererMcpPromptSlashCommands);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (slashCommandUtils, paneSessionContextUtils, promptSlashUtils) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Split view W1-4b: the ONE pane session context every surface below acts on (renderer-pane-session-context.js,
  // loaded before this file). W1-4c injects a pane-bound one; `paneId` alone builds that pane's default.
  function resolvePaneSessionContext({ state, sessionContext: injected, paneId }) {
    if (!injected) {
      const owner = paneSessionContextUtils || globalThis.rendererPaneSessionContext;
      if (typeof owner?.createPaneSessionContext !== 'function') {
        throw new Error('renderer/chat/renderer-pane-session-context.js must load before renderer/chat/renderer-chat-shell-controller.js');
      }
      return owner.createPaneSessionContext({ state, paneId });
    }
    if (['getSessionId', 'setSessionId', 'isCurrent'].every((key) => typeof injected[key] === 'function')) return injected;
    throw new TypeError('createChatShellController: sessionContext needs getSessionId, setSessionId and isCurrent.');
  }
  const { isPrimarySessionId = () => false } = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)) || {};
  function createChatShellController(deps) {
    const { state, slashDependencies, compactionCoordinator } = deps;
    const sessionContext = resolvePaneSessionContext(deps);
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
    // Late-bound forwarders: each entry looks the callback up at CALL time, so
    // a callbacks bag filled after construction (and sparse test bags) work.
    const forward = (names) => Object.fromEntries(names.map((name) => [name, (...args) => callbacks[name](...args)]));
    const forwardOptional = (names) => Object.fromEntries(names.map((name) => [name, (...args) => callbacks[name]?.(...args)]));
    // A callback with a fallback used when the host supplies none.
    const callbackOr = (name, fallback) => (...args) => (typeof callbacks[name] === 'function' ? callbacks[name] : fallback)(...args);
    const log = (...args) => callbacks.appendClientLog?.(...args);
    const toast = (...args) => callbacks.showToastMessage?.(...args);
    const noop = () => {};
    const noopAsync = async () => {};
    const documentRef = typeof document !== 'undefined' ? document : windowRef.document || null;
    let _optimisticAppend = function noopOptimisticAppend() { return {}; };
    let _flushBufferedStreamEvents = async function noopFlushBufferedStreamEvents() {
      return { flushedCount: 0, terminal: false };
    };
    let _flushPendingStreamCommitsForSession = function noopFlushPendingStreamCommitsForSession() {
      return { flushedCount: 0, catchupRequired: false };
    };
    let _dropBufferedStreamEvents = function noopDropBufferedStreamEvents() {};
    let _rehydrateSessionFromPersistedTurnEvents = () => null;
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
      || (() => () => toast(jt('chat.shell.scratchpadUnavailable', 'Scratchpad is unavailable.'), { title: jt('chat.shell.scratchpadTitle', 'Scratchpad'), tone: 'warning' }));
    const noteHandler = createNoteCommandHandler({
      captureToScratchpad: slashDependencies && slashDependencies.captureToScratchpad,
      showToastMessage: toast, appendClientLog: log,
    });
    const linkedHandler = (factories.createLinkedCommandHandler || windowRef.rendererSlashLinkedCommand?.createLinkedCommandHandler)?.({
      state, getStartPromptSend: () => startPromptSend, getSessionProposals: () => windowRef.jennyShell?.sessionProposals,
      setNotice: (text) => callbacks.setComposerStatusNotice?.(text, { owner: 'slash:linked', tone: 'warning' }),
      appendClientLog: log });
    const handoffHandler = (factories.createHandoffCommandHandler || windowRef.rendererSlashHandoffCommand?.createHandoffCommandHandler)?.({
      state, documentRef: windowRef.document, getStartPromptSend: () => startPromptSend,
      createSession: (options) => callbacks.handleCreateSession(options),
      getHandoffApi: () => windowRef.jennyShell?.handoff,
      setNotice: (text, tone) => callbacks.setComposerStatusNotice?.(text, { owner: 'slash:handoff', tone: tone || 'warning' }),
      clearComposer: () => { if (dom.chatInput) { dom.chatInput.value = ''; callbacks.syncComposerInputHeight(); callbacks.syncComposerVisualState(); } },
      setComposerDraft: (text) => { if (!dom.chatInput) return false; dom.chatInput.value = String(text || ''); callbacks.syncComposerInputHeight(); callbacks.syncComposerVisualState(); return true; },
      isSessionCurrent: (sessionId) => sessionContext.isCurrent(sessionId),
      getComposerController: () => windowRef.rendererComposerSessionStateController || globalThis.rendererComposerSessionStateController || null,
      appendClientLog: log });
    const memoryHandlers = (factories.createMemoryCommandHandlers || windowRef.rendererSlashMemoryCommands?.createMemoryCommandHandlers)?.({ state, getMemoryApi: slashDependencies?.getMemoryApi,
      injectOutput: (...a) => slashCommandRegistry.injectOutput(...a), showToastMessage: toast, appendClientLog: log }) || {};
    const activityHandler = (factories.createActivityCommandHandler || windowRef.rendererSlashActivityCommand?.createActivityCommandHandler)?.({ state, showToast: toast,
      open: (args) => state.features?.featureFlags?.primary_activity_log !== false && windowRef.rendererPrimaryActivity?.getDefaultPrimaryActivity?.({ documentRef: windowRef.document, stepModal: windowRef.inventoryStepModal, state, getBridge: () => windowRef.jennyShell?.primaryChat || null, appendClientLog: log }).open(args) });
    registerBuiltInSlashCommands({
      registry: slashCommandRegistry, contextHandler, noteHandler, linkedHandler, handoffHandler, activityHandler, ...memoryHandlers, compact: (sessionId) => compactionCoordinator?.invoke?.(sessionId, { source: 'slash' }),
      showToastMessage: toast,
    });
    const promptCommands = promptSlashUtils?.createMcpPromptSlashCommands?.({
      registry: slashCommandRegistry, state, sessionContext, chatInput: dom.chatInput,
      getMcpState: () => windowRef.jennyShell?.mcpDiscovery?.getState?.(), getPrompt: payload => windowRef.jennyShell?.mcpDiscovery?.getPrompt?.(payload),
      showToastMessage: callbacks.showToastMessage, renderComposerState: callbacks.renderComposerState, log: callbacks.appendClientLog,
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
          callbacks.showToastMessage?.(jt('chat.shell.commandConflict', 'Finish or remove the current command before inserting another.'), {
            title: jt('chat.shell.commandAlreadyPresent', 'Command already present'),
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
      state, sessionContext,
      dom: { chatInput: dom.chatInput },
      slashCommandRegistry, promptCommands,
      multiStreamController: controllers.multiStreamController,
      thinkingIndicator: controllers.thinkingIndicator, compactionCoordinator,
      constants: {
        INTERACTIVE_GUARDRAIL_PROMPT: constants.INTERACTIVE_GUARDRAIL_PROMPT,
        INTERACTIVE_SEQUENCE_IDLE: constants.INTERACTIVE_SEQUENCE_IDLE,
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: constants.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        TOAST_SOURCE: constants.TOAST_SOURCE,
        MAX_INTERACTIVE_ROUNDS: constants.MAX_INTERACTIVE_ROUNDS,
      },
      callbacks: {
        ...forward([
          'getActiveSession', 'getPendingQuestionBatch', 'normalizePendingQuestionBatch', 'shouldForceInteractiveGuardrail',
          'getInteractiveSequenceState', 'clearInteractiveDraft', 'patchSessionSummary', 'getCurrentRuntimePreferences',
          'getCurrentVisibleMessages', 'getCurrentSessionMessages', 'getSessionMessages', 'setSessionMessages',
          'createNormalizedMessage', 'resolveSessionId', 'buildAttachmentBudget', 'resetAttachmentQueue', 'showToastMessage',
          'setComposerStatusNotice', 'clearComposerStatusNotice', 'showComposerActionError', 'renderComposerState',
          'renderAll', 'renderMessages', 'renderSessions', 'renderHeader', 'syncComposerInputHeight', 'syncComposerVisualState',
          'setFollowLatest', 'refreshSessionSummaries', 'isSessionStreaming', 'hasPendingToolApprovalForSession',
          'getCurrentMessageById', 'getElaboratePrompt', 'getLatestReplyAssistantMessageId', 'resolveRegenerateRequest',
          'showCopyFeedback', 'upsertSessionSummary', 'rekeySessionState', 'attachPendingOriginToSession', 'rekeySessionOrigin',
          'appendClientLog', 'getToolPreferences', 'setChatSendLifecycle', 'clearChatSendLifecycle', 'moveChatSendLifecycle',
        ]),
        ...forwardOptional(['clearProjectionContextCacheForSession', 'publishCancelImpulse']),
        getRuntimePreferencesFromSession: callbacks.getRuntimePreferencesFromSession,
        // Composer menus only insert; the global palette has its own execute seam.
        handleSlashCommandSelection: insertSlashCommand,
        activateWorkspaceSession,
        thinkingController: controllers.thinkingController,
        flushBufferedStreamEvents: (...args) => _flushBufferedStreamEvents(...args),
        dropBufferedStreamEvents: (...args) => _dropBufferedStreamEvents(...args),
        optimisticAppend: (...args) => _optimisticAppend(...args),
        onUserSendStarted: notifyUserSendStarted,
      },
    }) || null;
    const {
      startPromptSend = noopAsync,
      handleStopActiveStream = noopAsync,
      getQueuedSend = () => null,
      restoreQueuedSendDraft = () => null,
      dispatchQueuedSendForSession = noopAsync,
      handleElaborateMessage = noopAsync,
      handleRegenerateMessage = noopAsync,
      handleCopyMessage = noopAsync,
      retryFailedPayload = noopAsync,
      getFailedPayloadRetryAvailability = () => (
        { available: false, reason: jt('chat.shell.failedPayloadUnavailable', 'The original failed payload is unavailable.') }
      ),
      dismissFailedPayload = () => false,
    } = sendController || {};
    const resolveOutboxAction = (entry) => {
      const current = state.sendOutboxController?.list?.(entry?.sessionId)
        .find((item) => item.id === entry?.id);
      return current && ['capturing_context', 'ready', 'waiting_for_turn', 'failed', 'needs_review'].includes(current.status) ? current : null;
    };
    if (sendController) {
      const rerenderOutbox = () => {
        callbacks.renderComposerState();
        callbacks.renderSessions();
      };
      controllers.sendOutboxActions = {
        async edit(entry, prompt) {
          entry = resolveOutboxAction(entry);
          if (!entry) return null;
          dispatchQueuedSendForSession.cancelAutoRetry?.(entry?.sessionId);
          const result = state.sendOutboxController?.edit?.(entry, prompt);
          rerenderOutbox();
          if (!result) return null;
          return dispatchQueuedSendForSession(result.sessionId);
        },
        cancel(entry) {
          entry = resolveOutboxAction(entry);
          if (!entry) return false;
          dispatchQueuedSendForSession.cancelAutoRetry?.(entry?.sessionId);
          const result = state.sendOutboxController?.remove?.(entry) === true;
          rerenderOutbox();
          return result;
        },
        async retry(entry) {
          entry = resolveOutboxAction(entry);
          if (!entry || !['failed', 'needs_review'].includes(entry.status)) return null;
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
        getCurrentSessionId: () => sessionContext.getSessionId(),
        isSessionSendBusy: controllers.multiStreamController?.isSessionSendBusy?.bind(controllers.multiStreamController),
        hasComposerDraftAttachments: () => Boolean( // W2-2b: this pane's session's queue
          (globalThis.rendererComposerSessionState?.getQueuedAttachments?.(state, sessionContext.getSessionId()) ?? state.attachments?.queued)?.length
        ),
        appendClientLog: callbacks.appendClientLog,
        showComposerActionError: callbacks.showComposerActionError,
        sessionCallbacks: callbacks,
      });
    }

    // Sub-controllers are best-effort: a missing module or a construction
    // throw (jsdom edge case) leaves that affordance off; the chat keeps working.
    const jennyShell = windowRef.jennyShell || {};
    const buildController = (api, factoryName, logEvent, buildOptions) => {
      if (typeof api?.[factoryName] !== 'function') return null;
      try {
        return api[factoryName](buildOptions()) || null;
      } catch (error) {
        log('WARN', logEvent, { message: error?.message || String(error) });
        return null;
      }
    };
    const clearProjectionContextCacheForSession = (...args) => callbacks.clearProjectionContextCacheForSession?.(...args);
    const isSessionBusyForEdit = (sessionId) => {
      // Mirrors the send controller's follow-up gate: a send still in
      // preflight/outbox dispatch counts as busy, not only a live stream.
      const multiStream = controllers.multiStreamController;
      if (typeof multiStream?.isSessionSendBusy === 'function') return multiStream.isSessionSendBusy(sessionId);
      return callbacks.isSessionStreaming?.(sessionId) === true;
    };

    // F2: inline message edit; commit() calls startPromptSend after the
    // backend truncate succeeds.
    const messageEditController = buildController(globalThis.rendererChatMessageEditUtils, 'createMessageEditController', 'chat.edit_controller_init_failed', () => ({
      state,
      document: documentRef,
      jennyShellSessions: jennyShell.sessions || null,
      getCurrentSessionId: () => sessionContext.getSessionId(),
      isPrimarySession: (id) => isPrimarySessionId(state.sessions, id),
      startPromptSend: (...args) => startPromptSend(...args),
      ...forward(['getCurrentSessionMessages', 'renderAll', 'appendClientLog', 'showComposerActionError', 'showToastMessage']),
      resolveFollowUpActionBlock: () => {
        const currentSessionId = sessionContext.getSessionId();
        if (isSessionBusyForEdit(currentSessionId) || callbacks.hasPendingToolApprovalForSession?.(currentSessionId)) {
          return { blocked: true, reason: jt('chat.edit.waitForCurrentResponse', 'Wait for the current response to finish before editing.') };
        }
        return { blocked: false };
      },
      clearProjectionContextCacheForSession,
      buildReplayableImageAttachments: callbackOr('buildReplayableImageAttachments',
        (...args) => globalThis.chatBubbleActionUtils?.buildReplayableImageAttachments?.(...args) ?? []),
      hasTextAttachmentMetadata: callbackOr('hasTextAttachmentMetadata',
        (...args) => globalThis.chatBubbleActionUtils?.hasTextAttachmentMetadata?.(...args) ?? false),
    }));
    controllers.messageEditController = messageEditController;

    // F3: branch via the sessions.forkSession IPC seam, then activate the new tab.
    const messageBranchController = buildController(globalThis.rendererChatBranchUtils, 'createMessageBranchController', 'chat.branch_controller_init_failed', () => ({
      state, sessionContext,
      jennyShellSessions: jennyShell.sessions || null,
      getCurrentSessionId: () => sessionContext.getSessionId(),
      activateWorkspaceSession,
      ...forward([
        'getCurrentSessionMessages', 'loadSessions', 'upsertSessionSummary', 'renderAll', 'appendClientLog',
        'showComposerActionError', 'showToastMessage', 'isSessionStreaming', 'hasPendingToolApprovalForSession',
      ]),
    }));
    controllers.messageBranchController = messageBranchController;

    // F4/F5/F6: the selection controller owns selection mode + per-session
    // selected sets; bulk actions wrap the format builders, save/clipboard
    // and the F2 truncate path.
    const confirmDialogFactory = windowRef.rendererIdeConfirmDialog?.createIdeConfirmDialog;
    const helpOverlayFactory = windowRef.inventoryHelpOverlay?.createHelpOverlay;
    const bulkDeleteConfirmDialog = typeof confirmDialogFactory === 'function' && typeof helpOverlayFactory === 'function'
      ? confirmDialogFactory({
        document: documentRef,
        actionButton: windowRef.inventoryActionButton,
        helpOverlayFactory,
        hostId: 'chatBulkDeleteConfirmOverlay',
      })
      : null;
    function confirmBulkDelete(promptText) {
      if (typeof callbacks.confirmBulkDelete === 'function') return callbacks.confirmBulkDelete(promptText);
      if (typeof bulkDeleteConfirmDialog?.confirm !== 'function') return Promise.resolve(false);
      return bulkDeleteConfirmDialog.confirm({
        title: jt('chat.shell.deleteFromHere', 'Delete from here?'),
        message: promptText,
        confirmLabel: jt('common.delete', 'Delete'),
        cancelLabel: jt('common.cancel', 'Cancel'),
        variant: 'danger',
      });
    }
    selectionController = buildController(globalThis.rendererChatSelectionUtils, 'createSelectionController', 'chat.selection_controller_init_failed', () => ({
      state,
      document: documentRef,
      getCurrentSessionId: () => sessionContext.getSessionId(), paneId: sessionContext.paneId,
      ...forward(['getCurrentSessionMessages', 'renderAll', 'appendClientLog']),
      focusEntryByMessageId: callbackOr('focusEntryByMessageId', () => null),
    }));
    controllers.selectionController = selectionController;
    const bulkActionsController = selectionController && buildController(globalThis.rendererChatBulkActionsUtils, 'createBulkActionsController', 'chat.bulk_actions_controller_init_failed', () => ({
      state,
      jennyShellSessions: jennyShell.sessions || null,
      jennyShellDialog: jennyShell.dialog || null,
      jennyShellClipboard: jennyShell.clipboard || null,
      getCurrentSessionId: () => sessionContext.getSessionId(),
      ...forward(['getCurrentSessionMessages', 'renderAll', 'appendClientLog', 'showToastMessage']),
      getCurrentSessionTurnEvents: callbackOr('getCurrentSessionTurnEvents', () => []),
      getCurrentSessionMeta: callbackOr('getCurrentSessionMeta', () => ({})),
      selectionController,
      conversationFormatUtils: globalThis.conversationFormatUtils || null,
      clearProjectionContextCacheForSession,
      confirmDelete: confirmBulkDelete,
    }));
    controllers.bulkActionsController = bulkActionsController;

    // F10: first-unread orientation is renderer-only state. The stream
    // handler notifies this controller when a visible assistant/tool row is
    // appended, while keyboard/accessibility wiring owns the affordance mount.
    const unreadOrientationController = buildController(globalThis.rendererChatUnreadOrientationUtils, 'createUnreadOrientationController', 'chat.unread_orientation_controller_init_failed', () => ({
      state,
      document: documentRef,
      chatTimeline: dom.chatTimeline,
      chatThreadScroll: dom.chatThreadScroll,
      getCurrentSessionId: () => sessionContext.getSessionId(),
      ...forward(['getCurrentSessionMessages', 'appendClientLog']),
      getScrollMetrics: callbackOr('getScrollMetrics', () => ({
        scrollTop: Number(dom.chatThreadScroll?.scrollTop || 0),
        scrollHeight: Number(dom.chatThreadScroll?.scrollHeight || 0),
        clientHeight: Number(dom.chatThreadScroll?.clientHeight || 0),
      })),
      scrollMessageIntoView: callbackOr('scrollMessageIntoView', () => false),
      viewportReveal: callbacks.viewportReveal || null,
      focusEntryByMessageId: callbackOr('focusEntryByMessageId', () => false),
      timelineVirtualizer: controllers.timelineVirtualizer,
      onStateChange: typeof callbacks.onUnreadOrientationStateChange === 'function'
        ? (...args) => callbacks.onUnreadOrientationStateChange(...args)
        : undefined,
    }));
    controllers.unreadOrientationController = unreadOrientationController;
    if (unreadOrientationController) callbacks.setUnreadOrientationController?.(unreadOrientationController);

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
      state, sessionContext,
      windowRef,
      appendClientLog: (...args) => callbacks.appendClientLog(...args),
    });

    const {
      handleInteractiveOptionSelect = noop,
      handleInteractiveOtherConfirm = noop,
      handleInteractiveOtherInputChange = noop,
      handleInteractiveSkip = noop,
      handleInteractiveSkipQuestion = noop,
      handleInteractiveSkipAll = noop,
      handleInteractiveSubmit = noop,
      handleComposerPaste = noop,
      handleSend = noop,
      persistInteractiveFallbackRequest = noop,
      requestInteractiveGuardrailAnswer = noop,
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
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: constants.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        TOAST_SOURCE: constants.TOAST_SOURCE,
      },
      callbacks: {
        ...forward([
          'renderComposerState', 'renderMessages', 'renderHeader', 'renderAll', 'renderComposerStatusNotice', 'renderSessions',
          'renderSettings', 'renderWorkspaceChrome', 'getSessionMessages', 'setSessionMessages', 'createNormalizedMessage',
          'setComposerStatusNotice', 'clearComposerStatusNotice', 'normalizePendingQuestionBatch', 'getInteractiveSequenceState',
          'clearInteractiveDraft', 'ensureInteractiveDraft', 'patchSessionSummary', 'buildInteractiveQuestionBatchVisibleText',
          'refreshSessionSummaries', 'refreshSnapshots', 'showToastMessage', 'dismissStreamErrors', 'queueInteractiveComposerFocus',
          'mergeMessageReasoning', 'appendClientLog', 'updateContextUsage', 'setChatSendLifecycle', 'clearChatSendLifecycle',
          'getChatSendLifecycle',
        ]),
        ...forwardOptional([
          'scheduleMessageViewportSync', 'setSessionTurnEventState', 'handlePresenceStreamEvent', 'handleWorkspaceActivityStreamEvent',
          'dismissToast', 'getChatTimelineRowModelEnabled', 'recordChatTimelineRolloutSignal', 'publishFirstTokenImpulse',
          'publishToolStartImpulse', 'publishCompleteImpulse', 'invalidateProjectionStateForSession',
        ]),
        renderSessionPane: callbacks.renderSessionPane,
        syncTurnElapsedClock,
        refreshObservability: (...args) => callbacks.refreshObservability?.(...args) ?? Promise.resolve(null),
        getInteractiveComposerStatusNotice: (...args) => slashDependencies.getInteractiveComposerStatusNotice(...args),
        persistInteractiveFallbackRequest,
        requestInteractiveGuardrailAnswer,
        getQueuedSend,
        restoreQueuedSendDraft,
        dispatchQueuedSendForSession,
        noteTimelineMessageCreated: (...args) => unreadOrientationController?.noteTimelineMessageCreated?.(...args) ?? false,
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
      state, sessionContext,
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
        composerRunModeSlot: dom.composerRunModeSlot, // W2-2a: a pane's own rail slot
        artifactReviewPanel: dom.artifactReviewPanel, chatSelectionOverlayHost: dom.chatSelectionOverlayHost, // W2-3: a pane's own host
      },
      callbacks: {
        ...forward([
          'setActivityChangeListener', 'handleActivityChange', 'renderHeader', 'renderSettings', 'renderAll', 'renderLogs',
          'pushIncomingLog', 'syncBackendActivityFromStatus', 'appendClientLog', 'getRendererElapsedMs', 'loadSessions',
          'refreshSnapshots', 'refreshApprovedMemories', 'resetArtifactsState', 'resetAttachmentQueue', 'closeComposerPopover',
          'hideAssistantSprite', 'setFollowLatest', 'setActiveView', 'syncComposerInputHeight', 'syncComposerVisualState',
          'renderComposerState', 'handleCreateSession', 'showSessionActionError', 'showComposerActionError',
          'setComposerStatusNotice', 'clearComposerStatusNotice', 'handleJumpToTop', 'handleJumpToLastPrompt',
          'handleJumpToBottom', 'syncThreadScrollState', 'getPendingQuestionBatch', 'toggleInteractiveRoundRecap',
          'toggleContextCompactionDetails', 'handleFollowUpMessage', 'syncThinkingBlockNode', 'dismissToast',
          'showShellErrorToast', 'showToastMessage', 'toErrorMessage', 'beginActivity', 'resolveActivity', 'failActivity',
          'getRuntimePreferenceSnapshot', 'runRuntimePreferenceActivity', 'getCurrentRuntimePreferences',
          'handleSaveProactiveSuggestionMessage', 'handleLaterProactiveSuggestionMessage', 'handleUseProactiveSuggestionMessage',
          'handleLifecycleProgress', 'handleLifecycleBackendStatus', 'beginModelSwitch', 'updateModelSwitch', 'failModelSwitch',
          'openSettingsSection', 'handleErrorRecoveryAction', 'handleArtifactAction', 'handleComposerToggleChange',
          'getCurrentSessionMessages',
        ]),
        ...forwardOptional([
          'setToolCallExpansion', 'refreshComposerToolToggles', 'resetPanes', 'updateAssistantSpritePosition', 'toggleThreadBranch',
          'setReasoningPhaseExpandedPreference', 'clearChatSendLifecycle', 'adjustChatZoomPercent', 'resetChatZoomPercent',
          'getSessionTurnEventState', 'scrollMessageIntoView', 'focusEntryByMessageId',
        ]),
        getSessionMessages: callbacks.getSessionMessages,
        setSessionMessages: (...args) => {
          const result = callbacks.setSessionMessages(...args);
          callbacks.renderWorkspaceChrome?.({ runtimeOnly: true });
          return result;
        },
        getRuntimePreferencesFromSession: callbacks.getRuntimePreferencesFromSession,
        viewportReveal: callbacks.viewportReveal || null,
        handleStopActiveStream,
        handleSend,
        handleComposerPaste,
        handleInteractiveOptionSelect,
        handleInteractiveOtherConfirm,
        handleInteractiveSubmit,
        handleInteractiveSkip,
        handleInteractiveSkipQuestion,
        handleInteractiveSkipAll,
        handleInteractiveOtherInputChange,
        handleCopyMessage,
        handleElaborateMessage,
        handleRegenerateMessage,
        handleBranchMessage: (...args) => messageBranchController?.branchFromMessage?.(...args) ?? Promise.resolve(null),
        // F2 edit handlers, wired from the locally-constructed messageEditController above.
        handleEditMessage: (...args) => messageEditController?.enterEdit?.(...args) ?? false,
        handleEditCommit: () => messageEditController?.commitEdit?.() ?? Promise.resolve(null),
        handleEditCancel: () => { messageEditController?.cancelEdit?.(); },
        reportError: callbackOr('reportError', () => null),
        guardComposerTextPaste: callbackOr('guardComposerTextPaste', () => ({ allowed: true })),
        handleCodeReviewAction: callbackOr('handleCodeReviewAction', () => Promise.resolve()),
        handleOpenChangeDiff: callbackOr('handleOpenChangeDiff', () => Promise.resolve(false)),
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
      promptCommands?.refresh()?.catch(() => {});
      addCleanup(() => promptCommands?.dispose());
      addCleanup(() => handoffHandler?.dispose?.());
      addCleanup(() => sendController?.dispose?.());
      addCleanup(() => resumeTurnInteraction?.dispose?.());
      addCleanup(() => messageEditController?.dispose?.());
      addCleanup(() => messageBranchController?.dispose?.());
      addCleanup(() => selectionController?.dispose?.());
      addCleanup(() => bulkActionsController?.dispose?.());
      addCleanup(() => bulkDeleteConfirmDialog?.dispose?.());
      if (sessionContext.paneId === 0) addCleanup(() => { // W1-4c: #sendOutbox is pane 0's view
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
      addCleanup(globalThis.rendererCalendarChatBindings?.bindCalendarChatInteractions?.(dom.chatTimeline, {
        shell: windowRef.jennyShell,
        setActiveView: (...args) => callbacks.setActiveView(...args),
        setHomeCalendarFocusDay: (key) => { state.ui.homeCalendarFocusDay = key; },
        appendClientLog: (...args) => callbacks.appendClientLog(...args),
      }) || (() => {}));
      addCleanup(globalThis.rendererProposalCardActions?.bindProposalCardInteractions?.(dom.chatTimeline, {
        shell: windowRef.jennyShell, appendClientLog: (...args) => callbacks.appendClientLog(...args),
        openSession: (sessionId) => activateWorkspaceSession(sessionId, { mode: 'replace' }),
        retryChildTurn: async (sessionId, messageId) => { // F3b: the child's own Retry turn, in the child
          await activateWorkspaceSession(sessionId, { mode: 'replace' });
          return state.currentSessionId === sessionId ? handleRegenerateMessage(messageId, { failureRetry: true }) : null;
        },
        isPrimarySession: (id) => isPrimarySessionId(state.sessions, id), launchPermissionEnabled: () => state.features?.featureFlags?.primary_launch_permission !== false,
      }) || (() => {}));
      addCleanup(globalThis.rendererSessionMessageRows?.bindSessionMessageCards?.(dom.chatTimeline, {
        openSession: (sessionId) => activateWorkspaceSession(sessionId, { mode: 'replace' }),
      }) || (() => {}));
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
      sendOutboxActions: controllers.sendOutboxActions, streamHandler,
      onPaneSessionChanged: (sessionId) => selectionController?.onSessionSwitch?.(sessionId), // P2: the pane composition, on a layout session change
      bind,
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
