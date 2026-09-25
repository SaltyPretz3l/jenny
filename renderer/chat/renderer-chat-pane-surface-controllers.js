/* renderer/chat/renderer-chat-pane-surface-controllers.js - one chat pane's
   surface controller cluster (UMD).

   Split view W0-1. The lifecycle composition sat at the 1015-line hard cap, so
   the construction of the three controllers that belong to ONE pane's chat
   surface moved here verbatim: the scroll coordinator, the viewport controller
   (plus the fully-defaulted view of its API the composition destructures), and
   the renderless pin-to-top observer, wired to each other exactly as before.

   This module is a seam, not a feature. `paneId` is accepted, defaulted to 0
   and exposed so a later slice can build a second pane; it changes nothing
   about what is built. Every dependency is injected - the pane's already
   resolved nodes arrive as `dom`, the sibling factories as `factories`, the
   composition's with(ctx) wrappers as `callbacks` - so this file resolves no
   globals and looks nothing up for itself.

   Dispose order is behaviour, not taste. The renderer cleanup registry pops
   (LIFO), so the shipped app tears this cluster down pin -> viewport -> scroll;
   dispose() reproduces that sequence and is idempotent, because the viewport's
   own dispose already disposes the coordinator it holds. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatPaneSurfaceControllers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const noop = () => {};
  const noopAsync = async () => {};
  const noopNull = () => null;
  const noopFalse = () => false;

  const PIN_PINNABLE_SELECTOR = '.chat-entry[data-message-role="user"]';
  const PIN_TOP_OFFSET = 88;

  /* The composition destructured the viewport controller with a default for
     every member so a null controller could not crash the shell. That contract
     moves here unchanged: same names, same default values, same semantics. */
  function buildViewportApi(viewportController, state, callbacks) {
    const {
      composerLayoutRuntime = { measureCanvas: null, measureContext: null, resizeObserver: null, safeOffset: 0 },
      getReasoningEntries = (m) => m?.reasoning?.entries && Array.isArray(m.reasoning.entries) ? m.reasoning.entries : [],
      mergeMessageReasoning = (msg, payload) => {
        if (!payload || !Array.isArray(payload.entriesDelta) || !payload.entriesDelta.length) {
          return msg.reasoning || { source: 'none', entries: [] };
        }
        const existing = msg?.reasoning?.entries && Array.isArray(msg.reasoning.entries) ? msg.reasoning.entries : [];
        return { source: String(payload.source || 'provider'), entries: callbacks.mergeReasoningEntries(existing, payload.entriesDelta) };
      },
      getScrollMetrics = () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
      getScrollBehavior = () => 'auto',
      setFollowLatest = (v) => { state.ui.followLatest = Boolean(v); },
      syncThreadScrollState = () => true,
      getComposerSafeOffset = () => 0, measureComposerSafeOffset = () => 0,
      updateComposerSafeOffset = noop, initializeComposerLayoutObserver = noop,
      scrollThreadToTop = noop, scrollThreadToBottom = noop,
      scrollMessageIntoView = noopFalse, viewportReveal = null, getCurrentMessageById = noopNull,
      isInteractiveRoundRecapExpanded = () => false,
      pruneInteractiveRoundRecapExpansionState = noop,
      toggleInteractiveRoundRecap = noopAsync, isContextCompactionExpanded = () => false,
      toggleContextCompactionDetails = noop, clearCopyFeedback = noop,
      showCopyFeedback = noop, syncRenderedThinkingPanels = noop,
      syncThinkingBlockNode = noop, scheduleMessageViewportSync = noop,
      disposeViewportController = noop,
    } = viewportController || {};
    return {
      composerLayoutRuntime, getReasoningEntries, mergeMessageReasoning, getScrollMetrics, getScrollBehavior,
      setFollowLatest, syncThreadScrollState, getComposerSafeOffset, measureComposerSafeOffset,
      updateComposerSafeOffset, initializeComposerLayoutObserver, scrollThreadToTop, scrollThreadToBottom,
      scrollMessageIntoView, viewportReveal, getCurrentMessageById, isInteractiveRoundRecapExpanded,
      pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap, isContextCompactionExpanded,
      toggleContextCompactionDetails, clearCopyFeedback,
      showCopyFeedback, syncRenderedThinkingPanels, syncThinkingBlockNode, scheduleMessageViewportSync,
      disposeViewportController,
    };
  }

  function createChatPaneSurfaceControllers(options) {
    const opts = options || {};
    const state = opts.state;
    const paneId = opts.paneId === undefined || opts.paneId === null ? 0 : opts.paneId;
    const dom = opts.dom || {};
    const callbacks = opts.callbacks || {};
    const controllers = opts.controllers || {};
    const factories = opts.factories || {};
    const scrollCoordinatorUtils = factories.scrollCoordinatorUtils || {};
    const viewportUtils = factories.viewportUtils || {};
    const pinToTopUtils = factories.pinToTopUtils || {};

    const scrollCoordinator = scrollCoordinatorUtils.createChatScrollCoordinator?.({
      state, scrollContainer: dom.chatThreadScroll, timelineContainer: dom.chatTimeline, window: opts.windowRef,
      appendClientLog: callbacks.appendClientLog, renderJumpControls: callbacks.renderJumpControls,
      isStreaming: callbacks.isStreaming,
    }) || null;

    const viewport = viewportUtils.createViewportController?.({
      state,
      constants: opts.constants,
      dom: {
        chatView: dom.chatView,
        chatSurfaceEffects: dom.chatSurfaceEffects,
        chatSurfaceEffectLeft: dom.chatSurfaceEffectLeft,
        chatThreadStage: dom.chatThreadStage,
        chatThreadColumn: dom.chatThreadColumn,
        composerWrap: dom.composerWrap,
        chatTimeline: dom.chatTimeline,
        chatThreadScroll: dom.chatThreadScroll,
      },
      controllers: {
        thinkingController: controllers.thinkingController,
        reducedMotionQuery: controllers.reducedMotionQuery,
        scrollCoordinator,
      },
      callbacks: {
        mergeReasoningEntries: callbacks.mergeReasoningEntries,
        deriveFollowLatestFromScroll: callbacks.deriveFollowLatestFromScroll,
        shouldAutoScrollThread: callbacks.shouldAutoScrollThread,
        escapeSelectorValue: callbacks.escapeSelectorValue,
        getCurrentSessionMessages: callbacks.getCurrentSessionMessages,
        buildInteractiveRecapViewModel: callbacks.buildInteractiveRecapViewModel,
        renderMessages: callbacks.renderMessages,
        updateAssistantSpritePosition: callbacks.updateAssistantSpritePosition,
        appendClientLog: callbacks.appendClientLog,
      },
    }) || null;
    const viewportApi = buildViewportApi(viewport, state, callbacks);
    scrollCoordinator?.setViewportController?.(viewport);

    const pinToTop = (typeof pinToTopUtils.createPinToTopController === 'function'
      ? pinToTopUtils.createPinToTopController({
          scrollContainer: dom.chatThreadScroll,
          timelineContainer: dom.chatTimeline,
          pinnableSelector: PIN_PINNABLE_SELECTOR,
          topOffset: PIN_TOP_OFFSET, listenForScroll: false,
          onStateChange: function (nextState) {
            callbacks.getWayfinderController?.()?.setPinState?.({
              ...nextState,
              sessionId: state.currentSessionId,
            });
            callbacks.renderJumpControls?.();
          },
        })
      : null);
    scrollCoordinator?.setPinController?.(pinToTop);

    /* The three used to be separate cleanup-registry entries, each wrapped in its own
       try/catch by renderer/app.js; fused into one dispose() they keep that isolation,
       so a throwing pin dispose can never skip the viewport or the coordinator. */
    function safely(fn) {
      try { fn(); } catch (error) { /* best-effort teardown, as the registry does */ }
    }
    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      safely(() => pinToTop?.dispose?.());
      safely(() => viewportApi.disposeViewportController?.());
      safely(() => scrollCoordinator?.dispose?.());
    }

    return { paneId, scrollCoordinator, viewport, viewportApi, pinToTop, dispose };
  }

  return {
    createChatPaneSurfaceControllers,
  };
});
