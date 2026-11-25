/* renderer/chat/renderer-chat-right-stack.js - the Chat room's one right-hand stack (UMD).
 *
 * Row 190. The Chat room's workbench (renderer-chat-workbench.js) has one right stack: Session, Artifacts,
 * Changes and Project, plus optional views that join when first opened (file preview, Browser, Terminal,
 * Runs, Activity). Row 195: one view may show more than one mode (Project: Tasks and Notes; Runs: the list
 * and a helper's page); picking its tab opens the mode it last showed. This module keeps that stack and the
 * panels in step:
 *
 *   - The side panel (#artifactReviewPanel) is ONE live element. Its mode names the view that shows it
 *     (MODE_VIEW), and present() moves the panel into that view's host: the method the chat dock already
 *     uses, one element moved between hosts and never copied. The rail's state machine still owns the
 *     mode and the open state; it calls present() instead of sizing itself while this stack is active.
 *   - A tab the person picks (the view becomes shown) opens its mode through openMode(); the Session tab,
 *     and a stack that is collapsed or folded, close the panel without a dismissal.
 *   - The panel's own Close collapses the stack, or closes an optional view's tab.
 *
 * `presenting` guards the loop: a reveal this module makes never re-opens the mode that asked for it.
 * No DOM of its own, no storage.
 *
 * Wave 4: the Workspace and the Board make their own instance over their workbench, with only the modes
 * they have a view for (deps.modeViews; row 195: Artifacts, Project and Runs in both), all of them
 * optional. serves(mode) tells the side panel whether the room on screen can show a mode beside its work. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatRightStack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Side-panel mode -> the right-stack view that shows it.
  const MODE_VIEW = Object.freeze({
    artifact: 'artifacts',
    code_review: 'changes',
    tasks: 'project',
    notes: 'project',
    file_preview: 'preview',
    browser: 'browser',
    live: 'live-view',
    terminal: 'terminal',
    background_tasks: 'runs',
    subagents: 'runs',
  });
  const OPTIONAL_VIEWS = Object.freeze(['preview', 'browser', 'live-view', 'terminal', 'runs', 'activity']);

  // Wave 4: each other room's stack by its view name ('ide', 'board'); the side panel asks for the one on screen.
  const rooms = new Map();
  // The side panel's state machine, handed over once by the app (renderer-app-chat-workbench-composition.js).
  let panelAccess = { rail: () => null, openMode: () => false };
  function setPanelAccess(access) { panelAccess = Object.assign({}, panelAccess, access || {}); }
  function registerRoom(view, getStack) {
    rooms.set(view, getStack);
    return () => { if (rooms.get(view) === getStack) rooms.delete(view); };
  }
  function roomStack(view) {
    const get = rooms.get(view);
    return (get && get()) || null;
  }

  /* deps = {
   *   bench: { hostFor, isViewVisible, revealView, collapseStackOf, hasView, addView, removeView, getActiveView },
   *   getPanel() -> the side panel element or null,
   *   rail() -> { visible: bool, mode: string, collapse() } | null (the side panel's state machine),
   *   openMode(mode) -> bool (opens a mode with its content, as the old toolbar buttons did),
 *   resumeMode?(mode) -> bool (shows a mode again as it was left; absent: openMode),
   *   onSessionShown?(),
   *   modeFor?(viewId, modes) -> the mode a view with several should open on (absent or unknown: the last it showed),
   *   modeViews?: { [mode]: viewId } (default MODE_VIEW), optionalViews?: viewId[] (default OPTIONAL_VIEWS) } */
  function createChatRightStack(deps) {
    const d = deps || {};
    const bench = d.bench;
    const modeViews = d.modeViews || MODE_VIEW;
    const optionalViews = d.optionalViews || OPTIONAL_VIEWS;
    // A view's modes in the order listed: the first is the one it opens on until it has shown another.
    const viewModes = Object.keys(modeViews).reduce((out, mode) => { (out[modeViews[mode]] = out[modeViews[mode]] || []).push(mode); return out; }, {});
    const lastMode = {};
    function modeOf(viewId) {
      const modes = viewModes[viewId];
      if (!modes) return '';
      let wanted;
      try { wanted = typeof d.modeFor === 'function' ? d.modeFor(viewId, modes.slice()) : ''; } catch (_error) { wanted = ''; }
      if (modes.indexOf(wanted) >= 0) return wanted;
      return modes.indexOf(lastMode[viewId]) >= 0 ? lastMode[viewId] : modes[0];
    }
    const serves = (mode) => Object.prototype.hasOwnProperty.call(modeViews, mode);
    // This room's view for a mode: the Chat room falls back to Artifacts; a room without the mode has none.
    const viewOf = (mode) => (serves(mode) ? modeViews[mode] : (d.modeViews ? '' : 'artifacts'));
    let presenting = false;
    let shownMode = ''; // the mode the panel last showed in its view; '' while it is closed
    // The mode afterRender closed because its view stopped showing (a fold, a collapsed stack). When that view shows
    // again the panel comes back as it was left: no fresh content, no focus taken from the composer.
    let suspendedMode = '';

    function guarded(run) {
      const was = presenting;
      presenting = true;
      try { return run(); } finally { presenting = was; }
    }

    function railState() {
      try { return typeof d.rail === 'function' ? d.rail() : null; } catch (_error) { return null; }
    }

    function placePanel(viewId) {
      const panel = typeof d.getPanel === 'function' ? d.getPanel() : null;
      const host = panel ? bench.hostFor(viewId) : null;
      if (host && panel.parentNode !== host) host.appendChild(panel);
      return panel;
    }

    // The rail's classes on the panel and the chat view while hosted.
    // Before any reveal: a reveal re-renders the stack, which reads this state.
    function applyPanelChrome(info, visible, mode) {
      const { panel, chatView } = info;
      if (panel) {
        panel.classList.toggle('code-review-mode', mode === 'code_review');
        panel.dataset.artifactReviewMode = mode;
        panel.classList.toggle('hidden', !visible);
      }
      if (chatView) {
        chatView.classList.toggle('artifact-review-mode', visible);
        chatView.classList.toggle('code-review-open', visible && mode === 'code_review');
      }
    }

    // The rail's layout pass, while this stack is active. info = { visible, mode, panel?, chatView? }.
    function present(info) {
      const visible = Boolean(info && info.visible);
      const mode = String((info && info.mode) || 'artifact');
      // Another room adds its optional tab only on an open made there (info.explicit), never because the panel
      // was already open when the room came on screen: the tab would cover the chat in the dock.
      const viewId = viewOf(mode);
      const shows = visible && Boolean(viewId) && (!d.modeViews || bench.hasView(viewId) || (info && info.explicit === true));
      applyPanelChrome(info || {}, shows, mode);
      if (shows) {
        // Reveal on a new mode or an explicit open only: the rail presents on every render pass, and a stack the
        // solver keeps folded would otherwise force a workbench render each time.
        const reveal = shownMode !== mode || (info && info.explicit === true);
        shownMode = mode;
        lastMode[viewId] = mode;
        suspendedMode = '';
        guarded(() => {
          if (!bench.hasView(viewId)) bench.addView(viewId);
          const panel = placePanel(viewId);
          if (panel) panel.classList.remove('hidden');
          if (reveal && !bench.isViewVisible(viewId)) bench.revealView(viewId);
        });
        return true;
      }
      // A panel that never showed (no chat to show it for) is no dismissal: its view keeps showing.
      if (!shownMode) return true;
      const shownView = viewOf(shownMode);
      shownMode = '';
      guarded(() => {
        // The panel's own Close (or a rule that closed it) while its view shows: the stack follows.
        if (bench.isViewVisible(shownView) && bench.getActiveView(shownView) === shownView) {
          if (optionalViews.indexOf(shownView) >= 0) bench.removeView(shownView);
          else bench.collapseStackOf(shownView);
        }
      });
      return true;
    }

    // A view became shown (a tab, a strip button, a reveal). Opens its mode, or closes the panel for Session.
    function onViewShown(viewId) {
      if (presenting) return;
      const state = railState();
      const resume = suspendedMode;
      suspendedMode = '';
      if (viewId === 'session' || viewId === 'activity') {
        if (state && state.visible) guarded(() => state.collapse());
        if (viewId === 'session' && typeof d.onSessionShown === 'function') d.onSessionShown();
        return;
      }
      // The panel already shows one of this view's modes (Notes inside Project): it only needs its host.
      if (state && state.visible && viewModes[viewId] && viewOf(state.mode) === viewId && serves(state.mode)) { placePanel(viewId); return; }
      const mode = modeOf(viewId);
      if (!mode) return;
      guarded(() => {
        if (resume === mode && typeof d.resumeMode === 'function') d.resumeMode(mode);
        else if (typeof d.openMode === 'function') d.openMode(mode);
      });
      placePanel(viewId);
    }

    // After every workbench render: a panel whose view is no longer shown (collapsed, folded, moved behind
    // another tab) closes without a dismissal; it reopens when its view shows again.
    function afterRender() {
      if (presenting) return;
      const state = railState();
      if (!state || !state.visible) return;
      if (bench.isViewVisible(viewOf(state.mode))) return;
      const mode = state.mode;
      guarded(() => state.collapse());
      suspendedMode = mode;
    }

    // An optional view's own Close action.
    function closeView(viewId) {
      if (optionalViews.indexOf(viewId) < 0) return false;
      const state = railState();
      if (state && state.visible && viewOf(state.mode) === viewId) guarded(() => state.collapse());
      guarded(() => bench.removeView(viewId));
      return true;
    }

    return { present, onViewShown, afterRender, closeView, serves, size: d.bench.size || null };
  }

  // The side panel's home in #chatView: before the Activity panel while that is home too, else last.
  function parkSidePanel(panel) {
    const doc = panel && panel.ownerDocument;
    const view = doc && doc.getElementById('chatView');
    const context = doc && doc.getElementById('chatContextPanel');
    if (view) view.insertBefore(panel, context && context.parentNode === view ? context : null);
  }

  /* Wave 4: another room's stack over its own workbench (the Workspace's, the Board's). Its views are all
   * optional: one joins beside the first of opts.near the layout holds, and its Close takes it out.
   * opts = { workbench, getLayout(), commit(next), model, ops, modeViews, near: viewId[], jt?, icons?, doc? }; the
   *   panel is #artifactReviewPanel and its state machine is the one setPanelAccess was given. Returns the stack plus views(): the room's view entries for those tabs. */
  function createRoomStack(opts) {
    const o = opts || {};
    const wb = o.workbench;
    const ids = Object.keys(o.modeViews).map((mode) => o.modeViews[mode]).filter((id, at, list) => list.indexOf(id) === at);
    const hasView = (id) => o.model.findView(o.getLayout(), id) !== null;
    const getPanel = () => (o.doc || globalThis.document)?.getElementById('artifactReviewPanel') || null;
    const bench = {
      hostFor: (id) => wb.hostFor(id),
      isViewVisible: (id) => wb.isViewVisible(id),
      revealView: (id) => wb.revealView(id),
      collapseStackOf: (id) => wb.collapseStackOf(id),
      getActiveView: (id) => wb.getActiveView(id),
      hasView,
      addView(id) {
        const near = hasView(id) ? null : (o.near || []).find(hasView);
        if (near) o.commit(o.ops.addView(o.getLayout(), id, near));
      },
      // A view that leaves takes its host out of the document: the live panel goes home first, hidden.
      removeView(id) {
        if (!hasView(id)) return;
        const panel = getPanel();
        const host = wb.hostFor(id);
        if (panel && host && host.contains(panel)) { panel.classList.add('hidden'); parkSidePanel(panel); }
        o.commit(o.ops.removeView(o.getLayout(), id));
      },
    };
    const stack = createChatRightStack({
      bench, getPanel, modeViews: o.modeViews, optionalViews: ids,
      rail: () => panelAccess.rail(),
      openMode: (mode) => panelAccess.openMode(mode),
    });
    // A tab saved in the room's layout would come back empty after a restart (as in Chat, its tab joins when the
    // panel opens here): the room starts without them.
    const saved = ids.filter(hasView);
    if (saved.length) o.commit(saved.reduce((next, id) => o.ops.removeView(next, id), o.getLayout()));
    const jt = typeof o.jt === 'function' ? o.jt : (key, fallback) => fallback;
    const icons = o.icons || (globalThis.rendererChatWorkbench && globalThis.rendererChatWorkbench.ICONS) || {};
    const LABELS = {
      artifacts: () => jt('chat.workbench.view.artifacts', 'Artifacts'),
      project: () => jt('chat.workbench.view.project', 'Project'),
      runs: () => jt('chat.workbench.view.runs', 'Runs'),
    };
    function views() {
      const out = {};
      ids.forEach((id) => {
        const label = LABELS[id];
        out[id] = {
          label,
          icon: icons[id],
          onShow: () => stack.onViewShown(id),
          actions: () => [{ name: 'close', label: jt('chat.workbench.closeView', 'Close {name}', { name: label() }), icon: icons.close }],
          onAction: (name) => { if (name === 'close') stack.closeView(id); },
        };
      });
      return out;
    }
    // Before a reset: the room's tabs leave the way their Close takes them, so the live panel goes home first.
    const releaseViews = () => ids.forEach((id) => bench.removeView(id));
    return Object.assign({}, stack, { views, ids, releaseViews });
  }

  return { createChatRightStack, createRoomStack, parkSidePanel, setPanelAccess, registerRoom, roomStack, MODE_VIEW, OPTIONAL_VIEWS };
});
