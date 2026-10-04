(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineMessageRenderer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
  const renderSignatureUtils = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineRenderSignatures)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-render-signatures') : null)
    || {};
  // CTL-004: pure ref-refresh helpers for the #15 structural-signature cache
  // hit path below -- see renderer-render-pipeline-projection-cache.js for
  // the mechanism. Loaded the same way as the sibling UMD modules above so
  // it resolves off the already-loaded global in the browser (this module
  // loads after projection-cache.js in index.html) or via require() in Node.
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

    function renderMessages(options = {}) {
      const paneSessionId = getPaneSessionId();
      const timeFormat = globalThis.jennyI18n?.timeOptions?.().hourCycle || '';
      // A4: an approval card's state (live, paused, inactive) moves without any
      // message changing, so neither the no-op guard, the settled-root memo nor
      // a streaming patch would repaint it. Committed only by a full render.
      const approvalCardKey = globalThis.rendererApprovalBlock?.approvalCardStateKey?.(state, paneSessionId) || '';
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
      // The pane's timeline carries the view for the stylesheet (per pane, not
      // per document: split view shows two sessions). Written only on change.
      if (chatTimeline.dataset && chatTimeline.dataset.transcriptView !== transcriptView) {
        const previousView = chatTimeline.dataset.transcriptView || '';
        chatTimeline.dataset.transcriptView = transcriptView;
        // Pane-scoped notice (cluster control, search overlay): a switch or a
        // pane session change, never a per-delta write.
        const EventCtor = chatTimeline.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
        if (typeof EventCtor === 'function') {
          chatTimeline.dispatchEvent(new EventCtor('transcript-view-rendered', {
            detail: { view: transcriptView, previousView, sessionId: paneSessionId },
          }));
        }
      }
      // A forced render wants fresh markup: settled roots cache message-keyed
      // HTML that cannot see ambient state (e.g. a materialized tool disclosure).
      if (forceFullRender) {
        uiRuntime.threadRootMarkupCache?.clear();
      }
      // Reflect shared display flags onto the root dataset so the pure row
      // builders read them without threading state through the whole render
      // pipeline. Per document only: per-pane state such as the transcript
      // view travels through render options instead.
      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        const featureFlags = state?.features?.featureFlags || state?.featureFlags || {};
        // reasoning_prettify: joinReasoningEntriesMarkdown
        // (chat-thinking-utils.js) reads it back to gate display-time
        // whitespace repair of glued thinking text. Write only on change: the
        // flag is stable for a session, so this avoids a dataset mutation (and
        // its attribute-selector style invalidation) on every streaming repaint.
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
      // Split view W0-5: the prune keeps the RETAINED set, which with one pane
      // is exactly `[state.currentSessionId]` -- the argument this passed before.
      pruneToolRowProjectionSessionCaches(resolveRetainedSessionIds(state));
      function resolveFollowUpDisabledReason() {
        if (state.ui?.branchCommitting === true) {
      return jt('chat.messageRenderer.waitForBranch', 'Wait for the branch to finish before trying that.');
        }
        if (isSendBusy() || isSendPreflightPending()) {
      return jt('shell.fallback.waitForCurrentResponse', 'Wait for the current response to finish before trying that.');
        }
        if (!state.auth?.authenticated) {
      return jt('chat.messageRenderer.signInBeforeTrying', 'Sign in before trying that.');
        }
        // model_unavailable keeps follow-up actions live: regenerate /
        // edit-and-resend retry the model load, matching the composer gates
        // in renderer-render-pipeline-chrome.js and renderer-send-utils.js.
        if (!['ready', 'model_unavailable'].includes(String(state.backend?.phase || '').trim())) {
      return jt('chat.messageRenderer.waitForBackend', 'Wait for Jenny to finish connecting before trying that.');
        }
        return '';
      }

      const sourceMessages = getVisibleSessionMessages(paneSessionId);
      // #15: reuse the canonical transcript + thread tree across renders whose
      // source structure is unchanged (text-streaming frames, chrome-only
      // renders, thread/recap toggles). Both builds are pure structural
      // transforms whose output arrays hold the live message refs, so cached
      // results stay content-current; the per-render fingerprints + structureHash
      // below still drive the actual render decision. forceFullRender bypasses
      // the cache.
      const sourceStructureSignature = paneSessionId
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
        const streamingMessageId = String(streamingMessage?.id || '').trim();
        let article = articleOverride || resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext);
        if (!streamingMessageId || !article) {
          return false;
        }
        const articleMessageId = String(
          article.getAttribute?.('data-message-id')
          || resolveTurnArticleMessageId(streamingMessageId, projectionContext)
        ).trim();
        const articleMessageMatch = messages.find(
          (message) => String(message?.id || '').trim() === articleMessageId
        );
        const articleMessage = articleMessageMatch || streamingMessage;
        // timeline-perf 2026-09-30: the row segments let the morph below
        // reconcile the turn row list per row (settled rows keep their
        // reconcile stamps) instead of morphing every row of the turn.
        const rowListSegments = [];
        const nextArticleMarkup = buildMessageArticleMarkup(
          articleMessage,
          messages,
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          followUpDisabledReason,
          String(articleMessage.id || '') === latestReplyAssistantMessageId ? latestRegenerateRequest : null,
          projectionContext,
          { rowListSegmentSink: rowListSegments }
        );
        const template = article.ownerDocument?.createElement?.('template') || null;
        let nextArticle = null;
        if (template) {
          template.innerHTML = String(nextArticleMarkup || '').trim();
          nextArticle = template.content.querySelector('.chat-entry[data-message-id]');
        }
        // HB-006: under turn_activity_envelope the live article hosts the WHOLE
        // turn's row list. When the dispatcher answers with a compat stub (the
        // anchor moved, or the article's message fell out of `messages` and the
        // streaming segment stood in), the legacy branch below wrote only that
        // segment's reasoning into the host and wiped every other row until a
        // later full render. Refuse, and let the caller render the timeline.
        const hostsRowList = Boolean(article.querySelector?.('[data-turn-row-list]'));
        const refusal = nextArticle
          ? (hostsRowList && !nextArticle.querySelector('[data-turn-row-list]') ? 'refused_row_list_collapse' : '')
          : (hostsRowList ? 'refused_row_list_collapse' : (articleMessageMatch ? '' : 'refused_article_fallback'));
        if (refusal) {
          recordStreamingArticleRebuild({ turnId: articleMessageId, streamingMessageId, outcome: refusal });
          return false;
        }
        noteStructuralRewrite();
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
              {
                collectStats: state?.features?.featureFlags?.chat_timeline_render_telemetry === true,
                rowListSegments: hostsRowList && rowListSegments.length ? rowListSegments : null,
              }
            );
            rebuildOutcome = String(result?.outcome || 'morph_unavailable');
            rebuildStats = result?.stats;
            if (result?.rowList) {
              const rowStats = result.rowList.stats || {};
              rebuildStats = { ...(rebuildStats || {}), row_list: result.rowList.outcome, kept: rowStats.kept, morphed: rowStats.morphed, added: rowStats.added };
              streamClientMetrics?.noteRowListMorph?.(getPaneSessionId(), {
                reason: 'article_rewrite',
                rowsReused: Number(rowStats.kept) || 0,
                rowsRebuilt: (Number(rowStats.morphed) || 0) + (Number(rowStats.added) || 0),
              });
            }
            if (rebuildOutcome !== 'morph_applied') {
              article = resolveVisibleTurnArticleTarget(streamingMessageId, projectionContext) || article;
            }
          } else {
            // The rollback path (chat_timeline_streaming_article_morph off)
            // shares morphNode's attribute diff (syncElementAttributes) rather
            // than a second hand-rolled copy that fixes would skip. Optional-
            // called: without the module setOuterHtmlPreservingCodeScroll is
            // gone too, and an unsynced attribute is not worth throwing over.
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
