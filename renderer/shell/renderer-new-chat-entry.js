/* renderer/shell/renderer-new-chat-entry.js - the "+ New chat" entry.
 *
 * Split out of renderer-shell-runtime-utils.js (at the 1015-line cap), which
 * still exports handleCreateSessionWithWorkspace and delegates here. Every
 * bare New chat reaches this path: the #newChatButton click, which the tab
 * rail +, the Chats +, the global shortcut and the command palette all press,
 * plus the bare programmatic callers (error recovery, Home, Send to Jenny).
 *
 * Real-app finding X3 (2026-09-29): a bare create (no options) reuses an
 * untouched empty chat instead of stacking another empty "New Chat" tab.
 * Untouched mirrors the backend empty-session sweep
 * (services/backend/electron-session-store.js sweepEmptySessions and
 * interactive-session-utils.js isDefaultSessionTitle): 0 messages, stored title
 * empty or the canonical 'New Chat' (the localized label is display-only), not
 * pinned. On top of that: a regular chat, not archived, no live turn / stream /
 * queued send / preflight, no hydrated messages, no composer draft or queued
 * attachment, and in the project a bare create lands in (the Workspace
 * folder's project, General with no folder open). Any create with options
 * always creates; a failing lookup creates (today's behaviour).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererNewChatEntry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GENERAL_PROJECT_ID = 'project_general';

  function noop() {}
  function noopAsync() { return Promise.resolve(); }
  function text(value) { return String(value || '').trim(); }

  function isBareCreateRequest(args) {
    const list = Array.from(args || []);
    if (list.length > 1) return false;
    const first = list[0];
    if (first == null) return true;
    return typeof first === 'object' && !Array.isArray(first) && Object.keys(first).length === 0;
  }

  function isDefaultChatTitle(title) {
    const value = text(title);
    // The canonical stored default (display localizes it; storage never does).
    return !value || value === 'New Chat';
  }

  // The composer record is captured on every composer 'input'
  // (renderer-composer-session-state.js); the live attachment queue is the
  // current chat's.
  function hasComposerContent(state, sessionId) {
    const record = state.composerSessionState instanceof Map ? state.composerSessionState.get(sessionId) : null;
    if (record && (text(record.text) || (Array.isArray(record.attachments) && record.attachments.length))) return true;
    const liveQueue = state.attachments && state.attachments.queued;
    return sessionId === text(state.currentSessionId) && Array.isArray(liveQueue) && liveQueue.length > 0;
  }

  function isUntouchedEmptyChat(state, session) {
    const id = text(session && session.id);
    if (!id || typeof session !== 'object') return false;
    if (text(session.session_type || 'chat').toLowerCase() !== 'chat' || session.plugin_session) return false;
    if (session.pinned === true || session.archived_at) return false;
    if (Math.max(Number(session.message_count || 0), 0) !== 0) return false;
    if (!isDefaultChatTitle(session.title) || text(session.composer_draft)) return false;
    if (session.active_turn || session.activeTurn || text(state.activeStreamSessionId) === id) return false;
    if (state.queuedSendBySession instanceof Map && state.queuedSendBySession.has(id)) return false;
    if (text(state.sendPreflight && state.sendPreflight.sessionId) === id) return false;
    const hydrated = state.messagesBySession instanceof Map ? state.messagesBySession.get(id) : null;
    if (Array.isArray(hydrated) && hydrated.some(Boolean)) return false;
    return !hasComposerContent(state, id);
  }

  // The current chat first, then chats open as tabs, then the most recently created.
  function rankReusableChats(state, candidates) {
    const currentId = text(state.currentSessionId);
    const openIds = new Set((Array.isArray(state.workspace && state.workspace.openSessionIds)
      ? state.workspace.openSessionIds : []).map(text));
    const rank = (session) => (text(session.id) === currentId ? 2 : (openIds.has(text(session.id)) ? 1 : 0));
    const createdMs = (session) => Date.parse(session.created_at || '') || 0;
    return candidates.slice().sort((a, b) => (rank(b) - rank(a)) || (createdMs(b) - createdMs(a)));
  }

  function createNewChatEntry(deps) {
    const { state, windowRef = null, callbacks = {} } = deps || {};
    const {
      appendClientLog = noop,
      handleCreateSession = noopAsync,
      activateWorkspaceSession = noopAsync,
      renderWorkspaceChrome = noop,
      renderSessions = noop,
      focusComposer = noop,
    } = callbacks;
    // Workspace folder path -> the project a bare create lands in there,
    // learned from a bare create's result or one projects.list read.
    const projectByRoot = new Map();

    function workspaceRootPath() {
      return text(state.workspaceRoot && state.workspaceRoot.path);
    }

    function findSession(sessionId) {
      return (Array.isArray(state.sessions) ? state.sessions : []).find((session) => text(session && session.id) === sessionId) || null;
    }

    // '' = unknown: the caller then creates, as it did before reuse existed.
    async function bareCreateProjectId() {
      const rootPath = workspaceRootPath();
      if (!rootPath) return GENERAL_PROJECT_ID;
      if (projectByRoot.has(rootPath)) return projectByRoot.get(rootPath);
      const api = windowRef && windowRef.jennyShell && windowRef.jennyShell.projects;
      if (!api || typeof api.list !== 'function') return '';
      const payload = await api.list();
      if (workspaceRootPath() !== rootPath) return '';
      const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.projects) ? payload.projects : []);
      const current = rows.find((row) => row && row.is_current === true);
      const projectId = text(current && current.id);
      if (projectId) projectByRoot.set(rootPath, projectId);
      return projectId;
    }

    async function findReusableChat() {
      const candidates = (Array.isArray(state.sessions) ? state.sessions : [])
        .filter((session) => isUntouchedEmptyChat(state, session));
      if (!candidates.length) return '';
      let expectedProjectId = null;
      for (const session of rankReusableChats(state, candidates)) {
        // A local draft materializes in the bare-create project by construction.
        if (session.local_draft === true) return text(session.id);
        if (expectedProjectId === null) expectedProjectId = await bareCreateProjectId();
        // Re-checked: the projects.list read may have awaited while the chat changed.
        if (expectedProjectId && (text(session.project_id) || GENERAL_PROJECT_ID) === expectedProjectId
          && isUntouchedEmptyChat(state, session)) return text(session.id);
      }
      return '';
    }

    function noteBareCreate(rootPath, sessionId) {
      const session = findSession(sessionId);
      const projectId = text(session && session.project_id);
      if (rootPath && projectId && session.local_draft !== true && workspaceRootPath() === rootPath) {
        projectByRoot.set(rootPath, projectId);
      }
    }

    // D7: a project-filtered Chats list follows to the chat just opened.
    function followChatsProjectFilter(sessionId) {
      const filter = String(state.ui && state.ui.chatsProjectFilter || '');
      const session = filter && sessionId ? findSession(sessionId) : null;
      if (session && (session.project_id || GENERAL_PROJECT_ID) !== filter) {
        state.ui.chatsProjectFilter = session.project_id || GENERAL_PROJECT_ID;
        renderSessions();
      }
    }

    async function reuseChat(sessionId, navigationGuard) {
      followChatsProjectFilter(sessionId);
      await activateWorkspaceSession(sessionId, { silent: true, mode: 'new-tab', navigationGuard });
      if (navigationGuard.isCurrent() && text(state.currentSessionId) === sessionId) focusComposer();
      renderWorkspaceChrome();
      appendClientLog('INFO', 'sessions.new_chat_reused', { sessionId });
      return sessionId;
    }

    // F37: the latest New chat wins. An older create's tab activation still in
    // flight must not reclaim the current session from a newer create.
    let createSessionGeneration = 0;
    async function handleCreateSessionWithWorkspace(...args) {
      const generation = ++createSessionGeneration;
      const navigationGuard = { isCurrent: () => generation === createSessionGeneration };
      const bare = isBareCreateRequest(args);
      if (bare) {
        let reusableId = '';
        try {
          reusableId = await findReusableChat();
        } catch (error) {
          appendClientLog('WARN', 'sessions.new_chat_reuse_lookup_failed', { message: text(error && error.message || error).slice(0, 200) });
        }
        // Superseded meanwhile: the newer New chat owns navigation.
        if (reusableId) return navigationGuard.isCurrent() ? reuseChat(reusableId, navigationGuard) : reusableId;
      }
      const rootAtCreate = workspaceRootPath();
      const createdSessionId = String(await handleCreateSession(...args) || '').trim();
      if (bare && createdSessionId) noteBareCreate(rootAtCreate, createdSessionId);
      followChatsProjectFilter(createdSessionId);
      if (createdSessionId && navigationGuard.isCurrent()) {
        state.currentSessionId = createdSessionId;
        // A brand-new chat always opens in its own tab, regardless of the
        // open-in-new-tab preference (which only governs existing sessions).
        await activateWorkspaceSession(createdSessionId, { silent: true, mode: 'new-tab', navigationGuard });
        renderWorkspaceChrome();
      }
      return createdSessionId;
    }

    return { handleCreateSessionWithWorkspace, findReusableChat };
  }

  return { createNewChatEntry, isBareCreateRequest, isUntouchedEmptyChat, rankReusableChats };
});
