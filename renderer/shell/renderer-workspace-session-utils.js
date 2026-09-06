/* renderer/shell/renderer-workspace-session-utils.js — workspace session coordination (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceSessionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function normalizeSessionId(value) {
    return String(value || '').trim();
  }

  function navigationIsCurrent(options) {
    const guard = options?.navigationGuard;
    return !guard || typeof guard.isCurrent !== 'function' || guard.isCurrent() === true;
  }

  function createWorkspaceSessionCoordinator(deps) {
    const { state, constants, dom, callbacks, controllers, windowRef } = deps;
    const { TOAST_SOURCE } = constants;
    const { workspaceRailShell } = dom;
    const {
      openSession, renderAll, renderSessions, renderSettings,
      showToastMessage, showSessionActionError, patchSessionSummary, syncChatsStrip, patchChatsStripRuntime,
    } = callbacks;
    const getOpenSessionsInNewTab = typeof callbacks.getOpenSessionsInNewTab === 'function'
      ? callbacks.getOpenSessionsInNewTab
      : () => false;
    const _window = windowRef || globalThis;

    function getMultiStreamController() {
      return controllers.getMultiStreamController();
    }
    function getWorkspaceStateController() {
      return controllers.getWorkspaceStateController();
    }
    function getWorkspaceChromeController() {
      return controllers.getWorkspaceChromeController();
    }

    const getApprovalSessionIds = () => getMultiStreamController()?.getApprovalPendingSessionIds?.()
      || [...state.pendingToolApprovals.values()].map((approval) => normalizeSessionId(approval?.sessionId)).filter(Boolean);

    const getStreamingSessionIds = () => getMultiStreamController()?.getStreamingSessionIds?.()
      || (normalizeSessionId(state.activeStreamSessionId) ? [normalizeSessionId(state.activeStreamSessionId)] : []);

    const isWorkspaceSessionBusy = (sessionId) => {
      const id = normalizeSessionId(sessionId);
      return getStreamingSessionIds().includes(id) || getApprovalSessionIds().includes(id);
    };

    const getSessionSummary = (sessionId) =>
      state.sessions.find((session) => normalizeSessionId(session?.id) === normalizeSessionId(sessionId)) || null;

    function applyWorkspaceSnapshot(snapshot) {
      state.workspace = {
        activeSessionId: normalizeSessionId(snapshot?.activeSessionId),
        openSessionIds: Array.isArray(snapshot?.openSessionIds) ? snapshot.openSessionIds.map(normalizeSessionId).filter(Boolean) : [],
      };
      state.currentSessionId = state.workspace.activeSessionId;
      return state.workspace;
    }

    async function syncWorkspaceFromStore({ silent = true, renderAfter = false } = {}) {
      const wsc = getWorkspaceStateController();
      if (!wsc) return state.workspace;
      const previousSessionId = normalizeSessionId(state.currentSessionId);
      const nextWorkspace = applyWorkspaceSnapshot(await wsc.restore(state.sessions.map((s) => normalizeSessionId(s?.id)).filter(Boolean)));
      if (nextWorkspace.activeSessionId && (nextWorkspace.activeSessionId !== previousSessionId || !state.messagesBySession.has(nextWorkspace.activeSessionId))) {
        await openSession(nextWorkspace.activeSessionId, { silent });
      } else if (!nextWorkspace.activeSessionId) {
        state.currentSessionId = '';
      }
      if (renderAfter) renderAll();
      return nextWorkspace;
    }

    async function activateWorkspaceSession(sessionId, options = {}) {
      if (!navigationIsCurrent(options)) return state.workspace;
      const wsc = getWorkspaceStateController();
      if (!wsc) {
        await openSession(sessionId, options);
        return state.workspace;
      }
      const requestedId = normalizeSessionId(sessionId);
      const previousSessionId = normalizeSessionId(state.currentSessionId);
      const previousWorkspace = typeof wsc.getState === 'function'
        ? wsc.getState()
        : {
          activeSessionId: normalizeSessionId(state.workspace?.activeSessionId),
          openSessionIds: Array.isArray(state.workspace?.openSessionIds)
            ? state.workspace.openSessionIds.slice()
            : [],
        };
      const rollbackSnapshot = typeof wsc.getRollbackSnapshot === 'function'
        ? wsc.getRollbackSnapshot()
        : previousWorkspace;
      // 'replace' swaps the active tab in place; 'new-tab' adds a tab. The default
      // follows the user's sticky preference; callers (e.g. + new-chat, context
      // menu) may force a mode explicitly via options.mode.
      const mode = options.mode || (getOpenSessionsInNewTab() ? 'new-tab' : 'replace');
      const openFn = (mode === 'replace' && typeof wsc.replaceActiveSession === 'function')
        ? wsc.replaceActiveSession
        : wsc.openSession;
      const nextWorkspace = await openFn.call(wsc, sessionId);
      if (!navigationIsCurrent(options)) return state.workspace;
      applyWorkspaceSnapshot(nextWorkspace);
      const resolvedActiveId = normalizeSessionId(state.workspace.activeSessionId);
      if (requestedId && resolvedActiveId !== requestedId) {
        showToastMessage('Close or finish a busy session before opening another tab.', {
          title: 'Session Rail Full',
          tone: 'info',
          source: TOAST_SOURCE.sessionAction,
          dedupeKey: 'workspace:cap-busy',
        });
        return state.workspace;
      }
      try {
        const opened = await openSession(resolvedActiveId, {
          ...options,
          outgoingSessionId: previousSessionId,
        });
        if (opened === false) {
          const restored = typeof wsc.restoreSnapshot === 'function'
            ? await wsc.restoreSnapshot(rollbackSnapshot)
            : previousWorkspace;
          applyWorkspaceSnapshot(restored);
          renderAll();
          return state.workspace;
        }
      } catch (error) {
        try {
          const restored = typeof wsc.restoreSnapshot === 'function'
            ? await wsc.restoreSnapshot(rollbackSnapshot)
            : previousWorkspace;
          applyWorkspaceSnapshot(restored);
          if (previousSessionId) {
            await openSession(previousSessionId, {
              silent: true,
              outgoingSessionId: resolvedActiveId,
            });
          }
        } catch (_rollbackError) {
          applyWorkspaceSnapshot(previousWorkspace);
        }
        renderAll();
        throw error;
      }
      return state.workspace;
    }

    async function closeWorkspaceSession(sessionId, { renderAfter = true } = {}) {
      const wsc = getWorkspaceStateController();
      const id = normalizeSessionId(sessionId);
      if (!id || !wsc) return false;
      if (!await wsc.closeSession(id)) {
        showToastMessage('Finish the current response or approval before closing this session.', {
          title: 'Session Busy', tone: 'info', source: TOAST_SOURCE.sessionAction, dedupeKey: 'workspace:busy-close',
        });
        return false;
      }
      const previousSessionId = normalizeSessionId(state.currentSessionId);
      applyWorkspaceSnapshot(wsc.getState());
      if (state.workspace.activeSessionId && state.workspace.activeSessionId !== previousSessionId) await openSession(state.workspace.activeSessionId, { silent: true });
      else if (!state.workspace.activeSessionId) state.currentSessionId = '';
      if (renderAfter) renderAll();
      return true;
    }

    async function reorderWorkspaceSession(sessionId, newIndex) {
      const wsc = getWorkspaceStateController();
      if (!wsc?.reorderSession) return;
      await wsc.reorderSession(sessionId, newIndex);
      applyWorkspaceSnapshot(wsc.getState());
      callbacks.renderWorkspaceChrome();
    }

    async function applyBatchClose(method, arg) {
      const wsc = getWorkspaceStateController();
      if (typeof wsc?.[method] !== 'function') return;
      const { closed, skipped } = await wsc[method](arg);
      if (skipped > 0) {
        showToastMessage(`${skipped} busy session(s) kept open.`, {
          title: 'Sessions Closed', tone: 'info', source: TOAST_SOURCE.sessionAction, dedupeKey: 'workspace:batch-close',
        });
      }
      const previousSessionId = normalizeSessionId(state.currentSessionId);
      applyWorkspaceSnapshot(wsc.getState());
      if (state.workspace.activeSessionId && state.workspace.activeSessionId !== previousSessionId) await openSession(state.workspace.activeSessionId, { silent: true });
      else if (!state.workspace.activeSessionId) state.currentSessionId = '';
      if (closed > 0 || skipped > 0) renderAll();
    }

    function closeOtherWorkspaceSessions(keepId) {
      return applyBatchClose('closeOtherSessions', keepId);
    }

    function closeWorkspaceSessionsToRight(anchorId) {
      return applyBatchClose('closeSessionsToRight', anchorId);
    }

    function closeAllWorkspaceSessions() {
      return applyBatchClose('closeAllSessions');
    }

    const renderWorkspaceSidebarBadges = (sessionElements, visibleSessions) => {
      const approvalIds = getApprovalSessionIds();
      const linkedCounts = Array.isArray(visibleSessions)
        ? visibleSessions.reduce((m, s) => {
          const id = normalizeSessionId(s?.id);
          if (id) m[id] = Array.isArray(s?.linked_session_ids) ? s.linked_session_ids.filter(Boolean).length : 0;
          return m;
        }, {})
        : Array.from(sessionElements || []).reduce((m, element) => {
          const id = normalizeSessionId(element?.dataset?.sessionId);
          if (id) m[id] = Math.max(Number(element?.dataset?.sessionLinkedCount || 0), 0);
          return m;
        }, {});
      getWorkspaceChromeController()?.renderSidebarBadges(sessionElements, (state.workspace?.openSessionIds || []).filter((id) => !approvalIds.includes(normalizeSessionId(id))), getStreamingSessionIds().filter((id) => !approvalIds.includes(normalizeSessionId(id))), approvalIds, linkedCounts);
    };

    async function handleLinkedSessionsChanged(sessionId, linkedSessionIds) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const previousLinkedIds = (getSessionSummary(normalizedSessionId)?.linked_session_ids || []).map(normalizeSessionId).filter(Boolean);
      const nextLinkedIds = [...new Set((Array.isArray(linkedSessionIds) ? linkedSessionIds : []).map(normalizeSessionId).filter((id) => id && id !== normalizedSessionId))];
      patchSessionSummary(normalizedSessionId, { linked_session_ids: nextLinkedIds });
      renderSessions();
      callbacks.renderWorkspaceChrome();
      renderSettings();
      try {
        await _window.jennyShell.sessions.setPreferences(normalizedSessionId, { linked_session_ids: nextLinkedIds });
      } catch (error) {
        patchSessionSummary(normalizedSessionId, { linked_session_ids: previousLinkedIds });
        renderSessions();
        callbacks.renderWorkspaceChrome();
        renderSettings();
        showSessionActionError(error, 'Linked Sessions Failed');
      }
    }

    const handleLinkedSessionPopover = (activeSessionId) => getWorkspaceChromeController()?.showLinkedSessionPopover(
      activeSessionId,
      state.sessions,
      getSessionSummary(activeSessionId)?.linked_session_ids || [],
      (linkedSessionIds) => handleLinkedSessionsChanged(activeSessionId, linkedSessionIds)
    );

    function renderWorkspaceChrome(options = {}) {
      if (!workspaceRailShell) return;
      const sessionElements = workspaceRailShell.ownerDocument?.querySelectorAll?.(
        '#conversationGroups .conversation-item[data-session-id]'
      ) || [];
      renderWorkspaceSidebarBadges(sessionElements);
      if (options.runtimeOnly === true) patchChatsStripRuntime?.();
      else syncChatsStrip?.();
      const visible = options.visible !== false && state.ui.activeView === 'chat';
      workspaceRailShell.classList.toggle('hidden', !visible);
      workspaceRailShell.hidden = !visible;
      if (!visible) return getWorkspaceChromeController()?.hideLinkedSessionPopover();
      if (options.runtimeOnly === true) {
        return getWorkspaceChromeController()?.patchRailRuntime(
          state.workspace?.activeSessionId || state.currentSessionId,
          getStreamingSessionIds(),
          getApprovalSessionIds()
        );
      }
      getWorkspaceChromeController()?.renderRail(
        state.workspace?.openSessionIds || [],
        state.workspace?.activeSessionId || state.currentSessionId,
        state.sessions,
        getStreamingSessionIds(),
        getApprovalSessionIds()
      );
    }

    async function handleWorkspaceShortcut(event) {
      // keyup half of the Alt+Tab gesture: when the Ctrl modifier is released we
      // commit the deferred MRU promotion for whatever tab the user landed on.
      // Until release, each Ctrl+Tab walks a frozen MRU snapshot (see the state
      // controller's cycleNext/cyclePrev) instead of oscillating. commitCycle is
      // a no-op when no cycle is in flight, so firing it on every Ctrl-up (even
      // outside a gesture, even while focused in an input) is harmless.
      if (event.type === 'keyup') {
        if (event.key !== 'Control') return;
        const wsc = getWorkspaceStateController();
        if (!wsc?.commitCycle) return;
        const committed = await wsc.commitCycle(); // null when no gesture was in flight
        if (committed) applyWorkspaceSnapshot(committed);
        return;
      }
      const target = event.target;
      if (target?.closest?.('textarea, input, [contenteditable=""], [contenteditable="true"]') || target?.isContentEditable || !event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const wsc = getWorkspaceStateController();
        if (!wsc) return; // guard: applyWorkspaceSnapshot(undefined) would wipe state.workspace
        const previousSessionId = normalizeSessionId(state.workspace?.activeSessionId);
        const nextWorkspace = applyWorkspaceSnapshot(event.shiftKey ? await wsc.cyclePrev() : await wsc.cycleNext());
        if (nextWorkspace.activeSessionId && nextWorkspace.activeSessionId !== previousSessionId) {
          await openSession(nextWorkspace.activeSessionId, { silent: true });
          renderAll();
        }
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        globalThis.window.jennyShell.windowControl('reload');
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        globalThis.window.jennyShell.windowControl('toggle-devtools');
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        await closeWorkspaceSession(state.workspace?.activeSessionId || state.currentSessionId);
      }
    }

    return {
      normalizeSessionId,
      getApprovalSessionIds,
      getStreamingSessionIds,
      isWorkspaceSessionBusy,
      getSessionSummary,
      applyWorkspaceSnapshot,
      syncWorkspaceFromStore,
      activateWorkspaceSession,
      closeWorkspaceSession,
      reorderWorkspaceSession,
      closeOtherWorkspaceSessions,
      closeWorkspaceSessionsToRight,
      closeAllWorkspaceSessions,
      renderWorkspaceSidebarBadges,
      handleLinkedSessionsChanged,
      handleLinkedSessionPopover,
      renderWorkspaceChrome,
      handleWorkspaceShortcut,
    };
  }

  return { createWorkspaceSessionCoordinator };
});
