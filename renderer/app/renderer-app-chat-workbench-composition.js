/* renderer/app/renderer-app-chat-workbench-composition.js - builds and keeps the Chat room's workbench (UMD).
 *
 * Row 190. renderer-chat-workbench.js is the binding; this composition hands it the app's seams (the side panel's
 * state machine through the shell artifact bridge, the session rail's host, New chat, the composer) and mounts it
 * once at boot: the Chat room is always on the workbench (Wave 5 deleted the old shell and its kill switch).
 * The live controller is published as window.rendererChatWorkbenchController for the shortcuts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppChatWorkbenchComposition = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* o = { state, windowRef, documentRef, getArtifactBridge() -> shell artifact bridge, applyViewChrome(),
   *       appendClientLog(), registerCleanup() } */
  function composeChatWorkbench(o) {
    const win = o.windowRef;
    const doc = o.documentRef;
    const log = (...args) => { try { o.appendClientLog?.(...args); } catch (_error) { /* logging never blocks */ } };
    let controller = null;
    const jt = (key, fallback, params) => (win.jennyI18n?.t ? win.jennyI18n.t(key, fallback, params) : fallback);

    const focusedPane = () => doc.querySelector('#chatView > .chat-pane[data-pane-focused="true"]') || doc.getElementById('chatPane0');

    // Changes waiting for the owner, from what the Changes client already holds (it loads when Changes first opens):
    // reading the count never starts a load. The strip repaints when that list changes.
    let stopChangesWatch = null;
    function changesWaiting() {
      const client = win.rendererSuggestedChangesClient?.getSharedClient?.() || null;
      if (!client || typeof client.peek !== 'function') return 0;
      if (!stopChangesWatch && typeof client.subscribe === 'function') stopChangesWatch = client.subscribe(() => onSignals());
      return Number(client.peek(o.state?.currentSessionId)?.pending_count) || 0;
    }

    function build() {
      const utils = win.rendererChatWorkbench;
      const model = win.jennyWorkbenchLayoutModel;
      if (!utils || !model || !win.rendererChatLayoutStore || !win.rendererChatRightStack) return null;
      let storage;
      try { storage = win.localStorage; } catch (_error) { storage = null; }
      return utils.createChatWorkbench({
        doc,
        win,
        workbenchUtils: win.rendererIdeWorkbench,
        layoutModel: model,
        layoutOps: win.jennyWorkbenchLayoutOps,
        store: win.rendererChatLayoutStore.createChatLayoutStore({ storage: storage || { getItem: () => null, setItem: () => {} }, model }),
        rightStackUtils: win.rendererChatRightStack,
        jt,
        newChat: () => doc.getElementById('newChatButton')?.click?.(),
        focusComposer: () => {
          const input = focusedPane()?.querySelector?.('[data-chat-node="chatInput"]');
          if (!input || typeof input.focus !== 'function') return false;
          input.focus({ preventScroll: true });
          return true;
        },
        openMode: (mode) => o.getArtifactBridge()?.openRailMode?.(mode) === true,
        resumeMode: (mode) => o.getArtifactBridge()?.resumeRailMode?.(mode) === true,
        rail: () => o.getArtifactBridge()?.getRailState?.() || null,
        // Row 195: a number means "look here". Runs: how many are running. Changes: how many wait for the owner (known
        // once the Changes client has loaded for this chat). Project: a dot when Jenny changed a note not opened since.
        counts: {
          runs: () => win.rendererBackgroundTasksPanel?.runningCount?.() || 0,
          changes: changesWaiting,
        },
        unread: { project: () => win.rendererProjectTabSignals?.noteChanged?.() === true },
        unreadLabel: { project: () => jt('chat.workbench.noteChanged', 'a note changed') },
        modeFor: (viewId) => (viewId === 'project' ? win.rendererProjectTabSignals?.preferredSide?.() || '' : ''),
        isActivityAvailable: () => o.state?.features?.featureFlags?.activity_monitor === true,
        isLiveViewAvailable: () => o.state?.features?.featureFlags?.live_run_view !== false, // row 197
        // The tab's Close: Activity's own close control (renderer-chat-activity.js listens on the document).
        closeActivity: () => doc.querySelector('#chatContextPanel.activity-mode [data-activity-action="close"]')?.click?.(),
        onSessionShown: () => { win.rendererSessionRail?.syncHosts?.(); syncSessionOwner(); },
        onUnmount: () => { win.rendererSessionRail?.syncHosts?.(); settleProject(); },
        // A fold, reopen, room switch or pane count change: the rail catches up when shown, the owner line follows.
        onRendered: () => { win.rendererSessionRail?.syncHosts?.(); syncSessionOwner(); settleProject(); },
        log,
      });
    }

    // Workspace and Board host the same side panel in their own stacks (Wave 4): they drive it through this access.
    win.rendererChatRightStack?.setPanelAccess?.({
      rail: () => o.getArtifactBridge()?.getRailState?.() || null,
      openMode: (mode) => o.getArtifactBridge()?.openRailMode?.(mode) === true,
    });

    // The focused chat pane's session rail lives in the Session view; every other rail hides.
    win.rendererSessionRail?.configure?.({
      getHost: (pane) => {
        if (!controller || !controller.isMounted()) return null;
        const inChat = Boolean(pane && pane.closest && pane.closest('#chatView'));
        return inChat && pane.dataset?.paneFocused === 'true' ? controller.hostFor('session') : null;
      },
      isShown: () => doc.documentElement.dataset.activeView === 'chat' && controller?.isViewVisible?.('session') === true,
      // Row 195: "Running now" reads the Runs list, so the two cannot disagree; a row opens that run in Runs.
      getRunningRows: (sessionId) => win.rendererBackgroundTasksPanel?.runningRows?.(sessionId) ?? null,
      openRun: (id, context) => win.rendererBackgroundTasksPanel?.openRun?.(id, { sessionId: context?.ownerSessionId }),
      openRuns: (context) => win.rendererBackgroundTasksPanel?.open?.({ sessionId: context?.ownerSessionId }),
      // The checklist is the focused chat's (the Tasks list read the same source before it moved here).
      getChecklist: (sessionId) => (sessionId === o.state?.currentSessionId ? win.rendererProjectTabSignals?.checklist?.() || [] : []),
      isFullAuto: (sessionId) => win.rendererPrimaryChatStore?.peekDefaultPrimaryChatStore?.()?.fullAutoFor?.(sessionId) === 'armed',
    });

    // Two panes: the Session view names the chat it is for, as the side panel does ("From <title>").
    function syncSessionOwner() {
      const host = controller?.isMounted() ? controller.hostFor('session') : null;
      if (!host) return;
      let line = host.querySelector(':scope > .side-panel-owner-line');
      const split = doc.getElementById('chatView')?.dataset?.paneCount === '2';
      const id = o.state?.currentSessionId;
      const title = split && id ? String((o.state.sessions || []).find((s) => s.id === id)?.title || '').trim() : '';
      if (!split || !id) { line?.remove(); return; }
      if (!line) { line = doc.createElement('p'); line.className = 'side-panel-owner-line'; host.prepend(line); }
      const shown = title || jt('chat.empty.newSession', 'New session');
      const template = String(jt('artifacts.panel.fromChat', 'From {title}'));
      // It re-syncs on every workbench render: write only on a change of title or of language.
      if (line.dataset.shown === shown && line.dataset.template === template) return;
      line.dataset.shown = shown;
      line.dataset.template = template;
      const [before = '', after = ''] = template.split('{title}');
      const titleEl = doc.createElement('span');
      titleEl.className = 'side-panel-owner-title';
      titleEl.setAttribute('dir', 'auto');
      titleEl.textContent = shown;
      titleEl.title = shown;
      line.replaceChildren(...[before.trim(), titleEl, after.trim()].filter(Boolean));
    }

    // Row 195: the Project tab stopped showing, so a task Delete held for its Undo line is carried out.
    let projectShown = false;
    function settleProject() {
      const shown = controller?.isViewVisible?.('project') === true;
      if (projectShown && !shown) win.rendererProjectTabSignals?.settle?.();
      projectShown = shown;
    }
    // A count or a dot moved (a run started or ended, a note changed): the strip repaints on the next frame.
    // controller.render() ends in onRendered, which brings the Session rail up to date too.
    function onSignals() { if (controller?.isMounted()) controller.render(); }
    win.addEventListener?.('jenny:side-signals-changed', onSignals);

    // The focused pane changed: its rail moves into Session and the owner line follows.
    const onFocusedChat = () => { if (controller?.isMounted()) { win.rendererSessionRail?.syncHosts?.(); syncSessionOwner(); } };
    win.addEventListener?.('jenny:focused-chat-changed', onFocusedChat);

    // Wave 3: one header row per pane (renderer-chat-pane-rows.js); renderer-workspace-session-utils.js reads it.
    const rows = win.rendererChatPaneRows?.createChatPaneRows?.({ doc, win, state: o.state, getKit: () => win.rendererWorkspaceChromeKit, jt, log }) || null;

    function mount() {
      if (!controller) controller = build();
      if (!controller) return false;
      if (controller.isMounted()) return true;
      if (!controller.mount()) { log('WARN', 'chat_workbench.mount_skipped', {}); return false; }
      win.rendererChatWorkbenchController = controller;
      o.getArtifactBridge()?.syncArtifactReviewLayout?.();
      win.rendererSessionRail?.syncHosts?.();
      syncSessionOwner();
      o.applyViewChrome?.();
      if (rows) { rows.attach(); win.rendererChatPaneRowsLive = rows; }
      win.rendererWorkspaceChromeKit?.renderChrome?.();
      return true;
    }

    // Row 197: the More menu's Live entry opens the Live tab's mode (its scripts load on that first render).
    const liveView = { open: () => o.getArtifactBridge()?.openRailMode?.('live') === true };
    win.rendererLiveRunView = liveView;

    mount();
    o.registerCleanup?.(() => {
      if (win.rendererLiveRunView === liveView) delete win.rendererLiveRunView;
      win.removeEventListener?.('jenny:focused-chat-changed', onFocusedChat);
      win.removeEventListener?.('jenny:side-signals-changed', onSignals);
      stopChangesWatch?.();
      rows?.dispose?.();
      if (win.rendererChatPaneRowsLive === rows) delete win.rendererChatPaneRowsLive;
      controller?.dispose?.();
      if (win.rendererChatWorkbenchController === controller) win.rendererChatWorkbenchController = null;
      win.rendererSessionRail?.configure?.({ getHost: null });
      win.rendererChatRightStack?.setPanelAccess?.({ rail: () => null, openMode: () => false });
    });
    return { mount, getController: () => controller };
  }

  return { composeChatWorkbench };
});
