/* renderer/app/renderer-app-navigation-composition.js -- the navigation shell: sidebar, top navigation, Chats panel and workspace tabs */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-lifecycle-composition.js (a with(ctx) section), in the order
 * the root built them: the sidebar controller, the top navigation shell (bound and published
 * as window.rendererTopNavShellController), the Chats panel, the global error boundary, the
 * multi-stream controller and the workspace session coordinator with the workspace state and
 * tab chrome controllers. The sidebar resize handlers and setSidebarCollapsed stay hoisted
 * function declarations in the root; topNavShellController stays the root's late-bound
 * binding (read and written through accessors).
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  function createNavigationComposition(ctx) {
    with (ctx) {
  /* sidebarController */
  const sidebarController = sidebarControllerUtils.createSidebarController?.({
    state,
    dom: { chatView, attachmentTray, attachmentNotice },
    callbacks: { escapeHtml },
  }) || null;
  const {
    updateTokenDisplay = noop, renderAttachmentTray = noop,
  } = sidebarController || {};
  let chatsPanelController = null;
  /* topNavShellController (top navigation shell dispatcher) */
  topNavShellController = (window.rendererTopNavShell || {}).createTopNavShellController?.({
    state,
    constants: { SIDEBAR_STORAGE_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH },
    // Resolve rail nodes directly because they are not part of the app.js DOM bindings.
    dom: { workspace, viewPanel: sidebar, sidebarResizer, searchInput, topRail: document.getElementById('topRail'), topRailTabs: document.getElementById('topRailTabs'), topRailIndicator: document.getElementById('topRailIndicator'), artifactSplitViewToggle: document.getElementById('artifactSplitViewToggle') },
    callbacks: {
      setActiveView: (...a) => setActiveView(...a),
      escapeHtml,
      appendClientLog: (...a) => appendClientLog(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      // A live sidebar drag re-fits an open artifact panel every frame (its
      // overlay switch lands mid-drag) without the full chat re-render.
      onLayoutChanged: (change) => {
        if (change?.live) {
          if (isArtifactReviewVisible()) syncArtifactReviewLayout();
          return;
        }
        syncArtifactReviewLayout({ refreshChatChrome: true });
      },
      // Chats-strip plumbing (W11): open rides the workspace activation path
      // (late-bound below); New Chat reuses the panel button's full pipeline.
      getSessionMonogram,
      openSession: (...a) => activateWorkspaceSession(...a),
      newChat: () => document.getElementById('newChatButton')?.click?.(),
      prepareChatsPanelForExpansion: () => chatsPanelController?.prepareForStripExpansion?.(),
    },
  }) || null;
  _applySidebarLayout = (...a) => topNavShellController?.applyViewChrome?.(...a);
  topNavShellController?.bind?.();
  window.rendererTopNavShellController = topNavShellController;
  registerRendererCleanup(() => {
    topNavShellController?.dispose?.();
    if (window.rendererTopNavShellController === topNavShellController) {
      window.rendererTopNavShellController = null;
    }
  });
  chatsPanelController = (window.rendererChatsPanel || {}).createChatsPanelController?.({
    state, documentRef: document, windowRef: window,
    dom: { conversationGroups, conversationCount, searchInput,
      scopeSlot: document.getElementById('chatsScopeSlot'), projectRow: document.getElementById('chatsProjectRow'),
      status: document.getElementById('chatsPanelStatus') },
    inventory: { actionButton: window.inventoryActionButton, segmentedControl: window.inventorySegmentedControl },
    callbacks: { newChat: () => document.getElementById('newChatButton')?.click?.(),
      appendClientLog: (...a) => appendClientLog(...a), getProjectSwitcher: (...a) => getProjectSwitcher(...a),
      showToastMessage: (...a) => showToastMessage(...a),
      afterRenderSessions: (...a) => { renderWorkspaceSidebarBadges(...a); topNavShellController?.syncChatsStrip?.(); } },
  }) || null;
  const { renderSessions = noop,
    setRovingSession: setRovingChatSession = noop, toggleScope: toggleChatsScope = noop } = chatsPanelController || {};
  registerRendererCleanup(() => chatsPanelController?.dispose?.());
  /* lifecycleController continued (late-bound) */
  attachGlobalErrorBoundary();
  registerRendererCleanup(() => detachGlobalErrorBoundary());
  const multiStreamController = (window.rendererMultiStreamUtils || {}).createMultiStreamController?.({
    getState: () => state,
    appendClientLog: (...a) => appendClientLog(...a),
  }) || null;
  window.rendererMultiStreamController = multiStreamController;
  registerRendererCleanup(() => {
    multiStreamController?.dispose?.();
    if (window.rendererMultiStreamController === multiStreamController) {
      window.rendererMultiStreamController = null;
    }
  });
  const _wsUtils = window.rendererWorkspaceSessionUtils || {};
  const workspaceSessionCoordinator = _wsUtils.createWorkspaceSessionCoordinator?.({
    state, windowRef: window,
    constants: { TOAST_SOURCE },
    dom: { workspaceRailShell },
    callbacks: {
      openSession: (...a) => openSession(...a),
      renderAll: (...a) => renderAll(...a),
      renderSessions: (...a) => renderSessions(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      syncChatsStrip: () => topNavShellController?.syncChatsStrip?.(),
      patchChatsStripRuntime: () => topNavShellController?.patchChatsStripRuntime?.(),
      showToastMessage: (...a) => showToastMessage(...a),
      showSessionActionError: (...a) => showSessionActionError(...a),
      patchSessionSummary: (...a) => patchSessionSummary(...a),
      getOpenSessionsInNewTab: () => (globalThis.sessionOpenPrefUtils?.getOpenSessionsInNewTab?.() === true),
      isChatsPanelCollapsed: () => topNavShellController?.isActivePanelCollapsed?.() === true,
      expandChatsPanel: () => setSidebarCollapsed(false),
      onWorkspaceRestored: () => window.rendererAppPaneComposition?.getPaneComposition?.()?.hydrateOnce?.(),
    },
    controllers: {
      getMultiStreamController: () => multiStreamController,
      getWorkspaceStateController: () => workspaceStateController,
      getWorkspaceChromeController: () => workspaceChromeController,
      getChatsPanelController: () => chatsPanelController,
    },
  }) || {};
  const {
    isWorkspaceSessionBusy = () => false,
    getSessionSummary = () => null,
    applyWorkspaceSnapshot = (s) => s,
    syncWorkspaceFromStore = async () => state.workspace,
    activateWorkspaceSession = async (sid, opts) => { await openSession(sid, opts); return state.workspace; },
    closeWorkspaceSession: closeWorkspaceSessionBase = async () => false,
    reorderWorkspaceSession = async () => {},
    closeOtherWorkspaceSessions: closeOtherWorkspaceSessionsBase = async () => {},
    closeWorkspaceSessionsToRight: closeWorkspaceSessionsToRightBase = async () => {},
    closeAllWorkspaceSessions: closeAllWorkspaceSessionsBase = async () => {},
    renderWorkspaceSidebarBadges = noop,
    handleLinkedSessionPopover = noop,
    renderWorkspaceChrome = noop,
    handleWorkspaceShortcut = noop,
  } = workspaceSessionCoordinator;
  // Split view: a tab close another pane still shows closes that pane (the store already blanked it).
  const withPaneTabRule = (fn) => async (...args) => { const next = await fn(...args); ctx.paneLayoutController?.closePanesWithoutTab?.(state.workspace?.openSessionIds); return next; };
  const closeWorkspaceSession = withPaneTabRule(closeWorkspaceSessionBase);
  const [closeOtherWorkspaceSessions, closeWorkspaceSessionsToRight, closeAllWorkspaceSessions] = [closeOtherWorkspaceSessionsBase, closeWorkspaceSessionsToRightBase, closeAllWorkspaceSessionsBase].map(withPaneTabRule);
  workspaceStateController = workspaceStateUtils.createWorkspaceStateController?.({ jennyShell: window.jennyShell, isSessionBusy: isWorkspaceSessionBusy, onStateChanged: applyWorkspaceSnapshot, onPersistenceError: (failure) => appendClientLog('WARN', 'workspace.state_persist_failed', failure) }) || null;
  workspaceChromeController = workspaceChromeUtils.createWorkspaceChromeController?.({
    containerEl: workspaceRailShell,
    getSessionSummary,
    isSessionBusy: isWorkspaceSessionBusy,
    onSessionActivated: (sessionId) => activateWorkspaceSession(sessionId),
    onSessionClosed: (sessionId) => closeWorkspaceSession(sessionId),
    onLinkSessionsRequested: (sessionId, anchor) => handleLinkedSessionPopover(sessionId, anchor),
    // Tab rename rides the sidebar's rename path (unchanged-title check, sessions.renamed log).
    onRenameSession: (sessionId, title) => lifecycleController?.handleRenameSession?.(sessionId, title),
    onRenameFailed: (...a) => showSessionActionError(...a),
    onNewSessionRequested: () => handleCreateSessionWithWorkspace(),
    onSessionReordered: (sessionId, newIndex) => reorderWorkspaceSession(sessionId, newIndex),
    onCloseOtherSessions: (keepId) => closeOtherWorkspaceSessions(keepId),
    onCloseSessionsToRight: (anchorId) => closeWorkspaceSessionsToRight(anchorId),
    onCloseAllSessions: () => closeAllWorkspaceSessions(),
    onOpenBeside: (sessionId) => ctx.paneLayoutController?.openBeside?.(sessionId), isSessionInPane: (sessionId) => ctx.paneLayoutController?.isSessionInPane?.(sessionId) === true,
  }) || null;
  return {
    updateTokenDisplay, renderAttachmentTray, renderSessions, setRovingChatSession, toggleChatsScope,
    multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
    handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
  };
    }
  }

  root.rendererAppNavigationComposition = {
    createNavigationComposition,
  };
})(window);
