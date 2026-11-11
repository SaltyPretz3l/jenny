/* renderer/app/renderer-app-split-view-composition.js -- the second chat pane's composition hand-off (split view) */
/**
 * Extracted from renderer/app.js. createSplitView(deps) names projects for the pane
 * kickers and session rows (configuring renderer-session-message-rows.js and the session
 * rail), then builds the pane composition (renderer-app-pane-composition.js) with the SAME
 * builders the lifecycle and controller compositions use for pane 0, and returns it (null
 * without a layout controller). app.js keeps the one `paneComposition` binding, its cleanup
 * and the rail drop target.
 *
 * deps: the app.js bindings the hand-off reads, captured when app.js calls it (every one is
 * bound by then and never reassigned), plus getPaneComposition() for the late kicker repaint.
 */
(function (root) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createSplitView(deps) {
    const {
      activateWorkspaceSession, ACTIVITY_SCOPE, appendClientLog, applyActivityAttributes, beginAttachmentToken,
      buildModelOptionMarkup, cancelAttachmentToken, chatInput, chatShellController, chatView,
      clearComposerStatusNotice, contextPanelController, controllerComposition, getActivitySnapshot,
      getChatSendLifecycle, getDroppedFilePaths, getPaneComposition, getProjectSwitcher,
      getRuntimePreferencesFromSession, getSessionMessages, getVisibleSessionMessages, handleAttachmentPicker,
      hasPendingToolApprovalForSession, isActivityBusy, isSessionStreaming, lifecycleComposition,
      paneLayoutController, paneSharedStore, prepareDroppedAttachments, queueInlineImageAttachment,
      removeQueuedAttachment, renderAll, renderAttachmentTray, renderComposerStatusNotice, renderMessages,
      resetAttachmentQueue, setFollowLatest, setSessionMessages, setSessionTurnEventState, shellArtifactBridge,
      showToastMessage, state, suppressFileDropNavigation, surfaceDom, thinkingController, ThinkingPanelController,
      TOAST_SOURCE, toErrorMessage, workspaceStateController,
    } = deps;
  let paneProjectSwitcher = null;
  const getPaneProjectName = (projectId) => {
    if (!paneProjectSwitcher) {
      Promise.resolve(getProjectSwitcher?.()).then((switcher) => {
        if (!switcher || paneProjectSwitcher) return undefined;
        paneProjectSwitcher = switcher;
        // The switcher lists projects lazily (its menu refreshes on open); read
        // the list once so a kicker can name a project the menu never showed.
        return Promise.resolve(switcher.refresh?.()).then(() => getPaneComposition()?.renderKickers?.());
      }).catch(() => {});
    }
    const project = paneProjectSwitcher?.projectById?.(projectId);
    if (project?.name) return project.name;
    return projectId === 'project_general' ? jt('projects.switcher.generalName', 'General') : '';
  };
  window.rendererSessionMessageRows?.configure?.({ getProjectName: getPaneProjectName }); // row 59 cp4 card headers
  window.rendererSessionRail?.configure?.({ openSession: (id) => activateWorkspaceSession(id, { mode: 'replace' }) }); // cp5a linked rows
  return paneLayoutController && window.rendererAppPaneComposition?.createPaneComposition?.({
    documentRef: document, windowRef: window, state, chatView, layoutController: paneLayoutController,
    resolvePane: (paneRoot) => surfaceDom.chat.resolvePane(paneRoot),
    createPaneRuntime: ({ paneId }) => window.rendererPaneRuntime.createPaneRuntime({ paneId, shared: paneSharedStore }),
    buildPaneSurface: lifecycleComposition.buildPaneSurface,
    buildRenderPipeline: controllerComposition.buildRenderPipeline,
    buildChatShellController: controllerComposition.buildChatShellController,
    createThinkingController: () => new ThinkingPanelController(), // pane 1's own reasoning-disclosure state
    relatchPrimaryFollow: () => { thinkingController.resumeAutoScroll(); setFollowLatest(true); }, // pane 0 took another session through a layout change
    getPrimaryShell: () => chatShellController,
    getPrimaryComposerInput: () => chatInput, // pane 0's composer, wherever the Workspace dock holds it
    createResizer: (resizerDeps) => window.rendererChatPaneResizer?.createChatPaneResizer?.(resizerDeps) || null,
    persistSplitRatio: (splitRatio) => workspaceStateController?.persistPaneLayout?.({ splitRatio }),
    renderPrimaryMessages: () => renderMessages(),
    requestFullRender: () => renderAll(),
    getStoredLayout: () => workspaceStateController?.getPaneLayout?.() || null,
    collapseSidePanel: () => { shellArtifactBridge?.collapseSidePanel?.(); contextPanelController?.collapseForOwnerClose?.(); }, // W3-2: the owning pane closed
    getSessionSummary: (sessionId) => (state.sessions || []).find((session) => session?.id === sessionId) || null,
    getProjectName: getPaneProjectName,
    getSessionMessages: (sessionId) => getSessionMessages(sessionId),
    getVisibleSessionMessages: (sessionId) => getVisibleSessionMessages(sessionId),
    loadSessionMessages: async (sessionId) => {
      if (!sessionId || state.messagesBySession.has(sessionId) || !window.jennyShell?.sessions?.getMessages) return false;
      const payload = await window.jennyShell.sessions.getMessages(sessionId);
      if (!payload || state.messagesBySession.has(sessionId)) return false;
      setSessionMessages(sessionId, payload.data || [], `session_${sessionId}`);
      setSessionTurnEventState(sessionId, {
        turnEventLogVersion: Number(payload?.turn_event_log_version || 0),
        turnEvents: Array.isArray(payload?.turn_events) ? payload.turn_events : [],
        activeTurn: payload?.active_turn ?? null,
      });
      return true;
    },
    listSwitchCandidates: () => {
      const snapshot = workspaceStateController?.getRollbackSnapshot?.() || {};
      const open = Array.isArray(snapshot.openSessionIds) ? snapshot.openSessionIds : [];
      return (Array.isArray(snapshot.mruStack) ? snapshot.mruStack : []).filter((id) => open.includes(id)).concat(open);
    },
    isSessionStreaming: (sessionId) => isSessionStreaming(sessionId),
    hasPendingToolApproval: (sessionId) => hasPendingToolApprovalForSession(sessionId),
    getSendLifecycle: (sessionId) => getChatSendLifecycle(sessionId),
    countQueuedSends: (sessionId) => (state.queuedSendBySession?.get?.(sessionId) ? 1 : 0)
      + (state.runtimeSendController?.listPending?.(sessionId) || []).length,
    appendClientLog: (...a) => appendClientLog(...a),
    // W2-2b: pane 1's attachments (its queue is its session's composer record).
    TOAST_SOURCE, getQueuedAttachments: (sessionId) => window.rendererComposerSessionState?.getQueuedAttachments?.(state, sessionId) || [],
    renderAttachmentTray: (target) => renderAttachmentTray(target),
    // W3-1: pane 1's status notice (the slot keyed to its session) and its failed-send notice.
    renderComposerStatusNotice: (target) => renderComposerStatusNotice(target), clearComposerStatusNotice: () => clearComposerStatusNotice(),
    mountFailedSendNotice: (notice) => window.rendererAppShellBindings?.mountFailedSendNotice?.({ ...notice, getSessionMessages, setSessionMessages, renderAll, appendClientLog }) || null,
    attachmentCallbacks: { resetAttachmentQueue, removeQueuedAttachment, beginAttachmentToken, cancelAttachmentToken, handleAttachmentPicker,
      prepareDroppedAttachments, queueInlineImageAttachment, suppressFileDropNavigation, getDroppedFilePaths, showToastMessage, toErrorMessage,
      appendClientLog: (...a) => appendClientLog(...a) },
    createPaneComposerRail: (railOptions) => window.rendererPaneComposerRail?.createPaneComposerRail?.({ ...railOptions, deps: { getRuntimePreferencesFromSession, getActivitySnapshot, isActivityBusy, applyActivityAttributes, ACTIVITY_SCOPE, buildModelOptionMarkup } }) || null, // W2-2a
  }) || null;
  }

  root.rendererAppSplitViewComposition = {
    createSplitView,
  };
})(window);
