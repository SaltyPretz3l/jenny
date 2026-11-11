(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineMessageRenderer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const streamDomPatchUtils = (typeof globalThis !== 'undefined' && globalThis.rendererStreamDomPatchUtils)
    || (typeof require === 'function' ? require('./renderer-stream-dom-patch-utils') : null)
    || {};
  const renderLadderUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineRenderLadder)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-render-ladder') : null)
    || {};
  const createRenderLadder = renderLadderUtils.createRenderLadder;
  const streamRevealCallbacksUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineStreamRevealCallbacks)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-stream-reveal-callbacks') : null)
    || {};
  const createStreamRevealPatchCallbacks = streamRevealCallbacksUtils.createStreamRevealPatchCallbacks;
  const renderSignatureUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineRenderSignatures)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-render-signatures') : null)
    || {};
  const streamingArticleUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineStreamingArticle)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-streaming-article') : null)
    || {};
  const renderPreludeUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineRenderPrelude)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-render-prelude') : null)
    || {};
  // The projection-cache module also owns the #15 cache ref-refresh helpers (used by the prelude).
  const projectionCacheRefreshUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineProjectionCacheUtils)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
  // Split view W0-5: which sessions the projection-cache prune must keep. Same
  // module as above; absent, it collapses to the single current session.
  const resolveRetainedSessionIds = projectionCacheRefreshUtils.resolveRetainedSessionIds
    || function singleRetainedSession(state) { return [String((state && state.currentSessionId) || '').trim()]; };
  function noop() {}
  function noopFalse() { return false; }
  function noopEmptyString() { return ''; }
  function noopArray() { return []; }
  function noopSet() { return new Set(); }

  function asFn(value, fallback) {
    return typeof value === 'function' ? value : fallback;
  }

  function emptyDerivedMessageState() {
    return {
      latestAssistantMessageId: '',
      streamTargetAssistantMessageId: '',
      latestReplyAssistantMessageId: '',
      thinkingMessageIds: [],
      streamingMessage: null,
      idToIndex: new Map(),
    };
  }

  function toStreamingRowTargetPayload(streamingRowTarget) {
    return streamingRowTarget
      ? {
        turnId: streamingRowTarget.turnId,
        rowKind: streamingRowTarget.rowKind,
        toolCallId: streamingRowTarget.toolCallId,
      }
      : null;
  }
  function createRenderPipelineMessageRenderer(deps) {
    const settings = deps || {};
    const state = settings.state || {};
    const dom = settings.dom || {};
    const callbacks = settings.callbacks || {};
    const controllers = settings.controllers || {};
    const runtime = settings.runtime || {};
    const chatTimeline = dom.chatTimeline || null;
    const chatThreadScroll = dom.chatThreadScroll || null;
    const uiRuntime = runtime.uiRuntime || {};
    const reducedMotionQuery = controllers.reducedMotionQuery || { matches: false };
    const thinkingController = controllers.thinkingController || {
      prune: noop,
      resumeAutoScroll: noop,
    };
    const timelineVisibilityTracker = settings.timelineVisibilityTracker || null;
    // Per-stream paint counters (client_timing diagnostics). Resolved off the
    // shared module global so the ceiling-constrained pipeline composition
    // does not need a new dependency thread; always best-effort.
    const streamClientMetrics = settings.streamClientMetrics
      || ((typeof globalThis !== 'undefined'
        && globalThis.rendererStreamClientMetricsModule
        && typeof globalThis.rendererStreamClientMetricsModule.getShared === 'function')
        ? globalThis.rendererStreamClientMetricsModule.getShared()
        : null);
    // Split view W1-4a: every read below uses the session THIS pane shows,
    // resolved once per renderMessages() and passed down as `paneSessionId`.
    const getPaneSessionId = asFn(callbacks.getPaneSessionId, () => String(state.currentSessionId || '').trim());
    const getPaneTranscriptView = asFn(callbacks.getPaneTranscriptView, () => 'thinking');
    // Split view W3-1: selection chrome renders only in the pane that owns the mode.
    const isPaneSelecting = asFn(callbacks.isPaneSelecting, () => state?.ui?.selectionModePaneId === 0);
    const noteStreamRender = (kind, reason) => streamClientMetrics?.noteRenderForSession(getPaneSessionId(), kind, reason);

    // The source-structure and ambient-UI render signatures live in
    // renderer-render-pipeline-render-signatures.js (split at the line cap).
    const { buildSourceStructureSignature } = renderSignatureUtils;
    const buildAmbientUiSignature = renderSignatureUtils.createAmbientUiSignature({ state, isPaneSelecting });

    const appendClientLog = asFn(callbacks.appendClientLog, noop);
    const buildCanonicalTranscriptMessages = asFn(callbacks.buildCanonicalTranscriptMessages, (messages) => (
      Array.isArray(messages) ? messages : []
    ));
    const buildMessageArticleInnerHtml = asFn(callbacks.buildMessageArticleInnerHtml, noopEmptyString);
    const buildMessageArticleMarkup = asFn(callbacks.buildMessageArticleMarkup, noopEmptyString);
    const buildMessageInnerMarkup = asFn(callbacks.buildMessageInnerMarkup, () => ({
      innerHtml: '',
      pending: false,
      status: '',
      finalizedAt: '',
    }));
    const buildMessageRenderSignature = asFn(callbacks.buildMessageRenderSignature, noopEmptyString);
    const buildProjectionContext = asFn(callbacks.buildProjectionContext, () => null);
    const buildProjectionStreamingRowMarkup = asFn(callbacks.buildProjectionStreamingRowMarkup, noopEmptyString);
    const buildRecapExpansionSignature = asFn(callbacks.buildRecapExpansionSignature, noopEmptyString);
    const buildThreadExpansionSignature = asFn(callbacks.buildThreadExpansionSignature, noopEmptyString);
    const buildTimelineDividerInputSignature = asFn(callbacks.buildTimelineDividerInputSignature, noopEmptyString);
    const buildTimeDividerMap = asFn(callbacks.buildTimeDividerMap, () => new Map());
    const buildTranscriptThreadTree = asFn(callbacks.buildTranscriptThreadTree, () => ({
      roots: [],
      nodeById: new Map(),
    }));
    const canPatchStreamRevealMessage = asFn(callbacks.canPatchStreamRevealMessage, noopFalse);
    // Post-approval flicker RCA: names the comparand that blocked the patch
    // path, so a full render is attributable rather than anonymous.
    const describeStreamRevealPatchBlock = asFn(callbacks.describeStreamRevealPatchBlock, () => '');
    const stampStreamingArticleMarkerNode = asFn(callbacks.stampStreamingArticleMarkerNode, () => null);
    const collectThreadBranchIds = asFn(callbacks.collectThreadBranchIds, noopSet);
    const commitStreamRevealFullRender = asFn(callbacks.commitStreamRevealFullRender, noop);
    const replayStreamRevealHandoff = asFn(callbacks.replayStreamRevealHandoff, noop);
    const computeDerivedMessageState = asFn(callbacks.computeDerivedMessageState, emptyDerivedMessageState);
    const computeMessageFingerprintList = asFn(callbacks.computeMessageFingerprintList, null);
    const renderSignatureFromFingerprints = asFn(callbacks.renderSignatureFromFingerprints, null);
    const computeStructureHash = asFn(callbacks.computeStructureHash, () => 0);
    const deriveTimelineTimeDividers = asFn(callbacks.deriveTimelineTimeDividers, noopArray);
    const getCurrentVisibleMessages = asFn(callbacks.getCurrentVisibleMessages, noopArray);
    const getVisibleSessionMessages = asFn(callbacks.getVisibleSessionMessages, () => getCurrentVisibleMessages());
    const getForcedOpenStreamingMessageId = asFn(callbacks.getForcedOpenStreamingMessageId, noopEmptyString);
    const isSendBusy = asFn(callbacks.isSendBusy, noopFalse);
    const isSendPreflightPending = asFn(callbacks.isSendPreflightPending, noopFalse);
    const isThreadBranchOpen = asFn(callbacks.isThreadBranchOpen, noopFalse);
    const noteScrollProgrammaticWrite = asFn(callbacks.noteScrollProgrammaticWrite, noop);
    const performFullMessageRender = asFn(callbacks.performFullMessageRender, noop);
    const pruneRecapExpansionState = asFn(callbacks.pruneRecapExpansionState, noop);
    const pruneThreadBranchState = asFn(callbacks.pruneThreadBranchState, noop);
    const pruneToolRowProjectionSessionCaches = asFn(callbacks.pruneToolRowProjectionSessionCaches, noop);
    const queueStreamRevealPatch = asFn(callbacks.queueStreamRevealPatch, noop);
    const recordTurnArticleRolloutSignal = asFn(callbacks.recordTurnArticleRolloutSignal, noop);
    const resetStreamRevealState = asFn(callbacks.resetStreamRevealState, noop);
    const resolveProjectionStreamingRowTarget = asFn(callbacks.resolveProjectionStreamingRowTarget, () => null);
    const resolveRegenerateRequest = asFn(callbacks.resolveRegenerateRequest, () => null);
    const resolveTurnArticleMessageId = asFn(callbacks.resolveTurnArticleMessageId, (messageId) => (
      String(messageId || '').trim()
    ));
    const resolveVisibleTurnArticleTarget = asFn(callbacks.resolveVisibleTurnArticleTarget, () => null);
    const runPostTimelineRenderEffects = asFn(callbacks.runPostTimelineRenderEffects, noop);
    const scheduleThreadTransitionCleanup = asFn(callbacks.scheduleThreadTransitionCleanup, noop);
    const setFollowLatest = asFn(callbacks.setFollowLatest, noop);
    const isFollowingLatest = asFn(callbacks.isFollowingLatest, () => state.ui?.followLatest !== false);
    const shouldShowThinkingToggle = asFn(callbacks.shouldShowThinkingToggle, noopFalse);
    const shouldShowThreadToggle = asFn(callbacks.shouldShowThreadToggle, noopFalse);
    const syncChatState = asFn(callbacks.syncChatState, noop);
    const syncPersistedReasoningPhaseExpansionState = asFn(
      callbacks.syncPersistedReasoningPhaseExpansionState,
      noop
    );
    const syncPostRenderChrome = asFn(callbacks.syncPostRenderChrome, noop);
    const syncTimelineBusyState = asFn(callbacks.syncTimelineBusyState, noop);
    const tryPatchActiveTurnRoot = asFn(callbacks.tryPatchActiveTurnRoot, noopFalse);
    const updateAssistantSpritePosition = asFn(callbacks.updateAssistantSpritePosition, noop);
    const updateTokenDisplay = asFn(callbacks.updateTokenDisplay, noop);
    const hideAssistantSprite = asFn(callbacks.hideAssistantSprite, noop);

    const prelude = renderPreludeUtils.createRenderPrelude({
      state,
      chatTimeline,
      uiRuntime,
      isSendBusy,
      isSendPreflightPending,
      buildSourceStructureSignature,
      buildCanonicalTranscriptMessages,
      buildTranscriptThreadTree,
      buildInteractiveRecapModel: callbacks.buildInteractiveRecapModel,
    });
    const { resolveFollowUpDisabledReason } = prelude;
    const { patchStreamingArticle, isRowlessShellOfVisibleTurn } = streamingArticleUtils.createStreamingArticlePatcher({
      state,
      chatTimeline,
      uiRuntime,
      streamClientMetrics,
      getPaneSessionId,
      noteStreamRender,
      resolveVisibleTurnArticleTarget,
      resolveTurnArticleMessageId,
      buildMessageArticleMarkup,
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      replayStreamRevealHandoff,
      stampStreamingArticleMarkerNode,
      runPostTimelineRenderEffects,
    });

    function renderMessages(options = {}) {
      const paneSessionId = getPaneSessionId();
      const timeFormat = globalThis.jennyI18n?.timeOptions?.().hourCycle || '';
      // A4: an approval card's state (live, paused, inactive) moves without any
      // message changing, so neither the no-op guard, the settled-root memo nor
      // a streaming patch would repaint it. Committed only by a full render.
      // The proposal cards' read model (row 59 checkpoint 3) rides the same comparand.
      const approvalCardKey = (globalThis.rendererApprovalBlock?.approvalCardStateKey?.(state, paneSessionId) || '')
        + (globalThis.rendererProposalCardStore?.proposalCardStateKey?.(paneSessionId) || '');
      // Transcript view is baked into row markup as expansion defaults: a switch
      // on this pane's session commits through a full render (session-scoped
      // comparand; a pane session change is already a full render).
      const transcriptView = getPaneTranscriptView();
      const transcriptViewChanged = uiRuntime.transcriptView !== undefined
        && uiRuntime.transcriptViewSessionId === paneSessionId
        && uiRuntime.transcriptView !== transcriptView;
      const forceFullRender = options?.forceFullRender === true || options?.forceLegacyRowModelFallback === true
        || (uiRuntime.timeFormat || '') !== timeFormat
        || (uiRuntime.approvalCardKey || '') !== approvalCardKey
        || transcriptViewChanged;
      uiRuntime.timeFormat = timeFormat;
      uiRuntime.transcriptView = transcriptView;
      uiRuntime.transcriptViewSessionId = paneSessionId;
      if (!chatTimeline || !chatThreadScroll) {
        return;
      }
      prelude.syncTimelineEnvironment(transcriptView, paneSessionId, forceFullRender);
      // Split view W0-5: the prune keeps the RETAINED set, which with one pane
      // is exactly `[state.currentSessionId]` -- the argument this passed before.
      pruneToolRowProjectionSessionCaches(resolveRetainedSessionIds(state));

      const sourceMessages = getVisibleSessionMessages(paneSessionId);
      const { messages, threadTree } = prelude.resolveCanonicalTranscript(sourceMessages, paneSessionId, forceFullRender);
      pruneRecapExpansionState(paneSessionId, messages);
      updateTokenDisplay();
      const hasMessages = messages.length > 0;
      const shouldAnimateActivation =
        hasMessages && state.ui.chatMode !== 'thread' && state.ui.animateNextChatActivation && !reducedMotionQuery.matches;
      const derived = computeDerivedMessageState(messages, { shouldShowThinkingToggle });
      const { latestReplyAssistantMessageId } = derived;
      // Streaming gates (reasoning live-tail, streaming bubble, row-model
      // streamingMessageId) mean "which message is streaming right now", which is the
      // stream-target id — the plain latest-assistant id adopts a tool_use row that
      // trails the live segment and flips the live rows to their settled shape.
      const latestAssistantMessageId = derived.streamTargetAssistantMessageId
        || derived.latestAssistantMessageId;
      const visibleThinkingMessageIds = derived.thinkingMessageIds;
      // Compute fingerprints once and reuse them for the render guard and projection-cache keys.
      const messageFingerprints = computeMessageFingerprintList ? computeMessageFingerprintList(messages) : null;
      const projectionContext = buildProjectionContext(
        messages,
        threadTree,
        derived,
        messageFingerprints ? { messageFingerprints } : undefined
      );
      const projectionRevisionKey = String(projectionContext?.projectionStateRevisionKey || '');
      pruneThreadBranchState(paneSessionId, threadTree);
      const forcedOpenIds = collectThreadBranchIds(
        threadTree.nodeById,
        getForcedOpenStreamingMessageId(messages, derived)
      );
      const followUpDisabledReason = resolveFollowUpDisabledReason();
      const latestRegenerateRequest = latestReplyAssistantMessageId
        ? resolveRegenerateRequest(latestReplyAssistantMessageId, messages, {
          latestReplyAssistantMessageId,
          followUpActionsBusy: Boolean(followUpDisabledReason),
          idToIndex: derived.idToIndex,
        })
        : null;
      const structureSignature = computeStructureHash(messages);
      const tokenMessageSignature = messageFingerprints && renderSignatureFromFingerprints
        ? renderSignatureFromFingerprints(messageFingerprints)
        : buildMessageRenderSignature(messages);
      const messageRenderSignature = tokenMessageSignature
        + '\u001eF7I:' + buildTimelineDividerInputSignature(messages)
        + 'AUI:' + buildAmbientUiSignature(paneSessionId)
        // F27: the follow-up gate (Resume, Edit, Branch, Regenerate) is baked
        // into the markup but lives on no message, so a render that ran while
        // terminal postwork held the session busy latched them disabled.
        + 'FU:' + followUpDisabledReason
        // PSR: the projection-state revision (renderer-render-pipeline-
        // projection-context.js) folds the live/reconciled row overlay into
        // this one transcript render signature. A projection-row-only change
        // (terminal reconcile consumption, row-model rollback) is invisible to
        // every message fingerprint above — the revision is what breaks the
        // no-op guard for it.
        + 'PSR:' + projectionRevisionKey;
      if (projectionContext && typeof projectionContext === 'object') {
        projectionContext.messageTokenSignature = tokenMessageSignature;
      }
      // The narrow patch paths below commit only the streaming/active turn's
      // DOM, so they must never swallow a projection-row change that touches a
      // SETTLED turn. uiRuntime.projectionCommittedRevisionKey advances only on
      // paths that rebuild the whole timeline (full render / empty transcript);
      // while it lags the context's revision, every patch path stands down and
      // the render falls through to performFullMessageRender — and keeps doing
      // so on later renders if this one is dropped before the DOM commit.
      const projectionRevisionChanged = uiRuntime.projectionCommittedRevisionKey !== projectionRevisionKey;
      const recapExpansionSignature = buildRecapExpansionSignature(messages, paneSessionId);
      const recapExpansionChanged = uiRuntime.recapExpansionSignature !== recapExpansionSignature;
      const threadExpansionSignature = buildThreadExpansionSignature(threadTree, paneSessionId, forcedOpenIds);
      const threadExpansionChanged = uiRuntime.threadBranchSignature !== threadExpansionSignature;
      const renderReason = String(options?.reason || '').trim();
      const renderLadder = createRenderLadder({
        state,
        uiRuntime,
        appendClientLog,
        timelineVisibilityTracker,
        recordTurnArticleRolloutSignal,
        describeDomWrite: streamDomPatchUtils.describeDomWrite,
        describeStreamRevealPatchBlock,
        forceFullRender,
        projectionRevisionChanged,
        recapExpansionChanged,
        threadExpansionChanged,
        messages,
        latestAssistantMessageId,
        structureSignature,
        derived,
        renderReason,
        paneSessionId,
      });
      const catchupActive = renderLadder.catchupActive;
      const {
        resolveFullRenderReason,
        markCatchupPatched,
        markCatchupFullRenderFallback,
        recordStreamingArticleRebuild,
      } = renderLadder;

      // HB-006: a structural write can shrink the timeline for one layout (the
      // browser clamps scrollTop) and regrow it before the scroll coordinator's
      // frame reads the snapshot. Unattributed, that reads as an upward reader
      // scroll and drops follow mode, parking the view where the clamp left it.
      // While a following reader watches a live stream, attribute the write;
      // the syncViewport pass that follows every such write then re-pins.
      function noteStructuralRewrite() {
        if (derived.streamingMessage && isFollowingLatest()) {
          noteScrollProgrammaticWrite('structural_rewrite');
        }
      }
      function renderFullTimeline(...args) {
        noteStructuralRewrite();
        return performFullMessageRender(...args);
      }

      function patchVisibleStreamingArticle(streamingMessage, articleOverride) {
        return patchStreamingArticle({
          messages,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          latestRegenerateRequest,
          projectionContext,
          messageRenderSignature,
          recapExpansionSignature,
          threadExpansionSignature,
          noteStructuralRewrite,
          recordStreamingArticleRebuild,
        }, streamingMessage, articleOverride);
      }

      state.ui.animateNextChatActivation = false;
      syncChatState(hasMessages, { animate: shouldAnimateActivation });
      syncPersistedReasoningPhaseExpansionState(paneSessionId, messages, controllers.thinkingController);
      thinkingController.prune(visibleThinkingMessageIds);

      if (!hasMessages) {
        resetStreamRevealState();
        uiRuntime.messageRenderSignature = '';
        uiRuntime.recapExpansionSignature = '';
        uiRuntime.threadBranchSignature = '';
        // An emptied timeline is a whole-timeline commit: nothing the current
        // projection revision covers can be stale in an empty DOM.
        uiRuntime.projectionCommittedRevisionKey = projectionRevisionKey;
        uiRuntime.approvalCardKey = approvalCardKey;
        // An empty transcript invalidates cached root markup so a later session cannot reuse stale HTML.
        uiRuntime.threadRootMarkupCache?.clear();
        chatTimeline.innerHTML = '';
        globalThis.markdownUtils?.pruneDetachedMermaidObservations?.(); // no later scan runs while the transcript stays empty
        // Arm only when the write will actually move the viewport: a no-op
        // reset must not leave a live marker that could excuse the next
        // genuine unattributed jump inside the marker TTL.
        if (chatThreadScroll.scrollTop !== 0) {
          noteScrollProgrammaticWrite('empty_transcript_reset');
        }
        chatThreadScroll.scrollTop = 0;
        thinkingController.resumeAutoScroll();
        setFollowLatest(true);
        hideAssistantSprite({ clearTarget: true });
        syncTimelineBusyState();
        syncPostRenderChrome();
        markCatchupFullRenderFallback('no_messages');
        return;
      }

      if (
        !forceFullRender
        && !recapExpansionChanged
        && !threadExpansionChanged
        && !catchupActive
        && uiRuntime.messageRenderSignature === messageRenderSignature
      ) {
        runPostTimelineRenderEffects(messages, { syncChrome: true });
        updateAssistantSpritePosition(messages, derived);
        noteStreamRender('noop');
        return;
      }

      const timelineDividers = deriveTimelineTimeDividers(threadTree, {
        includeChildren(node) {
          return !shouldShowThreadToggle(node)
            || isThreadBranchOpen(node, paneSessionId, forcedOpenIds);
        },
      });
      const timelineDividerByMessageId = buildTimeDividerMap(timelineDividers);
      if (projectionContext && typeof projectionContext === 'object') {
        projectionContext.timelineDividerByMessageId = timelineDividerByMessageId;
      }

      let canPatchStreamingMessage = canPatchStreamRevealMessage({
        currentSessionId: paneSessionId,
        messages,
        latestAssistantMessageId,
        structureSignature,
        streamingMessage: derived.streamingMessage,
      });
      if (!canPatchStreamingMessage && catchupActive && derived.streamingMessage) {
        const streamingMessageId = String(derived.streamingMessage.id || '').trim();
        const streamingArticleMessageId = resolveTurnArticleMessageId(
          streamingMessageId,
          projectionContext
        );
        const hasStreamingArticle = resolveVisibleTurnArticleTarget(
          streamingMessageId,
          projectionContext
        );
        if (hasStreamingArticle) {
          const streamingRowTarget = resolveProjectionStreamingRowTarget(projectionContext);
          commitStreamRevealFullRender({
            currentSessionId: paneSessionId,
            structureSignature,
            streamingMessage: derived.streamingMessage,
            streamingArticleMessageId,
            streamingRowTarget: toStreamingRowTargetPayload(streamingRowTarget),
            activeTurnRootMessageId: projectionContext?.activeTurnRootMessageId || '',
            activeTurnStructureHash: projectionContext?.activeTurnStructureHash || 0,
            activeTurnTailFingerprint: projectionContext?.activeTurnTailFingerprint || '',
          });
          canPatchStreamingMessage = true;
        } else {
          markCatchupFullRenderFallback('missing_streaming_article', {
            streamingMessageId,
            streamingArticleMessageId,
          });
        }
      }

      if (
        catchupActive
        && !forceFullRender
        && !projectionRevisionChanged
        && !recapExpansionChanged
        && !threadExpansionChanged
        && derived.streamingMessage
      ) {
        const streamingMessageId = String(derived.streamingMessage.id || '').trim();
        const article = resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext);
        if (patchVisibleStreamingArticle(derived.streamingMessage, article)) {
          markCatchupPatched('stream_reveal', { messageId: streamingMessageId });
          return;
        }
      }

      if (
        !forceFullRender
        && !projectionRevisionChanged
        && !recapExpansionChanged
        && !threadExpansionChanged
        && canPatchStreamingMessage) {
        uiRuntime.threadBranchSignature = threadExpansionSignature;
        const streamingRowTarget = resolveProjectionStreamingRowTarget(projectionContext);
        queueStreamRevealPatch({
          currentSessionId: paneSessionId,
          messages,
          latestAssistantMessageId,
          structureSignature,
          streamingMessage: derived.streamingMessage,
          streamingRowTarget: toStreamingRowTargetPayload(streamingRowTarget),
          state: state,
          ...createStreamRevealPatchCallbacks({
            uiRuntime,
            chatTimeline,
            messages,
            threadTree,
            derived,
            projectionContext,
            streamingRowTarget,
            latestAssistantMessageId,
            latestReplyAssistantMessageId,
            followUpDisabledReason,
            latestRegenerateRequest,
            structureSignature,
            forcedOpenIds,
            timelineDividerByMessageId,
            messageFingerprints,
            messageRenderSignature,
            recapExpansionSignature,
            threadExpansionSignature,
            projectionRevisionKey,
            resolveFollowUpDisabledReason,
            resolveRegenerateRequest,
            buildMessageInnerMarkup,
            buildMessageArticleInnerHtml,
            buildProjectionStreamingRowMarkup,
            resolveVisibleTurnArticleTarget,
            resolveTurnArticleMessageId,
            buildMessageArticleMarkup,
            noteStreamRender,
            runPostTimelineRenderEffects,
            markCatchupPatched,
            recordTurnArticleRolloutSignal,
            markCatchupFullRenderFallback,
            resolveFullRenderReason,
            performFullMessageRender: renderFullTimeline,
          }),
        });
        return;
      }

      const streamingMessageId = String(derived.streamingMessage?.id || '').trim();
      if (
        !forceFullRender
        && !projectionRevisionChanged
        && !recapExpansionChanged
        && !threadExpansionChanged
        && !catchupActive
        && derived.streamingMessage
        && !isRowlessShellOfVisibleTurn(streamingMessageId, projectionContext)
      ) {
        const streamingArticleMessageId = resolveTurnArticleMessageId(
          streamingMessageId,
          projectionContext
        );
        const hasStreamingArticle = resolveVisibleTurnArticleTarget(
          streamingMessageId,
          projectionContext
        );
        // Charged directly, not through the ladder: this branch is only
        // reachable once canPatch already failed, so the ladder would always
        // shadow it with a generic cannot_patch:* and bury the one fact that
        // matters here. A turn-root attempt in 38356436 was reverted because
        // patching the root instead of running a full render left
        // style.minHeight on the newborn article: schedulePredictedHeightCleanup
        // cancels and reschedules on every call, intermittently failing the
        // pretext predicted-height test. Any future attempt must handle
        // predicted-height cleanup explicitly on the patched path.
        const commitSignatureHoldFullRender = (reason) => {
          noteStreamRender('full', reason);
          renderFullTimeline(
            messages,
            threadTree,
            latestAssistantMessageId,
            latestReplyAssistantMessageId,
            followUpDisabledReason,
            latestRegenerateRequest,
            structureSignature,
            derived,
            forcedOpenIds,
            projectionContext,
            timelineDividerByMessageId,
            messageFingerprints
          );
          uiRuntime.messageRenderSignature = messageRenderSignature;
          uiRuntime.recapExpansionSignature = recapExpansionSignature;
          uiRuntime.threadBranchSignature = threadExpansionSignature;
          uiRuntime.projectionCommittedRevisionKey = projectionRevisionKey;
          uiRuntime.approvalCardKey = approvalCardKey;
          runPostTimelineRenderEffects(messages, {
            decorateFollowUps: true,
            syncViewport: true,
            syncChrome: true,
          });
        };
        if (!hasStreamingArticle) {
          recordTurnArticleRolloutSignal('turn_article_stream_mismatch', {
            streamingMessageId,
            streamingArticleMessageId,
            phase: 'signature_hold',
          });
          commitSignatureHoldFullRender('missing_streaming_article');
          return;
        }
        const streamingRowTarget = resolveProjectionStreamingRowTarget(projectionContext);
        commitStreamRevealFullRender({
          currentSessionId: paneSessionId,
          structureSignature,
          streamingMessage: derived.streamingMessage,
          streamingArticleMessageId,
          streamingRowTarget: toStreamingRowTargetPayload(streamingRowTarget),
          activeTurnRootMessageId: projectionContext?.activeTurnRootMessageId || '',
          activeTurnStructureHash: projectionContext?.activeTurnStructureHash || 0,
          activeTurnTailFingerprint: projectionContext?.activeTurnTailFingerprint || '',
        });
        if (!patchVisibleStreamingArticle(derived.streamingMessage, hasStreamingArticle)) {
          // The rebuild refused to collapse a row-model article (HB-006):
          // committing the signatures here would freeze the stale DOM.
          commitSignatureHoldFullRender('streaming_article_rewrite_refused');
        }
        return;
      }

      if (
        !forceFullRender
        && !projectionRevisionChanged
        && !recapExpansionChanged
        && !threadExpansionChanged
        && tryPatchActiveTurnRoot(
          messages,
          threadTree,
          forcedOpenIds,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          latestRegenerateRequest,
          structureSignature,
          projectionContext,
          timelineDividerByMessageId
        )) {
        uiRuntime.messageRenderSignature = messageRenderSignature;
        uiRuntime.recapExpansionSignature = recapExpansionSignature;
        uiRuntime.threadBranchSignature = threadExpansionSignature;
        runPostTimelineRenderEffects(messages, {
          decorateFollowUps: true,
          inlineMermaidStreaming: true,
          cleanupPredictedHeights: true,
          syncViewport: true,
          syncChrome: true,
        });
        markCatchupPatched('active_turn_root');
        noteStreamRender('patch');
        return;
      }

      if (derived.streamingMessage) {
        const streamingMessageId = String(derived.streamingMessage.id || '').trim();
        const streamingArticleMessageId = resolveTurnArticleMessageId(
          streamingMessageId,
          projectionContext
        );
        if (!resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext)) {
          recordTurnArticleRolloutSignal('turn_article_stream_mismatch', {
            streamingMessageId,
            streamingArticleMessageId,
            phase: 'full_render',
          });
        }
      }

      noteStreamRender('full', resolveFullRenderReason('final_full_render'));
      renderFullTimeline(
        messages,
        threadTree,
        latestAssistantMessageId,
        latestReplyAssistantMessageId,
        followUpDisabledReason,
        latestRegenerateRequest,
        structureSignature,
        derived,
        forcedOpenIds,
        projectionContext,
        timelineDividerByMessageId,
        messageFingerprints
      );
      markCatchupFullRenderFallback('final_full_render');
      uiRuntime.messageRenderSignature = messageRenderSignature;
      uiRuntime.recapExpansionSignature = recapExpansionSignature;
      uiRuntime.threadBranchSignature = threadExpansionSignature;
      uiRuntime.projectionCommittedRevisionKey = projectionRevisionKey;
      uiRuntime.approvalCardKey = approvalCardKey;

      if (shouldAnimateActivation) {
        scheduleThreadTransitionCleanup();
      }
      runPostTimelineRenderEffects(messages, {
        decorateFollowUps: true,
        syncViewport: true,
        syncChrome: true,
      });
    }

    return { renderMessages };
  }

  return {
    createRenderPipelineMessageRenderer,
  };
});
