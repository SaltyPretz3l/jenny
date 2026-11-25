/* renderer/app/renderer-app-navigation-composition.js -- the navigation shell: sidebar, top navigation, Chats panel and workspace tabs */
/**
 * Extracted from renderer-app-lifecycle-composition.js, in the order
 * the root built them: the sidebar controller, the top navigation shell (bound and published
 * as window.rendererTopNavShellController), the Chats panel, the global error boundary, the
 * multi-stream controller and the workspace session coordinator with the workspace state and
 * tab chrome controllers. topNavShellController stays the root's late-bound
 * binding (read and written through accessors).
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  function createNavigationComposition(ctx) {
  /* sidebarController */
  const sidebarController = ctx.sidebarControllerUtils.createSidebarController?.({
    state: ctx.state,
    dom: { chatView: ctx.chatView, attachmentTray: ctx.attachmentTray, attachmentNotice: ctx.attachmentNotice },
    callbacks: { escapeHtml: ctx.escapeHtml },
  }) || null;
  const {
    updateTokenDisplay = ctx.noop, renderAttachmentTray = ctx.noop,
  } = sidebarController || {};
  /* topNavShellController (top navigation shell dispatcher) */
  ctx.topNavShellController = (ctx.window.rendererTopNavShell || {}).createTopNavShellController?.({
    state: ctx.state,
    // Resolve rail nodes directly because they are not part of the app.js DOM bindings.
    dom: { workspace: ctx.workspace, viewPanel: ctx.sidebar, topRail: ctx.document.getElementById('topRail'), topRailTabs: ctx.document.getElementById('topRailTabs'), topRailIndicator: ctx.document.getElementById('topRailIndicator'), artifactSplitViewToggle: ctx.document.getElementById('artifactSplitViewToggle') },
    callbacks: {
      setActiveView: (...a) => ctx.setActiveView(...a),
      escapeHtml: ctx.escapeHtml,
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      updateComposerSafeOffset: (...a) => ctx.updateComposerSafeOffset(...a),
      onLayoutChanged: () => ctx.syncArtifactReviewLayout({ refreshChatChrome: true }),
      // Opening a session rides the workspace activation path (late-bound below); the Board's picker uses it.
      openSession: (...a) => activateWorkspaceSession(...a),
      // The Board page (row 150, slice B4): the current project, and the app's toast for "Board deleted. Undo".
      getProjectSwitcher: (...a) => ctx.getProjectSwitcher(...a),
      showToastMessage: (...a) => ctx.showToastMessage(...a),
      // The Board's docked chat (slice C1): the dock's shell hooks when the Board opens before the Workspace.
      showShellErrorToast: (...a) => ctx.showShellErrorToast(...a), noteScrollProgrammaticWrite: (reason) => ctx.chatScrollCoordinator?.noteProgrammaticWrite?.(reason),
    },
  }) || null;
  ctx._applySidebarLayout = (...a) => ctx.topNavShellController?.applyViewChrome?.(...a);
  ctx.window.rendererTopNavShellController = ctx.topNavShellController;
  ctx.registerRendererCleanup(() => {
    ctx.topNavShellController?.dispose?.();
    if (ctx.window.rendererTopNavShellController === ctx.topNavShellController) {
      ctx.window.rendererTopNavShellController = null;
    }
  });
  const chatsPanelController = (ctx.window.rendererChatsPanel || {}).createChatsPanelController?.({
    state: ctx.state, documentRef: ctx.document, windowRef: ctx.window,
    dom: { conversationGroups: ctx.conversationGroups, conversationCount: ctx.conversationCount, searchInput: ctx.searchInput,
      scopeSlot: ctx.document.getElementById('chatsScopeSlot'), projectRow: ctx.document.getElementById('chatsProjectRow'),
      status: ctx.document.getElementById('chatsPanelStatus') },
    inventory: { actionButton: ctx.window.inventoryActionButton, segmentedControl: ctx.window.inventorySegmentedControl },
    callbacks: { newChat: () => ctx.document.getElementById('newChatButton')?.click?.(),
      appendClientLog: (...a) => ctx.appendClientLog(...a), getProjectSwitcher: (...a) => ctx.getProjectSwitcher(...a),
      showToastMessage: (...a) => ctx.showToastMessage(...a),
      afterRenderSessions: (...a) => renderWorkspaceSidebarBadges(...a) },
  }) || null;
  const { renderSessions = ctx.noop,
    setRovingSession: setRovingChatSession = ctx.noop, toggleScope: toggleChatsScope = ctx.noop } = chatsPanelController || {};
  ctx.registerRendererCleanup(() => chatsPanelController?.dispose?.());
  /* lifecycleController continued (late-bound) */
  ctx.attachGlobalErrorBoundary();
  ctx.registerRendererCleanup(() => ctx.detachGlobalErrorBoundary());
  const multiStreamController = (ctx.window.rendererMultiStreamUtils || {}).createMultiStreamController?.({
    getState: () => ctx.state,
    appendClientLog: (...a) => ctx.appendClientLog(...a),
  }) || null;
  ctx.window.rendererMultiStreamController = multiStreamController;
  ctx.registerRendererCleanup(() => {
    multiStreamController?.dispose?.();
    if (ctx.window.rendererMultiStreamController === multiStreamController) {
      ctx.window.rendererMultiStreamController = null;
    }
  });
  const _wsUtils = ctx.window.rendererWorkspaceSessionUtils || {};
  const workspaceSessionCoordinator = _wsUtils.createWorkspaceSessionCoordinator?.({
    state: ctx.state, windowRef: ctx.window,
    constants: { TOAST_SOURCE: ctx.TOAST_SOURCE },
    dom: { workspaceRailShell: ctx.workspaceRailShell },
    callbacks: {
      openSession: (...a) => ctx.openSession(...a),
      renderAll: (...a) => ctx.renderAll(...a),
      renderSessions: (...a) => renderSessions(...a),
      renderSettings: (...a) => ctx.renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      showToastMessage: (...a) => ctx.showToastMessage(...a),
      showSessionActionError: (...a) => ctx.showSessionActionError(...a),
      patchSessionSummary: (...a) => ctx.patchSessionSummary(...a),
      getOpenSessionsInNewTab: () => (ctx.globalThis.sessionOpenPrefUtils?.getOpenSessionsInNewTab?.() === true),
      onWorkspaceRestored: () => ctx.window.rendererAppPaneComposition?.getPaneComposition?.()?.hydrateOnce?.(),
    },
    controllers: {
      getMultiStreamController: () => multiStreamController,
      getWorkspaceStateController: () => ctx.workspaceStateController,
      getWorkspaceChromeController: () => ctx.workspaceChromeController,
      getChatsPanelController: () => chatsPanelController,
    },
  }) || {};
  const {
    isWorkspaceSessionBusy = () => false,
    getSessionSummary = () => null,
    applyWorkspaceSnapshot = (s) => s,
    syncWorkspaceFromStore = async () => ctx.state.workspace,
    activateWorkspaceSession = async (sid, opts) => { await ctx.openSession(sid, opts); return ctx.state.workspace; },
    closeWorkspaceSession: closeWorkspaceSessionBase = async () => false,
    reorderWorkspaceSession = async () => {},
    closeOtherWorkspaceSessions: closeOtherWorkspaceSessionsBase = async () => {},
    closeWorkspaceSessionsToRight: closeWorkspaceSessionsToRightBase = async () => {},
    closeAllWorkspaceSessions: closeAllWorkspaceSessionsBase = async () => {},
    renderWorkspaceSidebarBadges = ctx.noop,
    handleLinkedSessionPopover = ctx.noop,
    renderWorkspaceChrome = ctx.noop,
    handleWorkspaceShortcut = ctx.noop,
  } = workspaceSessionCoordinator;
  // Split view: a tab close another pane still shows closes that pane (the store already blanked it).
  const withPaneTabRule = (fn) => async (...args) => { const next = await fn(...args); ctx.paneLayoutController?.closePanesWithoutTab?.(ctx.state.workspace?.openSessionIds); return next; };
  const closeWorkspaceSession = withPaneTabRule(closeWorkspaceSessionBase);
  const [closeOtherWorkspaceSessions, closeWorkspaceSessionsToRight, closeAllWorkspaceSessions] = [closeOtherWorkspaceSessionsBase, closeWorkspaceSessionsToRightBase, closeAllWorkspaceSessionsBase].map(withPaneTabRule);
  ctx.workspaceStateController = ctx.workspaceStateUtils.createWorkspaceStateController?.({ jennyShell: ctx.window.jennyShell, isSessionBusy: isWorkspaceSessionBusy, onStateChanged: applyWorkspaceSnapshot, onPersistenceError: (failure) => ctx.appendClientLog('WARN', 'workspace.state_persist_failed', failure) }) || null;
  const chromeCallbacks = {
    getSessionSummary,
    isSessionBusy: isWorkspaceSessionBusy,
    onSessionActivated: (sessionId) => activateWorkspaceSession(sessionId),
    onSessionClosed: (sessionId) => closeWorkspaceSession(sessionId),
    onLinkSessionsRequested: (sessionId, anchor) => handleLinkedSessionPopover(sessionId, anchor),
    // Tab rename rides the sidebar's rename path (unchanged-title check, sessions.renamed log).
    onRenameSession: (sessionId, title) => ctx.lifecycleController?.handleRenameSession?.(sessionId, title),
    onRenameFailed: (...a) => ctx.showSessionActionError(...a),
    onNewSessionRequested: () => ctx.handleCreateSessionWithWorkspace(),
    onSessionReordered: (sessionId, newIndex) => reorderWorkspaceSession(sessionId, newIndex),
    onCloseOtherSessions: (keepId) => closeOtherWorkspaceSessions(keepId),
    onCloseSessionsToRight: (anchorId) => closeWorkspaceSessionsToRight(anchorId),
    onCloseAllSessions: () => closeAllWorkspaceSessions(),
    onOpenBeside: (sessionId) => ctx.paneLayoutController?.openBeside?.(sessionId), isSessionInPane: (sessionId) => ctx.paneLayoutController?.isSessionInPane?.(sessionId) === true,
  };
  ctx.workspaceChromeController = ctx.workspaceChromeUtils.createWorkspaceChromeController?.({ containerEl: ctx.workspaceRailShell, ...chromeCallbacks }) || null;
  // Row 190 Wave 3: the Chat room's second pane gets its own tab row from the same callbacks (renderer-chat-pane-rows.js).
  ctx.window.rendererWorkspaceChromeKit = {
    create: (containerEl, overrides) => ctx.workspaceChromeUtils.createWorkspaceChromeController?.({ containerEl, ...chromeCallbacks, ...overrides }) || null,
    getPaneLayout: () => ctx.paneLayoutController || null,
    activate: (sessionId) => activateWorkspaceSession(sessionId),
    newSession: () => ctx.handleCreateSessionWithWorkspace(),
    getMainChrome: () => ctx.workspaceChromeController,
    renderChrome: () => renderWorkspaceChrome(),
  };
  // renderer-stream-handler-session-helpers.js falls back to this global to activate a session's tab.
  ctx.globalThis.workspaceChromeController = ctx.workspaceChromeController;
  return {
    updateTokenDisplay, renderAttachmentTray, renderSessions, setRovingChatSession, toggleChatsScope,
    multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
    handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
  };
  }

  root.rendererAppNavigationComposition = {
    createNavigationComposition,
  };
})(window);
