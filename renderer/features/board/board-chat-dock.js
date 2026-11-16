/* renderer/features/board/board-chat-dock.js - the chat docked beside the board (UMD), row 150 slice C1.
 *
 * One dock, two pages (the project board plan, section 16.5): the Workspace's chat dock
 * element (#ideChatDock) and its one controller (renderer-ide-chat-dock.js) serve the Board too. This
 * module is the Board's side of it:
 *  - it adds the Board as a page of the shared dock controller, once per app state. The registration
 *    outlives the page: with no page attached it answers "not active, not open" and costs two constant
 *    checks a reconcile. The chat render pipeline drives every move of the transcript, so leaving the
 *    Board never depends on the order in which the page is hidden and the transcript is taken back;
 *  - while the Board is the view on screen it moves the dock element into the Board's chat column, and
 *    puts it back where it was when the page is hidden (before the page clears its container);
 *  - it keeps two mirrors on the app state: `state.ui.boardChatDockOpen` (is the Board's chat column
 *    open: renderer-chat-surface-live-utils.js reads it) and `state.ui.boardChat` (`{ boardId, projectId }`
 *    while a turn typed here may be stamped with the board, else null: section 7.1);
 *  - when the chat on screen belongs to another project than the board, it says so above the chat, and
 *    no turn is stamped. The main process checks the stamp again; this is what the person sees.
 *  - beside a team board (row 151 slice T7, D30; `deps.isTeam()`) the column holds the team project's conversation,
 *    drawn by board-team.js, not this Jenny's chat: the Board's host says its chat is not open, so the transcript
 *    stays in the Chat view, no turn typed in this Jenny's chat is stamped with a team board, and no line is said.
 * Project and board names reach the page through textContent only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardChatDock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const GENERAL_PROJECT_ID = 'project_general';
  const registrations = new WeakMap(); // app state -> { dock, page }: one Board host per app state
  const noop = () => {};

  function dockModule(windowRef) {
    if (windowRef && windowRef.rendererIdeChatDock) return windowRef.rendererIdeChatDock;
    if (typeof require === 'function') {
      try { return require('../renderer-ide-chat-dock'); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  // The project of the chat on screen. A chat that has no row yet (a new chat before its first turn)
  // is made in the current project, which is the board's, so it is not counted as another project.
  function chatProjectOf(state) {
    const id = String(state.currentSessionId || '').trim();
    const session = id ? (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => String(entry && entry.id || '').trim() === id) : null;
    if (!session) return '';
    const projectId = String(session.project_id || '').trim();
    // A chat not stored yet (a New chat draft, or a first send in flight) names no project: the main process
    // makes it in the current project, so it is not "in General". The main process checks the stamp again.
    if (!projectId && (session.local_draft === true || session.optimistic_local === true)) return '';
    return projectId || GENERAL_PROJECT_ID;
  }

  function setIfChanged(target, key, value) {
    if (target[key] !== value) target[key] = value;
  }

  function register(state, windowRef, shell) {
    const utils = dockModule(windowRef);
    if (!utils || typeof utils.createIdeChatDock !== 'function') return null;
    const doc = windowRef.document;
    const byId = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
    const entry = { dock: null, page: null };
    const active = () => Boolean(entry.page) && state.ui.activeView === 'board';
    entry.dock = utils.createIdeChatDock({
      shared: true, state, windowRef,
      // The shell hooks matter only when the Board opens before the Workspace: the first page's are kept.
      getDom: () => ({ ideChatDock: byId('ideChatDock'), ideChatDockHeader: byId('ideChatDockHeader'), ideChatDockBody: byId('ideChatDockBody') }),
      onNewChat: () => { const button = byId('newChatButton'); if (button && typeof button.click === 'function') button.click(); },
      onHostChanged: (docked) => windowRef.rendererAppPaneComposition?.getPaneComposition?.()?.handleChatDocked?.(docked),
      showShellErrorToast: shell.showShellErrorToast, appendClientLog: shell.appendClientLog, noteProgrammaticWrite: shell.noteScrollProgrammaticWrite,
      host: {
        id: 'board',
        isActive: active,
        isEnabled: () => state.features?.featureFlags?.project_boards === true,
        isOpen: () => Boolean(entry.page) && entry.page.isChatOpen(),
        // Told on every reconcile, before the transcript moves: the dock element is in place by then.
        mirrorOpen: (open) => { if (entry.page) entry.page.refresh(open); },
        workbench: {
          setOpen: (open) => entry.page?.setChatOpen(open),
          reveal: (id) => entry.page?.reveal(id),
          isVisible: (id) => entry.page?.isVisible(id) === true,
        },
        layout: () => entry.page?.layout(),
        focusEditor: () => entry.page?.focusCanvas(),
        onSelectSession: (sessionId) => shell.openSession(sessionId),
        getRoot: () => (entry.page ? entry.page.rootEl : null),
        preferredProjectId: () => (entry.page ? entry.page.projectId() : ''),
      },
    });
    return entry;
  }

  /* Binds the Board page on screen to the Board's dock host. deps:
   *   windowRef, state (the app state), bench (board-page-workbench), chatHost ([data-board-chat-host]),
   *   rootEl (the page's workbench element), getBoard() -> { id, name }, getProject() -> { id, name },
   *   nameOfProject(id) -> string, layout(), focusCanvas(), appendClientLog,
   *   chat: { openSession(id), showShellErrorToast, noteScrollProgrammaticWrite }.
   * Returns { sync(), detach(), available }. With no app state or no dock module it does nothing. */
  function attachBoardChatDock(deps) {
    const { windowRef, state, bench, chatHost } = deps;
    const inert = { sync: noop, detach: noop, openChat: () => false, available: false };
    if (!state || typeof state !== 'object' || !state.ui || typeof state.ui !== 'object' || !bench || !chatHost) return inert;
    const chat = deps.chat || {};
    let entry = registrations.get(state) || null;
    if (!entry) {
      entry = register(state, windowRef, {
        openSession: (id) => (typeof chat.openSession === 'function' ? chat.openSession(id) : undefined),
        showShellErrorToast: chat.showShellErrorToast, noteScrollProgrammaticWrite: chat.noteScrollProgrammaticWrite,
        appendClientLog: deps.appendClientLog,
      });
      if (!entry) return inert;
      registrations.set(state, entry);
    }
    const doc = chatHost.ownerDocument;
    const aside = () => doc.getElementById('ideChatDock');
    let home = null; // where the dock element was before the Board took it
    let notice = null;
    let detached = false;
    const team = () => typeof deps.isTeam === 'function' && deps.isTeam() === true;

    function adopt() {
      const dock = aside();
      if (!dock || dock.parentNode === chatHost || state.ui.activeView !== 'board') return;
      home = { parent: dock.parentNode, next: dock.nextSibling };
      chatHost.appendChild(dock);
    }

    function showNotice(text) {
      const dock = aside();
      if (!text || !dock || dock.parentNode !== chatHost) {
        if (notice) notice.remove();
        notice = null;
        return;
      }
      if (!notice) {
        notice = doc.createElement('p');
        notice.className = 'board-chat-notice';
        notice.setAttribute('data-board-chat-notice', '');
        notice.setAttribute('role', 'status');
      }
      if (notice.textContent !== text) notice.textContent = text;
      const body = doc.getElementById('ideChatDockBody');
      if (notice.parentNode !== dock || notice.nextSibling !== body) dock.insertBefore(notice, body && body.parentNode === dock ? body : null);
    }

    // Called by the dock controller on every reconcile with (flag on && chat column open).
    function refresh(open) {
      if (detached) return;
      if (team()) {
        setIfChanged(state.ui, 'boardChatDockOpen', false);
        if (state.ui.boardChat) state.ui.boardChat = null;
        showNotice('');
        return;
      }
      setIfChanged(state.ui, 'boardChatDockOpen', open === true);
      adopt();
      const onScreen = open === true && state.ui.activeView === 'board';
      const board = (onScreen && deps.getBoard()) || {};
      // The mark on a message sent from here names the board (renderer-transcript-attachments.js).
      if (board.id) (deps.windowRef || globalThis).rendererChatSurfaceLiveUtils?.rememberBoardName?.(String(board.id), board.name);
      const project = deps.getProject() || {};
      const chatProject = onScreen ? chatProjectOf(state) : '';
      const other = Boolean(chatProject) && chatProject !== project.id;
      const stamp = board.id && !other ? { boardId: String(board.id), projectId: String(project.id || '') } : null;
      const current = state.ui.boardChat || null;
      if ((current && current.boardId) !== (stamp && stamp.boardId) || (current && current.projectId) !== (stamp && stamp.projectId)) state.ui.boardChat = stamp;
      showNotice(other ? jt('board.chat.otherProject', 'This chat is in {chatProject}, so Jenny cannot see this board from it. Pick or start a chat in {boardProject}.', {
        chatProject: deps.nameOfProject(chatProject) || jt('board.chat.anotherProject', 'another project'),
        boardProject: String(project.name || ''),
      }) : '');
    }

    entry.page = {
      rootEl: deps.rootEl || null,
      isChatOpen: () => !team() && bench.isChatOpen(),
      setChatOpen: (open) => bench.setChatOpen(open),
      reveal: (id) => bench.workbench.revealView(id),
      isVisible: (id) => bench.workbench.isViewVisible(id),
      layout: () => { if (typeof deps.layout === 'function') deps.layout(); },
      focusCanvas: () => (typeof deps.focusCanvas === 'function' ? deps.focusCanvas() : false),
      projectId: () => String((deps.getProject() || {}).id || ''),
      refresh,
    };
    const page = entry.page;

    return {
      available: true,
      // After the Board's layout, its project or its open board changed: the dock controller reconciles
      // (which moves the transcript in or out and calls refresh).
      sync() {
        if (detached) return false;
        try { return entry.dock.reconcile() === true; } catch (error) {
          if (typeof deps.appendClientLog === 'function') deps.appendClientLog('WARN', 'board.chat_dock_sync_failed', { message: String(error && error.message || error).slice(0, 200) });
          return false;
        }
      },
      // Opens the chat column (the dock puts the caret in the composer once it shows). False when the Board's chat is off
      // or this page has left; the "Ask Jenny" tool tells the person so.
      openChat() {
        if (detached || team() || state.features?.featureFlags?.project_boards !== true) return false;
        try { entry.dock.open(); } catch (_error) { return false; }
        return entry.page === page && page.isChatOpen() === true;
      },
      // Before the page clears its container: the dock element goes back where it was, with whatever it
      // holds. The next chat render takes the transcript back to the Chat view through the controller.
      detach() {
        if (detached) return;
        detached = true;
        if (entry.page === page) entry.page = null;
        setIfChanged(state.ui, 'boardChatDockOpen', false);
        if (state.ui.boardChat) state.ui.boardChat = null;
        if (notice) notice.remove();
        notice = null;
        const dock = aside();
        if (!dock || dock.parentNode !== chatHost) return;
        const fallback = doc.getElementById('ideStatusBar');
        const parent = home && home.parent && home.parent.isConnected ? home.parent : ((fallback && fallback.parentNode) || doc.body);
        dock.classList.add('hidden');
        parent.insertBefore(dock, home && home.next && home.next.parentNode === parent ? home.next : null);
      },
    };
  }

  return { attachBoardChatDock, chatProjectOf, GENERAL_PROJECT_ID };
});
