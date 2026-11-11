/* renderer/app/renderer-app-pane-placement.js -- which chat pane has focus and where a pane's root sits (UMD) */
/**
 * Extracted from renderer-app-pane-composition.js (which creates it once and
 * calls through). The composition still owns mount/unmount and the layout
 * callback; this owns:
 *   bindFocusTracking(), unbindFocusTracking()  a pointerdown (capture) or
 *       focusin inside a pane root focuses that pane; bound only while two
 *       panes are open
 *   syncFocus()  the data-pane-focused attributes
 *   focusPaneInput(paneId), focusComposer(), handleChatDocked(docked)
 *   setPaneHost(paneId, host)  row 40 W6b: the Workspace shows a pane other
 *       than pane 0 as its second chat
 *   getSessionPaneTarget(sessionId)  the side panel's jump target in a pane
 *       other than pane 0, else null
 *
 * deps: chatView, doc, layoutController, panes (the composition's Map),
 * pane0Root, paneRootOf, paneRoots, resizerEl, call, isDisposed, normalizeId.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppPanePlacement = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createPanePlacement(deps) {
    var chatView = deps.chatView;
    var doc = deps.doc;
    var layoutController = deps.layoutController;
    var panes = deps.panes;
    var pane0Root = deps.pane0Root;
    var paneRootOf = deps.paneRootOf;
    var paneRoots = deps.paneRoots;
    var resizerEl = deps.resizerEl;
    var call = deps.call;
    var isDisposed = deps.isDisposed;
    var normalizeId = deps.normalizeId;
    var focusCleanup = null;

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
      return !isDisposed() && layout.panes.length > 1 && focusPaneInput(layout.focusedPaneId);
    }

    var focusBeforeDock = -1;
    function handleChatDocked(docked) {
      if (isDisposed()) return false;
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
      var zeroRoot = pane0Root();
      if (!active || active === doc.body || (zeroRoot && zeroRoot.contains(active))) focusPaneInput(restore);
      return true;
    }

    /* Row 40 W6b: the Workspace shows a pane other than pane 0 as its second chat. The whole root
       moves (kicker, thread, composer, tray), so everything pane-scoped keeps working; a null host
       puts it back after the divider. The pane's virtualizer rebuilds on the next frame. */
    function setPaneHost(paneId, host) {
      var pane = isDisposed() ? null : panes.get(paneId);
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
      var pane = isDisposed() || paneId < 1 ? null : panes.get(paneId);
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

    return {
      bindFocusTracking: bindFocusTracking,
      unbindFocusTracking: unbindFocusTracking,
      syncFocus: syncFocus,
      focusPaneInput: focusPaneInput,
      focusComposer: focusComposer,
      handleChatDocked: handleChatDocked,
      setPaneHost: setPaneHost,
      getSessionPaneTarget: getSessionPaneTarget,
    };
  }

  return { createPanePlacement: createPanePlacement };
});
