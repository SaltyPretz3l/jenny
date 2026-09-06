(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _sendFlowHelpers = typeof globalThis !== 'undefined' && globalThis.rendererSendFlowHelpers
    ? globalThis.rendererSendFlowHelpers
    : typeof require === 'function'
      ? require('./renderer-send-flow-helpers')
      : null;
  if (!_sendFlowHelpers
    || typeof _sendFlowHelpers.adoptPersistedUserMessageId !== 'function'
    || typeof _sendFlowHelpers.clipSessionTitle !== 'function'
    || typeof _sendFlowHelpers.createOptimisticSessionId !== 'function'
    || typeof _sendFlowHelpers.createSendQueueGuards !== 'function'
    || typeof _sendFlowHelpers.createTraceToken !== 'function'
    || typeof _sendFlowHelpers.cloneJsonLike !== 'function'
    || typeof _sendFlowHelpers.cloneQueuedAttachments !== 'function'
    || typeof _sendFlowHelpers.buildOptimisticAttachmentMetadata !== 'function'
    || typeof _sendFlowHelpers.buildDurableFailureMessage !== 'function'
    || typeof _sendFlowHelpers.buildSendFailureMetadata !== 'function'
    || typeof _sendFlowHelpers.summarizeDurableFailurePreview !== 'function'
    || typeof _sendFlowHelpers.getQueuedSendFromState !== 'function'
    || typeof _sendFlowHelpers.getOrCreateSendOutbox !== 'function'
    || typeof _sendFlowHelpers.clearQueuedSendInState !== 'function'
    || typeof _sendFlowHelpers.stashQueuedSendInState !== 'function'
    || typeof _sendFlowHelpers.annotateUserSendFailureInStore !== 'function'
    || typeof _sendFlowHelpers.reconcileAcceptedRegenerate !== 'function'
    || typeof _sendFlowHelpers.rejectBusyPluginCommand !== 'function'
    || typeof _sendFlowHelpers.resolveMessageCopyText !== 'function') {
    throw new Error('renderer-send-flow-helpers must load before renderer/chat/renderer-send-utils.js');
  }
  const {
    adoptPersistedUserMessageId,
    annotateUserSendFailureInStore,
    buildDurableFailureMessage,
    buildOptimisticAttachmentMetadata,
    buildSendFailureMetadata,
    clearQueuedSendInState,
    cloneJsonLike,
    cloneQueuedAttachments,
    clipSessionTitle,
    createOptimisticSessionId,
    createSendQueueGuards,
    createTraceToken,
    getQueuedSendFromState,
    getOrCreateSendOutbox,
    reconcileAcceptedRegenerate,
    resolveMessageCopyText,
    stashQueuedSendInState,
    summarizeDurableFailurePreview,
  } = _sendFlowHelpers;
  const _sendMessageActions = typeof globalThis !== 'undefined' && globalThis.rendererSendMessageActions
    ? globalThis.rendererSendMessageActions
    : typeof require === 'function'
      ? require('./renderer-send-message-actions')
      : null;
  if (!_sendMessageActions || typeof _sendMessageActions.createSendMessageActions !== 'function') {
    throw new Error('renderer-send-message-actions must load before renderer/chat/renderer-send-utils.js');
  }
  const { createSendMessageActions } = _sendMessageActions;
  const _navigationIntentUtils = (typeof globalThis !== 'undefined' && globalThis.rendererNavigationIntent)
    || (typeof require === 'function' ? require('./renderer-navigation-intent') : null);
  if (!_navigationIntentUtils || typeof _navigationIntentUtils.getOrCreateNavigationIntentOwner !== 'function') {
    throw new Error('renderer-navigation-intent must load before renderer/chat/renderer-send-utils.js');
  }
  const _sendOutboxDispatch = (typeof globalThis !== 'undefined' && globalThis.rendererSendOutboxDispatch)
    || (typeof require === 'function' ? require('./renderer-send-outbox-dispatch') : null);
  if (!_sendOutboxDispatch || typeof _sendOutboxDispatch.createQueuedSendDispatcher !== 'function') {
    throw new Error('renderer-send-outbox-dispatch must load before renderer/chat/renderer-send-utils.js');
  }
  const _sendPreflightUtils = typeof globalThis !== 'undefined' && globalThis.rendererSendPreflightUtils
    ? globalThis.rendererSendPreflightUtils
    : typeof require === 'function'
      ? require('./renderer-send-preflight-utils')
      : null;
  if (!_sendPreflightUtils || typeof _sendPreflightUtils.createSendPreflightUtils !== 'function') {
    throw new Error('renderer-send-preflight-utils must load before renderer/chat/renderer-send-utils.js');
  }
  const { createSendPreflightUtils } = _sendPreflightUtils;
  const _sendCompletionUtils = typeof globalThis !== 'undefined' && globalThis.rendererSendCompletion
    ? globalThis.rendererSendCompletion
    : typeof require === 'function'
      ? require('./renderer-send-completion')
      : null;
  if (!_sendCompletionUtils || typeof _sendCompletionUtils.createSendCompletion !== 'function') {
    throw new Error('renderer-send-completion must load before renderer/chat/renderer-send-utils.js');
  }
  const { createSendCompletion } = _sendCompletionUtils;
  const _sendReceiptUtils = typeof globalThis !== 'undefined' && globalThis.rendererSendReceipts
    ? globalThis.rendererSendReceipts
    : typeof require === 'function'
      ? require('./renderer-send-receipts')
      : null;
  if (!_sendReceiptUtils || typeof _sendReceiptUtils.createSendReceiptStore !== 'function') {
    throw new Error('renderer-send-receipts must load before renderer/chat/renderer-send-utils.js');
  }
  const { createSendReceiptStore } = _sendReceiptUtils;
  const _skillSlashCommands = (typeof globalThis !== 'undefined' && globalThis.rendererSkillSlashCommands)
    || (typeof require === 'function' ? require('./renderer-skill-slash-commands') : null);
  if (!_skillSlashCommands || typeof _skillSlashCommands.createSendSlashDispatch !== 'function') {
    throw new Error('renderer-skill-slash-commands must load before renderer/chat/renderer-send-utils.js');
  }
  const _asyncFenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererAsyncFence) ||
    (typeof require === 'function' ? require('../shared/async-fence') : null);
  if (!_asyncFenceUtils || typeof _asyncFenceUtils.createDisposalFence !== 'function') {
    throw new Error('rendererAsyncFence must load before renderer/chat/renderer-send-utils.js');
  }
  const PILL_SOURCES = (typeof globalThis !== 'undefined'
    && globalThis.rendererTurnStatusPill
    && globalThis.rendererTurnStatusPill.SOURCES)
    || { TURN_SENDING: 'turn.sending' };

  const FOLLOW_UP_ACTION_BUSY_REASON = 'Wait for the current response to finish before trying that.';
  const FOLLOW_UP_AUTH_BLOCKED_REASON = 'Sign in before trying that.';
  const FOLLOW_UP_BACKEND_NOT_READY_REASON = 'Wait for Jenny to finish connecting before trying that.';
  // Atomic edit failures keep the inline editor open; this notice points the
  // user back to that retained retry surface instead of the ordinary composer.
  const EDIT_REGENERATE_FAILURE_MESSAGE =
    'Your edit was not applied because the replacement response could not start. Retry from the open editor.';


  function createSendController(deps) {
    const { state } = deps;
    const sendOutbox = getOrCreateSendOutbox(state, {
      releaseAssets: (assetPaths) => window.jennyShell?.attachments?.releaseAssets?.(assetPaths),
    });
    const navigationIntent = _navigationIntentUtils.getOrCreateNavigationIntentOwner(state);
    const multiStreamController = deps.multiStreamController || globalThis.rendererMultiStreamController || null;
    const thinkingIndicator = deps.thinkingIndicator || null;
    const disposalFence = _asyncFenceUtils.createDisposalFence();

    const {
      INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_IDLE,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      TOAST_SOURCE,
    } = deps.constants;

    const { chatInput } = deps.dom;
    const compactionCoordinator = deps.compactionCoordinator || null;

    const {
      getActiveSession,
      getPendingQuestionBatch,
      normalizePendingQuestionBatch,
      shouldForceInteractiveGuardrail,
      getInteractiveSequenceState,
      clearInteractiveDraft,
      patchSessionSummary,
      getCurrentRuntimePreferences,
      getCurrentVisibleMessages,
      getCurrentSessionMessages,
      getSessionTurnEventState = function noopGetSessionTurnEventState() { return { turnEvents: [] }; },
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      resolveSessionId,
      buildAttachmentBudget,
      resetAttachmentQueue,
      showToastMessage,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      setTurnStatusPill = () => {},
      clearTurnStatusPill = () => {},
      showComposerActionError,
      renderComposerState,
      renderAll = () => {},
      renderMessages = () => {},
      renderSessions = () => {},
      renderHeader = () => {},
      syncComposerInputHeight,
      syncComposerVisualState,
      handleSlashCommandSelection = () => false,
      setFollowLatest,
      appendClientLog,
      refreshSessionSummaries,
      activateWorkspaceSession = async (sessionId) => { state.currentSessionId = sessionId; },
      thinkingController,
      optimisticAppend,
      flushBufferedStreamEvents,
      dropBufferedStreamEvents,
      isSendBusy,
      isSessionStreaming,
      hasPendingToolApprovalForSession,
      getCurrentMessageById,
      getElaboratePrompt,
      getLatestReplyAssistantMessageId,
      resolveRegenerateRequest,
      showCopyFeedback,
      upsertSessionSummary,
      removeSessionState,
      rekeySessionState,
      attachPendingOriginToSession = () => '',
      rekeySessionOrigin = () => '',
      onUserSendStarted = () => {},
      getToolPreferences = () => ({}),
      setChatSendLifecycle = () => 'idle',
      clearChatSendLifecycle = () => false,
      moveChatSendLifecycle = () => 'idle',
      clearProjectionContextCacheForSession = () => {},
      // Background Effects v3 S5 W1b: cancel impulse, fired only once the
      // stop-stream request has proceeded past the cancel-refusal gate.
      publishCancelImpulse = () => {},
    } = deps.callbacks;

    const { slashCommandRegistry } = deps;
    function markStartupAudit(name, details = {}) {
      try {
        globalThis.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best effort only.
      }
    }

    function getCurrentSessionId() {
      return String(state.currentSessionId || '').trim();
    }

    function startOptimisticSendIndicator() {
      if (thinkingIndicator && typeof thinkingIndicator.startIndicator === 'function') {
        const displayState = typeof thinkingIndicator.getDisplayState === 'function'
          ? thinkingIndicator.getDisplayState()
          : null;
        if (!displayState || displayState.mode === 'idle') {
          thinkingIndicator.startIndicator('thinking');
        }
      }
      setTurnStatusPill(PILL_SOURCES.TURN_SENDING, {
        message: 'Sending\u2026',
        tone: 'pending',
        spinner: true,
        badgeText: 'Sending',
      });
    }

    function clearOptimisticSendIndicator({ resetThinking = false } = {}) {
      clearTurnStatusPill(PILL_SOURCES.TURN_SENDING);
      if (resetThinking && thinkingIndicator && typeof thinkingIndicator.resetIndicator === 'function') {
        thinkingIndicator.resetIndicator();
      }
    }

    // Preflight-state lifecycle lives in a sibling module (size cap); wired
    // with this closure's controller/state/log so behavior is unchanged.
    const {
      beginSessionPreflight,
      moveSessionPreflight,
      resolveSessionPreflight,
      clearSessionPreflight,
    } = createSendPreflightUtils({ state, multiStreamController, appendClientLog });

    function resolveFollowUpActionBlock() {
      const currentSessionId = getCurrentSessionId();
      if (isSessionBusy(currentSessionId) || hasPendingToolApprovalForSession(currentSessionId)) {
        return {
          blocked: true,
          reason: FOLLOW_UP_ACTION_BUSY_REASON,
        };
      }
      if (!state.auth?.authenticated) {
        return {
          blocked: true,
          reason: FOLLOW_UP_AUTH_BLOCKED_REASON,
        };
      }
      if (!['ready', 'model_unavailable'].includes(String(state.backend?.phase || '').trim())) {
        return {
          blocked: true,
          reason: FOLLOW_UP_BACKEND_NOT_READY_REASON,
        };
      }
      return {
        blocked: false,
        reason: '',
      };
    }

    // Queued-send state helpers (sibling lift-out); bind to this closure's state.
    const getQueuedSend = (sessionId) => getQueuedSendFromState(state, sessionId);
    const clearQueuedSendForSession = (sessionId) => clearQueuedSendInState(state, sessionId);
    const stashQueuedSendForSession = (sessionId, payload) => stashQueuedSendInState(state, sessionId, payload);

    // Dock-scoped approval-steer (ide_chat_dock, plan §17 decision 7): a
    // queued send drains despite a pending approval while the Workspace dock
    // is live. Kept here (not in the queue-guards sibling) since two other
    // call sites below also need this exact definition directly.
    function isDockApprovalSteerActive() {
      return state.ui?.activeView === 'ide'
        && (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state) === true;
    }

    // isSessionBusy / restoreQueuedSendDraft / canQueueForSession: sibling
    // lift-out (renderer-send-flow-helpers.js) for the 1015-line ceiling.
    const { isSessionBusy, restoreQueuedSendDraft, canQueueForSession } = createSendQueueGuards({
      state, multiStreamController, isSessionStreaming, hasPendingToolApprovalForSession,
      getPendingQuestionBatch, isDockApprovalSteerActive, chatInput,
      syncComposerInputHeight, syncComposerVisualState, renderComposerState, renderMessages,
    });

    const messageStoreBinding = { getSessionMessages, setSessionMessages };
    const annotateOptimisticUserSendFailure = (sessionId, messageId, metadata) =>
      annotateUserSendFailureInStore(messageStoreBinding, sessionId, messageId, metadata);
    const discardOptimisticUserSend = (sessionId, messageId) => {
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) return false;
      const messages = getSessionMessages(sessionId);
      const next = (Array.isArray(messages) ? messages : []).filter(
        (message) => String(message?.id || '').trim() !== normalizedMessageId
      );
      if (next.length === messages.length) return false;
      setSessionMessages(sessionId, next, `session_${sessionId}`);
      return true;
    };
    const adoptPersistedUserMessageIdInStore = (sessionId, optimisticId, persistedId) =>
      adoptPersistedUserMessageId(messageStoreBinding, sessionId, optimisticId, persistedId);
    const createReceiptStore = typeof deps.createSendReceiptStore === 'function'
      ? deps.createSendReceiptStore
      : createSendReceiptStore;
    const sendReceipts = createReceiptStore({
      state,
      chatInput,
      getComposerController: () => globalThis.rendererComposerSessionStateController || null,
      releaseAssets: (assetPaths) => window.jennyShell?.attachments?.releaseAssets?.(assetPaths),
      log: appendClientLog,
    });
    const sendCompletion = createSendCompletion({
      state,
      navigationIntent,
      sendReceipts,
      constants: {
        EDIT_REGENERATE_FAILURE_MESSAGE,
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        MAX_INTERACTIVE_ROUNDS: deps.constants.MAX_INTERACTIVE_ROUNDS,
        TOAST_SOURCE,
      },
      callbacks: {
        activateWorkspaceSession,
        appendClientLog,
        clearChatSendLifecycle,
        clearInteractiveDraft,
        clearOptimisticSendIndicator,
        clearSessionPreflight,
        createNormalizedMessage,
        dropBufferedStreamEvents,
        flushBufferedStreamEvents,
        getActiveSession,
        getInteractiveSequenceState,
        getSessionMessages,
        moveChatSendLifecycle,
        moveSessionPreflight,
        multiStreamController,
        patchSessionSummary,
        refreshSessionSummaries,
        rekeySessionOrigin,
        rekeySessionState,
        renderComposerState,
        renderHeader,
        renderMessages,
        renderSessions,
        resetAttachmentQueue,
        resolveSessionId,
        resolveSessionPreflight,
        setChatSendLifecycle,
        setSessionMessages,
        showComposerActionError,
        showToastMessage,
        syncComposerInputHeight,
        syncComposerVisualState,
      },
      helpers: {
        adoptPersistedUserMessageIdInStore,
        annotateOptimisticUserSendFailure,
        discardOptimisticUserSend,
        buildDurableFailureMessage,
        buildSendFailureMetadata,
        summarizeDurableFailurePreview,
      },
    });
    const skillsBridge = window.jennyShell?.skills || null;
    const sendSlashDispatch = _skillSlashCommands.createSendSlashDispatch({
      state, registry: slashCommandRegistry, chatInput, renderComposerState,
      syncComposerInputHeight, syncComposerVisualState,
      selectSlashCommand: handleSlashCommandSelection,
      submitPrompt: (nextPrompt) => startPromptSend(nextPrompt),
      getSkillsState: skillsBridge?.getState ? () => skillsBridge.getState() : null,
      onSkillsChanged: skillsBridge?.onChanged ? (listener) => skillsBridge.onChanged(listener) : null,
      log: appendClientLog,
    });

    async function startPromptSend(prompt, options) {
      let settings = options || {};
      let slashDispatch = sendSlashDispatch.dispatch(prompt, settings);
      if (slashDispatch && typeof slashDispatch.then === 'function') slashDispatch = await slashDispatch;
      if (slashDispatch.handled) return null;
      prompt = slashDispatch.prompt;
      settings = slashDispatch.settings;
      const pendingBatch = getPendingQuestionBatch();
      const usesReplayImageAttachments = Array.isArray(settings.replayImageAttachments);
      const attachmentBudget = buildAttachmentBudget(
        usesReplayImageAttachments ? settings.replayImageAttachments : state.attachments.queued
      );
      const promptBearingAttachments = attachmentBudget.accepted.filter(
        (entry) => String(entry?.kind || '').trim() !== 'audio'
      );
      const preserveComposerDraft = Object.prototype.hasOwnProperty.call(settings, 'preserveComposerDraft')
        ? settings.preserveComposerDraft === true
        : usesReplayImageAttachments;
      const preserveCurrentSessionOnDispatch = settings.preserveCurrentSessionOnDispatch === true;
      // commitEdit keeps its own editor draft alive until this atomic command
      // succeeds, so the ordinary composer draft remains untouched on failure.
      const isEditRegenerate = Boolean(String(settings.editedMessageId || '').trim());
      const normalizedInteractiveResponse = normalizePendingQuestionBatch(settings.interactiveResponse?.batch_snapshot)
        ? {
            ...settings.interactiveResponse,
            batch_snapshot: normalizePendingQuestionBatch(settings.interactiveResponse.batch_snapshot),
          }
        : null;
      const interactiveGuardrailFallback =
        Boolean(settings.interactiveGuardrailFallback) ||
        shouldForceInteractiveGuardrail(normalizedInteractiveResponse?.batch_snapshot);
      const audioOnlyDraftBlocked =
        !String(prompt || '').trim()
        && !normalizedInteractiveResponse
        && !promptBearingAttachments.length
        && attachmentBudget.accepted.some(
          (entry) => String(entry?.kind || '').trim() === 'audio'
        );
      if (audioOnlyDraftBlocked && ['ready', 'model_unavailable'].includes(state.backend.phase) && state.auth.authenticated) {
        // Audio clips carry no prompt content (voice transcription was
        // removed), so a clip-only draft has nothing to send. Say so
        // instead of silently ignoring the click/Enter.
        setComposerStatusNotice('Audio clips need a typed message — add some text before sending.', {
          owner: 'send:audio_only',
          tone: 'warning',
        });
        renderComposerState();
        appendClientLog('INFO', 'chat.audio_only_send_blocked', {
          attachmentCount: attachmentBudget.accepted.length,
        });
        return null;
      }
      if (
        (!String(prompt || '').trim() && !normalizedInteractiveResponse && !promptBearingAttachments.length)
        || !['ready', 'model_unavailable'].includes(state.backend.phase)
        || !state.auth.authenticated
      ) {
        return null;
      }
      const requestedSessionId = String(settings.sessionIdOverride || state.currentSessionId || '').trim();
      if (compactionCoordinator?.isPending?.(requestedSessionId)) {
        setComposerStatusNotice('Compacting context…', { owner: `compaction:${requestedSessionId}`, tone: 'pending', spinner: true });
        renderComposerState();
        appendClientLog('INFO', 'chat.send_blocked', { sessionId: requestedSessionId, reason: 'session_compacting' });
        return { rejected: true, reason: 'session_compacting', sessionId: requestedSessionId };
      }
      compactionCoordinator?.clearSettled?.(requestedSessionId);
      clearComposerStatusNotice();
      const requestedSession = requestedSessionId
        ? (state.sessions.find((session) => String(session?.id || '').trim() === requestedSessionId) || null)
        : null;
      const runModeState = globalThis.rendererComposerV2State || (typeof require === 'function' ? require('./renderer-composer-v2-state') : null);
      const runtimePreferences = runModeState.resolveSendRuntimePreferences({
        snapshot: settings.runtimePreferencesSnapshot, session: requestedSession, current: getCurrentRuntimePreferences, clone: cloneJsonLike,
      });
      const visionGate = globalThis.rendererComposerVisionGate?.evaluateComposerVisionGate?.({ state, runtimePreferences });
      if (visionGate?.blocked && !usesReplayImageAttachments && !isEditRegenerate && !normalizedInteractiveResponse) {
        setComposerStatusNotice(visionGate.notice, { owner: 'attachments.vision', tone: visionGate.tone, at: 0 }); renderComposerState(); return null;
      }
      const requestedSessionBusy = isSessionBusy(requestedSessionId);
      const pluginCommandInvocation = settings.pluginCommandInvocation && typeof settings.pluginCommandInvocation === 'object' ? settings.pluginCommandInvocation : null;
      const rawSkillInvocation = (settings.skillInvocation && typeof settings.skillInvocation === 'object' ? settings.skillInvocation : null) || (settings.outboxDispatch ? getQueuedSend(requestedSessionId)?.meta?.skillInvocation || null : null);
      const skillInvocation = rawSkillInvocation && typeof rawSkillInvocation.id === 'string' ? Object.fromEntries(['id', 'name', 'scope', 'command'].filter((key) => typeof rawSkillInvocation[key] === 'string').map((key) => [key, rawSkillInvocation[key]])) : null;
      // Dock-scoped approval-steer (see isDockApprovalSteerActive above): once a
      // turn's stream has actually gone terminal (requestedSessionBusy false), a
      // pending-approval entry still on state.pendingToolApprovals for this
      // session is stale bookkeeping, not a live gate — approvals only block a
      // session while its stream is mid-flight, so busy is the true signal.
      // Ungating this let a stale flag strand the queued-send drain (below)
      // exactly like it must not strand a fresh dock send.
      if (requestedSessionBusy || (hasPendingToolApprovalForSession(requestedSessionId) && !isDockApprovalSteerActive())) {
        const commandRefusal = _sendFlowHelpers.rejectBusyPluginCommand({ invocation: pluginCommandInvocation, sessionId: requestedSessionId, setNotice: setComposerStatusNotice, render: renderComposerState, log: appendClientLog });
        if (commandRefusal) return commandRefusal;
        if (
          canQueueForSession(requestedSessionId)
          && (String(prompt || '').trim() || attachmentBudget.accepted.length)
        ) {
          // Snapshot the @-mention + active-file context the user is looking at
          // NOW, so a later dispatchQueuedSendForSession does not re-collect
          // against an already-cleared composer / a different focused file.
          // The stash + composer clear stay fully SYNCHRONOUS (no await before
          // them): the stream-terminal handler dispatches queued sends the moment
          // a stream settles, so yielding before the stash would let it run
          // getQueuedSend() and miss this entry, stranding the send. Mention PATHS
          // + the active-file slice are captured synchronously; the async
          // mention-content read is backfilled onto the queued entry when it
          // settles (guarded against dispatch/clear/replacement meanwhile).
          const queuedAccepted = Array.isArray(attachmentBudget.accepted) ? attachmentBudget.accepted : [];
          const queuedAttachedPaths = queuedAccepted.map((e) => String(e?.path || e?.assetPath || e?.absolute_path || e?.absolutePath || '').trim()).filter(Boolean);
          const queuedAttachedNames = queuedAccepted.map((e) => String(e?.displayName || e?.promptName || '').trim()).filter(Boolean);
          const queuedMentionPaths = window.rendererIdeMentionAutocomplete?.collectMentionPaths?.() || [];
          const queuedMentionContentsPromise = Promise.resolve(
            window.rendererIdeMentionAutocomplete?.collectMentionContents?.() || []
          );
          // Dedupe the active-file slice against ATTACHMENTS only here (synchronous
          // + known now). The @-mention dedupe is applied in the backfill below
          // against the mentions that actually RESOLVED — matching the live send
          // path, which dedupes against resolved mentions, not merely requested
          // ones. (Deduping against requested paths would drop the slice for a
          // focused file whose @-mention read fails, losing it from both snapshots.)
          const queuedActiveFileContext = window.rendererIdeActiveFileContext?.readActiveFileContextForTurn?.({
            mentionedPaths: [],
            attachedPaths: queuedAttachedPaths,
            attachedNames: queuedAttachedNames,
          }) || null;
          const queuedEntry = stashQueuedSendForSession(requestedSessionId, {
            prompt: String(prompt || ''),
            attachments: attachmentBudget.accepted,
            runtimePreferences,
            createdAt: Date.now(),
            status: 'capturing_context',
            sourceRevision: Number(state.composerSessionState?.get?.(requestedSessionId)?.generation || 0),
            targetSessionIncarnation: String(
              requestedSession?.session_incarnation || requestedSession?.sessionIncarnation || ''
            ),
            meta: {
              mentionContentsSnapshot: [],
              activeFileContextSnapshot: queuedActiveFileContext, skillInvocation,
            },
          });
          if (!queuedEntry) {
            setComposerStatusNotice('The send outbox is full. Cancel or send an existing item first.', {
              owner: 'send:outbox_full', tone: 'warning',
            });
            renderComposerState();
            return null;
          }
          if (queuedActiveFileContext?.path) {
            window.rendererIdeActiveFileContext?.markTurnAccepted?.(queuedActiveFileContext.path);
          }
          // Capture the stored entry by reference so the async backfill below can
          // target it by object IDENTITY — robust against a dispatch, clear, or a
          // newer queued send (which all replace/remove the Map entry), where a
          // createdAt timestamp could collide at ms resolution.
          chatInput.value = '';
          state.attachments.queued = [];
          syncComposerInputHeight();
          syncComposerVisualState();
          renderComposerState();
          appendClientLog('INFO', 'chat.queue_created', {
            sessionId: requestedSessionId,
            attachmentCount: attachmentBudget.accepted.length,
            mentionCount: queuedMentionPaths.length,
          });
          // Backfill the resolved @-mention contents once the (time-boxed) reads
          // settle, and apply the resolved-mention dedupe to the active-file slice.
          sendOutbox.settleContextCapture(queuedEntry, queuedMentionContentsPromise.then((contents) => {
            const capturedContents = Array.isArray(contents) ? contents : [];
            let activeFileContextSnapshot = queuedActiveFileContext;
            const activeSnapshot = activeFileContextSnapshot;
            if (activeSnapshot && activeSnapshot.path) {
              const normalizedActive = String(activeSnapshot.path).trim().replace(/\\/g, '/');
              const resolvedPaths = capturedContents.map((entry) => String((entry && entry.path) || '').trim().replace(/\\/g, '/'));
              if (resolvedPaths.indexOf(normalizedActive) !== -1) {
                activeFileContextSnapshot = null;
              }
            }
            return { mentionContentsSnapshot: capturedContents, activeFileContextSnapshot };
          }));
          return {
            queued: true,
            sessionId: requestedSessionId,
          };
        }
        return null;
      }
      if (attachmentBudget.skipped.length) {
        showToastMessage(
          `${attachmentBudget.skipped.length} attachment${attachmentBudget.skipped.length === 1 ? '' : 's'} skipped because the session budget is full.`,
          {
            title: 'Attachment Budget Reached',
            tone: 'warning',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:budget`,
          }
        );
      }
      const currentMessages = getCurrentVisibleMessages();
      const shouldAnimateActivation = currentMessages.length === 0;
      const normalizedPrompt = String(prompt || '').trim();
      const effectivePrompt = interactiveGuardrailFallback
        ? [
            normalizedPrompt,
            normalizedPrompt.includes(INTERACTIVE_GUARDRAIL_PROMPT) ? '' : INTERACTIVE_GUARDRAIL_PROMPT,
          ].filter(Boolean).join('\n\n')
        : String(prompt || '');
      const hasExplicitVisiblePrompt = Object.prototype.hasOwnProperty.call(settings, 'visiblePrompt');
      const visiblePrompt = String(hasExplicitVisiblePrompt ? settings.visiblePrompt : prompt).trim();
      const optimisticTitleSource = visiblePrompt || (hasExplicitVisiblePrompt ? '' : normalizedPrompt);
      const pendingBatchSnapshot = pendingBatch && normalizedInteractiveResponse ? pendingBatch : null;
      const acceptedAttachments = cloneQueuedAttachments(attachmentBudget.accepted);
      const attachedPaths = acceptedAttachments.map((e) => String(e?.path || e?.assetPath || e?.absolute_path || e?.absolutePath || '').trim()).filter(Boolean);
      const attachedNames = acceptedAttachments.map((e) => String(e?.displayName || e?.promptName || '').trim()).filter(Boolean);
      const previousSessionId = String(state.currentSessionId || '').trim();
      const optimisticSessionId = requestedSessionId || createOptimisticSessionId();
      const createdOptimisticSession = !requestedSessionId || requestedSession?.local_draft === true;
      const retryPayloadId = String(settings.failedPayloadId || '').trim();
      const retryPayload = retryPayloadId ? sendReceipts.getFailedPayload(retryPayloadId) : null;
      const toolPreferences = cloneJsonLike(getToolPreferences());
      const runModeProjection = typeof runModeState?.projectRunMode === 'function'
        ? runModeState.projectRunMode(runtimePreferences.runMode, { planModeFallback: runtimePreferences.planMode === true })
        : { approvalMode: 'prompt', planMode: runtimePreferences.planMode === true };
      const { approvalMode } = runModeProjection;
      let sendReceipt = sendReceipts.begin({
        sessionId: optimisticSessionId,
        prompt: effectivePrompt,
        visiblePrompt,
        attachments: acceptedAttachments,
        runtimePreferences,
        toolPreferences,
        approvalMode,
        interactiveResponse: normalizedInteractiveResponse,
        pluginCommandInvocation, skillInvocation,
        editedMessageId: String(settings.editedMessageId || '').trim(),
      }, {
        consumeDraft: !preserveComposerDraft,
        restoreOnFailure: settings.restoreDraftOnStartStreamReject !== false,
        recordFailedPayload: settings.recordFailedPayload !== false,
        failedPayloadId: retryPayloadId,
      });
      if (!sendReceipt) return null;
      // A queued send carries a mention-contents snapshot captured at queue time;
      // absent it, resolution starts only after the immutable origin receipt owns
      // the draft and attachments.
      const mentionContentsPromise = Object.prototype.hasOwnProperty.call(settings, 'mentionContentsSnapshot')
        ? Promise.resolve(Array.isArray(settings.mentionContentsSnapshot) ? settings.mentionContentsSnapshot : [])
        : Promise.resolve(window.rendererIdeMentionAutocomplete?.collectMentionContents?.() || []).catch(() => []);
      if (!preserveComposerDraft) syncComposerInputHeight();
      thinkingController.resumeAutoScroll();
      setFollowLatest(true);
      // Send-stay-in-dock (ide_chat_dock): only force the view back to Chat when
      // NO live chat surface is showing — a send typed into the open Workspace
      // dock must not yank the user out of the IDE (falls back flag-off).
      const chatSurfaceLiveForSend = (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
        ?? (state.ui.activeView === 'chat');
      if (!chatSurfaceLiveForSend) {
        appendClientLog('INFO', 'chat.send_view_corrected', {
          previousView: state.ui.activeView,
        });
        state.ui.activeView = 'chat';
      }
      const preflightState = beginSessionPreflight({
        sessionId: optimisticSessionId,
        optimisticSessionId,
        previousSessionId,
        optimisticCreated: createdOptimisticSession,
      });
      setChatSendLifecycle(optimisticSessionId, 'preflight');
      if (pendingBatchSnapshot) {
        patchSessionSummary(createdOptimisticSession ? optimisticSessionId : state.currentSessionId, {
          pending_question_batch: null,
          interactive_sequence_state: interactiveGuardrailFallback
            ? INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED
            : INTERACTIVE_SEQUENCE_IDLE,
          interactive_round_count: pendingBatchSnapshot.round_index,
        });
      }
      if (createdOptimisticSession) {
        const timestamp = new Date().toISOString();
        upsertSessionSummary({
          id: optimisticSessionId,
          title: clipSessionTitle(optimisticTitleSource),
          session_type: 'chat',
          created_at: timestamp,
          updated_at: timestamp,
          message_count: visiblePrompt || acceptedAttachments.length ? 1 : 0,
          last_message_preview: String(visiblePrompt || '').slice(0, 160),
          last_model_used: '',
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          conversation_mode: 'chat',
          pending_question_batch: null,
          interactive_sequence_state: interactiveGuardrailFallback
            ? INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED
            : INTERACTIVE_SEQUENCE_IDLE,
          interactive_round_count: pendingBatchSnapshot?.round_index || 0,
          run_mode: runModeProjection.runMode,
          plan_mode: runModeProjection.planMode,
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality !== false,
            include_memory: runtimePreferences.contextPreferences.includeMemory !== false,
          },
          optimistic_local: true,
          local_draft: false,
        }, { prepend: true });
        state.currentSessionId = optimisticSessionId;
        attachPendingOriginToSession(optimisticSessionId);
        setSessionMessages(optimisticSessionId, getSessionMessages(optimisticSessionId), `session_${optimisticSessionId}`);
        state.ui.animateNextChatActivation = shouldAnimateActivation;
      } else {
        state.ui.animateNextChatActivation = shouldAnimateActivation;
      }
      const operationState = { optimisticUserMessageId: '' };
      if (visiblePrompt || acceptedAttachments.length) {
        operationState.optimisticUserMessageId = isEditRegenerate
          ? String(settings.editedMessageId || '').trim()
          : `user_local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
        if (!isEditRegenerate) {
          optimisticAppend(optimisticSessionId, 'user', visiblePrompt, {
            id: operationState.optimisticUserMessageId,
            attachments: buildOptimisticAttachmentMetadata(acceptedAttachments),
            ...(skillInvocation ? { skill_invocation: skillInvocation } : {}),
          });
        }
        onUserSendStarted({
          sessionId: optimisticSessionId,
          prompt: visiblePrompt,
          attachmentCount: acceptedAttachments.length,
        });
      }
      renderMessages();
      renderSessions();
      renderHeader();
      renderComposerState();
      const optimisticRenderedAtMs = Date.now();
      const localRenderLatencyMs = Math.max(
        optimisticRenderedAtMs - Number(preflightState?.startedAt || optimisticRenderedAtMs),
        0
      );
      appendClientLog('INFO', 'chat.send_optimistic_rendered', {
        sessionId: optimisticSessionId,
        localRenderLatencyMs,
      });
      startOptimisticSendIndicator();
      const sendNavigationToken = navigationIntent.beginOperation('chat.send');

      try {
        const targetSessionId = createdOptimisticSession ? '' : optimisticSessionId;
        const traceId = createTraceToken();
        markStartupAudit('first-chat-send', {
          sessionId: optimisticSessionId,
          model: runtimePreferences.preferredModel,
          reasoningEffort: runtimePreferences.reasoningEffort,
          startupAudit: settings.startupAudit === true,
        });
        // Resolve @-mention contents (captured pre-clear), then read the active-file slice deduped vs the @-mentions that actually resolved + attachments (the reader reads the EDITOR, so reading post-clear is safe).
        const mentionContents = await mentionContentsPromise;
        disposalFence.throwIfDisposed('chat.send');
        // A queued send carries an active-file snapshot captured at queue time;
        // use it (even when null — "no active file then") instead of re-reading
        // whatever editor is focused at dispatch. Absent the snapshot the live
        // send path is unchanged.
        const activeFileContext = Object.prototype.hasOwnProperty.call(settings, 'activeFileContextSnapshot')
          ? (settings.activeFileContextSnapshot || null)
          : (window.rendererIdeActiveFileContext?.readActiveFileContextForTurn?.({
              mentionedPaths: mentionContents.map((entry) => entry && entry.path).filter(Boolean),
              attachedPaths,
              attachedNames,
            }) || null);
        sendReceipt = sendReceipts.seal(sendReceipt, {
          activeFileContext,
          mentionContents,
        }) || sendReceipt;
        const startPayload = {
          sessionId: targetSessionId,
          prompt: effectivePrompt,
          visiblePrompt,
          // CTL-001 anchor reuse: an edit-resend re-anchors the edited durable
          // user message instead of persisting a second copy of the prompt.
          ...(String(settings.editedMessageId || '').trim()
            ? { editedMessageId: String(settings.editedMessageId).trim(), ...(settings.failureRetry === true ? { failureRetry: true } : {}) }
            : {}),
          traceId,
          preferredModel: runtimePreferences.preferredModel,
          reasoningEffort: runtimePreferences.reasoningEffort,
          attachments: acceptedAttachments,
          contextPreferences: runtimePreferences.contextPreferences,
          activeFileContext,
          mentionContents,
          interactiveResponse: normalizedInteractiveResponse,
          interactiveRoundCount: getActiveSession()?.interactive_round_count || 0,
          planMode: runModeProjection.planMode,
          toolPreferences,
          approvalMode,
          clientTiming: {
            send_started_at_ms: Number(preflightState?.startedAt || 0),
            optimistic_rendered_at_ms: optimisticRenderedAtMs,
            local_render_latency_ms: localRenderLatencyMs,
          },
          ...(pluginCommandInvocation ? { pluginCommandInvocation } : {}), ...(skillInvocation?.id ? { skillInvocation: { id: skillInvocation.id } } : {}),
        };
        const chatBridge = window.jennyShell?.chat;
        const startOperation = isEditRegenerate
          ? chatBridge?.editAndRegenerate
          : chatBridge?.startStream;
        if (typeof startOperation !== 'function') {
          throw new Error(
            isEditRegenerate
              ? 'Edit-and-regenerate is unavailable in this app version.'
              : 'Chat start is unavailable in this app version.'
          );
        }
        const result = await startOperation.call(chatBridge, startPayload);
        const completed = await sendCompletion.completeAcceptedSend(result, {
          activeFileContext,
          activeFileContextController: window.rendererIdeActiveFileContext,
          chatBridge,
          createdOptimisticSession,
          interactiveGuardrailFallback,
          isEditRegenerate,
          normalizedInteractiveResponse,
          operationState,
          optimisticSessionId,
          pendingBatchSnapshot,
          preflightState,
          preserveCurrentSessionOnDispatch,
          previousSessionId,
          sendNavigationToken,
          sendReceipt,
          settings,
        });
        sendSlashDispatch.clearAccepted(completed, skillInvocation, settings);
        return completed;
      } catch (error) {
        return await sendCompletion.completeFailedSend(error, {
          chatBridge: window.jennyShell?.chat,
          chatInput,
          createdOptimisticSession,
          isEditRegenerate,
          isOutboxDispatch: settings.outboxDispatch === true,
          operationState,
          optimisticSessionId,
          pendingBatchSnapshot,
          preflightState,
          previousSessionId,
          sendNavigationToken,
          sendReceipt,
          settings,
          visiblePrompt,
        });
      } finally {
        sendCompletion.finalizeSend();
      }
    }

    function getFailedPayloadRetryAvailability(payloadId) {
      const availability = sendReceipts.getRetryAvailability(payloadId);
      if (!availability.available) return availability;
      const payload = sendReceipts.getFailedPayload(payloadId);
      if (!payload || !payload.sessionId) {
        return { available: false, reason: 'The original failed payload has no destination chat.' };
      }
      return availability;
    }

    function dismissFailureMarkerForPayload(sessionId, payloadId) {
      const normalizedPayloadId = String(payloadId || '').trim();
      if (!normalizedPayloadId) return false;
      const messages = getSessionMessages(sessionId);
      let changed = false;
      const next = (Array.isArray(messages) ? messages : []).map((message) => {
        if (String(message?.send_failure?.payload_id || '').trim() !== normalizedPayloadId
          || message.send_failure.dismissed === true) return message;
        changed = true;
        return { ...message, send_failure: { ...message.send_failure, dismissed: true } };
      });
      if (changed) setSessionMessages(sessionId, next, `session_${sessionId}`);
      return changed;
    }

    async function retryFailedPayload(payloadId) {
      const availability = getFailedPayloadRetryAvailability(payloadId);
      if (!availability.available) return null;
      const payload = sendReceipts.getFailedPayload(payloadId);
      if (isSessionBusy(payload.sessionId)) {
        showComposerActionError(new Error('Wait for the current response to finish before retrying.'), 'Retry Unavailable');
        return null;
      }
      const result = await startPromptSend(payload.prompt, {
        visiblePrompt: payload.visiblePrompt,
        sessionIdOverride: payload.sessionId,
        runtimePreferencesSnapshot: payload.runtimePreferences,
        replayImageAttachments: payload.attachments,
        preserveComposerDraft: true,
        preserveCurrentSessionOnDispatch: getCurrentSessionId() !== payload.sessionId,
        restoreDraftOnStartStreamReject: false,
        mentionContentsSnapshot: payload.mentionContents || [],
        activeFileContextSnapshot: payload.activeFileContext || null,
        interactiveResponse: payload.interactiveResponse || null,
        pluginCommandInvocation: payload.pluginCommandInvocation || null, skillInvocation: payload.skillInvocation || null,
        failedPayloadId: payload.id,
      });
      const retryDidNotStart = !result || result.rejected === true
        || result.queued === true || result.failed === true;
      if (!retryDidNotStart && String(result.streamId || '').trim()
        && dismissFailureMarkerForPayload(payload.sessionId, payload.id)) {
        renderMessages();
      }
      return result;
    }

    function dismissFailedPayload(payloadId) {
      return sendReceipts.dismissFailedPayload(payloadId);
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      sendSlashDispatch.dispose();
      dispatchQueuedSendForSession?.dispose?.();
      sendReceipts.dispose();
      sendOutbox.dispose?.();
    }

    async function handleStopActiveStream(sessionIdInput) { // session-scoped callers (lockdown) share the Stop hold protocol
      const activeSessionId = (typeof sessionIdInput === 'string' && sessionIdInput.trim()) || getCurrentSessionId();
      const activeStreamId = String(
        multiStreamController?.getActiveStreamIdForCancel(activeSessionId) || ''
      ).trim();
      if (!activeStreamId) {
        return null;
      }
      appendClientLog('INFO', 'chat.cancel_requested', { streamId: activeStreamId, sessionId: activeSessionId });
      // Hold the drain BEFORE the round-trip: a cancelled terminal that lands
      // first must restore the queued entry to the composer, not send it.
      const queuedAtStop = getQueuedSend(activeSessionId) || null;
      if (queuedAtStop) dispatchQueuedSendForSession.holdNextDispatch(activeSessionId, activeStreamId);
      const cancelResult = await window.jennyShell.chat.cancelStream(activeStreamId);
      // CTL-009: a refused cancel (stream already finished/unknown by the time
      // this round-trip landed) is a no-op — don't report the success shape
      // that drives UI state for a cancellation that never happened. The
      // stream had ended, so its terminal drain runs as normal (hold released).
      // Refusal shape owned by isCancelStreamRefused.
      if (multiStreamController.isCancelStreamRefused(cancelResult)) {
        appendClientLog('WARN', 'chat.cancel_refused', { streamId: activeStreamId, sessionId: activeSessionId });
        dispatchQueuedSendForSession.releaseHold(activeSessionId, activeStreamId);
        return null;
      }
      // The terminal may already have restored the head entry itself;
      // restoring whatever is queued NOW would act on the next entry and park
      // it as needs_review. Only the entry queued when Stop was pressed is ours.
      const queuedAfterCancel = getQueuedSend(activeSessionId) || null;
      if (queuedAtStop && queuedAfterCancel?.id === queuedAtStop.id && getCurrentSessionId() === activeSessionId) {
        dispatchQueuedSendForSession.releaseHold(activeSessionId, activeStreamId);
        restoreQueuedSendDraft(activeSessionId);
      }
      // No stream payload exists at the cancel site — omit timeStamp so the
      // manager stamps the impulse with its own monotonic clock.
      publishCancelImpulse({ sessionId: activeSessionId, streamId: activeStreamId });
      return { streamId: activeStreamId, sessionId: activeSessionId };
    }

    const dispatchQueuedSendForSession = _sendOutboxDispatch.createQueuedSendDispatcher({
      sendOutbox, getQueuedSend, isSessionBusy, hasPendingToolApprovalForSession,
      isDockApprovalSteerActive, startPromptSend, renderComposerState, renderSessions,
      appendClientLog,
    });

    const messageActions = createSendMessageActions({
      appendClientLog,
      showComposerActionError,
      showCopyFeedback,
      getCurrentMessageById,
      getCurrentSessionMessages,
      getLatestReplyAssistantMessageId,
      getElaboratePrompt,
      resolveRegenerateRequest,
      resolveMessageCopyText,
      resolveFollowUpActionBlock,
      getCurrentSessionId,
      reconcileAcceptedRegenerate: (payload) => reconcileAcceptedRegenerate(payload, {
        getSessionMessages, setSessionMessages, patchSessionSummary,
        clearProjectionContextCacheForSession, renderAll, appendClientLog,
      }),
      startPromptSend,
    });
    const {
      handleElaborateMessage,
      handleRegenerateMessage,
      handleCopyMessage,
    } = messageActions;

    return {
      startPromptSend,
      handleStopActiveStream,
      getQueuedSend,
      clearQueuedSendForSession,
      stashQueuedSendForSession,
      restoreQueuedSendDraft,
      dispatchQueuedSendForSession,
      handleElaborateMessage,
      handleRegenerateMessage,
      handleCopyMessage,
      retryFailedPayload,
      getFailedPayloadRetryAvailability,
      dismissFailedPayload,
      dispose,
    };
  }

  return { createSendController };
});
