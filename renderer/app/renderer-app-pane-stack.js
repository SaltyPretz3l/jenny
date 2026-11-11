/* renderer/app/renderer-app-pane-stack.js -- the controller stack of a chat pane that is not pane 0 (UMD) */
/**
 * Extracted from renderer-app-pane-composition.js (which creates it once and
 * calls through). mount() still owns the order; this builds, in that order, the
 * pane runtime, the pane's own follow state and reasoning controller, the
 * surface cluster, the render pipeline and the chat shell controller with the
 * SAME builders the app uses for pane 0, then binds the shell.
 *
 *   createPaneStack(deps) returns
 *     buildPaneControllers(pane, paneId, getSessionId)  fills pane.runtime,
 *         followState, thinkingController, controllers, spriteRuntime, surface,
 *         pipeline and shell (bound)
 *
 * deps: state, layoutController, call (the composition's injected-option
 * caller), syncPaneComposer, autosizeInput, getPaneRenderListener (the W6b
 * listener, read per render), safely.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppPaneStack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* What a second pane's pipeline must NOT touch: the document-global chrome
     pane 0's pipeline owns (header, rail, artifact panel, composer chrome,
     backend notice, surface effects, token display). */
  var GLOBAL_CHROME_NOOPS = {
    renderHeader: noop, renderArtifactReviewPanel: noop, syncBackendNotice: noop,
    refreshActiveSurfaceEffect: noop, onSurfaceLifecycleSync: noop, renderContextPanel: noop,
    renderPinnedNotes: noop, renderSessions: noop, renderWorkspaceChrome: noop, renderSettings: noop, renderComposerCarriers: noop,
    renderIde: noop, layoutIdeEditor: noop, reconcileChatDockHost: function () { return false; },
    renderHomePanel: noop, shouldRenderHomePanel: function () { return false; },
    renderAttachmentTray: noop, renderComposerStatusNotice: noop, renderToastViewport: noop,
    renderComposerPopover: noop, renderComposerEnhancements: noop,
    renderComposerInteractivePanel: noop, closeComposerPopover: noop,
    setComposerHoloState: noop, updateTokenDisplay: noop,
  };

  function noop() {}

  function createPaneStack(deps) {
    var state = deps.state;
    var layoutController = deps.layoutController;
    var call = deps.call;
    var syncPaneComposer = deps.syncPaneComposer;
    var autosizeInput = deps.autosizeInput;
    var getPaneRenderListener = deps.getPaneRenderListener;
    var safely = deps.safely;

    /* The shell's stream-handler factory for a pane that is not pane 0: a
       facade over pane 0's ONE handler. One IPC subscription, one render
       latch; the optimistic append and flushes are session-keyed already. */
    function createStreamHandlerFacade() {
      function primary() {
        var shell = call('getPrimaryShell');
        return shell && shell.streamHandler ? shell.streamHandler : null;
      }
      function forward(name, fallback) {
        return function () {
          var handler = primary();
          return handler && typeof handler[name] === 'function' ? handler[name].apply(handler, arguments) : fallback();
        };
      }
      return {
        createStreamHandler: function createStreamHandler() {
          return {
            optimisticAppend: forward('optimisticAppend', function () { return {}; }),
            flushBufferedStreamEvents: forward('flushBufferedStreamEvents', function () { return Promise.resolve({ flushedCount: 0, terminal: false }); }),
            flushPendingStreamCommitsForSession: forward('flushPendingStreamCommitsForSession', function () { return { flushedCount: 0, catchupRequired: false }; }),
            dropBufferedStreamEvents: forward('dropBufferedStreamEvents', noop),
            rehydrateSessionFromPersistedTurnEvents: forward('rehydrateSessionFromPersistedTurnEvents', function () { return null; }),
            registerStreamHandler: noop,
            dispose: noop,
          };
        },
      };
    }

    function buildPaneControllers(pane, paneId, getSessionId) {
      pane.runtime = call('createPaneRuntime', { paneId: paneId }) || { paneId: paneId };
      /* Follow intent and reasoning-disclosure state are this pane's own: sharing pane 0's
         (state.ui.followLatest, the app-level ThinkingPanelController) lets one pane's
         scroll or full render release, re-latch or wipe the other's. */
      var followLatest = true;
      pane.followState = { get: function () { return followLatest; }, set: function (value) { followLatest = value; } };
      pane.thinkingController = call('createThinkingController') || null;
      pane.controllers = pane.thinkingController ? { thinkingController: pane.thinkingController } : {};
      pane.spriteRuntime = { frameHandle: 0, targetMessageId: '', targetY: 0 };
      pane.surface = call('buildPaneSurface', {
        paneId: paneId,
        dom: pane.dom,
        followState: pane.followState,
        getSessionId: getSessionId,
        controllers: pane.controllers,
        overrides: {
          renderJumpControls: function () { return pane.pipeline?.renderComposerJumpControls?.(); },
          isStreaming: function () { return call('isSessionStreaming', getSessionId()) === true; },
          getCurrentSessionMessages: function () { return call('getSessionMessages', getSessionId()) || []; },
          renderMessages: function () { return pane.pipeline && pane.pipeline.renderMessages ? pane.pipeline.renderMessages.apply(null, arguments) : undefined; },
          updateAssistantSpritePosition: function () { return pane.pipeline && pane.pipeline.updateAssistantSpritePosition ? pane.pipeline.updateAssistantSpritePosition.apply(null, arguments) : undefined; },
        },
      }) || {};
      var viewportApi = pane.surface.viewportApi || {};
      var viewport = function (name, fallback) {
        return function () { return typeof viewportApi[name] === 'function' ? viewportApi[name].apply(null, arguments) : fallback; };
      };
      pane.pipeline = call('buildRenderPipeline', {
        paneId: paneId,
        dom: pane.dom,
        runtime: { uiRuntime: pane.runtime, spriteRuntime: pane.spriteRuntime },
        controllers: Object.assign({
          scrollCoordinator: pane.surface.scrollCoordinator || null,
          getSendOutboxActions: function () { return pane.shell ? pane.shell.sendOutboxActions : null; },
          // The pane's own durable send controller (buildShell keeps it off the state slot).
          getRuntimeSendController: function () { return pane.runtimeSendController || null; },
        }, pane.controllers),
        overrides: Object.assign({}, GLOBAL_CHROME_NOOPS, {
          syncPaneLayout: undefined,
          reconcileChatDockHost: function () {
            var paneRenderListener = getPaneRenderListener();
            if (paneRenderListener) safely(function () { paneRenderListener(paneId); });
            return false;
          },
          syncComposerInputHeight: function () { autosizeInput(pane.dom.chatInput); },
          getCurrentSessionMessages: function () { return call('getSessionMessages', getSessionId()) || []; },
          getCurrentVisibleMessages: function () { return call('getVisibleSessionMessages', getSessionId()) || []; },
          scheduleMessageViewportSync: viewport('scheduleMessageViewportSync'),
          setFollowLatest: viewport('setFollowLatest'),
          isFollowingLatest: viewport('isFollowingLatest', true),
          updateComposerSafeOffset: viewport('updateComposerSafeOffset'),
          syncTurnElapsedClock: function () { if (pane.shell && pane.shell.syncTurnElapsedClock) pane.shell.syncTurnElapsedClock(); },
        }),
      }) || {};
      pane.shell = buildShell(pane, getSessionId, viewportApi);
      if (pane.shell && typeof pane.shell.bind === 'function') pane.shell.bind();
    }

    /* Pane 0's two send-controller single slots (state.runtimeSendController,
       state.sendReceiptController) stay pane 0's: a second shell registers its
       own and would otherwise take them over. Wave 2 makes them per pane. */
    function buildShell(pane, getSessionId, viewportApi) {
      var savedSlots = { runtimeSendController: state.runtimeSendController, sendReceiptController: state.sendReceiptController };
      var fromViewport = function (name, fallback) {
        return function () { return typeof viewportApi[name] === 'function' ? viewportApi[name].apply(null, arguments) : fallback; };
      };
      var shell;
      try {
        shell = call('buildChatShellController', {
          paneId: pane.paneId,
          sessionContext: layoutController.createSessionContext(pane.paneId),
          dom: pane.dom,
          controllers: Object.assign({
            timelineVirtualizer: pane.pipeline.timelineVirtualizer || null,
            chatScrollCoordinator: pane.surface.scrollCoordinator || null,
          }, pane.controllers),
          // W2-3: no chatEventUtils override -- pane 1 binds with pane 0's own
          // rendererChatEventUtils, which registers only the pane-scoped set for
          // a pane that is not pane 0 (renderer-chat-event-utils.js).
          factories: { streamHandlerUtils: createStreamHandlerFacade() },
          overrides: {
            renderMessages: function () { return pane.pipeline.renderMessages ? pane.pipeline.renderMessages.apply(null, arguments) : undefined; },
            renderComposerState: function () { syncPaneComposer(pane); },
            syncComposerInputHeight: function () { autosizeInput(pane.dom.chatInput); },
            syncComposerVisualState: noop,
            getCurrentSessionMessages: function () { return call('getSessionMessages', getSessionId()) || []; },
            getCurrentVisibleMessages: function () { return call('getVisibleSessionMessages', getSessionId()) || []; },
            setFollowLatest: function () { return typeof viewportApi.setFollowLatest === 'function' ? viewportApi.setFollowLatest.apply(null, arguments) : undefined; },
            getScrollMetrics: viewportApi.getScrollMetrics,
            scrollMessageIntoView: viewportApi.scrollMessageIntoView,
            handleJumpToBottom: fromViewport('scrollThreadToBottom'),
            viewportReveal: viewportApi.viewportReveal || null,
            showCopyFeedback: viewportApi.showCopyFeedback,
            // W2-3: the transcript handlers read THIS pane's messages and patch THIS pane's timeline.
            getCurrentMessageById: fromViewport('getCurrentMessageById', null),
            toggleInteractiveRoundRecap: fromViewport('toggleInteractiveRoundRecap'),
            toggleContextCompactionDetails: fromViewport('toggleContextCompactionDetails'),
            syncThinkingBlockNode: fromViewport('syncThinkingBlockNode'),
            toggleThreadBranch: function () { return pane.pipeline.toggleThreadBranch ? pane.pipeline.toggleThreadBranch.apply(null, arguments) : undefined; },
            syncThreadScrollState: function () {
              var coordinator = pane.surface.scrollCoordinator;
              if (coordinator && typeof coordinator.scheduleFrame === 'function') coordinator.scheduleFrame();
            },
            setUnreadOrientationController: function (controller) {
              var coordinator = pane.surface.scrollCoordinator;
              if (coordinator && typeof coordinator.setUnreadController === 'function') coordinator.setUnreadController(controller);
            },
            onUnreadOrientationStateChange: noop,
          },
        }) || null;
      } finally {
        if (state.runtimeSendController !== savedSlots.runtimeSendController) {
          pane.runtimeSendController = state.runtimeSendController;
          state.runtimeSendController = savedSlots.runtimeSendController;
        }
        if (state.sendReceiptController !== savedSlots.sendReceiptController) {
          pane.sendReceiptController = state.sendReceiptController;
          state.sendReceiptController = savedSlots.sendReceiptController;
        }
      }
      return shell;
    }

    return { buildPaneControllers: buildPaneControllers };
  }

  return { createPaneStack: createPaneStack };
});
