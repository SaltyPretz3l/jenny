/* renderer/shell/renderer-viewport-utils.js – scroll / viewport / copy / thinking helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function getThreadTreeUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererThreadTreeUtils)
      || (typeof require === 'function' ? require('../chat/renderer-thread-tree-utils') : null)
      || {};
  }
  function getThreadStateUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineThreadStateUtils)
      || (typeof require === 'function' ? require('../chat/renderer-render-pipeline-thread-state') : null)
      || {};
  }
  const turnShellUtils = (typeof globalThis !== 'undefined' && globalThis.rendererTurnShell)
    || (typeof require === 'function' ? require('../chat/renderer-turn-shell') : null)
    || {};
  const viewportLayoutUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportLayoutUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-layout-utils') : null)
    || {};
  const viewportLiveFollowUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportLiveFollowUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-live-follow-utils') : null)
    || {};
  const viewportCopyFeedbackUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportCopyFeedbackUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-copy-feedback-utils') : null)
    || {};
  const viewportRecapUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportRecapUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-recap-utils') : null)
    || {};
  const viewportRevealUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportRevealUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-reveal-utils') : null)
    || {};
  const viewportSchedulingUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportSchedulingUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-scheduling-utils') : null) || {};
  const viewportThinkingPanelUtils = (typeof globalThis !== 'undefined' && globalThis.rendererViewportThinkingPanelUtils)
    || (typeof require === 'function' ? require('./renderer-viewport-thinking-panel-utils') : null) || {};
  const resolveVisibleMessageDomTarget = typeof turnShellUtils.resolveVisibleMessageDomTarget === 'function'
    ? turnShellUtils.resolveVisibleMessageDomTarget
    : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!container || !normalizedMessageId || typeof container.querySelector !== 'function') {
        return null;
      }
      return container.querySelector(`[data-message-id="${normalizedMessageId}"]`);
    };

  /* Minimum px clearance between chat-thread-stage bottom and composer top.
     Used by measureComposerSafeOffset() so the last visible message never
     sits flush against the composer chrome. */
  const SAFE_OFFSET_MINIMUM_PX = viewportLayoutUtils.SAFE_OFFSET_MINIMUM_PX || 28;
  const LIVE_FOLLOW_USER_OVERRIDE_PX = viewportLiveFollowUtils.LIVE_FOLLOW_USER_OVERRIDE_PX || 24;
  const READER_AWAY_PAUSE_REASON = 'reader_away';

  const COLLECTION_BRAND_PROBE = Object.freeze({});

  function hasNativeCollectionBrand(value, hasMethod) {
    if (!value) return false;
    try {
      hasMethod.call(value, COLLECTION_BRAND_PROBE);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isMapLike(value) {
    return hasNativeCollectionBrand(value, Map.prototype.has);
  }

  function isSetLike(value) {
    return hasNativeCollectionBrand(value, Set.prototype.has);
  }

  function createViewportController(deps) {
    const { state } = deps;
    const {
      MESSAGE_STATUS,
    } = deps.constants || {};
    const {
      chatView, chatSurfaceEffects, chatSurfaceEffectLeft,
      chatThreadStage, chatThreadColumn, composerWrap, chatTimeline, chatThreadScroll,
    } = deps.dom || {};
    const {
      mergeReasoningEntries,
      deriveFollowLatestFromScroll,
      shouldAutoScrollThread,
      escapeSelectorValue,
      getCurrentSessionMessages,
      buildInteractiveRecapViewModel,
      renderMessages,
      updateAssistantSpritePosition,
      appendClientLog = () => {},
    } = deps.callbacks || {};
    const {
      thinkingController,
      reducedMotionQuery,
      scrollCoordinator: initialScrollCoordinator = null,
      timelineVirtualizer: initialTimelineVirtualizer = null,
    } = deps.controllers || {};
    let scrollCoordinator = initialScrollCoordinator;
    let timelineVirtualizer = initialTimelineVirtualizer;

    let viewportDisposed = false; // guards transient thinking-panel rAF/timeout bodies post-dispose

    function requestViewportFrame(callback) {
      if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(callback);
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(callback);
      }
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        return window.setTimeout(() => callback(Date.now()), 16);
      }
      return 0;
    }

    function cancelViewportFrame(handle) {
      if (!handle) {
        return;
      }
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle);
        return;
      }
      if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(handle);
        return;
      }
      if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
        window.clearTimeout(handle);
      }
    }

    const liveFollowController = viewportLiveFollowUtils.createViewportLiveFollowUtils({
      state,
      chatThreadScroll,
      requestViewportFrame,
      cancelViewportFrame,
      noteProgrammaticWrite: (reason) => scrollCoordinator?.noteProgrammaticWrite?.(reason),
    });
    const {
      liveFollowRuntime,
      noteUserScrollIntent,
      clampProgrammaticScrollTop,
      cancelLiveStreamingFollow,
      startLiveStreamingFollow,
      snapThreadToBottom,
    } = liveFollowController;

    // The scheduling sibling needs layoutController's updateComposerSafeOffset,
    // and layoutController needs the scheduler back — late-bind the scheduler
    // side (only ever invoked from observers, after both exist).
    let schedulingController = null;
    let panelSyncController = null;
    const layoutController = viewportLayoutUtils.createViewportLayoutUtils({
      state,
      dom: {
        chatView,
        chatSurfaceEffects,
        chatSurfaceEffectLeft,
        chatThreadStage,
        chatThreadColumn,
        composerWrap,
      },
      callbacks: {
        getCurrentSessionMessages,
        scheduleMessageViewportSync: (messages, options) => schedulingController?.scheduleMessageViewportSync(messages, options),
      },
    });
    const {
      composerLayoutRuntime,
      getComposerSafeOffset,
      measureComposerSafeOffset,
      updateComposerSafeOffset,
      initializeComposerLayoutObserver,
      disposeComposerLayoutObserver,
    } = layoutController;
    const copyFeedbackController = viewportCopyFeedbackUtils.createViewportCopyFeedbackUtils({
      chatTimeline,
      documentRef: typeof document !== 'undefined' ? document : null,
      escapeSelectorValue,
    });
    const {
      clearCopyFeedback,
      showCopyFeedback,
      disposeCopyFeedback,
    } = copyFeedbackController;
    const viewportRevealController = viewportRevealUtils.createViewportRevealUtils({
      setFollowLatest,
      getScrollCoordinator: () => scrollCoordinator,
      reducedMotionQuery,
    });
    schedulingController = viewportSchedulingUtils.createViewportSchedulingUtils({
      state,
      readerAwayPauseReason: READER_AWAY_PAUSE_REASON,
      dom: { chatTimeline, chatThreadScroll },
      controllers: { thinkingController, reducedMotionQuery },
      callbacks: {
        requestViewportFrame,
        cancelViewportFrame,
        isDisposed: () => viewportDisposed,
        getScrollCoordinator: () => scrollCoordinator,
        shouldAutoScrollThread,
        getCurrentSessionMessages,
        getScrollMetrics,
        syncThreadScrollState,
        // Late-bound: the panel-sync sibling is created just below and is only
        // reached from inside scheduled rAF callbacks.
        syncRenderedThinkingPanels: (rootNode) => panelSyncController.syncRenderedThinkingPanels(rootNode),
        snapThreadToBottom,
        startLiveStreamingFollow,
        cancelLiveStreamingFollow,
        updateComposerSafeOffset,
        updateAssistantSpritePosition,
        appendClientLog,
      },
    });
    const {
      scheduleMessageViewportSync,
      disposeViewportScheduling,
    } = schedulingController;
    panelSyncController = viewportThinkingPanelUtils.createViewportThinkingPanelUtils({
      state,
      dom: { chatTimeline },
      controllers: { thinkingController, reducedMotionQuery },
      callbacks: {
        escapeSelectorValue,
        appendClientLog,
        getScrollCoordinator: () => scrollCoordinator,
        isDisposed: () => viewportDisposed,
      },
      scheduling: {
        scheduleTransientViewportFrame: schedulingController.scheduleTransientViewportFrame,
        scheduleTransientViewportTimer: schedulingController.scheduleTransientViewportTimer,
        schedulePostLayoutViewportSync: schedulingController.schedulePostLayoutViewportSync,
      },
    });
    const {
      syncRenderedThinkingPanels,
      syncThinkingBlockNode,
      disposeThinkingPanelWork,
    } = panelSyncController;

    function getReasoningEntries(message) {
      return message && message.reasoning && Array.isArray(message.reasoning.entries)
        ? message.reasoning.entries
        : [];
    }

    function mergeMessageReasoning(message, reasoningPayload) {
      if (!reasoningPayload || !Array.isArray(reasoningPayload.entriesDelta) || !reasoningPayload.entriesDelta.length) {
        return message.reasoning || { source: 'none', entries: [] };
      }

      return {
        source: String(reasoningPayload.source || 'provider'),
        entries: mergeReasoningEntries(getReasoningEntries(message), reasoningPayload.entriesDelta, {
          timestamp: new Date().toISOString(),
        }),
      };
    }

    function getScrollMetrics(snapshot) {
      if (snapshot && typeof snapshot === 'object') {
        return {
          scrollTop: Number(snapshot.scrollTop) || 0,
          scrollHeight: Number(snapshot.scrollHeight) || 0,
          clientHeight: Number(snapshot.clientHeight) || 0,
        };
      }
      if (!chatThreadScroll) {
        return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      }
      return {
        scrollTop: chatThreadScroll.scrollTop,
        scrollHeight: chatThreadScroll.scrollHeight,
        clientHeight: chatThreadScroll.clientHeight,
      };
    }

    /* Sole smooth-scroll entry point.  Returns 'auto' (instant) when the
       user prefers reduced motion, 'smooth' otherwise.  Callers must not
       apply scroll-behavior globally via CSS — the viewport controller
       decides per-call based on motion preference, streaming state, and
       follow-latest semantics. */
    function getScrollBehavior() {
      return reducedMotionQuery.matches ? 'auto' : 'smooth';
    }

    function setFollowLatest(value) {
      if (viewportDisposed) return;
      state.ui.followLatest = Boolean(value);
      if (!state.ui.followLatest) {
        cancelLiveStreamingFollow();
      }
    }

    function noteScrollInputIntent() {
      if (viewportDisposed) return;
      noteUserScrollIntent?.();
    }

    function syncThreadScrollState(snapshot) {
      if (viewportDisposed) return false;
      if (!chatThreadScroll) {
        return true;
      }
      const metrics = getScrollMetrics(snapshot);
      const userInitiated = snapshot ? snapshot.userInitiated === true : true;
      if (userInitiated) noteScrollInputIntent();
      if (liveFollowRuntime.active) {
        const actualScrollTop = Number(metrics.scrollTop) || 0;
        const maximumScrollTop = Math.max(0,
          (Number(metrics.scrollHeight) || 0) - (Number(metrics.clientHeight) || 0));
        clampProgrammaticScrollTop?.(maximumScrollTop);
        const followedScrollTop = liveFollowRuntime.lastProgrammaticScrollTop || 0;
        if (
          !userInitiated
          || actualScrollTop >= followedScrollTop - LIVE_FOLLOW_USER_OVERRIDE_PX
        ) {
          /* The live-follow animator deliberately trails the growing bottom; that
             lag must not be re-derived as a user scroll-away, which would disable
             follow and strand streaming content below the fold (the streaming-
             not-visible regression). Keep following until the user scrolls up past
             where the animator last placed the viewport. */
          thinkingController.resumeAutoScroll(READER_AWAY_PAUSE_REASON);
          setFollowLatest(true);
          return true;
        }
        cancelLiveStreamingFollow();
      }
      const nearBottom = Boolean(deriveFollowLatestFromScroll(metrics));
      if (!userInitiated && !nearBottom && state.ui.followLatest !== false) {
        const direction = snapshot && typeof snapshot.direction === 'string' ? snapshot.direction : 'none';
        const attributed = Boolean(snapshot && snapshot.programmaticReason);
        if (direction !== 'up' || attributed) {
          /* Attribution preserves follow across programmatic movement; an
             unattributed upward move is reader movement and releases it. */
          thinkingController.resumeAutoScroll(READER_AWAY_PAUSE_REASON);
          return false;
        }
      }
      const thinkingNearBottom = Boolean(thinkingController.handleScroll(metrics));
      setFollowLatest(nearBottom);
      return thinkingNearBottom;
    }

    function disposeViewportController() {
      if (viewportDisposed) return;
      viewportDisposed = true;
      cancelLiveStreamingFollow();
      disposeCopyFeedback();
      disposeViewportScheduling();
      disposeThinkingPanelWork();
      disposeComposerLayoutObserver();
      scrollCoordinator?.dispose?.();
      scrollCoordinator = null;
      timelineVirtualizer = null;
    }

    function scrollThreadToTop() {
      if (viewportDisposed || !chatThreadScroll) {
        return;
      }
      cancelLiveStreamingFollow();
      chatThreadScroll.scrollTo({
        top: 0,
        behavior: getScrollBehavior(),
      });
      setFollowLatest(false);
      scrollCoordinator?.noteExplicitNavigation?.({ followLatest: false });
    }

    function scrollThreadToBottom({ behavior = getScrollBehavior(), forceFollowLatest = true } = {}) {
      if (viewportDisposed || !chatThreadScroll) {
        return;
      }
      snapThreadToBottom({ behavior });
      if (forceFollowLatest) {
        thinkingController.resumeAutoScroll(READER_AWAY_PAUSE_REASON);
        setFollowLatest(true);
      }
      scrollCoordinator?.noteExplicitNavigation?.({ followLatest: forceFollowLatest === true });
    }

    function ensureThreadBranchesCollapsedMap() {
      if (!state.ui || typeof state.ui !== 'object' || Array.isArray(state.ui)) {
        state.ui = {};
      }
      if (!isMapLike(state.ui.threadBranchesCollapsedBySession)) {
        state.ui.threadBranchesCollapsedBySession = new Map();
      }
      return state.ui.threadBranchesCollapsedBySession;
    }

    function getThreadCollapsedSet(sessionId, options = {}) {
      const canonicalGetter = getThreadStateUtils().getThreadCollapsedSetForState;
      if (typeof canonicalGetter === 'function') {
        return canonicalGetter(state, sessionId, options);
      }
      const resolvedSessionId = String(sessionId || state.currentSessionId || '').trim();
      if (!resolvedSessionId) {
        return null;
      }
      const collapsedBySession = ensureThreadBranchesCollapsedMap();
      if (collapsedBySession.has(resolvedSessionId)) {
        const existingSet = collapsedBySession.get(resolvedSessionId);
        if (isSetLike(existingSet)) {
          return existingSet;
        }
        collapsedBySession.delete(resolvedSessionId);
      }
      if (options.create) {
        const createdSet = new Set();
        collapsedBySession.set(resolvedSessionId, createdSet);
        return createdSet;
      }
      return null;
    }

    function revealMessageAnchor(messageId) {
      if (viewportDisposed) return false;
      const targetId = String(messageId || '').trim();
      if (
        !targetId
        || typeof renderMessages !== 'function'
        || typeof getCurrentSessionMessages !== 'function'
      ) {
        return false;
      }
      const sessionId = String(state.currentSessionId || '').trim();
      if (!sessionId) {
        return false;
      }
      const collapsedSet = getThreadCollapsedSet(sessionId);
      if (!collapsedSet || !collapsedSet.size) {
        return false;
      }
      const currentMessages = getCurrentSessionMessages();
      const threadTreeUtils = getThreadTreeUtils();
      const buildTranscriptThreadTree = threadTreeUtils.buildTranscriptThreadTree;
      const collectThreadAncestorIds = threadTreeUtils.collectThreadAncestorIds;
      if (typeof buildTranscriptThreadTree !== 'function' || typeof collectThreadAncestorIds !== 'function') {
        return false;
      }
      const threadTree = buildTranscriptThreadTree(currentMessages, { buildInteractiveRecapViewModel });
      if (!threadTree?.nodeById?.get?.(targetId)) {
        return false;
      }
      const ancestorIds = collectThreadAncestorIds(threadTree.nodeById, targetId);
      let changed = false;
      Array.from(ancestorIds).forEach((ancestorId) => {
        const normalizedAncestorId = String(ancestorId || '').trim();
        if (!normalizedAncestorId || !collapsedSet.has(normalizedAncestorId)) {
          return;
        }
        collapsedSet.delete(normalizedAncestorId);
        changed = true;
      });
      if (!changed) {
        return false;
      }
      if (!collapsedSet.size) {
        ensureThreadBranchesCollapsedMap().delete(sessionId);
      }
      renderMessages();
      return true;
    }

    function scrollMessageIntoView(messageId, options = {}) {
      if (viewportDisposed) return false;
      const targetId = String(messageId || '');
      if (!targetId || !chatTimeline) {
        return false;
      }
      if (options.revealAnchor !== false) {
        revealMessageAnchor(targetId);
      }
      let targetNode = resolveVisibleMessageDomTarget(chatTimeline, targetId);
      if (targetNode?.closest) {
        const entry = targetNode.closest('.chat-entry[data-message-id]');
        if (entry?.getAttribute?.('data-virtualized') === 'true') {
          try { timelineVirtualizer?.ensureMounted?.(entry); } catch (_error) { /* best-effort */ }
          targetNode = resolveVisibleMessageDomTarget(chatTimeline, targetId);
        }
      }
      if (!targetNode) {
        try { timelineVirtualizer?.ensureMountedForMessageId?.(targetId); } catch (_error) { /* best-effort */ }
        targetNode = resolveVisibleMessageDomTarget(chatTimeline, targetId);
      }
      if (!targetNode) {
        return false;
      }
      cancelLiveStreamingFollow();
      return viewportRevealController.revealElement(targetNode, {
        block: options.block || 'end',
        behavior: options.behavior,
        followLatest: Boolean(options.followLatest),
        reason: typeof options.reason === 'string' && options.reason ? options.reason : 'message_jump',
      });
    }

    function getCurrentMessageById(messageId) {
      const targetId = String(messageId || '');
      if (!targetId) {
        return null;
      }
      return getCurrentSessionMessages().find((message) => String(message.id || '') === targetId) || null;
    }

    const {
      isInteractiveRoundRecapExpanded,
      pruneInteractiveRoundRecapExpansionState,
      toggleInteractiveRoundRecap,
    } = viewportRecapUtils.createViewportRecapUtils({
      state,
      chatTimeline,
      escapeSelectorValue,
      getCurrentMessageById,
      renderMessages,
      getCurrentSessionMessages,
      isMapLike,
      isSetLike,
      buildInteractiveRecapViewModel,
    });

    return {
      composerLayoutRuntime,
      getReasoningEntries,
      mergeMessageReasoning,
      getScrollMetrics,
      getScrollBehavior,
      setFollowLatest,
      viewportReveal: viewportRevealController,
      setTimelineVirtualizer(nextVirtualizer) {
        if (viewportDisposed) return;
        timelineVirtualizer = nextVirtualizer || null;
      },
      noteScrollInputIntent,
      syncThreadScrollState,
      getComposerSafeOffset,
      measureComposerSafeOffset,
      updateComposerSafeOffset,
      initializeComposerLayoutObserver,
      scrollThreadToTop,
      scrollThreadToBottom,
      revealMessageAnchor,
      scrollMessageIntoView,
      getCurrentMessageById,
      isInteractiveRoundRecapExpanded,
      pruneInteractiveRoundRecapExpansionState,
      toggleInteractiveRoundRecap,
      clearCopyFeedback,
      showCopyFeedback,
      syncRenderedThinkingPanels,
      syncThinkingBlockNode,
      scheduleMessageViewportSync,
      disposeViewportController,
    };
  }

  return { createViewportController, SAFE_OFFSET_MINIMUM_PX };
});
