/* renderer/app/renderer-app-pane-composition.js -- the second chat pane's lifecycle (UMD) */
/**
 * Split view W1-4c. The layout controller (renderer/shell/renderer-pane-layout-
 * controller.js) owns WHICH sessions are on screen; this owns the DOM and the
 * controller stack of the pane that is not pane 0.
 *
 *   mount(paneId, sessionId)  clone #chatPaneTemplate, insert the root right
 *       after #chatPaneResizer, resolve its nodes through the bootstrap
 *       `resolvePane(rootElement)` seam, then build, in order, a pane runtime,
 *       the surface cluster, the render pipeline and the chat shell controller
 *       with the SAME builders the app uses for pane 0 (each handed
 *       `{ paneId, dom, runtime, controllers, sessionContext, overrides }`).
 *       Shows the divider, sets data-pane-count="2", binds the resizer.
 *   unmount(paneId)  dispose shell -> pipeline -> surface -> runtime (W0
 *       order), remove the root, hide the divider, data-pane-count="1", clear
 *       the split tracks.
 *   handleLayoutChanged(prev, next)  the layout controller's one callback:
 *       mount/unmount on a pane-count change, focus attributes, kickers, and
 *       one coalesced full render when sessions or focus moved (a ratio-only
 *       change renders nothing: the divider writes its own tracks per frame).
 *   renderSessionPane(sessionId, kind)  the render-frame router
 *       (renderer-stream-handler-runtime.js): `messages` renders the ONE pane
 *       showing the session; `composer` syncs a non-focused pane's composer.
 *       true = handled, false = the session is in no pane, undefined = one pane
 *       (the global render stands, exactly the pre-split path).
 *   syncPaneLayout(kind)  called at the start of pane 0's exported renderAll /
 *       renderHeader / renderMessages: reconciles the legacy currentSessionId
 *       writers, and schedules the other pane after a full render. A header
 *       or full render also raises `jenny:focused-chat-changed` (window) when
 *       the focused chat, pane 0's chat or either one's project changed.
 *   syncFocus(), renderKickers(), measureWidth(), toggleSplit(),
 *   hydrateOnce(storedLayout), getPane(paneId), dispose().
 *   getSessionPaneTarget(sessionId)  the side panel's jump target in a pane
 *       other than pane 0 (timeline, scroll, projection), else null.
 *   setDropHover(side), getDropTarget()  drag-to-split (W2-1): the drop-zone
 *       outline attribute and the rail tab drag's target; a kicker-title drag
 *       swaps the panes (renderer-pane-drag-controller.js, injected).
 *   Attachments (W2-2b): pane 1 gets its own tray (template), attach button
 *       (inserted at mount) and pane-scoped attachment bindings keyed by its
 *       session; its queue is its session's composer record, rendered by
 *       syncPaneComposer. The attachment notice stays pane 0's.
 *   Notices (W3-1): pane 1's template carries its own preview pill, composer
 *       status notice and failed-send notice (data-chat-node hosts resolved
 *       here, not through CHAT_PANE_NODE_NAMES: pane 0 keeps its ids). The
 *       status notice renders the one notice slot when it is keyed to pane
 *       1's session (`renderComposerStatusNotice({ node, sessionId })`), the
 *       pill watches pane 1's tray, the failed-send notice scans pane 1's
 *       session and retries through pane 1's shell, and the pending-skill chip
 *       renders in pane 1's tray when the skill is pane 1's session's. A split
 *       layout change that takes a keyed notice's session off screen clears
 *       the slot (`clearComposerStatusNotice`); compaction progress for pane
 *       1's session renders in its status notice too.
 *   Side panel owner (W3-2): handleLayoutChanged reconciles the owner first
 *       and collapses the panel (`collapseSidePanel`) when its pane closed.
 *   Drafts (Astra pane findings P1): a pane whose session changed hands its
 *       composer text to the session it showed and shows the incoming one's
 *       (renderer-composer-pane-drafts.js over the one session-keyed store).
 *   Selection (P2): a pane whose session changed tells its shell
 *       (`onPaneSessionChanged`), which drops the selection mode it owns.
 *
 * No `with (ctx)`: every dependency is injected, so jsdom tests build it with
 * fakes. The module holds no pane-0 construction; pane 0 stays the app's.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./renderer-pane-drag-controller'), require('../chat/renderer-composer-pane-drafts'), require('./renderer-app-pane-chrome'));
    return;
  }
  root.rendererAppPaneComposition = factory(root, root.rendererPaneDragController, root.rendererComposerPaneDrafts, root.rendererAppPaneChrome);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, paneDragController, paneDrafts, paneChrome) {
  'use strict';

  var jtFallback = function (key, fallback, params) {
    return params ? String(fallback).replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    }) : fallback;
  };
  var GENERAL_PROJECT_ID = 'project_general';
  var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var live = null;
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
    renderComposerPopover: noop, renderCommandPopover: noop, renderComposerEnhancements: noop,
    renderComposerInteractivePanel: noop, closeComposerPopover: noop,
    setComposerHoloState: noop, updateTokenDisplay: noop,
  };

  function noop() {}
  var normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;
  function projectKey(value) { return normalizeId(value) || GENERAL_PROJECT_ID; }
  function safely(fn) {
    try { fn(); } catch (_error) { /* best-effort teardown, as the cleanup registry does */ }
  }

  function createPaneComposition(deps) {
    var options = deps || {};
    var state = options.state;
    var layoutController = options.layoutController;
    var chatView = options.chatView;
    if (!state || !layoutController || !chatView) {
      throw new TypeError('createPaneComposition: state, layoutController and chatView are required.');
    }
    var doc = options.documentRef || chatView.ownerDocument;
    var jt = typeof options.jt === 'function' ? options.jt
      : (root.jennyI18n && typeof root.jennyI18n.t === 'function' ? root.jennyI18n.t : jtFallback);
    var actionButton = typeof options.actionButton === 'function' ? options.actionButton : root.inventoryActionButton;
    var scheduleMicrotask = typeof options.scheduleMicrotask === 'function'
      ? options.scheduleMicrotask
      : function (fn) { Promise.resolve().then(fn); };
    var call = function (name) {
      var fn = options[name];
      var args = Array.prototype.slice.call(arguments, 1);
      return typeof fn === 'function' ? fn.apply(null, args) : undefined;
    };

    var panes = new Map();
    var disposed = false;
    var hydrated = false;
    var routing = false;
    var fullRenderQueued = false;
    var paneRenderQueued = new Set();
    var focusCleanup = null;
    var resizer = null;
    var paneRenderListener = null; // W6b: the Workspace's second chat hears pane renders (unread, its Changes)

    function resizerEl() { return chatView.querySelector(':scope > .chat-pane-resizer'); }
    function pane0Root() { return chatView.querySelector(':scope > .chat-pane[data-pane-id="0"]'); }
    // Pane 0's root never leaves #chatView; another pane's may sit in the Workspace (setPaneHost).
    function paneRootOf(paneId) { return paneId === 0 ? pane0Root() : ((panes.get(paneId) || {}).root || null); }
    function paneRoots() { return [pane0Root()].concat(Array.from(panes.keys()).map(paneRootOf)).filter(Boolean); }
    function paneSessionId(paneId) {
      var layout = layoutController.getLayout();
      var entry = layout.panes[paneId];
      return entry ? entry.sessionId : '';
    }
    function isFocused(paneId) { return layoutController.getLayout().focusedPaneId === paneId; }
    function kickerFor(paneId) {
      if (paneId === 0) {
        var root0 = pane0Root();
        return root0 ? root0.querySelector('[data-chat-node="chatPaneKicker"]') : null;
      }
      var pane = panes.get(paneId);
      return pane ? pane.dom.chatPaneKicker : null;
    }

    var chrome = paneChrome.createPaneChrome({
      state: state, layoutController: layoutController, options: options, root: root, doc: doc, jt: jt,
      actionButton: actionButton, call: call, paneDrafts: paneDrafts, panes: panes,
      paneSessionId: paneSessionId, pane0Root: pane0Root,
    });
    var syncPaneComposer = chrome.syncPaneComposer;
    var mountPaneNotices = chrome.mountPaneNotices;
    var createPaneAttachments = chrome.createPaneAttachments;
    var handOffDrafts = chrome.handOffDrafts;
    var showPaneDraft = chrome.showPaneDraft;
    var autosizeInput = chrome.autosizeInput;
    var insertButton = chrome.insertButton;

    /* ── P2: a pane's selection mode belongs to the session it showed. A pane
       whose session changed (replaced, swapped, pane 0 taking pane 1's on a
       close, a legacy currentSessionId writer) tells its shell after the
       current pass (the exit re-renders); a focus change alone never does.
       A pane seen for the first time (a fresh mount) has nothing to drop. ── */
    var shownSessions = [];
    function notePaneSession(paneId, sessionId, rekeyed, layoutChange) {
      var seen = shownSessions[paneId];
      shownSessions[paneId] = sessionId;
      if (seen === undefined || seen === sessionId || rekeyed) return;
      // Pane 0 outside a layout change is openSession's to re-latch (and a one-pane id rekey is no session change).
      if (paneId !== 0) relatchPaneFollow(panes.get(paneId));
      else if (layoutChange) call('relatchPrimaryFollow');
      var shell = paneId === 0 ? call('getPrimaryShell') : (panes.get(paneId) || {}).shell;
      if (!shell || typeof shell.onPaneSessionChanged !== 'function') return;
      scheduleMicrotask(function () { if (!disposed) safely(function () { shell.onPaneSessionChanged(sessionId); }); });
    }
    /* openSession re-latches pane 0's follow for an incoming session; pane 1 owns its own. */
    function relatchPaneFollow(pane) {
      if (!pane) return;
      if (pane.thinkingController) pane.thinkingController.resumeAutoScroll();
      if (pane.followState) pane.followState.set(true);
    }
    function notePaneSessions(layout, rekeyed) {
      shownSessions.length = Math.min(shownSessions.length, layout.panes.length);
      layout.panes.forEach(function (entry, paneId) { notePaneSession(paneId, normalizeId(entry.sessionId), rekeyed, true); });
    }

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

    function mount(paneId, sessionId) {
      if (disposed || paneId !== 1 || panes.has(paneId)) return panes.get(paneId) || null;
      var template = chatView.querySelector('template#chatPaneTemplate') || (doc && doc.getElementById('chatPaneTemplate'));
      var divider = resizerEl();
      if (!template || !divider) return null;
      var fragment = template.content.cloneNode(true);
      var rootEl = fragment.querySelector('.chat-pane');
      rootEl.dataset.paneId = String(paneId);
      rootEl.dataset.paneFocused = isFocused(paneId) ? 'true' : 'false';
      divider.after(rootEl);
      if (root.jennyI18n && typeof root.jennyI18n.applyStaticNodes === 'function') safely(function () { root.jennyI18n.applyStaticNodes(rootEl); });
      var paneDom = options.resolvePane(rootEl) || {};
      if (paneDom.chatInput) paneDom.chatInput.setAttribute('spellcheck', 'true');
      var pane = { paneId: paneId, root: rootEl, composer: rootEl.querySelector('.composer') };
      var toolbarRight = chrome.buildComposerNodes(pane, paneDom);
      var getSessionId = function () { return paneSessionId(paneId); };
      // W2-2a: the pane's own rail (model pill, effort, run mode) in its toolbar, before Stop and Send.
      pane.rail = call('createPaneComposerRail', { state: state, paneRoot: rootEl, railEl: toolbarRight, hintHost: pane.composer, sessionContext: { paneId: paneId, getSessionId: getSessionId }, documentRef: doc }) || null;
      if (pane.rail) Object.assign(pane.dom, pane.rail.dom);
      panes.set(paneId, pane);
      kickerKey = '';

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
          renderJumpControls: noop,
          isStreaming: function () { return call('isSessionStreaming', getSessionId()) === true; },
          getCurrentSessionMessages: function () { return call('getSessionMessages', getSessionId()) || []; },
          renderMessages: function () { return pane.pipeline && pane.pipeline.renderMessages ? pane.pipeline.renderMessages.apply(null, arguments) : undefined; },
          updateAssistantSpritePosition: function () { return pane.pipeline && pane.pipeline.updateAssistantSpritePosition ? pane.pipeline.updateAssistantSpritePosition.apply(null, arguments) : undefined; },
          getWayfinderController: function () { return null; },
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
      pane.attachments = createPaneAttachments(pane);
      mountPaneNotices(pane, getSessionId);

      divider.classList.remove('hidden');
      divider.setAttribute('tabindex', '0');
      chatView.dataset.paneCount = '2';
      bindFocusTracking();
      resizer = call('createResizer', {
        resizerEl: divider,
        chatViewEl: chatView,
        getSplitRatio: function () { return layoutController.getSplitRatio(); },
        setSplitRatio: function (ratio) { return layoutController.setSplitRatio(ratio); },
        onPersist: function (ratio) { call('persistSplitRatio', ratio); },
        measureWidth: measureWidth,
      }) || null;
      if (resizer) {
        resizer.bind();
        resizer.sync();
      }
      showPaneDraft(pane, sessionId || getSessionId());
      syncPaneComposer(pane);
      ensureSessionLoaded(paneId, sessionId || getSessionId());
      return pane;
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

    function unmount(paneId) {
      var pane = panes.get(paneId);
      if (!pane) return false;
      cancelKickerDrag();
      panes.delete(paneId);
      paneRenderQueued.delete(paneId);
      safely(function () { if (pane.previewPill) pane.previewPill.destroy(); });
      safely(function () { if (pane.failedSendNotice) pane.failedSendNotice.destroy(); });
      safely(function () { if (pane.attachments && pane.attachments.dispose) pane.attachments.dispose(); });
      safely(function () { if (pane.shell && pane.shell.dispose) pane.shell.dispose(); });
      safely(function () { if (pane.pipeline && pane.pipeline.dispose) pane.pipeline.dispose(); });
      safely(function () { if (pane.surface && pane.surface.dispose) pane.surface.dispose(); });
      safely(function () { if (pane.runtime && pane.runtime.dispose) pane.runtime.dispose(); });
      safely(function () { if (pane.rail) pane.rail.dispose(); });
      safely(function () { pane.root.remove(); });
      kickerKey = '';
      if (!panes.size) {
        if (resizer) safely(function () { resizer.dispose(); });
        resizer = null;
        unbindFocusTracking();
        var divider = resizerEl();
        if (divider) {
          divider.classList.add('hidden');
          divider.setAttribute('tabindex', '-1');
        }
        chatView.dataset.paneCount = '1';
        chatView.style.removeProperty('--chat-pane-a');
        chatView.style.removeProperty('--chat-pane-b');
      }
      return true;
    }

    /* ── focus: a pointerdown (capture) or focusin inside a pane root focuses
       that pane; bound only while two panes are open ── */
    // A root the Workspace hosts is not tracked: there pane 0 names the chat the IDE shows.
    function paneIdFromEvent(event) {
      var target = event && event.target;
      var rootEl = target && typeof target.closest === 'function' ? target.closest('.chat-pane') : null;
      if (!rootEl || rootEl.parentElement !== chatView) return -1;
      var paneId = Number(rootEl.dataset.paneId);
      return Number.isInteger(paneId) ? paneId : -1;
    }
    function handleFocusEvent(event) {
      var paneId = paneIdFromEvent(event);
      if (paneId >= 0 && layoutController.getPaneCount() > 1) layoutController.setFocusedPane(paneId);
    }
    function bindFocusTracking() {
      if (focusCleanup) return;
      chatView.addEventListener('pointerdown', handleFocusEvent, true);
      chatView.addEventListener('focusin', handleFocusEvent);
      focusCleanup = function () {
        chatView.removeEventListener('pointerdown', handleFocusEvent, true);
        chatView.removeEventListener('focusin', handleFocusEvent);
      };
    }
    function unbindFocusTracking() {
      if (focusCleanup) focusCleanup();
      focusCleanup = null;
    }

    function syncFocus() {
      var layout = layoutController.getLayout();
      var two = layout.panes.length > 1;
      paneRoots().forEach(function (rootEl) {
        var paneId = Number(rootEl.dataset.paneId);
        var focused = !two || layout.focusedPaneId === paneId;
        if (rootEl.dataset.paneFocused !== String(focused)) rootEl.dataset.paneFocused = String(focused);
      });
    }

    /* ── kickers: hidden and empty with one pane (identity); with two, the
       session title, "· project" when the two panes' projects differ, and a
       close glyph ── */
    function sessionTitle(sessionId) {
      var summary = call('getSessionSummary', sessionId);
      var title = summary && normalizeId(summary.title);
      return title || jt('chat.empty.newSession', 'New session');
    }
    /* Rebuilt only when what it shows changed, so the header/full-render sync
       below can call it on every pass (a rename, an auto-title or a project
       move reaches the kicker without a layout change). A mount or unmount
       clears the key: the new or restored kicker node starts empty. */
    var kickerKey = '';
    function renderKickers() {
      var layout = layoutController.getLayout();
      var two = layout.panes.length > 1;
      var projects = layout.panes.map(function (entry) {
        var summary = call('getSessionSummary', entry.sessionId);
        return projectKey(summary && summary.project_id);
      });
      var projectsDiffer = two && projects[0] !== projects[1];
      var lines = [0, 1].map(function (paneId) {
        if (!two) return null;
        return {
          title: sessionTitle(paneSessionId(paneId)),
          projectName: projectsDiffer ? normalizeId(call('getProjectName', projects[paneId])) : '',
        };
      });
      var key = JSON.stringify(lines);
      if (key === kickerKey) return;
      kickerKey = key;
      [0, 1].forEach(function (paneId) {
        var kicker = kickerFor(paneId);
        if (!kicker) return;
        kicker.replaceChildren();
        kicker.hidden = !two;
        if (!two) return;
        var title = doc.createElement('span');
        title.className = 'chat-pane-kicker-title';
        title.setAttribute('dir', 'auto'); // an English title keeps LTR inside RTL chrome
        title.textContent = lines[paneId].title;
        title.addEventListener('pointerdown', function (event) { startKickerDrag(event, paneId); });
        kicker.appendChild(title);
        var projectName = lines[paneId].projectName;
        if (projectName) {
          var project = doc.createElement('span');
          project.className = 'chat-pane-kicker-project';
          project.textContent = ' ' + jt('chat.panes.kickerProject', '· {name}', { name: projectName });
          kicker.appendChild(project);
        }
        var label = jt('chat.panes.close', 'Close pane');
        var close = insertButton(kicker, { className: 'workspace-rail-close-button chat-pane-close', ariaLabel: label, title: label, trustedHtml: ICON_CLOSE });
        if (close) close.addEventListener('click', function () { layoutController.closePane(paneId); });
      });
    }

    /* ── drag-to-split (W2-1) and the kicker drag: renderer-pane-drag-controller.js. ── */
    var dragController = paneDragController.createPaneDragController({
      chatView: chatView, documentRef: doc, layoutController: layoutController, kickerFor: kickerFor,
      isRtl: options.isRtl, isDisposed: function () { return disposed; },
    });
    var setDropHover = dragController.setDropHover;
    var dropTarget = dragController.dropTarget;
    var startKickerDrag = dragController.startKickerDrag;
    var cancelKickerDrag = dragController.cancelKickerDrag;

    function measureWidth() {
      var width = function (element) {
        return element && typeof element.getBoundingClientRect === 'function' ? Number(element.getBoundingClientRect().width) || 0 : 0;
      };
      var pane1 = panes.get(1);
      return width(pane0Root()) + width(resizerEl()) + width(pane1 && pane1.root);
    }

    /* ── rendering ── */
    function renderPane(paneId) {
      if (paneId === 0) {
        routing = true;
        try { call('renderPrimaryMessages'); } finally { routing = false; }
        return true;
      }
      var pane = panes.get(paneId);
      if (!pane || !pane.pipeline || typeof pane.pipeline.renderMessages !== 'function') return false;
      pane.pipeline.renderMessages();
      syncPaneComposer(pane);
      return true;
    }

    function schedulePaneRender(paneId) {
      if (paneRenderQueued.has(paneId)) return;
      paneRenderQueued.add(paneId);
      scheduleMicrotask(function () {
        if (!paneRenderQueued.delete(paneId) || disposed) return;
        safely(function () { renderPane(paneId); });
      });
    }

    function requestFullRender() {
      if (fullRenderQueued) return;
      fullRenderQueued = true;
      scheduleMicrotask(function () {
        fullRenderQueued = false;
        if (!disposed) safely(function () { call('requestFullRender'); });
      });
    }

    function renderSessionPane(sessionId, kind) {
      if (disposed || layoutController.getPaneCount() < 2) return undefined;
      var id = normalizeId(sessionId);
      var layout = layoutController.getLayout();
      var paneId = -1;
      layout.panes.forEach(function (entry, index) { if (id && entry.sessionId === id) paneId = index; });
      if (kind === 'composer') {
        if (paneId <= 0) return undefined;
        syncPaneComposer(panes.get(paneId));
        return layout.focusedPaneId === paneId ? undefined : true;
      }
      if (paneId < 0) return false;
      return renderPane(paneId);
    }

    /* The Explorer nudge names the focused chat's project (pane 0's while docked): a header or full
       render raises `jenny:focused-chat-changed` only when either chat or its project moved. */
    var focusedChatKey = '';
    function projectOfSession(sessionId) {
      var summary = sessionId ? call('getSessionSummary', sessionId) : null;
      return normalizeId(summary && summary.project_id);
    }
    function noteFocusedChat() {
      var layout = layoutController.getLayout();
      var focused = layout.panes[layout.focusedPaneId] ? layout.panes[layout.focusedPaneId].sessionId : '';
      var zero = layout.panes[0] ? layout.panes[0].sessionId : '';
      var key = [focused, projectOfSession(focused), zero, projectOfSession(zero)].join('\u0000');
      if (key === focusedChatKey) return;
      focusedChatKey = key;
      var view = doc && doc.defaultView;
      if (view && typeof view.CustomEvent === 'function') safely(function () { view.dispatchEvent(new view.CustomEvent('jenny:focused-chat-changed')); });
    }

    function syncPaneLayout(kind) {
      if (disposed) return;
      layoutController.syncFocusedPaneFromState();
      if (kind === 'all' || kind === 'header') noteFocusedChat();
      if (layoutController.getPaneCount() < 2) notePaneSession(0, normalizeId(state.currentSessionId), false);
      if (routing || layoutController.getPaneCount() < 2) return;
      if (kind === 'all' || kind === 'header') renderKickers();
      var focused = layoutController.getLayout().focusedPaneId;
      if (kind === 'all') {
        panes.forEach(function (_pane, paneId) { schedulePaneRender(paneId); });
      } else if (kind === 'messages' && focused !== 0) {
        schedulePaneRender(focused);
      }
    }

    function ensureSessionLoaded(paneId, sessionId) {
      var id = normalizeId(sessionId);
      if (!id) return;
      Promise.resolve(call('loadSessionMessages', id)).then(function (loaded) {
        if (loaded && !disposed && paneSessionId(paneId) === id) schedulePaneRender(paneId);
      }).catch(function (error) {
        call('appendClientLog', 'WARN', 'chat.panes.load_failed', { paneId: paneId, message: String((error && error.message) || error) });
      });
    }

    function sameSessions(prev, next) {
      if (!prev || prev.panes.length !== next.panes.length) return false;
      return next.panes.every(function (entry, index) { return prev.panes[index].sessionId === entry.sessionId; });
    }

    /* W3-2: keep the side panel owner (renderer-side-panel-owner.js) in step
       with the layout BEFORE anything renders. 'collapse' = the owning pane
       closed: collapse the panel without the sticky dismissal. The sign-out
       reset (resetPanes, reason 'reset') is not a close, so it only clears
       the owner; a blank pane left by a real close still collapses. */
    function reconcileSidePanel(prev, next, meta) {
      var owner = options.sidePanelOwner || root.rendererSidePanelOwner;
      if (!owner || typeof owner.reconcilePanelOwner !== 'function') return false;
      var signedOut = Boolean(meta && meta.reason === 'reset');
      return owner.reconcilePanelOwner(state, prev, next) === 'collapse' && !signedOut;
    }

    /* Gate §D follow-up: a composer notice keyed to a session that a split
       layout showed and the next layout does not (pane 1 closed or switched
       away) is no pane's. With one pane left, pane 0 paints every keyed
       notice (today's one-pane path), so the slot is dropped here. */
    function dropOrphanedKeyedNotice(prev, next) {
      var noticeSessionId = normalizeId(state.ui && state.ui.composerStatusNoticeSessionId);
      var holds = function (layout) { return layout.panes.some(function (entry) { return entry.sessionId === noticeSessionId; }); };
      if (noticeSessionId && prev && prev.panes.length > 1 && holds(prev) && !holds(next)) call('clearComposerStatusNotice');
    }

    /* The panel shows the Subagent Monitor for a session the next layout drops:
       the monitor's own close (pane 1's dispose, or pane 0's session switch
       through the rail's layout sync) restores the prior prefs itself. */
    function subagentMonitorLeaves(next) {
      var record = state.ui && state.ui.subagentMonitor;
      var review = state.ui && state.ui.artifactReview;
      if (!record || !review || review.mode !== 'subagents') return false;
      return !next.panes.some(function (entry) { return entry.sessionId === record.sessionId; });
    }

    function handleLayoutChanged(prev, next, meta) {
      if (disposed || !next) return;
      dropOrphanedKeyedNotice(prev, next);
      var monitorClosing = subagentMonitorLeaves(next);
      var collapseSidePanel = reconcileSidePanel(prev, next, meta);
      var ratioOnly = sameSessions(prev, next) && prev.focusedPaneId === next.focusedPaneId;
      if (ratioOnly) return;
      var reason = (meta && meta.reason) || '';
      handOffDrafts(prev, next, reason);
      if (next.panes.length > 1 && !panes.has(1)) mount(1, next.panes[1].sessionId);
      if (next.panes.length < 2 && panes.has(1)) {
        // Removing pane 1's root drops a focus inside it to <body>; the
        // surviving session now shows in pane 0, so the keyboard goes there.
        var closing = panes.get(1);
        var hadFocus = Boolean(closing && closing.root && closing.root.contains(doc.activeElement));
        unmount(1);
        if (hadFocus) focusPaneInput(0);
      }
      if (next.panes.length > 1) showPaneDraft(panes.get(1), next.panes[1].sessionId, reason);
      notePaneSessions(next, reason === 'rekey');
      syncFocus();
      renderKickers();
      // Any pane whose session changed loads it (idempotent for a loaded one):
      // pane 0 too, since drag-to-split can place a never-opened tab there.
      next.panes.forEach(function (entry, index) {
        if (prev && prev.panes[index] && prev.panes[index].sessionId !== entry.sessionId) {
          ensureSessionLoaded(index, entry.sessionId);
        }
      });
      // The Subagent Monitor's own close already put back the prefs it displaced.
      if (collapseSidePanel && !monitorClosing) call('collapseSidePanel');
      requestFullRender();
    }

    /* ── IDE dock: it hosts pane 0's thread and composer (a W1 limit), so pane
       0 is the focused pane while docked: the dock header, its session
       picker, a dock send and the IDE all name the chat it shows. Undocking
       gives focus back to the pane that had it, DOM focus included (the
       dock's own focus restore lands in pane 0's composer). ── */
    function focusPaneInput(paneId) {
      var rootEl = paneRootOf(paneId);
      var input = rootEl ? rootEl.querySelector('textarea') : null;
      // Pane 0's composer may sit in the Workspace dock, outside its root.
      if (!input && paneId === 0) input = call('getPrimaryComposerInput') || null;
      if (input && typeof input.focus === 'function') input.focus({ preventScroll: true });
      return Boolean(input);
    }

    /* The legacy #chatInput is pane 0's; with two panes a view activation
       focuses the focused pane's composer instead. False with one pane. */
    function focusComposer() {
      var layout = layoutController.getLayout();
      return !disposed && layout.panes.length > 1 && focusPaneInput(layout.focusedPaneId);
    }

    var focusBeforeDock = -1;
    function handleChatDocked(docked) {
      if (disposed) return false;
      var layout = layoutController.getLayout();
      if (docked) {
        if (layout.panes.length < 2 || layout.focusedPaneId === 0) return false;
        focusBeforeDock = layout.focusedPaneId;
        return layoutController.setFocusedPane(0);
      }
      var restore = focusBeforeDock;
      focusBeforeDock = -1;
      if (restore < 1 || layout.panes.length <= restore) return false;
      layoutController.setFocusedPane(restore);
      var active = doc.activeElement;
      var zeroRoot = chatView.querySelector(':scope > .chat-pane[data-pane-id="0"]');
      if (!active || active === doc.body || (zeroRoot && zeroRoot.contains(active))) focusPaneInput(restore);
      return true;
    }

    /* ── Ctrl+Shift+\ : one pane -> the most recent other open tab beside;
       two panes -> close the non-focused pane ── */
    function toggleSplit() {
      if (disposed) return false;
      var layout = layoutController.getLayout();
      if (layout.panes.length > 1) {
        return layoutController.closePane(layout.focusedPaneId === 0 ? 1 : 0);
      }
      var current = normalizeId(state.currentSessionId);
      var candidates = call('listSwitchCandidates') || [];
      for (var index = 0; index < candidates.length; index += 1) {
        var id = normalizeId(candidates[index]);
        if (id && id !== current) return layoutController.openBeside(id);
      }
      return false;
    }

    /* Boot: a stored second pane reopens once the workspace restore settled
       (restore() already blanked a session that is no longer an open tab); a
       blank second pane stays closed. The store already holds the layout. */
    function hydrateOnce(storedLayout) {
      if (hydrated || disposed) return false;
      hydrated = true;
      var stored = storedLayout || call('getStoredLayout');
      var storedPanes = stored && Array.isArray(stored.panes) ? stored.panes : [];
      if (storedPanes.length < 2) return false;
      var second = storedPanes[1];
      var secondId = normalizeId(second && typeof second === 'object' ? second.sessionId : second);
      if (!secondId) return false;
      layoutController.applyLayout(stored, { persist: false });
      return layoutController.getPaneCount() > 1;
    }

    /* Row 40 W6b: the Workspace shows a pane other than pane 0 as its second chat. The whole root
       moves (kicker, thread, composer, tray), so everything pane-scoped keeps working; a null host
       puts it back after the divider. The pane's virtualizer rebuilds on the next frame. */
    function setPaneHost(paneId, host) {
      var pane = disposed ? null : panes.get(paneId);
      if (!pane || !pane.root) return false;
      var target = host || chatView;
      if (pane.root.parentNode === target) return false;
      var focused = pane.root.contains(doc.activeElement) ? doc.activeElement : null;
      var scroller = pane.dom && pane.dom.chatThreadScroll;
      var scrollTop = scroller ? scroller.scrollTop : 0;
      var divider = resizerEl();
      var parent = host || (divider && divider.parentNode) || chatView;
      var before = host ? null : (divider ? divider.nextSibling : null);
      // moveBefore keeps the subtree's state (scroll, focus) where the engine has it.
      if (typeof parent.moveBefore === 'function') parent.moveBefore(pane.root, before);
      else parent.insertBefore(pane.root, before);
      if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
      if (host) pane.root.dataset.paneHosted = 'workspace';
      else delete pane.root.dataset.paneHosted;
      // In the Workspace the root takes the dock body's adaptations (compact thread, docked composer).
      pane.root.classList.toggle('ide-chat-dock-body', Boolean(host));
      if (focused && focused.isConnected && typeof focused.focus === 'function') focused.focus({ preventScroll: true });
      var rebuild = function () {
        if (panes.get(paneId) !== pane) return;
        if (pane.pipeline && typeof pane.pipeline.rebuildVirtualizer === 'function') pane.pipeline.rebuildVirtualizer();
        if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
      };
      var win = doc && doc.defaultView;
      if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(rebuild);
      else rebuild();
      return true;
    }

    /* "Jump to chat": the non-zero pane showing `sessionId` (timeline, scroll, projection), else null. */
    function getSessionPaneTarget(sessionId) {
      var id = normalizeId(sessionId);
      var entries = layoutController.getLayout().panes;
      var paneId = -1;
      for (var index = 1; id && index < entries.length; index += 1) if (normalizeId(entries[index].sessionId) === id) paneId = index;
      var pane = disposed || paneId < 1 ? null : panes.get(paneId);
      if (!pane || !pane.dom || !pane.dom.chatTimeline) return null;
      var viewportApi = (pane.surface && pane.surface.viewportApi) || {};
      return {
        chatTimeline: pane.dom.chatTimeline,
        scrollMessageIntoView: typeof viewportApi.scrollMessageIntoView === 'function' ? viewportApi.scrollMessageIntoView : function () { return false; },
        getProjectionContext: function () {
          var cache = pane.runtime && pane.runtime.projectionContextBySession, entry = cache && typeof cache.get === 'function' ? cache.get(id) : null;
          return (entry && entry.currentContext) || null;
        },
      };
    }

    function dispose() {
      if (disposed) return;
      Array.from(panes.keys()).forEach(unmount);
      disposed = true;
      unbindFocusTracking();
      if (live === api) live = null;
    }

    var api = {
      mount: mount,
      unmount: unmount,
      getPane: function (paneId) { return panes.get(paneId) || null; },
      getPaneCount: function () { return layoutController.getPaneCount(); },
      getPaneSessionId: function (paneId) { return disposed ? '' : normalizeId(paneSessionId(paneId)); },
      setPaneHost: setPaneHost,
      setPaneRenderListener: function (fn) { paneRenderListener = typeof fn === 'function' ? fn : null; },
      handleLayoutChanged: handleLayoutChanged,
      renderSessionPane: renderSessionPane,
      renderMessagesForSession: function (sessionId) { return renderSessionPane(sessionId, 'messages'); },
      syncPaneLayout: syncPaneLayout,
      syncFocus: syncFocus,
      renderKickers: renderKickers,
      setDropHover: setDropHover,
      getDropTarget: function () { return disposed ? null : dropTarget; },
      measureWidth: measureWidth,
      toggleSplit: toggleSplit,
      hydrateOnce: hydrateOnce,
      handleChatDocked: handleChatDocked,
      focusComposer: focusComposer,
      getSessionPaneTarget: getSessionPaneTarget,
      dispose: dispose,
    };
    live = api;
    return api;
  }

  function getPaneComposition() {
    return live;
  }

  return {
    createPaneComposition: createPaneComposition,
    getPaneComposition: getPaneComposition,
  };
});
