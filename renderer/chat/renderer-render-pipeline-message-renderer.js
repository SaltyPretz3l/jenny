(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineMessageRenderer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Ht-D: syncChatEntryCvExemptAttribute keeps the paint-skip exemption
  // attribute in lockstep with the 'pending' class on the narrow patch path
  // below (which bypasses a full markup rebuild).
  const turnShellUtils = (typeof globalThis !== 'undefined' && globalThis.rendererTurnShell)
    || (typeof require === 'function' ? require('./renderer-turn-shell') : null)
    || {};
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
  // CTL-004: pure ref-refresh helpers for the #15 structural-signature cache
  // hit path below -- see renderer-render-pipeline-projection-cache.js for
  // the mechanism. Loaded the same way as the sibling UMD modules above so
  // it resolves off the already-loaded global in the browser (this module
  // loads after projection-cache.js in index.html) or via require() in Node.
  const projectionCacheRefreshUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineProjectionCacheUtils)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
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
    const noteStreamRender = (kind, reason) => streamClientMetrics?.noteRenderForSession(state.currentSessionId, kind, reason);

    // #15: cheap structural signature over the RAW source messages, used to skip
    // the two heavy O(n) builds (canonical transcript + thread tree) when the
    // transcript STRUCTURE is unchanged. Settled message content is intentionally
    // excluded; STREAMING messages additionally contribute their content/reasoning
    // growth because the delta commit replaces the message object (see the
    // streaming block inside buildSourceStructureSignature), and the
    // per-render fingerprints/structureHash below still drive the render decision.
    // The signature MUST capture every projection-affecting field that can change
    // via OBJECT REPLACEMENT (not in-place mutation): when such a field flips, the
    // owner replaces the message object in the session store, so reusing the cached
    // canonical array would serve a stale ref and silently suppress the re-projection.
    // The tool lifecycle status is exactly such a field — handleApprovalNeeded
    // replaces a tool_use message to flip tool_call.status 'running' ->
    // 'pending_approval', and the turn projector keys the approval_gap row on that
    // status; omitting it here is what made the live approve/deny prompt never
    // render. `send_failure` is another such field — annotateUserSendFailureInStore
    // and the failed-send-notice onDismiss replace the user message to add/flip
    // send_failure.{state,dismissed}, which the user bubble's "Failed to send" chip
    // keys on; omitting it here left the chip stale (never appeared after a failed
    // send in an existing session, never cleared on dismiss). Keep this field set
    // reconciled with buildToolCall/ToolResultSignature.
    function buildSourceStructureSignature(list) {
      const messages = Array.isArray(list) ? list : [];
      const parts = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message) {
          continue;
        }
        const kind = String(message.kind || '');
        const status = String(message.status || '');
        const fields = [
          String(message.id || ''),
          String(message.role || ''),
          kind,
          status,
          String(message.finalizedAt || ''),
          String(message.streamId || ''),
          String(message.parent_stream_id || ''),
          Array.isArray(message.phases) ? message.phases.length : 0,
          Array.isArray(message.reasoning_phases) ? message.reasoning_phases.length : 0,
          Array.isArray(message.tool_steps) ? message.tool_steps.length : 0,
          Array.isArray(message.attachments) ? message.attachments.length : 0,
          String((message.tool_call && message.tool_call.status) || ''),
          String((message.tool_result && message.tool_result.status) || ''),
          String((message.send_failure && message.send_failure.state) || ''),
          String(message.send_failure && message.send_failure.dismissed ? '1' : ''),
        ];
        // Streaming content/reasoning growth is deliberately NOT part of this
        // signature (CTL-012): growth frames are structure-stable cache HITS.
        // Object-replacement staleness is handled on the hit path by the
        // CTL-004 ref refresh (refreshCanonicalMessageRefs /
        // refreshCanonicalThreadTreeRefs), and the render decision rides the
        // fixed-size object-revision fingerprints, so every replacement delta
        // still paints without rebuilding the whole-transcript
        // canonical array + thread tree per token frame. Anti-freeze contract
        // pinned in tests/renderer-render-pipeline-settled-refresh.test.js.
        if (kind === 'interactive_round_recap' && message.interactive_round_recap) {
          fields.push(JSON.stringify(message.interactive_round_recap));
        }
        parts.push(fields.join('|'));
      }
      return parts.join('\n');
    }

    // Ambient UI state that article rendering reads (edit target, selection
    // mode + selected set) but that lives on state.ui, NOT on any message object,
    // so it is invisible to the content-only render fingerprints. Entering edit
    // swaps the user bubble for the inline editor (article-markup) and selection
    // mounts per-row handles/chrome — both only during a full markup build. The
    // controllers trigger these via a plain renderAll()/renderMessages() with no
    // force, so without folding this into messageRenderSignature the whole-
    // transcript no-op guard held on a settled timeline and the editor/handles
    // never mounted. Idle (no edit target, selection off) yields a stable empty
    // suffix, so this is byte-inert for untouched transcripts. Selection folds the
    // MEMBERSHIP (sorted ids), not just the size — deselect-A-then-select-B keeps
    // size 1 but must re-render the moved selected chrome.
    function buildAmbientUiSignature() {
      const ui = (state && state.ui) || {};
      const editingId = String(ui.editingMessageId || '');
      const selectionActive = ui.selectionMode === true;
      let selectedSignature = '';
      if (selectionActive && ui.selectedMessageIdsBySession
        && typeof ui.selectedMessageIdsBySession.get === 'function') {
        const set = ui.selectedMessageIdsBySession.get(state.currentSessionId);
        if (set && typeof set.forEach === 'function') {
          const ids = [];
          set.forEach((id) => { ids.push(String(id)); });
          ids.sort();
          selectedSignature = ids.join(',');
        }
      }
      return 'E:' + editingId + 'B:' + (ui.branchCommitting === true ? '1' : '')
        + 'S:' + (selectionActive ? '1' : '') + 'SEL:' + selectedSignature;
    }

    const appendClientLog = asFn(callbacks.appendClientLog, noop);
    const buildCanonicalTranscriptMessages = asFn(callbacks.buildCanonicalTranscriptMessages, (messages) => (
      Array.isArray(messages) ? messages : []
    ));
    const buildMessageArticleInnerHtml = asFn(callbacks.buildMessageArticleInnerHtml, noopEmptyString);
    const buildMessageArticleMarkup = asFn(callbacks.buildMessageArticleMarkup, noopEmptyString);
    const buildMessageInnerMarkup = asFn(callbacks.buildMessageInnerMarkup, () => ({
      innerHtml: '',
      pending: false,
      entryReveal: false,
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
    // CTL-004: refresh the #15 cache's object refs on a structural-signature
    // hit (see the call site below); fall back to identity if the sibling
    // module didn't resolve so a cache hit still degrades to "reuse as-is"
    // (the pre-fix behavior) rather than throwing.
    const refreshCanonicalMessageRefs = asFn(
      projectionCacheRefreshUtils.refreshCanonicalMessageRefs,
      (cachedMessages) => (Array.isArray(cachedMessages) ? cachedMessages : [])
    );
    const refreshCanonicalThreadTreeRefs = asFn(
      projectionCacheRefreshUtils.refreshCanonicalThreadTreeRefs,
      (threadTree) => threadTree
    );
    // Shared id-index builder so a cache hit indexes sourceMessages once for
    // both refreshes; null fallback makes each refresh build its own.
    const buildCanonicalMessageIdIndex = asFn(
      projectionCacheRefreshUtils.buildMessageIdIndex,
      () => null
    );
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

    function renderMessages(options = {}) {
      const forceFullRender = options?.forceFullRender === true || options?.forceLegacyRowModelFallback === true;
      if (!chatTimeline || !chatThreadScroll) {
        return;
      }
      // A forced render is also a request for fresh article markup. Settled
      // roots normally reuse cached HTML whose key is message-derived; ambient
      // renderer state such as a lazily materialized tool disclosure is not.
      // Drop the cache once here so the full render below rebuilds and recaches
      // the current disclosure state instead of serving the collapsed root.
      if (forceFullRender) {
        uiRuntime.threadRootMarkupCache?.clear();
      }
      // Reflect the shared response_loop_display_v2 flag onto the root dataset so
      // the pure row builders (renderer-turn-row-list-utils.js) gate the
      // commentary/intermediate de-emphasis without threading state through the
      // whole render pipeline — mirrors how timelineStyle is read off the root.
      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        const featureFlags = state?.features?.featureFlags || state?.featureFlags || {};
        const nextResponseLoopDisplay = featureFlags.response_loop_display_v2 === true ? 'true' : 'false';
        // Write only on change: the flag is stable for a session, so this avoids a
        // dataset mutation (and its attribute-selector style invalidation) on every
        // streaming repaint. Unlike timelineStyle (written once on appearance-apply),
        // this lives on the render path, so the guard keeps it effectively write-once.
        if (document.documentElement.dataset.responseLoopDisplay !== nextResponseLoopDisplay) {
          document.documentElement.dataset.responseLoopDisplay = nextResponseLoopDisplay;
        }
        // reasoning_prettify rides the same dataset-reflection channel:
        // joinReasoningEntriesMarkdown (chat-thinking-utils.js) reads it back
        // to gate display-time whitespace repair of glued thinking text.
        const nextReasoningPrettify = featureFlags.reasoning_prettify === false ? 'false' : 'true';
        if (document.documentElement.dataset.reasoningPrettify !== nextReasoningPrettify) {
          document.documentElement.dataset.reasoningPrettify = nextReasoningPrettify;
        }
        // turn_activity_envelope rides the same dataset-reflection channel: the
        // pure article/row builders read it back without threading state.
        const nextTurnActivityEnvelope = featureFlags.turn_activity_envelope === true ? 'true' : 'false';
        if (document.documentElement.dataset.turnActivityEnvelope !== nextTurnActivityEnvelope) {
          document.documentElement.dataset.turnActivityEnvelope = nextTurnActivityEnvelope;
        }
        // chat_render_content_visibility (Ht-D) rides the same channel, but
        // OFF means the attribute is ABSENT (not 'false') so the CSS
        // attribute-selector rule in chat-thread.css is inert and markup
        // stays byte-identical pre-Ht-D — jsdom-pinnable per the design spec.
        if (featureFlags.chat_render_content_visibility === true) {
          if (document.documentElement.dataset.chatContentVisibility !== 'on') {
            document.documentElement.dataset.chatContentVisibility = 'on';
          }
        } else if (document.documentElement.dataset.chatContentVisibility !== undefined) {
          delete document.documentElement.dataset.chatContentVisibility;
        }
      }
      pruneToolRowProjectionSessionCaches(state.currentSessionId);
      function resolveFollowUpDisabledReason() {
        if (state.ui?.branchCommitting === true) {
          return 'Wait for the branch to finish before trying that.';
        }
        if (isSendBusy() || isSendPreflightPending()) {
          return 'Wait for the current response to finish before trying that.';
        }
        if (!state.auth?.authenticated) {
          return 'Sign in before trying that.';
        }
        // model_unavailable keeps follow-up actions live: regenerate /
        // edit-and-resend retry the model load, matching the composer gates
        // in renderer-render-pipeline-chrome.js and renderer-send-utils.js.
        if (!['ready', 'model_unavailable'].includes(String(state.backend?.phase || '').trim())) {
          return 'Wait for Jenny to finish connecting before trying that.';
        }
        return '';
      }

      const sourceMessages = getCurrentVisibleMessages();
      // #15: reuse the canonical transcript + thread tree across renders whose
      // source structure is unchanged (text-streaming frames, chrome-only
      // renders, thread/recap toggles). Both builds are pure structural
      // transforms whose output arrays hold the live message refs, so cached
      // results stay content-current; the per-render fingerprints + structureHash
      // below still drive the actual render decision. forceFullRender bypasses
      // the cache.
      const sourceStructureSignature = String(state.currentSessionId || '')
        + '\n#\n' + buildSourceStructureSignature(sourceMessages);
      let messages;
      let threadTree;
      if (
        !forceFullRender
        && uiRuntime.canonicalBuildSignature === sourceStructureSignature
        && Array.isArray(uiRuntime.cachedCanonicalMessages)
        && uiRuntime.cachedThreadTree
      ) {
        // CTL-004: a structural-signature match only guarantees STRUCTURE
        // parity (same ids, same order) -- it does NOT guarantee the cached
        // arrays' object refs are current, because every settled-content
        // update here is an OBJECT REPLACEMENT, not an in-place mutation.
        // Refresh both cached views to the CURRENT source objects by id
        // (cheap O(n), no rebuild) so the fingerprint pass below sees fresh
        // content instead of a frozen-in-time ref.
        const sourceMessageIdIndex = buildCanonicalMessageIdIndex(sourceMessages);
        messages = refreshCanonicalMessageRefs(
          uiRuntime.cachedCanonicalMessages, sourceMessages, sourceMessageIdIndex
        );
        threadTree = refreshCanonicalThreadTreeRefs(
          uiRuntime.cachedThreadTree, sourceMessages, sourceMessageIdIndex
        );
        uiRuntime.cachedCanonicalMessages = messages;
        uiRuntime.cachedThreadTree = threadTree;
      } else {
        messages = buildCanonicalTranscriptMessages(sourceMessages);
        threadTree = buildTranscriptThreadTree(messages, { buildInteractiveRecapViewModel: callbacks.buildInteractiveRecapModel });
        uiRuntime.cachedCanonicalMessages = messages;
        uiRuntime.cachedThreadTree = threadTree;
        uiRuntime.canonicalBuildSignature = sourceStructureSignature;
      }
      pruneRecapExpansionState(state.currentSessionId, messages);
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
      pruneThreadBranchState(state.currentSessionId, threadTree);
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
        + 'AUI:' + buildAmbientUiSignature()
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
      const recapExpansionSignature = buildRecapExpansionSignature(messages, state.currentSessionId);
      const recapExpansionChanged = uiRuntime.recapExpansionSignature !== recapExpansionSignature;
      const threadExpansionSignature = buildThreadExpansionSignature(threadTree, state.currentSessionId, forcedOpenIds);
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
      });
      const catchupActive = renderLadder.catchupActive;
      const {
        resolveFullRenderReason,
        markCatchupPatched,
        markCatchupFullRenderFallback,
        recordStreamingArticleRebuild,
      } = renderLadder;

      function patchVisibleStreamingArticle(streamingMessage, articleOverride) {
        const streamingMessageId = String(streamingMessage?.id || '').trim();
        let article = articleOverride || resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext);
        if (!streamingMessageId || !article) {
          return false;
        }
        const articleMessageId = String(
          article.getAttribute?.('data-message-id')
          || resolveTurnArticleMessageId(streamingMessageId, projectionContext)
        ).trim();
        const articleMessage = messages.find(
          (message) => String(message?.id || '').trim() === articleMessageId
        ) || streamingMessage;
        const nextArticleMarkup = buildMessageArticleMarkup(
          articleMessage,
          messages,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          String(articleMessage.id || '') === latestReplyAssistantMessageId ? latestRegenerateRequest : null,
          projectionContext
        );
        const template = article.ownerDocument?.createElement?.('template') || null;
        let nextArticle = null;
        if (template) {
          template.innerHTML = String(nextArticleMarkup || '').trim();
          nextArticle = template.content.querySelector('.chat-entry[data-message-id]');
        }
        let rebuildOutcome = 'raw_innerhtml';
        let rebuildStats;
        if (nextArticle) {
          const streamingArticleMorphEnabled =
            state?.features?.featureFlags?.chat_timeline_streaming_article_morph === true;
          if (
            streamingArticleMorphEnabled
            && typeof streamDomPatchUtils.setOuterHtmlPreservingCodeScroll === 'function'
          ) {
            const result = streamDomPatchUtils.setOuterHtmlPreservingCodeScroll(
              article,
              nextArticleMarkup,
              { collectStats: state?.features?.featureFlags?.chat_timeline_render_telemetry === true }
            );
            rebuildOutcome = String(result?.outcome || 'morph_unavailable');
            rebuildStats = result?.stats;
            if (rebuildOutcome !== 'morph_applied') {
              article = resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext) || article;
            }
          } else {
            // The rollback path (chat_timeline_streaming_article_morph off).
            // It used to hand-roll the attribute diff morphNode already does
            // via syncElementAttributes -- the same two loops kept in a second
            // copy behind a flag, which is how a fix to one silently stops
            // applying to the other. Same semantics on this target: the shared
            // version skips a setAttribute whose value is already equal (one
            // less needless mutation to restart a CSS transition with), and
            // its .chat-thread-root style carve-out cannot fire here because
            // this element is always a .chat-entry. Optional-called like the
            // pipeline's other borrowed helpers: if the module did not resolve
            // then setOuterHtmlPreservingCodeScroll is gone too, and an
            // unsynced attribute is not the problem worth throwing over.
            article.innerHTML = nextArticle.innerHTML;
            streamDomPatchUtils.syncElementAttributes?.(article, nextArticle);
          }
          recordStreamingArticleRebuild({
            turnId: articleMessageId,
            streamingMessageId,
            outcome: rebuildOutcome,
            stats: rebuildStats,
          });
        } else {
          const nextMessageModel = buildMessageInnerMarkup(
            streamingMessage,
            messages,
            latestAssistantMessageId,
            latestReplyAssistantMessageId,
            followUpDisabledReason,
            latestRegenerateRequest,
            projectionContext
          );
          const nextInnerHtml = buildMessageArticleInnerHtml(streamingMessage, nextMessageModel.innerHtml);
          // The helper always returns an { outcome } record, so a nullish result
          // means only that the module did not resolve -- the last-resort write.
          if (!streamDomPatchUtils.setInnerHtmlPreservingCodeScroll?.(article, nextInnerHtml)) {
            article.innerHTML = nextInnerHtml;
          }
          article.classList.toggle('pending', nextMessageModel.pending);
          turnShellUtils.syncChatEntryCvExemptAttribute?.(article, { pending: nextMessageModel.pending });
          article.classList.toggle('stream-reveal-entry', nextMessageModel.entryReveal);
          article.dataset.messageStatus = nextMessageModel.status;
          article.dataset.finalizedAt = nextMessageModel.finalizedAt;
          recordStreamingArticleRebuild({
            turnId: articleMessageId,
            streamingMessageId,
            outcome: 'legacy_article_innerhtml',
          });
        }
        // The rebuild replaced the live reasoning panel with a settled, hidden
        // one; replay the eased hand-off before this task paints.
        replayStreamRevealHandoff();
        // Through the single writer, so rebuilding one article cannot leave the
        // previous streaming article still marked.
        stampStreamingArticleMarkerNode(article, streamingMessageId, chatTimeline);
        uiRuntime.messageRenderSignature = messageRenderSignature;
        uiRuntime.recapExpansionSignature = recapExpansionSignature;
        uiRuntime.threadBranchSignature = threadExpansionSignature;
        runPostTimelineRenderEffects(messages, {
          decorateFollowUps: true,
          inlineMermaidStreaming: true,
          syncViewport: true,
          syncChrome: true,
        });
        noteStreamRender('patch');
        return true;
      }

      state.ui.animateNextChatActivation = false;
      syncChatState(hasMessages, { animate: shouldAnimateActivation });
      syncPersistedReasoningPhaseExpansionState(state.currentSessionId, messages);
      thinkingController.prune(visibleThinkingMessageIds);

      if (!hasMessages) {
        resetStreamRevealState();
        uiRuntime.messageRenderSignature = '';
        uiRuntime.recapExpansionSignature = '';
        uiRuntime.threadBranchSignature = '';
        // An emptied timeline is a whole-timeline commit: nothing the current
        // projection revision covers can be stale in an empty DOM.
        uiRuntime.projectionCommittedRevisionKey = projectionRevisionKey;
        // An empty transcript invalidates cached root markup so a later session cannot reuse stale HTML.
        uiRuntime.threadRootMarkupCache?.clear();
        chatTimeline.innerHTML = '';
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
            || isThreadBranchOpen(node, state.currentSessionId, forcedOpenIds);
        },
      });
      const timelineDividerByMessageId = buildTimeDividerMap(timelineDividers);
      if (projectionContext && typeof projectionContext === 'object') {
        projectionContext.timelineDividerByMessageId = timelineDividerByMessageId;
      }

      let canPatchStreamingMessage = canPatchStreamRevealMessage({
        currentSessionId: state.currentSessionId,
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
            currentSessionId: state.currentSessionId,
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
          currentSessionId: state.currentSessionId,
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
            performFullMessageRender,
          }),
        });
        return;
      }

      if (
        !forceFullRender
        && !projectionRevisionChanged
        && !recapExpansionChanged
        && !threadExpansionChanged
        && !catchupActive
        && derived.streamingMessage
      ) {
        const streamingMessageId = String(derived.streamingMessage.id || '').trim();
        const streamingArticleMessageId = resolveTurnArticleMessageId(
          streamingMessageId,
          projectionContext
        );
        const hasStreamingArticle = resolveVisibleTurnArticleTarget(
          streamingMessageId,
          projectionContext
        );
        if (!hasStreamingArticle) {
          recordTurnArticleRolloutSignal('turn_article_stream_mismatch', {
            streamingMessageId,
            streamingArticleMessageId,
            phase: 'signature_hold',
          });
          // Charged directly, not through the ladder: this branch is only
          // reachable once canPatch already failed, so the ladder would always
          // shadow it with a generic cannot_patch:* and bury the one fact that
          // matters here -- the streaming article is not in the DOM at all.
          // A turn-root attempt in 38356436 was reverted because patching the
          // root instead of running a full render left style.minHeight on the
          // newborn article: schedulePredictedHeightCleanup cancels and
          // reschedules on every call, intermittently failing the pretext
          // predicted-height test. Any future attempt must handle predicted-
          // height cleanup explicitly on the patched path.
          noteStreamRender('full', 'missing_streaming_article');
          performFullMessageRender(
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
          runPostTimelineRenderEffects(messages, {
            decorateFollowUps: true,
            syncViewport: true,
            syncChrome: true,
          });
          return;
        }
        const streamingRowTarget = resolveProjectionStreamingRowTarget(projectionContext);
        commitStreamRevealFullRender({
          currentSessionId: state.currentSessionId,
          structureSignature,
          streamingMessage: derived.streamingMessage,
          streamingArticleMessageId,
          streamingRowTarget: toStreamingRowTargetPayload(streamingRowTarget),
          activeTurnRootMessageId: projectionContext?.activeTurnRootMessageId || '',
          activeTurnStructureHash: projectionContext?.activeTurnStructureHash || 0,
          activeTurnTailFingerprint: projectionContext?.activeTurnTailFingerprint || '',
        });
        if (patchVisibleStreamingArticle(derived.streamingMessage, hasStreamingArticle)) {
          return;
        }
        uiRuntime.messageRenderSignature = messageRenderSignature;
        uiRuntime.recapExpansionSignature = recapExpansionSignature;
        uiRuntime.threadBranchSignature = threadExpansionSignature;
        runPostTimelineRenderEffects(messages, { syncChrome: true });
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
      performFullMessageRender(
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
