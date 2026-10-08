/* renderer/features/renderer-ide-workspace-chats.js
 * The Workspace's chats and their links to Git (row 40 W6, F3 and F8).
 *
 * Pane 0 is the IDE's chat: the dock hosts its transcript, the first Changes view
 * shows its turns and Source Control marks the files Jenny changed in it. With two
 * split-view panes the workbench also offers `chat-2`, pane 1's whole root moved in
 * while the Workspace shows (its kicker heads it and closes it), and `changes-2`, a
 * second Changes view bound to pane 1's session. Both views join the layout tree the
 * first time a second chat exists and then stay where the user puts them; while
 * there is no second chat the workbench prunes them from the render.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkspaceChats = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const MARKER_DEBOUNCE_MS = 400;
  const SECOND_CHAT_HEIGHT = 320;

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  /**
   * @param {object} deps
   * @param {object} deps.state renderer state (ui.activeView, features, currentSessionId, workspaceRoot)
   * @param {() => object|null} deps.getWorkbench the workbench wiring (getLayout, replaceLayout, listViews, viewDeps, isVisible, showPanel, render)
   * @param {() => object|null} [deps.getPaneComposition] split view's pane composition
   * @param {(sessionId?: string) => object[]} deps.getTurnViewModels pane 0's projected turns for a session
   * @param {(sessionId: string) => object[]} deps.getSessionMessages
   * @param {(vms: object[], meta: object) => object} deps.buildLedger buildJennyChangeLedgerFromTurnViewModels
   * @param {() => object|null} deps.getGitFeature isRepo / getDecoration / subscribe / refreshJennyMarkers
   * @param {object} deps.viewDeps the Changes view deps both chats share (diff openers, undo, escapeHtml, log)
   * @param {() => Promise<object|null>} deps.loadChangesView
   * @param {() => void} [deps.requestRender] renderIde
   * @param {() => void} [deps.onCountChange] repaints the workbench chrome (Chat 2's dot, Changes 2's count)
   */
  function createIdeWorkspaceChats(deps = {}) {
    const state = deps.state || {};
    const getWorkbench = typeof deps.getWorkbench === 'function' ? deps.getWorkbench : () => null;
    const getPaneComposition = typeof deps.getPaneComposition === 'function'
      ? deps.getPaneComposition
      : () => globalRef.rendererAppPaneComposition?.getPaneComposition?.() || null;
    const getTurnViewModels = typeof deps.getTurnViewModels === 'function' ? deps.getTurnViewModels : () => [];
    const getSessionMessages = typeof deps.getSessionMessages === 'function' ? deps.getSessionMessages : () => [];
    const buildLedger = typeof deps.buildLedger === 'function' ? deps.buildLedger : () => ({ changes: [] });
    const getGitFeature = typeof deps.getGitFeature === 'function' ? deps.getGitFeature : () => null;
    const requestRender = typeof deps.requestRender === 'function' ? deps.requestRender : noop;
    const onCountChange = typeof deps.onCountChange === 'function' ? deps.onCountChange : noop;
    const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : (id) => clearTimeout(id);
    const layoutOps = deps.layoutOps || resolveModule('jennyWorkbenchLayoutOps', '../shared/workbench-layout-ops');
    const dockChanges = deps.dockChanges || resolveModule('rendererIdeChatDockChanges', './renderer-ide-chat-dock-changes');

    let disposed = false;
    let renderQueued = false;
    let renderHooked = null; // the composition the pane-render listener is registered on

    function isFlagOn() {
      return state.features?.featureFlags?.ide_chat_dock === true;
    }

    function inWorkspace() {
      return state.ui?.activeView === 'ide';
    }

    function composition() {
      const value = getPaneComposition();
      return value && typeof value.getPaneCount === 'function' ? value : null;
    }

    function hasSecondPane() {
      const panes = composition();
      return Boolean(panes && panes.getPaneCount() > 1);
    }

    /** The chat the IDE shows (pane 0): its own session with two panes, else the current one. */
    function primarySessionId() {
      const panes = hasSecondPane() ? composition() : null;
      const id = panes && typeof panes.getPaneSessionId === 'function' ? panes.getPaneSessionId(0) : '';
      return String(id || state.currentSessionId || '');
    }

    function secondSessionId() {
      const panes = hasSecondPane() ? composition() : null;
      return String((panes && typeof panes.getPaneSessionId === 'function' && panes.getPaneSessionId(1)) || '');
    }

    function isSecondChatAvailable() {
      return isFlagOn() && Boolean(secondSessionId());
    }

    // Pane 1's turns live in its own runtime's projection cache.
    function secondTurnViewModels() {
      const target = composition()?.getSessionPaneTarget?.(secondSessionId());
      const ctx = target && typeof target.getProjectionContext === 'function' ? target.getProjectionContext() : null;
      return ctx && ctx.viewModelByTurnId instanceof Map ? Array.from(ctx.viewModelByTurnId.values()) : [];
    }

    function workspaceId() {
      return String(state.workspaceRoot?.rootId || '');
    }

    /** Pane 1's ledger (Open diff from Chat 2's transcript). */
    function secondLedger() {
      return buildLedger(secondTurnViewModels(), { sessionId: secondSessionId(), workspaceId: workspaceId() });
    }

    // ---- Git links (F8) ------------------------------------------------------

    function getGitState(path) {
      const git = getGitFeature();
      if (!git || git.isRepo?.() !== true) return null;
      return git.getDecoration?.(path) ? 'changed' : 'clean';
    }

    function subscribeGit(fn) {
      return getGitFeature()?.subscribe?.(fn) || null;
    }

    // Open in Git shows Source Control, brings the file's row into view and focuses it, as the
    // Jenny marker focuses Changes: Changes may share Git's stack and have just been hidden.
    function openInGit(path) {
      const workbench = getWorkbench();
      workbench?.showPanel?.('source-control');
      const rows = workbench?.viewDeps?.('source-control')?.getMountEl?.()?.querySelectorAll?.('[data-ide-scm-path]') || [];
      const row = Array.from(rows).find((item) => item.getAttribute('data-ide-scm-path') === String(path || ''));
      row?.scrollIntoView?.({ block: 'nearest' });
      row?.querySelector?.('[data-ide-scm-action="diff"]')?.focus?.();
    }

    // Path -> Jenny's latest change to it in the IDE's chat, rebuilt only when its turns change.
    let jennyIndex = { sessionId: '', vms: [], byPath: new Map() };
    function jennyIndexNow() {
      const sessionId = primarySessionId();
      const vms = getTurnViewModels(sessionId) || [];
      const same = sessionId === jennyIndex.sessionId && vms.length === jennyIndex.vms.length
        && vms.every((vm, i) => vm === jennyIndex.vms[i]);
      if (!same) {
        const byPath = new Map();
        for (const change of buildLedger(vms, { sessionId, workspaceId: workspaceId() }).changes || []) {
          byPath.set(change.path, { turnId: change.turnId, fileKey: change.fileKey });
        }
        jennyIndex = { sessionId, vms: vms.slice(), byPath }; // a copy: an array grown in place must still read as changed
      }
      return jennyIndex;
    }

    /** Jenny's change to `path` in the IDE's chat, or null (always null without the dock: Changes lives there). */
    function jennyChangeFor(path) {
      if (!isFlagOn()) return null;
      return jennyIndexNow().byPath.get(String(path || '')) || null;
    }

    // The markers follow the ledger: a chat render re-checks it (debounced) and repaints Source Control on a change.
    let markerSig = '';
    let markerTimer = null;
    function scheduleMarkerRefresh() {
      if (disposed || markerTimer || !inWorkspace()) return;
      markerTimer = setTimer(() => {
        markerTimer = null;
        if (disposed) return;
        const sig = Array.from(jennyIndexNow().byPath, ([path, c]) => `${path}\x1f${c.turnId}\x1f${c.fileKey}`).join('\x1e');
        if (sig === markerSig) return;
        markerSig = sig;
        getGitFeature()?.refreshJennyMarkers?.();
      }, MARKER_DEBOUNCE_MS);
    }

    // ---- The Changes views' deps ---------------------------------------------

    const shared = deps.viewDeps || {};
    const gitDeps = { getGitState, subscribeGit, openInGit };

    // Each Changes view names its chat's pane, so a bound chat's diffs open in its group (W7c).
    const fromPane = (pane) => ({
      openChangeDiff: (change) => shared.openChangeDiff?.(change, { pane }),
      openSuggestionDiff: (sessionId, id) => shared.openSuggestionDiff?.(sessionId, id, { pane }),
    });
    /** The first Changes view's deps (pane 0's chat), for the dock. */
    const primaryViewDeps = {
      ...shared,
      ...fromPane(0),
      ...gitDeps,
      getTurnViewModels: () => getTurnViewModels(primarySessionId()) || [],
      getSessionId: primarySessionId,
      getWorkspaceId: workspaceId,
      getSessionMessages: () => getSessionMessages(primarySessionId()) || [],
    };

    // ---- The second chat (W6b) ------------------------------------------------

    const SECOND_IDS = { chat: 'chat-2', changes: 'changes-2' };
    const second = dockChanges?.createChatDockChanges?.({
      workbench: {
        isVisible: (id) => getWorkbench()?.isVisible?.(SECOND_IDS[id] || id) === true,
        reveal: (id) => getWorkbench()?.showPanel?.(SECOND_IDS[id] || id) === true,
        getChangesHost: () => getWorkbench()?.viewDeps?.('changes-2')?.getMountEl?.() || null,
        onCountChange: () => onCountChange(),
      },
      loadChangesView: deps.loadChangesView,
      appendClientLog: shared.appendClientLog,
      focusChatInput: () => composition()?.getPane?.(1)?.root?.querySelector?.('textarea')?.focus?.(),
      isChatOnScreen: () => !inWorkspace() || getWorkbench()?.isVisible?.('chat-2') === true,
      viewDeps: {
        ...shared,
        ...fromPane(1),
        ...gitDeps,
        getTurnViewModels: secondTurnViewModels,
        getSessionId: secondSessionId,
        getWorkspaceId: workspaceId,
        getSessionMessages: () => getSessionMessages(secondSessionId()) || [],
      },
    }) || null;

    /**
     * Both views join the tree once, together in a new stack below the first chat's (one that is
     * missing alone joins the other). A commit made while rendering (no re-render); true when the
     * tree changed.
     */
    function reconcileLayout() {
      const workbench = getWorkbench();
      if (disposed || !layoutOps || !isSecondChatAvailable() || !workbench?.getLayout) return false;
      const layout = workbench.getLayout();
      if (!layout) return false;
      const present = new Set(workbench.listViews?.() || []);
      let next = layout;
      if (!present.has('chat-2') && !present.has('changes-2')) {
        // Like the first chat's stack (Chat | Changes): one stack below it holds both. The first
        // keeps the rest of its rendered height (with no editor there, the new last stack flexes).
        const firstStack = workbench.viewDeps?.('chat')?.getMountEl?.()?.closest?.('[data-wb-stack]');
        const firstHeight = firstStack ? firstStack.getBoundingClientRect().height : 0;
        const beside = layoutOps.addStackBeside?.(next, ['chat-2', 'changes-2'], 'chat', 'col', SECOND_CHAT_HEIGHT, firstHeight);
        next = beside && beside !== next ? beside : next;
      }
      if (!present.has('chat-2') && next === layout) next = layoutOps.addView?.(next, 'chat-2', present.has('changes-2') ? 'changes-2' : 'chat') || next;
      if (!present.has('changes-2') && next === layout) next = layoutOps.addView?.(next, 'changes-2', present.has('chat-2') ? 'chat-2' : 'changes') || next;
      if (next === layout) return false;
      workbench.replaceLayout?.(next);
      return true;
    }

    // Pane 1's root sits in Chat 2's host while the Workspace shows, else back in the chat view.
    function syncHost() {
      const panes = composition();
      if (!panes || typeof panes.setPaneHost !== 'function' || !panes.getPane?.(1)) return;
      const host = inWorkspace() && isSecondChatAvailable()
        ? getWorkbench()?.viewDeps?.('chat-2')?.getMountEl?.() || null
        : null;
      const hosted = Boolean(host && host.isConnected);
      panes.setPaneHost(1, hosted ? host : null);
      // Chat 2 streams live while hosted, whatever the dock's own stack does (pane visibility reads it).
      if (state.ui) state.ui.ideSecondChatHosted = hosted;
      // A hosted root is not focus-tracked: with the dock showing, pane 0 stays the focused chat
      // its header and session picker name (the dock hands focus back when it undocks).
      if (hosted && getWorkbench()?.isVisible?.('chat') === true) panes.handleChatDocked?.(true);
    }

    /** Every dock sync (each chat render and Workspace render): markers, the second chat's host, its Changes. */
    function sync() {
      if (disposed) return;
      hookPaneRenders();
      scheduleMarkerRefresh();
      if (inWorkspace() && reconcileLayout()) {
        scheduleRender(); // the new views render on the next pass, and that pass syncs again
        return;
      }
      syncHost();
      second?.sync();
    }

    // Never re-enter a render in progress (sync runs inside the chat's own layout pass).
    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      Promise.resolve().then(() => {
        renderQueued = false;
        if (!disposed) requestRender();
      });
    }

    // Pane 1's own renders keep Chat 2's unread cue and Changes 2 current.
    function hookPaneRenders() {
      const panes = composition();
      if (!panes || renderHooked === panes || typeof panes.setPaneRenderListener !== 'function') return;
      renderHooked = panes;
      panes.setPaneRenderListener((paneId) => { if (!disposed && paneId === 1) second?.sync(); });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (markerTimer) clearTimer(markerTimer);
      markerTimer = null;
      second?.dispose();
      renderHooked?.setPaneRenderListener?.(null);
      renderHooked = null;
      composition()?.setPaneHost?.(1, null);
      if (state.ui) state.ui.ideSecondChatHosted = false;
    }

    return {
      primaryViewDeps,
      primarySessionId,
      jennyChangeFor,
      openInGit,
      scheduleMarkerRefresh,
      isAvailable: (id) => (id === 'chat-2' || id === 'changes-2' ? isSecondChatAvailable() : true),
      reconcileLayout,
      sync,
      secondLedger,
      isSecondSession: (sessionId) => isSecondChatAvailable() && String(sessionId || '') === secondSessionId(),
      revealSecondChat: () => getWorkbench()?.showPanel?.('chat-2') === true,
      hasSecondUnread: () => second?.hasUnread?.() === true,
      secondWaitingCount: () => second?.waitingCount?.() || 0,
      revealSecondChanges: (target) => (isSecondChatAvailable() && second ? second.reveal(target || {}) : false),
      dispose,
    };
  }

  return { createIdeWorkspaceChats };
});
