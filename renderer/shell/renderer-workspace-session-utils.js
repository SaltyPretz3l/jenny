/* renderer/shell/renderer-workspace-session-utils.js — workspace session coordination (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceSessionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function normalizeSessionId(value) {
    return String(value || '').trim();
  }

  const { resolveDefaultTitle } = globalThis.stringUtils
    || (typeof require === 'function' ? require('../shared/string-utils') : null);
  const EVICTION_TOAST_DURATION_MS = 6000;
  const EDITABLE_TARGET_SELECTOR = 'textarea, input, [contenteditable=""], [contenteditable="true"]';
  const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

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

    const getAttentionStates = (ids) => getMultiStreamController()?.getSessionAttentionStates?.(ids);

    const getStreamingSessionIds = () => getMultiStreamController()?.getStreamingSessionIds?.()
      || (normalizeSessionId(state.activeStreamSessionId) ? [normalizeSessionId(state.activeStreamSessionId)] : []);

    const isWorkspaceSessionBusy = (sessionId) => {
      const id = normalizeSessionId(sessionId);
      return getStreamingSessionIds().includes(id) || getApprovalSessionIds().includes(id);
    };

    const getSessionSummary = (sessionId) =>
      state.sessions.find((session) => normalizeSessionId(session?.id) === normalizeSessionId(sessionId)) || null;

    const sessionDisplayTitle = (sessionId) => resolveDefaultTitle(getSessionSummary(sessionId)?.title);

    // "Show in Chats": focus the evicted chat's sidebar row (still listed there).
    // The row may be filtered out (search, project, the archived scope) or sit
    // past the rendered page: widen the list until it is mounted, bounded by
    // a page count so a missing session cannot loop.
    const REVEAL_MAX_PAGES = 20;
    function findChatsRow(doc, sessionId) {
      const rows = doc?.querySelectorAll?.('#conversationGroups .conversation-item[data-session-id]') || [];
      return Array.from(rows).find((element) => normalizeSessionId(element?.dataset?.sessionId) === sessionId) || null;
    }
    function revealSessionInChats(sessionId) {
      const doc = workspaceRailShell?.ownerDocument;
      const panel = controllers.getChatsPanelController?.() || null;
      // A collapsed panel shows only the strip, so the row cannot take focus:
      // open it the way the strip's own expand does, filters cleared.
      if (callbacks.isChatsPanelCollapsed?.() === true) {
        panel?.prepareForStripExpansion?.();
        panel?.setProjectFilter?.('');
        callbacks.expandChatsPanel?.();
        panel?.renderNow?.();
      }
      let row = findChatsRow(doc, sessionId);
      if (!row) {
        const search = doc?.getElementById?.('conversationSearch');
        if (search && search.value) search.value = '';
        if (panel?.getScope?.() === 'archived') panel.setScope?.('recent');
        if (panel?.getProjectFilter?.()) panel.setProjectFilter?.('');
        panel?.resetQuery?.();
        panel?.renderNow?.();
        row = findChatsRow(doc, sessionId);
        for (let page = 0; !row && page < REVEAL_MAX_PAGES && typeof panel?.loadMore === 'function'; page += 1) {
          panel.loadMore();
          panel.renderNow?.();
          row = findChatsRow(doc, sessionId);
        }
      }
      const target = row?.querySelector?.('[data-session-open]') || row;
      if (!target) return;
      target.scrollIntoView?.({ block: 'nearest' });
      target.focus?.();
    }

    function showEvictionToast(evictedId) {
      showToastMessage(jt('shell.sessions.tabEvictedMessage', '“{title}” is still in Chats.', { title: sessionDisplayTitle(evictedId) }), {
        title: jt('shell.sessions.tabEvictedTitle', 'Tab closed to make room'),
        tone: 'info',
        source: TOAST_SOURCE.sessionAction,
        dedupeKey: 'workspace:evicted',
        durationMs: EVICTION_TOAST_DURATION_MS,
        actions: [{
          id: 'workspace-evicted-show',
          label: jt('shell.sessions.showInChats', 'Show in Chats'),
          onClick: () => revealSessionInChats(evictedId),
        }],
      });
    }

    // The rail is full and nothing could close: the current tab never does, and
    // an idle tab left over is one a pane shows (the state controller's rule).
    function showRailFullToast() {
      const { activeSessionId, openSessionIds } = state.workspace;
      const busy = openSessionIds.filter(isWorkspaceSessionBusy).length;
      const count = openSessionIds.length;
      const paneHeld = openSessionIds.some((id) => id !== activeSessionId && !isWorkspaceSessionBusy(id));
      const message = paneHeld
        ? jt('shell.sessions.railFullPane', 'A tab shown in a pane stays open. Close a tab before opening another.')
        : jt('shell.sessions.railFull', 'Close or finish a busy session before opening another tab.');
      showToastMessage(message, {
        title: busy === count
          ? jt('shell.sessions.railFullAllBusyTitle', 'All {count} tabs are busy', { count })
          : jt('shell.sessions.railFullSomeBusyTitle', '{busy} of {count} tabs are busy', { busy, count }),
        tone: 'info',
        source: TOAST_SOURCE.sessionAction,
        dedupeKey: 'workspace:cap-busy',
      });
    }

    function applyWorkspaceSnapshot(snapshot) {
      state.workspace = {
        activeSessionId: normalizeSessionId(snapshot?.activeSessionId),
        openSessionIds: Array.isArray(snapshot?.openSessionIds) ? snapshot.openSessionIds.map(normalizeSessionId).filter(Boolean) : [],
      };
      state.currentSessionId = state.workspace.activeSessionId;
      return state.workspace;
    }

    async function syncWorkspaceFromStore({ silent = true, renderAfter = false, preserveCurrentSession = false } = {}) {
      const wsc = getWorkspaceStateController();
      if (!wsc) return state.workspace;
      // Until the signed-in session list has loaded, a restore would validate
      // every stored tab away and persist the empty rail over them (a cold boot
      // races the backend; agent mode is signed in before the list arrives).
      // Defer it: the session load syncs again, from storage, not the empty
      // in-memory rail.
      if (state.auth?.authenticated !== true || state.sessionListLoaded !== true) {
        state.workspaceRestoreDeferred = true;
        return state.workspace;
      }
      const fromStorage = state.workspaceRestoreDeferred === true;
      state.workspaceRestoreDeferred = false;
      const previousSessionId = normalizeSessionId(state.currentSessionId);
      const nextWorkspace = applyWorkspaceSnapshot(await wsc.restore(state.sessions.map((s) => normalizeSessionId(s?.id)).filter(Boolean), { preserveCurrentSession: preserveCurrentSession && !fromStorage }));
      if (nextWorkspace.activeSessionId && (nextWorkspace.activeSessionId !== previousSessionId || !state.messagesBySession.has(nextWorkspace.activeSessionId))) {
        await openSession(nextWorkspace.activeSessionId, { silent });
      } else if (!nextWorkspace.activeSessionId) {
        state.currentSessionId = '';
      }
      callbacks.onWorkspaceRestored?.(); // split view: the stored second pane, once
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
      const evictedId = normalizeSessionId(nextWorkspace?.evictedSessionId);
      applyWorkspaceSnapshot(nextWorkspace);
      const resolvedActiveId = normalizeSessionId(state.workspace.activeSessionId);
      if (requestedId && resolvedActiveId !== requestedId) {
        showRailFullToast();
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
      if (evictedId) showEvictionToast(evictedId);
      return state.workspace;
    }

    async function closeWorkspaceSession(sessionId, { renderAfter = true } = {}) {
      const wsc = getWorkspaceStateController();
      const id = normalizeSessionId(sessionId);
      if (!id || !wsc) return false;
      if (!await wsc.closeSession(id)) {
        showToastMessage(jt('shell.sessions.busyClose', 'Finish the current response or approval before closing this session.'), {
          title: jt('shell.sessions.busyTitle', 'Session Busy'), tone: 'info', source: TOAST_SOURCE.sessionAction, dedupeKey: 'workspace:busy-close',
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
        showToastMessage(jt('shell.sessions.busyKeptOpen', '{count} busy session(s) kept open.', { count: skipped }), {
          title: jt('shell.sessions.closedTitle', 'Sessions Closed'), tone: 'info', source: TOAST_SOURCE.sessionAction, dedupeKey: 'workspace:batch-close',
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

    /* The "Needs you" inbox mirrors exactly the waits these badges do, so it
     * refreshes on exactly the passes that refresh them: afterRenderSessions
     * (the session list changed) and every workspace-chrome pass -- which is
     * the only signal an approval in a session that is not open produces, as
     * queueSessionRender drops the `sessions` flag for such a session and
     * keeps only `chrome`. No timer and no poll of its own. */
    const renderAttentionInbox = () => {
      try {
        state.attentionInboxController?.render?.();
      } catch (_error) { /* chrome only: a failed inbox render never breaks a pass */ }
      try {
        /* The reader syncs the active chat's seen cursor and panel-arrival read
         * on this pass; it never builds a model here. */
        state.awayDigestReader?.onChromePass?.();
      } catch (_error) { /* chrome only: a failed digest read never breaks a pass */ }
    };

    const renderWorkspaceSidebarBadges = (sessionElements, visibleSessions) => {
      renderAttentionInbox();
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
      getWorkspaceChromeController()?.renderSidebarBadges(sessionElements, state.workspace?.openSessionIds || [], getStreamingSessionIds(), approvalIds, linkedCounts,
        getAttentionStates(Array.from(sessionElements || [], (element) => element.dataset?.sessionId)), state.awayDigest?.digest?.outcomeBySession || null);
      // A sessions render (auto-title, rename) must reach the tab titles too.
      getWorkspaceChromeController()?.syncTabTitles?.();
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
        showSessionActionError(error, jt('shell.workspaceSessions.linkedSessionsFailed', 'Linked Sessions Failed'));
      }
    }

    const handleLinkedSessionPopover = (activeSessionId, anchor) => getWorkspaceChromeController()?.showLinkedSessionPopover(
      activeSessionId,
      state.sessions,
      getSessionSummary(activeSessionId)?.linked_session_ids || [],
      (linkedSessionIds) => handleLinkedSessionsChanged(activeSessionId, linkedSessionIds),
      anchor
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
      if (!visible) return getWorkspaceChromeController()?.hideLinkedSessionPopover({ keepRowAnchored: true });
      if (options.runtimeOnly === true) {
        return getWorkspaceChromeController()?.patchRailRuntime(
          state.workspace?.activeSessionId || state.currentSessionId,
          getStreamingSessionIds(),
          getApprovalSessionIds(),
          getAttentionStates(state.workspace?.openSessionIds || [])
        );
      }
      getWorkspaceChromeController()?.renderRail(
        state.workspace?.openSessionIds || [],
        state.workspace?.activeSessionId || state.currentSessionId,
        state.sessions,
        getStreamingSessionIds(),
        getApprovalSessionIds(),
        getAttentionStates(state.workspace?.openSessionIds || [])
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
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      // Ctrl+Tab / Ctrl+Shift+Tab switch chat tabs from the composer too (focus
      // usually lives there), but only in the chat view, never under a modal,
      // and never after another handler (the palette's scope cycle, the IDE's
      // editor MRU) already consumed the chord.
      if (event.key === 'Tab') {
        if (event.defaultPrevented || state.ui?.activeView !== 'chat' || event.target?.closest?.(MODAL_SELECTOR)) return;
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
        if (event.defaultPrevented) return; // an editor bound the chord itself (Monaco: Refactor)
        event.preventDefault();
        // The guarded reload, from a text field too (a chord, not text input):
        // the exit preflight runs first (unsaved Workspace buffers,
        // Personality and Memory notes), exactly as the palette's "Reload
        // window" does, and a thrown preflight is logged.
        const windowControls = globalThis.rendererWindowControlsUtils
          || (typeof require === 'function' ? require('../chat/renderer-window-controls-utils') : null);
        if (typeof windowControls?.reloadWindow === 'function') void windowControls.reloadWindow({ windowRef: _window });
        return;
      }
      const target = event.target;
      if (target?.closest?.(EDITABLE_TARGET_SELECTOR) || target?.isContentEditable) return;
      if (event.shiftKey && event.key.toLowerCase() === 'i') {
        if (event.defaultPrevented) return; // a surface already claimed the chord
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
