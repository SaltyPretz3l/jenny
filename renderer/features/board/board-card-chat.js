/* renderer/features/board/board-card-chat.js - chat cards on the board (UMD, global rendererBoardCardChat), a kind
 * module of board-card-kinds.js (row 150 slice B7).
 *
 * - Toolbar tool `chat` ("Chat", order 25): a menu (the inventory context menu) of the board's project's chats,
 *   newest first, at most CHAT_MENU_MAX, read from the app state the way the chat dock's session picker reads it
 *   (renderer-ide-chat-session-picker.js: chats only, not archived, not being deleted). Picking one adds
 *   { session_id, message_id: null, title, excerpt: '' } with editor.addCard.
 * - Enter or a double-click opens that chat on the Chat page: the page's context.openSession({ sessionId, messageId }) when it has one, else the
 *   app's own chat opener on the app state (state.harness.agentActions: setActiveView('chat'), then openSession(id),
 *   which selects the chat's tab as the sidebar does). A chat that is gone is told with ctx.notify.
 * - On a team board (row 151, section 8.7) the chats are the team project's conversations and nothing of this Jenny's own: the
 *   page's context.teamChats() answers [{ id, title }] there (null on a board of this Jenny's own), and its openSession shows the
 *   conversation in the chat column beside the board.
 * Chat titles reach the page through the menu primitive's textContent only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rendererBoardCardChat = api;
  if (root && root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('chat', api.createChatPart);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const CHAT_MENU_MAX = 30;
  const TITLE_CHARS = 200;
  const GENERAL_PROJECT_ID = 'project_general';
  const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/; // the model's token rule for data.session_id
  const CHAT_CARD = { w: 280, h: 140 }; // the model's default size for a chat card

  function tell(ctx, message) {
    try { if (typeof ctx.notify === 'function') ctx.notify(message, { tone: 'warning' }); } catch (_error) { /* a toast must not break a card */ }
  }
  function resolveGlobal(windowRef, name, requirePath) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }
  function stateOf(ctx) {
    const state = ctx.context && ctx.context.state;
    return state && typeof state === 'object' ? state : {};
  }
  /** One line of at most `max` characters: control characters and line or paragraph separators become spaces. */
  function oneLine(text, max) {
    let out = '';
    for (const ch of String(text == null ? '' : text)) {
      const code = ch.codePointAt(0);
      out += code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /** The chats a card may name: chats only, not archived, not being deleted. */
  function liveChats(state) {
    const deleting = new Set((Array.isArray(state.ui && state.ui.pendingSessionDeletes) ? state.ui.pendingSessionDeletes : []).map((id) => String(id || '').trim()));
    return (Array.isArray(state.sessions) ? state.sessions : []).filter((session) => {
      const id = String((session && session.id) || '').trim();
      const type = String((session && session.session_type) || 'chat').trim().toLowerCase();
      return SESSION_ID_RE.test(id) && type === 'chat' && !session.archived_at && !deleting.has(id);
    });
  }

  /** The chats of `projectId` a card may name, newest first, at most CHAT_MENU_MAX. */
  function projectChats(state, projectId) {
    return liveChats(state)
      .filter((session) => (String(session.project_id || '').trim() || GENERAL_PROJECT_ID) === projectId)
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
      .slice(0, CHAT_MENU_MAX);
  }

  /** A team board's chats: the team project's conversations, or null on a board of this Jenny's own. */
  function teamChats(ctx) {
    const list = ctx.context && typeof ctx.context.teamChats === 'function' ? ctx.context.teamChats() : null;
    return Array.isArray(list) ? list : null;
  }

  function titleOf(session) {
    return oneLine(session && session.title, TITLE_CHARS) || jt('board.chat.untitled', 'New Chat');
  }

  function createChatPart(ctx) {
    let disposed = false;

    async function addChat(session) {
      if (disposed) return;
      // No place is given: the board's next free place, as for a note from the toolbar.
      const result = await ctx.editor.addCard({
        kind: 'chat', data: { session_id: String(session.id).trim(), message_id: null, title: titleOf(session), excerpt: '' },
        w: CHAT_CARD.w, h: CHAT_CARD.h,
      });
      if (result.ok && ctx.host && typeof ctx.host.reveal === 'function') ctx.host.reveal(result.id);
    }

    function runTool() {
      const projectId = ctx.context && typeof ctx.context.getProjectId === 'function' ? String(ctx.context.getProjectId() || '') : '';
      const team = teamChats(ctx);
      const chats = team ? team.slice(0, CHAT_MENU_MAX) : projectChats(stateOf(ctx), projectId);
      if (!chats.length) { tell(ctx, jt('board.chat.none', 'This project has no chats yet. Start one, then add it here.')); return; }
      const menu = resolveGlobal(ctx.windowRef, 'inventoryContextMenu', '../../inventory/context-menu');
      if (!menu || typeof menu.show !== 'function') { tell(ctx, jt('board.chat.noMenu', 'The list of chats is not available here.')); return; }
      const canvas = ctx.surface.element.parentNode;
      const anchor = canvas ? canvas.querySelector('[data-board-tool="kind-chat"]:not([hidden]), [data-board-more]') : null; // More while the tool is in its menu
      menu.show({
        rootEl: ctx.surface.element, anchorEl: anchor, className: 'board-chat-menu',
        heading: jt('board.chat.menuHeading', 'Add a chat from this project'),
        items: chats.map((session) => ({ label: titleOf(session), value: String(session.id), action: () => addChat(session) })),
      });
    }

    async function open(card) {
      const state = stateOf(ctx);
      const id = card.data.session_id;
      const team = teamChats(ctx);
      if (!(team ? team.some((chat) => chat.id === id) : liveChats(state).some((session) => String(session.id).trim() === id))) { tell(ctx, jt('board.chat.gone', 'That chat is no longer here.')); return; }
      const fromPage = ctx.context && typeof ctx.context.openSession === 'function' ? ctx.context.openSession : null;
      const actions = state.harness && state.harness.agentActions;
      try {
        if (fromPage) { await fromPage({ sessionId: id, messageId: typeof card.data.message_id === 'string' ? card.data.message_id : null }); return; }
        if (actions && typeof actions.openSession === 'function') {
          if (typeof actions.setActiveView === 'function') actions.setActiveView('chat');
          await actions.openSession(id);
          return;
        }
      } catch (_error) { /* told below */ }
      tell(ctx, jt('board.chat.cannotOpen', 'That chat could not be opened.'));
    }

    return {
      kind: 'chat',
      activate(card) { void open(card); return true; },
      tools: [{ id: 'chat', label: jt('board.toolbar.chat', 'Chat'), title: jt('board.toolbar.chatTitle', 'Add a chat from this project'), order: 25, run: runTool }],
      dispose() { disposed = true; },
    };
  }

  return { createChatPart, CHAT_MENU_MAX };
});
