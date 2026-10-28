(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  // Load-order guard: each sibling module (browser global, else require) must
  // already be loaded and expose every function this file takes from it.
  function need(mod, keys, name) {
    if (!mod || keys.some((key) => typeof mod[key] !== 'function')) {
      throw new Error(`${name} must load before renderer/chat/renderer-send-utils.js`);
    }
    return mod;
  }
  const canRequire = typeof require === 'function';
  const {
    adoptPersistedUserMessageId,
    annotateUserSendFailureInStore,
    buildDurableFailureMessage,
    buildOptimisticAttachmentMetadata,
    buildSendFailureMetadata,
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
  } = need(globalThis.rendererSendFlowHelpers || (canRequire ? require('./renderer-send-flow-helpers') : null), [
    'adoptPersistedUserMessageId', 'annotateUserSendFailureInStore', 'buildDurableFailureMessage',
    'buildOptimisticAttachmentMetadata', 'buildSendFailureMetadata', 'cloneJsonLike', 'cloneQueuedAttachments',
    'clipSessionTitle', 'createOptimisticSessionId', 'createSendQueueGuards', 'createTraceToken',
    'getQueuedSendFromState', 'getOrCreateSendOutbox', 'reconcileAcceptedRegenerate', 'resolveMessageCopyText',
    'stashQueuedSendInState', 'summarizeDurableFailurePreview',
  ], 'renderer-send-flow-helpers');
  const { createSendMessageActions } = need(globalThis.rendererSendMessageActions
    || (canRequire ? require('./renderer-send-message-actions') : null), ['createSendMessageActions'], 'renderer-send-message-actions');
  const _navigationIntentUtils = need(globalThis.rendererNavigationIntent
    || (canRequire ? require('./renderer-navigation-intent') : null), ['getOrCreateNavigationIntentOwner'], 'renderer-navigation-intent');
  const _sendOutboxDispatch = need(globalThis.rendererSendOutboxDispatch
    || (canRequire ? require('./renderer-send-outbox-dispatch') : null), ['createQueuedSendDispatcher'], 'renderer-send-outbox-dispatch');
  const { createSendPreflightUtils } = need(globalThis.rendererSendPreflightUtils
    || (canRequire ? require('./renderer-send-preflight-utils') : null), ['createSendPreflightUtils'], 'renderer-send-preflight-utils');
  const { createSendCompletion } = need(globalThis.rendererSendCompletion
    || (canRequire ? require('./renderer-send-completion') : null), ['createSendCompletion'], 'renderer-send-completion');
  const { createSendReceiptStore } = need(globalThis.rendererSendReceipts
    || (canRequire ? require('./renderer-send-receipts') : null), ['createSendReceiptStore'], 'renderer-send-receipts');
  const _skillSlashCommands = need(globalThis.rendererSkillSlashCommands
    || (canRequire ? require('./renderer-skill-slash-commands') : null), ['createSendSlashDispatch'], 'renderer-skill-slash-commands');
  const _promptSlashCommands = globalThis.rendererMcpPromptSlashCommands || (canRequire ? require('./renderer-mcp-prompt-slash-commands') : null);
  const _asyncFenceUtils = need(globalThis.rendererAsyncFence
    || (canRequire ? require('../shared/async-fence') : null), ['createDisposalFence'], 'rendererAsyncFence');

  // Paths and display names of accepted attachments (active-file dedupe input).
  function attachmentRefs(list) {
    const entries = Array.isArray(list) ? list : [];
    return {
      paths: entries.map((e) => String(e?.path || e?.assetPath || e?.absolute_path || e?.absolutePath || '').trim()).filter(Boolean),
      names: entries.map((e) => String(e?.displayName || e?.promptName || '').trim()).filter(Boolean),
    };
  }

  const FOLLOW_UP_ACTION_BUSY_REASON = jt('shell.fallback.waitForCurrentResponse', 'Wait for the current response to finish before trying that.');
  const FOLLOW_UP_AUTH_BLOCKED_REASON = jt('chat.send.signInBeforeTrying', 'Sign in before trying that.');
  const FOLLOW_UP_BACKEND_NOT_READY_REASON = jt('chat.send.waitForBackend', 'Wait for Jenny to finish connecting before trying that.');
  // Atomic edit failures keep the inline editor open; this notice points the
  // user back to that retained retry surface instead of the ordinary composer.
  const EDIT_REGENERATE_FAILURE_MESSAGE =
    jt('chat.send.editReplacementFailed', 'Your edit was not applied because the replacement response could not start. Retry from the open editor.');

  function createSendController(deps) {
    const { state } = deps;
    const sessionContext = deps.sessionContext || (globalThis.rendererPaneSessionContext || require('./renderer-pane-session-context')).createPaneSessionContext({ state, paneId: deps.paneId });
    const releaseAssets = (assetPaths) => window.jennyShell?.attachments?.releaseAssets?.(assetPaths);
    const sendOutbox = getOrCreateSendOutbox(state, { releaseAssets });
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
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
      getCurrentVisibleMessages,
      getCurrentSessionMessages,
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      resolveSessionId,
      buildAttachmentBudget,
      resetAttachmentQueue,
      showToastMessage,
      setComposerStatusNotice,
      clearComposerStatusNotice,
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
      activateWorkspaceSession = async (sessionId) => { sessionContext.setSessionId(sessionId); },
      thinkingController,
      optimisticAppend,
      flushBufferedStreamEvents,
      dropBufferedStreamEvents,
      isSessionStreaming,
      hasPendingToolApprovalForSession,
      getCurrentMessageById,
      getElaboratePrompt,
      getLatestReplyAssistantMessageId,
      resolveRegenerateRequest,
      showCopyFeedback,
      upsertSessionSummary,
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

    function getCurrentSessionId() { return sessionContext.getSessionId(); }

    function startOptimisticSendIndicator() {
      if (typeof thinkingIndicator?.startIndicator !== 'function') return;
      const displayState = thinkingIndicator.getDisplayState?.() || null;
      if (!displayState || displayState.mode === 'idle') thinkingIndicator.startIndicator('thinking');
    }

    function clearOptimisticSendIndicator({ resetThinking = false } = {}) {
      if (resetThinking) thinkingIndicator?.resetIndicator?.();
    }

    // A split pane (paneId > 0) shares the outbox and failed-send payloads with
    // pane 0 through `state`; only pane 0's controller may tear those down.
    const ownsSharedSendState = !(Number(sessionContext.paneId) > 0);

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
      const reason = isSessionBusy(currentSessionId) || hasPendingToolApprovalForSession(currentSessionId)
        ? FOLLOW_UP_ACTION_BUSY_REASON
        : !state.auth?.authenticated ? FOLLOW_UP_AUTH_BLOCKED_REASON
          : !backendStartQueue.isBackendUsable() ? FOLLOW_UP_BACKEND_NOT_READY_REASON : '';
      return { blocked: Boolean(reason), reason };
    }

    // Queued-send state helpers (sibling lift-out); bind to this closure's state.
    const getQueuedSend = (sessionId) => getQueuedSendFromState(state, sessionId);
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
      getImageEditDraftController: () => window.rendererImageEditDraftController,
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
      getInputSessionId: Number(sessionContext.paneId) > 0 ? () => sessionContext.getSessionId() : undefined,
      getComposerController: () => globalThis.rendererComposerSessionStateController || null,
      releaseAssets,
      log: appendClientLog,
    });
    const sendCompletion = createSendCompletion({
      state, sessionContext,
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
    const durableModule = globalThis.rendererDurableSend || (typeof require === 'function' ? require('./renderer-durable-send') : null);
    const durableSend = durableModule.createController({ state, sessionContext,
      shell: { ...window.jennyShell, activeFileContext: window.rendererIdeActiveFileContext }, receipts: sendReceipts,
      callbacks: { ...deps.callbacks, renderMessages, renderSessions, renderHeader, renderComposerState,
        attachPendingOriginToSession, rekeySessionOrigin, activateWorkspaceSession, stopSessionStream: id => handleStopActiveStream(id) },
      helpers: { clipSessionTitle, buildOptimisticAttachmentMetadata, adoptPersistedUserMessageIdInStore },
      multiStreamController, isDisposed: () => disposalFence.isDisposed() });
    const skillsBridge = window.jennyShell?.skills || null;
    const sendSlashDispatch = _skillSlashCommands.createSendSlashDispatch({
      state, sessionContext, registry: slashCommandRegistry, chatInput, renderComposerState,
      syncComposerInputHeight, syncComposerVisualState,
      selectSlashCommand: handleSlashCommandSelection,
      submitPrompt: (nextPrompt) => startPromptSend(nextPrompt, { attachImageEditDraft: true }),
      // Scoped to this pane's chat: its bound project's skills, not the Workspace's.
      getSkillsState: skillsBridge?.getState ? (scope) => skillsBridge.getState(scope) : null,
      onSkillsChanged: skillsBridge?.onChanged ? (listener) => skillsBridge.onChanged(listener) : null,
      log: appendClientLog,
    });
    const backendStartQueue = _sendOutboxDispatch.createBackendStartQueue({ state, shell: window.jennyShell, isDisposed: () => disposalFence.isDisposed(), getDispatch: () => dispatchQueuedSendForSession }); // row 62: Send while the engine starts
    function startPromptSend(prompt, options = {}) {
      const imageDrafts = window.rendererImageEditDraft || (typeof require === 'function' ? require('../features/renderer-image-edit-draft') : null);
      return imageDrafts.sendWithDraft(startPromptSendCore, prompt, options, window.rendererImageEditDraftController,
        String(options.sessionIdOverride || getCurrentSessionId() || '').trim(), options.failedPayloadId ? sendReceipts.getFailedPayload(options.failedPayloadId) : null);
    }
    async function startPromptSendCore(prompt, options) {
      let settings = options || {};
      const composerTargetSessionId = String(settings.sessionIdOverride || getCurrentSessionId() || '').trim(); // before any await
      // The outbox dispatcher counts any truthy result as sent and deletes the
      // entry, so a drained send reports "not now" as null and stays queued.
      const isOutboxDispatch = settings.outboxDispatch === true;
      const reject = (reason, sessionId) => (isOutboxDispatch ? null : { rejected: true, reason, sessionId });
      if (!settings.editedMessageId && String(prompt || '').trim().startsWith('/')) await deps.promptCommands?.ensureScope({ maxAgeMs: 1000 });
      let slashDispatch = sendSlashDispatch.dispatch(prompt, settings);
      if (slashDispatch && typeof slashDispatch.then === 'function') slashDispatch = await slashDispatch;
      if (slashDispatch.handled) return null;
      prompt = slashDispatch.prompt;
      settings = slashDispatch.settings;
      const normalizedPrompt = String(prompt || '').trim();
      // A pending MCP prompt block rides typed sends only (the composer and slash submits mark themselves) or a drained outbox entry's own copy.
      const promptBlock = settings.outboxDispatch ? settings.promptBlock || null : settings.attachImageEditDraft === true && normalizedPrompt ? _promptSlashCommands?.getPendingPromptBlock(state, sessionContext) || null : null;
      const pendingBatch = getPendingQuestionBatch();
      const usesReplayImageAttachments = Array.isArray(settings.replayImageAttachments);
      const requestedSessionId = String(settings.sessionIdOverride || getCurrentSessionId() || '').trim(); // W2-2b: its queue is sent
      if (requestedSessionId !== composerTargetSessionId) return reject('session_changed', composerTargetSessionId);
      const imageEditDraft = settings.imageEditSnapshot;
      const sessionQueue = globalThis.rendererComposerSessionState || require('./renderer-composer-session-state');
      const queuedForSend = sessionQueue.getQueuedAttachments(state, requestedSessionId); // pane 0's live array or a pane's record
      const attachmentBudget = buildAttachmentBudget(usesReplayImageAttachments ? settings.replayImageAttachments : queuedForSend);
      const promptBearingAttachments = attachmentBudget.accepted.filter(
        (entry) => String(entry?.kind || '').trim() !== 'audio'
      );
      const preserveComposerDraft = Object.prototype.hasOwnProperty.call(settings, 'preserveComposerDraft')
        ? settings.preserveComposerDraft === true
        : usesReplayImageAttachments;
      const preserveCurrentSessionOnDispatch = settings.preserveCurrentSessionOnDispatch === true;
      // commitEdit keeps its own editor draft alive until this atomic command
      // succeeds, so the ordinary composer draft remains untouched on failure.
      const editedMessageId = String(settings.editedMessageId || '').trim();
      const isEditRegenerate = Boolean(editedMessageId);
      const batchSnapshot = normalizePendingQuestionBatch(settings.interactiveResponse?.batch_snapshot);
      const normalizedInteractiveResponse = batchSnapshot
        ? { ...settings.interactiveResponse, batch_snapshot: batchSnapshot }
        : null;
      const interactiveGuardrailFallback =
        Boolean(settings.interactiveGuardrailFallback) ||
        shouldForceInteractiveGuardrail(normalizedInteractiveResponse?.batch_snapshot);
      const audioOnlyDraftBlocked =
        !normalizedPrompt
        && !normalizedInteractiveResponse
        && !promptBearingAttachments.length
        && attachmentBudget.accepted.some(
          (entry) => String(entry?.kind || '').trim() === 'audio'
        );
      if (audioOnlyDraftBlocked && backendStartQueue.isBackendUsable() && state.auth.authenticated) {
        // Audio clips carry no prompt content (voice transcription was
        // removed), so a clip-only draft has nothing to send. Say so
        // instead of silently ignoring the click/Enter.
        setComposerStatusNotice(jt('composer.send.audioNeedsText', 'Audio clips need a typed message — add some text before sending.'), {
          owner: 'send:audio_only',
          tone: 'warning',
        });
        renderComposerState();
        appendClientLog('INFO', 'chat.audio_only_send_blocked', {
          attachmentCount: attachmentBudget.accepted.length,
        });
        return null;
      }
      const queueUntilBackendReady = backendStartQueue.claim(requestedSessionId, Boolean(isEditRegenerate || normalizedInteractiveResponse || settings.outboxDispatch || pendingBatch));
      if (
        (!normalizedPrompt && !normalizedInteractiveResponse && !promptBearingAttachments.length)
        || (!backendStartQueue.isBackendUsable() && !queueUntilBackendReady)
        || !state.auth.authenticated
      ) {
        return null;
      }
      if (compactionCoordinator?.isPending?.(requestedSessionId)) { // the inline compaction row already tells it
        appendClientLog('INFO', 'chat.send_blocked', { sessionId: requestedSessionId, reason: 'session_compacting' });
        return reject('session_compacting', requestedSessionId);
      }
      const autoGate = settings.startupAudit || (globalThis.rendererRunModeControl?.confirmAutoSend?.(requestedSessionId) ?? true); if (autoGate !== true && await autoGate !== true) return null; // FG-003 Auto warning
      compactionCoordinator?.clearSettled?.(requestedSessionId);
      clearComposerStatusNotice();
      const requestedSession = requestedSessionId
        ? (state.sessions.find((session) => String(session?.id || '').trim() === requestedSessionId) || null)
        : null;
      const runModeState = globalThis.rendererComposerV2State || (typeof require === 'function' ? require('./renderer-composer-v2-state') : null);
      const runtimePreferences = runModeState.resolveSendRuntimePreferences({
        snapshot: settings.runtimePreferencesSnapshot, session: requestedSession, current: getCurrentRuntimePreferences, clone: cloneJsonLike, fromSession: getRuntimePreferencesFromSession,
      });
      if (['ask', 'auto'].includes(settings.runModeOverride)) Object.assign(runtimePreferences, { runMode: settings.runModeOverride, planMode: false });
      const providerNotice = globalThis.rendererApiProviderNotice?.confirmFirstSend?.(runtimePreferences.preferredModel || state.status?.model) ?? true; if (providerNotice !== true && await providerNotice !== true) return null; // row 78 first-use notice
      const visionGate = globalThis.rendererComposerVisionGate?.evaluateComposerVisionGate?.({ state, runtimePreferences, queued: queuedForSend });
      if (visionGate?.blocked && !usesReplayImageAttachments && !isEditRegenerate && !normalizedInteractiveResponse) {
        setComposerStatusNotice(visionGate.notice, { owner: 'attachments.vision', tone: visionGate.tone, at: 0 }); renderComposerState(); return null;
      }
      const requestedSessionBusy = isSessionBusy(requestedSessionId);
      const rawSkillInvocation = settings.skillInvocation && typeof settings.skillInvocation === 'object' ? settings.skillInvocation : null;
      const skillInvocation = rawSkillInvocation && typeof rawSkillInvocation.id === 'string' ? Object.fromEntries(['id', 'name', 'scope', 'command'].filter((key) => typeof rawSkillInvocation[key] === 'string').map((key) => [key, rawSkillInvocation[key]])) : null;
      // Dock-scoped approval-steer (see isDockApprovalSteerActive above): once a
      // turn's stream has actually gone terminal (requestedSessionBusy false), a
      // pending-approval entry still on state.pendingToolApprovals for this
      // session is stale bookkeeping, not a live gate — approvals only block a
      // session while its stream is mid-flight, so busy is the true signal.
      // Ungating this let a stale flag strand the queued-send drain (below)
      // exactly like it must not strand a fresh dock send.
      const durableEligible = !isEditRegenerate && durableModule.eligible(state, window.jennyShell, settings, prompt, normalizedInteractiveResponse);
      if (durableEligible && !queueUntilBackendReady && !durableSend.hasCapacity()) return null;
      if (queueUntilBackendReady || (!durableEligible && (requestedSessionBusy || (hasPendingToolApprovalForSession(requestedSessionId) && !isDockApprovalSteerActive())))) {
        // An edit replaces a message in place and a drained outbox entry is
        // already queued: neither may become a new queued message.
        if (isEditRegenerate) {
          appendClientLog('INFO', 'chat.send_blocked', { sessionId: requestedSessionId, reason: 'session_busy_edit' });
          return { rejected: true, reason: 'session_busy', sessionId: requestedSessionId };
        }
        if (isOutboxDispatch) return null;
        if (
          (queueUntilBackendReady || canQueueForSession(requestedSessionId))
          && (normalizedPrompt || attachmentBudget.accepted.length)
        ) {
          // Legacy outbox capture and draft consumption must precede any await:
          // terminal dispatch may run while mention contents are still resolving.
          // Backfill only the same queued entry, deduping against resolved mentions.
          // A prompt that did not come from the composer (preserveComposerDraft)
          // takes none of its @-mentions and leaves its draft alone.
          const queuedRefs = attachmentRefs(attachmentBudget.accepted);
          const queuedMentionPaths = preserveComposerDraft ? [] : window.rendererIdeMentionAutocomplete?.collectMentionPaths?.(chatInput) || [];
          const queuedMentionContentsPromise = Promise.resolve(
            preserveComposerDraft ? [] : window.rendererIdeMentionAutocomplete?.collectMentionContents?.({ input: chatInput }) || []
          );
          // Initially dedupe only attachments; failed mention reads must not
          // discard the active-file snapshot from both context sources.
          const queuedActiveFileContext = window.rendererIdeActiveFileContext?.readActiveFileContextForTurn?.({
            mentionedPaths: [],
            attachedPaths: queuedRefs.paths,
            attachedNames: queuedRefs.names,
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
              activeFileContextSnapshot: queuedActiveFileContext, skillInvocation, imageEditSnapshot: imageEditDraft, promptBlock,
            },
          });
          if (!queuedEntry) {
      setComposerStatusNotice(jt('chat.send.outboxFull', 'The send outbox is full. Cancel or send an existing item first.'), {
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
          deps.promptCommands?.consume(promptBlock); // the queued entry carries it now
          if (!preserveComposerDraft) {
            chatInput.value = '';
            sessionQueue.clearQueuedAttachments(state, requestedSessionId);
            syncComposerInputHeight();
            syncComposerVisualState();
          }
          renderComposerState();
          appendClientLog('INFO', 'chat.queue_created', {
            sessionId: requestedSessionId, ...(queueUntilBackendReady ? { reason: 'backend_starting' } : {}),
            attachmentCount: attachmentBudget.accepted.length,
            mentionCount: queuedMentionPaths.length,
          });
          // Backfill the resolved @-mention contents once the (time-boxed) reads
          // settle, and apply the resolved-mention dedupe to the active-file slice.
          sendOutbox.settleContextCapture(queuedEntry, queuedMentionContentsPromise.then((contents) => {
            const capturedContents = Array.isArray(contents) ? contents : [];
            const norm = (path) => String(path || '').trim().replace(/\\/g, '/');
            const activePath = queuedActiveFileContext?.path ? norm(queuedActiveFileContext.path) : '';
            const activeFileContextSnapshot = activePath && capturedContents.some((entry) => norm(entry?.path) === activePath)
              ? null
              : queuedActiveFileContext;
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
          jtn('chat.send.attachmentBudgetSkipped', attachmentBudget.skipped.length, { count: attachmentBudget.skipped.length }, '{count} attachment skipped because the session budget is full.', '{count} attachments skipped because the session budget is full.'),
          {
            title: jt('chat.send.attachmentBudgetReachedTitle', 'Attachment Budget Reached'),
            tone: 'warning',
            sticky: true,
            source: TOAST_SOURCE.attachments,
            dedupeKey: `${TOAST_SOURCE.attachments}:budget`,
          }
        );
      }
      const currentMessages = getCurrentVisibleMessages();
      const shouldAnimateActivation = currentMessages.length === 0;
      let effectivePrompt = interactiveGuardrailFallback
        ? [
            normalizedPrompt,
            normalizedPrompt.includes(INTERACTIVE_GUARDRAIL_PROMPT) ? '' : INTERACTIVE_GUARDRAIL_PROMPT,
          ].filter(Boolean).join('\n\n')
        : String(prompt || '');
      if (!settings.imageEditContextIncluded && imageEditDraft?.sessionId === requestedSessionId) effectivePrompt += window.rendererImageEditDraft?.promptContext(imageEditDraft) || '';
      if (promptBlock) effectivePrompt = _promptSlashCommands.composePromptBlock(promptBlock, effectivePrompt); // model-facing only: the visible text and a restored draft stay the user's own
      const hasExplicitVisiblePrompt = Object.prototype.hasOwnProperty.call(settings, 'visiblePrompt');
      const visiblePrompt = String(hasExplicitVisiblePrompt ? settings.visiblePrompt : prompt).trim();
      const optimisticTitleSource = visiblePrompt || (hasExplicitVisiblePrompt ? '' : normalizedPrompt);
      const pendingBatchSnapshot = pendingBatch && normalizedInteractiveResponse ? pendingBatch : null;
      const acceptedAttachments = cloneQueuedAttachments(attachmentBudget.accepted);
      const { paths: attachedPaths, names: attachedNames } = attachmentRefs(acceptedAttachments);
      const previousSessionId = getCurrentSessionId();
      const optimisticSessionId = requestedSessionId || createOptimisticSessionId();
      const createdOptimisticSession = !requestedSessionId || requestedSession?.local_draft === true;
      const retryPayloadId = String(settings.failedPayloadId || '').trim();
      const retryPayload = retryPayloadId ? sendReceipts.getFailedPayload(retryPayloadId) : null;
      const toolPreferences = cloneJsonLike(getToolPreferences());
      const runModeProjection = typeof runModeState?.projectRunMode === 'function'
        ? runModeState.projectRunMode(runtimePreferences.runMode, { planModeFallback: runtimePreferences.planMode === true })
        : { approvalMode: 'prompt', planMode: runtimePreferences.planMode === true };
      const { approvalMode } = runModeProjection;
      // Capture approved paths synchronously from THIS textarea before the receipt
      // consumes its text. Reads may settle later; queued sends already own a snapshot.
      // A prompt that is not the composer's (edit, regenerate, retry, handoff)
      // must not carry the files @-mentioned in the user's unsent draft.
      const mentionContentsPromise = Object.prototype.hasOwnProperty.call(settings, 'mentionContentsSnapshot')
        ? Promise.resolve(Array.isArray(settings.mentionContentsSnapshot) ? settings.mentionContentsSnapshot : [])
        : preserveComposerDraft ? Promise.resolve([])
          : Promise.resolve(window.rendererIdeMentionAutocomplete?.collectMentionContents?.({ input: chatInput }) || []).catch(() => []);
      let sendReceipt = sendReceipts.begin({
        sessionId: optimisticSessionId,
        prompt: effectivePrompt,
        imageEditSnapshot: imageEditDraft,
        visiblePrompt,
        attachments: acceptedAttachments,
        runtimePreferences,
        toolPreferences,
        approvalMode,
        interactiveResponse: normalizedInteractiveResponse,
        skillInvocation,
        editedMessageId,
      }, {
        consumeDraft: !preserveComposerDraft,
        restoreOnFailure: settings.restoreDraftOnStartStreamReject !== false,
        // A failed edit keeps its editor open and gets no Retry marker, so a
        // failed payload for it could never be replayed.
        recordFailedPayload: settings.recordFailedPayload !== false && !isEditRegenerate,
        failedPayloadId: retryPayloadId,
      });
      if (!sendReceipt) return null; deps.promptCommands?.consume(promptBlock); // the receipt's Retry payload carries it; a restored draft does not
      if (durableEligible) {
        const result = await durableSend.send({ settings, optimisticSessionId, createdOptimisticSession, requestedSession,
          effectivePrompt, visiblePrompt, acceptedAttachments, attachedPaths, attachedNames, runtimePreferences,
          runModeProjection, toolPreferences, approvalMode, skillInvocation,
          sendReceipt, mentionContentsPromise, preserveComposerDraft });
        sendSlashDispatch.clearAccepted(result, skillInvocation, settings);
        return result;
      }
      // The draft is consumed from here on: any throw must settle the receipt
      // (restoring the draft) and clear preflight, so the try starts now.
      const operationState = { optimisticUserMessageId: '' };
      let preflightState = null;
      let sendNavigationToken = null;
      try {
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
        preflightState = beginSessionPreflight({
          sessionId: optimisticSessionId,
          optimisticSessionId,
          previousSessionId,
          optimisticCreated: createdOptimisticSession,
        });
        setChatSendLifecycle(optimisticSessionId, 'preflight');
        const sequenceState = interactiveGuardrailFallback ? INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED : INTERACTIVE_SEQUENCE_IDLE;
        if (pendingBatchSnapshot) {
          patchSessionSummary(createdOptimisticSession ? optimisticSessionId : getCurrentSessionId(), {
            pending_question_batch: null,
            interactive_sequence_state: sequenceState,
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
            interactive_sequence_state: sequenceState,
            interactive_round_count: pendingBatchSnapshot?.round_index || 0,
            run_mode: runModeProjection.runMode,
            plan_mode: runModeProjection.planMode,
            context_preferences: {
              history_scope: runtimePreferences.contextPreferences.historyScope,
              include_personality: runtimePreferences.contextPreferences.includePersonality !== false,
              include_memory: runtimePreferences.contextPreferences.includeMemory !== false, memory_opt_out: runtimePreferences.contextPreferences.memoryOptOut === true,
            },
            optimistic_local: true,
            local_draft: false,
          }, { prepend: true });
          sessionContext.setSessionId(optimisticSessionId);
          attachPendingOriginToSession(optimisticSessionId);
          setSessionMessages(optimisticSessionId, getSessionMessages(optimisticSessionId), `session_${optimisticSessionId}`);
        }
        state.ui.animateNextChatActivation = shouldAnimateActivation;
        if (visiblePrompt || acceptedAttachments.length) {
          operationState.optimisticUserMessageId = isEditRegenerate
            ? editedMessageId
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
        sendNavigationToken = navigationIntent.beginOperation('chat.send');

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
          ...(editedMessageId
            ? { editedMessageId, ...(settings.failureRetry === true ? { failureRetry: true } : {}) }
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
          ...(skillInvocation?.id ? { skillInvocation: { id: skillInvocation.id } } : {}),
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
      return { available: false, reason: jt('chat.send.failedPayloadNoDestination', 'The original failed payload has no destination chat.') };
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
        showComposerActionError(new Error(FOLLOW_UP_ACTION_BUSY_REASON), jt('chat.send.retryUnavailableTitle', 'Retry Unavailable'));
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
        skillInvocation: payload.skillInvocation || null,
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
      sendSlashDispatch.dispose(); backendStartQueue.dispose();
      dispatchQueuedSendForSession.dispose?.();
      durableSend.dispose();
      // Closing a split pane must not empty pane 0's outbox (a disposed outbox
      // refuses every later enqueue) or drop its failed-send Retry payloads.
      sendReceipts.dispose({ retainFailedPayloads: !ownsSharedSendState });
      if (ownsSharedSendState) sendOutbox.dispose?.();
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
      let cancelResult;
      try {
        cancelResult = await window.jennyShell.chat.cancelStream(activeStreamId);
      } catch (error) {
        // A failed cancel leaves the stream running: its terminal must drain
        // the queued entry normally, not restore it as if Stop had worked.
        dispatchQueuedSendForSession.releaseHold(activeSessionId, activeStreamId);
        throw error;
      }
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
      appendClientLog, isBackendStarting: backendStartQueue.isBackendStarting,
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
    const { handleElaborateMessage, handleRegenerateMessage, handleCopyMessage } = messageActions;

    return {
      startPromptSend,
      handleStopActiveStream,
      getQueuedSend,
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
