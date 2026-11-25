/* renderer/chat/renderer-chat-workbench.js - the Chat room's binding to the workbench (UMD).
 *
 * Row 190 (the workspace-shell one-layout-engine plan). The Workspace and the Board lay out their
 * panels with the workbench (renderer-ide-workbench.js); this is the Chat room's instance, in the shape of
 * board-page-workbench.js. Its layout is the `chat` profile: Chats | the chat panes | one right stack.
 *
 *   - Centre: a wrapper that adopts the open-chat tab row (#workspaceRailShell) and #chatView itself, so
 *     everything inside #chatView (the panes, the pane controller, the chat dock's moves) is untouched.
 *   - Left: the Chats panel's content (#sidebarHistorySection) moves into the `chats` host. New chat is the
 *     stack's header action and its folded strip's second button.
 *   - Right: renderer-chat-right-stack.js keeps the side panel and the session rail in their views' hosts.
 *
 * Every element is moved, never copied, and unmount() puts each back where it was (renderer teardown).
 * The centre's floor is 360px per visible pane; when two
 * panes cannot have it beside two folded strips, the second pane folds (`data-split-folded` on #chatView)
 * and returns when the room widens. The room hides with #chatView through html[data-active-view]. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatWorkbench = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PANE_MIN = 360;
  const SVG_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = Object.freeze({
    chats: `${SVG_OPEN}<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.5L5.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/></svg>`,
    newChat: `${SVG_OPEN}<path d="M8 3.5v9M3.5 8h9"/></svg>`,
    session: `${SVG_OPEN}<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg>`,
    artifacts: `${SVG_OPEN}<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/></svg>`,
    changes: `${SVG_OPEN}<path d="M4 2.5v11M12 2.5v11M2.5 5.5H5.5M10.5 10.5h3M12 9v3"/></svg>`,
    preview: `${SVG_OPEN}<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
    browser: `${SVG_OPEN}<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/></svg>`,
    'live-view': `${SVG_OPEN}<path d="M5 3.5v9l7-4.5z"/></svg>`,
    terminal: `${SVG_OPEN}<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5L6.5 8l-2 1.5M8 10h3"/></svg>`,
    activity: `${SVG_OPEN}<path d="M2 8.5h3l1.5-4 3 7 1.5-3H14"/></svg>`,
    project: `${SVG_OPEN}<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>`,
    runs: `${SVG_OPEN}<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>`,
    close: `${SVG_OPEN}<path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  });

  // Labels resolve at render time, so a language switch shows at the next render.
  function viewLabels(jt) {
    return {
      chats: () => jt('chat.workbench.view.chats', 'Chats'),
      session: () => jt('chat.workbench.view.session', 'Session'),
      artifacts: () => jt('chat.workbench.view.artifacts', 'Artifacts'),
      changes: () => jt('chat.workbench.view.changes', 'Changes'),
      project: () => jt('chat.workbench.view.project', 'Project'),
      preview: () => jt('chat.workbench.view.preview', 'File'),
      browser: () => jt('chat.workbench.view.browser', 'Browser'),
      'live-view': () => jt('chat.workbench.view.liveView', 'Live'),
      terminal: () => jt('chat.workbench.view.terminal', 'Terminal'),
      runs: () => jt('chat.workbench.view.runs', 'Runs'),
      activity: () => jt('chat.workbench.view.activity', 'Activity'),
    };
  }

  /* deps = { doc, win, workbenchUtils, layoutModel, layoutOps, store, rightStackUtils, jt,
   *   newChat(), focusComposer() -> bool, getFontScale?() -> number,
   *   openMode(mode) -> bool, resumeMode?(mode) -> bool, rail() -> { visible, mode, collapse() } | null,
   *   counts?: { [viewId]: () => number }, unread?: { [viewId]: () => bool } (row 195: Runs, Changes; Project's dot),
   *   unreadLabel?: { [viewId]: () => string } (what the dot means, for the tab's name), modeFor?(viewId, modes) -> mode,
   *   isActivityAvailable?() -> bool, closeActivity?(), onSessionShown?(), onUnmount?(), onRendered?(), log?(level, event, payload) } */
  function createChatWorkbench(deps) {
    const d = deps || {};
    const doc = d.doc;
    const win = d.win || (doc && doc.defaultView);
    const jt = typeof d.jt === 'function' ? d.jt : (k, def) => def;
    const model = d.layoutModel;
    const ops = d.layoutOps;
    const log = typeof d.log === 'function' ? d.log : () => {};

    let layout = null;
    let workbench = null;
    let rightStack = null;
    let rootEl = null;
    let centreEl = null;
    let moved = [];
    let observers = [];
    let frame = 0;
    let mounted = false;
    // A saved panel tab reopens its panel once the room is on screen: reopening it while another room shows
    // would pull the user into Chat (or open the panel in that room) at boot.
    let pendingReopen = false;
    const chatShown = () => { const view = doc.documentElement.dataset.activeView; return !view || view === 'chat'; };
    function reopenSaved() {
      if (!pendingReopen || !mounted || !chatShown()) return;
      pendingReopen = false;
      const shown = workbench.getActiveView(rightAnchor());
      if (shown && shown !== 'session' && workbench.isViewVisible(shown)) rightStack.onViewShown(shown);
    }
    let splitFolded = false;

    const byId = (id) => doc.getElementById(id);
    const chatView = () => byId('chatView');

    function paneCount() {
      const view = chatView();
      return view && view.dataset && view.dataset.paneCount === '2' ? 2 : 1;
    }

    function fontScale() {
      if (typeof d.getFontScale === 'function') return d.getFontScale();
      const raw = win && win.getComputedStyle ? Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--font-scale')) : NaN;
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    }

    /* Two panes keep 360px each, or the second folds: decided before the solve, from the room's width less
       the two strips the side stacks fold to, so the fold happens only after both stacks have folded. */
    function decideSplit() {
      const view = chatView();
      if (!view || !rootEl) return;
      const width = rootEl.getBoundingClientRect().width;
      const want = paneCount() === 2 && width > 0 && width - 2 * model.STRIP_SIZE < 2 * PANE_MIN * fontScale();
      if (want === splitFolded && (view.dataset.splitFolded === 'true') === want) return;
      splitFolded = want;
      if (want) view.dataset.splitFolded = 'true';
      else delete view.dataset.splitFolded;
    }

    const centreMin = () => (paneCount() === 2 && !splitFolded ? 2 * PANE_MIN : PANE_MIN);

    function commit(next) {
      if (!mounted || !next) return;
      layout = next;
      d.store.saveLayout(layout);
      workbench.render();
    }

    function render() {
      if (!mounted) return;
      decideSplit();
      workbench.render();
    }

    function scheduleRender() {
      if (!mounted || frame) return;
      const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
      frame = raf(() => { frame = 0; render(); });
    }

    function hasView(viewId) { return model.findView(layout, viewId) !== null; }

    // An optional view joins the right stack beside its last fixed view (Project), or wherever Session is.
    function addView(viewId) {
      if (hasView(viewId)) return;
      const near = ['project', 'changes', 'artifacts', 'session'].find(hasView);
      if (near) commit(ops.addView(layout, viewId, near));
    }

    const parkSidePanel = (panel) => { if (panel) d.rightStackUtils.parkSidePanel(panel); }; // its home in #chatView

    // A view that leaves takes its host out of the document: the live panel in it goes back to #chatView
    // first (hidden), so it is never detached. Activity's own Close follows its tab.
    function removeView(viewId) {
      if (!hasView(viewId)) return;
      const panel = byId('artifactReviewPanel');
      const host = workbench.hostFor(viewId);
      if (panel && host && host.contains(panel)) {
        panel.classList.add('hidden');
        parkSidePanel(panel);
      }
      if (viewId === 'activity') parkActivity();
      commit(ops.removeView(layout, viewId));
      if (viewId === 'activity' && typeof d.closeActivity === 'function') d.closeActivity();
    }

    // Activity (#chatContextPanel, flag activity_monitor) is an optional view: open, it joins the stack and its
    // panel moves into the tab; closed, the panel goes home and the tab leaves. Its column in #chatView is gone.
    function parkActivity() {
      const panel = byId('chatContextPanel');
      const view = chatView();
      if (panel && view && panel.parentNode !== view) view.appendChild(panel);
    }

    function syncActivity() {
      const panel = byId('chatContextPanel');
      if (!mounted || !panel) return;
      if (panel.classList.contains('activity-mode')) {
        addView('activity');
        const host = workbench.hostFor('activity');
        if (host && panel.parentNode !== host) host.appendChild(panel);
        if (!workbench.isViewVisible('activity')) workbench.revealView('activity');
      } else if (hasView('activity')) {
        parkActivity();
        commit(ops.removeView(layout, 'activity'));
      }
    }

    function buildViews() {
      const labels = viewLabels(jt);
      const views = {};
      Object.keys(labels).forEach((id) => {
        views[id] = { label: labels[id], icon: ICONS[id], onShow: () => rightStack && chatShown() && rightStack.onViewShown(id) };
        if (typeof d.counts?.[id] === 'function') views[id].count = d.counts[id];
        if (typeof d.unread?.[id] === 'function') views[id].unread = d.unread[id];
        if (typeof d.unreadLabel?.[id] === 'function') views[id].unreadLabel = d.unreadLabel[id];
      });
      const newChatAction = () => [{ name: 'new-chat', label: jt('chat.workbench.newChat', 'New chat'), icon: ICONS.newChat }];
      views.chats = {
        label: labels.chats,
        icon: ICONS.chats,
        actions: newChatAction,
        stripActions: newChatAction,
        onAction: (name) => { if (name === 'new-chat' && typeof d.newChat === 'function') d.newChat(); },
      };
      rightStackUtilsOf().OPTIONAL_VIEWS.forEach((id) => {
        views[id].actions = () => [{ name: 'close', label: jt('chat.workbench.closeView', 'Close {name}', { name: labels[id]() }), icon: ICONS.close }];
        views[id].onAction = (name) => { if (name === 'close' && rightStack) rightStack.closeView(id); };
      });
      return views;
    }

    function rightStackUtilsOf() { return d.rightStackUtils; }

    function move(node, parent, before) {
      if (!node || !parent) return;
      moved.push({ node, parent: node.parentNode, next: node.nextSibling });
      parent.insertBefore(node, before || null);
    }

    function focusComposer() {
      // Never take focus from inside the centre: a fold or reopen must not move a caret mid-typing.
      const active = doc.activeElement;
      if (centreEl && active && centreEl.contains(active)) return true;
      return typeof d.focusComposer === 'function' && d.focusComposer() === true;
    }

    function mount() {
      if (mounted) return true;
      const view = chatView();
      const history = byId('sidebarHistorySection');
      const context = byId('chatContextPanel'); // read now: the centre is out of the document until the first render
      if (!view || !view.parentNode || !history || !d.workbenchUtils || !model || !ops) return false;
      // Optional tabs join when their panel opens, so a saved one does not come back empty after a restart.
      layout = d.rightStackUtils.OPTIONAL_VIEWS.reduce((next, id) => (model.findView(next, id) ? ops.removeView(next, id) : next), d.store.loadLayout());
      rootEl = doc.createElement('div');
      rootEl.id = 'chatWorkbench';
      rootEl.className = 'ide-workbench chat-workbench';
      centreEl = doc.createElement('div');
      centreEl.className = 'chat-workbench-centre';
      view.parentNode.insertBefore(rootEl, view);
      moved = [];
      move(byId('workspaceRailShell'), centreEl);
      move(view, centreEl);
      mounted = true;
      try {
        workbench = d.workbenchUtils.createIdeWorkbench({
          getRoot: () => rootEl,
          idPrefix: 'chat-',
          getLayout: () => layout,
          commitLayout: commit,
          views: buildViews(),
          isViewAvailable: (id) => (id !== 'activity' || typeof d.isActivityAvailable !== 'function' || d.isActivityAvailable() === true)
            && (id !== 'live-view' || typeof d.isLiveViewAvailable !== 'function' || d.isLiveViewAvailable() === true), // row 197: the live_run_view flag
          getEditorElement: () => centreEl,
          getGroupElement: () => null,
          focusEditor: focusComposer,
          // The optional tabs leave first, so their live panels go home instead of out of the document.
          resetLayout: () => { d.rightStackUtils.OPTIONAL_VIEWS.forEach(removeView); commit(model.createDefaultLayout('chat')); },
          getFontScale: fontScale,
          getCentreMinWidth: centreMin,
          // Only while Chat is on screen: the panel may be showing in another room's stack, which this one must not close.
          onRendered: () => { if (rightStack && chatShown()) rightStack.afterRender(); reopenSaved(); if (typeof d.onRendered === 'function') d.onRendered(); },
          jt,
        });
        move(history, workbench.hostFor('chats'));
        rightStack = d.rightStackUtils.createChatRightStack({
          bench: {
            hostFor: (id) => workbench.hostFor(id),
            isViewVisible: (id) => workbench.isViewVisible(id),
            revealView: (id) => workbench.revealView(id),
            collapseStackOf: (id) => workbench.collapseStackOf(id),
            getActiveView: (id) => workbench.getActiveView(id),
            hasView,
            addView,
            removeView,
            size: { get: rightSize, set: setRightWidth }, // Wide (row 197): the right stack's width, committed like a sash drag
          },
          getPanel: () => byId('artifactReviewPanel'),
          rail: d.rail,
          openMode: d.openMode,
          resumeMode: d.resumeMode,
          modeFor: d.modeFor,
          onSessionShown: d.onSessionShown,
        });
        doc.documentElement.dataset.chatWorkbench = 'on';
        if (typeof win.ResizeObserver === 'function') {
          const resize = new win.ResizeObserver(scheduleRender);
          resize.observe(rootEl);
          observers.push(resize);
        }
        if (typeof win.MutationObserver === 'function') {
          const panes = new win.MutationObserver(scheduleRender);
          panes.observe(view, { attributes: true, attributeFilter: ['data-pane-count'] });
          observers.push(panes);
          const activity = new win.MutationObserver(syncActivity);
          if (context) activity.observe(context, { attributes: true, attributeFilter: ['class'] });
          observers.push(activity);
        }
        render();
        syncActivity();
        // A panel tab saved as the shown one reopens its panel (Session needs nothing), once Chat is on screen.
        pendingReopen = true;
        reopenSaved();
        return true;
      } catch (error) {
        log('ERROR', 'chat_workbench.mount_failed', { message: String((error && error.message) || error).slice(0, 200) });
        unmount();
        return false;
      }
    }

    function unmount() {
      if (!rootEl) return;
      mounted = false;
      observers.forEach((o) => o.disconnect());
      observers = [];
      if (frame && win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame);
      frame = 0;
      // Back where each came from, last moved first; the side panel and the session rail go home too.
      const panel = byId('artifactReviewPanel');
      const view = chatView();
      parkActivity();
      if (panel && view && !view.contains(panel)) parkSidePanel(panel);
      for (let i = moved.length - 1; i >= 0; i -= 1) {
        const m = moved[i];
        if (m.parent) m.parent.insertBefore(m.node, m.next && m.next.parentNode === m.parent ? m.next : null);
      }
      moved = [];
      if (view && view.dataset) delete view.dataset.splitFolded;
      splitFolded = false;
      if (workbench) workbench.dispose();
      workbench = null;
      rightStack = null;
      rootEl.remove();
      rootEl = null;
      centreEl = null;
      delete doc.documentElement.dataset.chatWorkbench;
      if (typeof d.onUnmount === 'function') d.onUnmount();
    }

    const rightAnchor = () => ['session', 'artifacts', 'changes', 'project'].find(hasView) || 'session';

    // The right stack's width now, the room's, and the most it can take beside the centre and the Chats stack.
    function rightSize() {
      const width = (host) => Math.round((host && host.getBoundingClientRect().width) || 0);
      const room = width(rootEl);
      const max = room - Math.round(centreMin() * fontScale()) - (workbench.isViewVisible('chats') ? width(workbench.hostFor('chats')) : 0);
      return { width: width(workbench.hostFor(rightAnchor())), room, max };
    }

    function setRightWidth(px) {
      const found = mounted ? model.findView(layout, rightAnchor()) : null;
      if (!found) return false;
      commit(model.setStackSize(layout, found.stackId, px));
      return true;
    }

    return {
      mount,
      unmount,
      isMounted: () => mounted,
      render: scheduleRender,
      getLayout: () => layout,
      getRightStack: () => (mounted ? rightStack : null),
      hostFor: (id) => (mounted ? workbench.hostFor(id) : null),
      isViewVisible: (id) => mounted && workbench.isViewVisible(id),
      revealView: (id, opts) => mounted && workbench.revealView(id, opts),
      // Ctrl+B ('chats') and Ctrl+Alt+B or Ctrl+\ ('right'): fold or reopen the stack; false while unmounted.
      toggle(which) {
        if (!mounted) return false;
        const anchor = which === 'chats' ? 'chats' : rightAnchor();
        const active = workbench.getActiveView(anchor) || anchor;
        if (workbench.isViewVisible(active)) workbench.collapseStackOf(active);
        else workbench.revealView(active);
        return true;
      },
      dispose: unmount,
    };
  }

  return { createChatWorkbench, ICONS, PANE_MIN };
});
