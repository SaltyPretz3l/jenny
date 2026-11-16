/* renderer/features/board/board-pin-menu.js - the board picker behind every "Pin to board" in the chat (UMD, global
 * rendererBoardPinMenu), row 150 slice C5.
 *
 * Loaded on first use from the chat page (renderer-chat-message-action-bindings.js openPinMenu loads it through the
 * script loader); it is in no startup list and needs no other board module. open({ anchorEl, rootEl, projectId, item,
 * heading, sessionId, messageId, deps }) asks boards.list for the project's boards (and boards.chatRefs, when it is
 * given the chat and the message, for the boards that already hold that message) and shows one context menu:
 *   - "On board: <name>" for each board that holds the message, first; choosing one opens the Board on that board;
 *   - then one line per board; choosing one calls boards.pin with the item as it came and says "Pinned to <name>"
 *     (with an "Open board" action: the board is never opened by pinning);
 *   - with no board in the project, one line "New board", which creates a board the way the Board page does (the same
 *     default name) and pins to it.
 * A refusal is a toast in plain words, never a reason code or a path. Board names are person- or model-written text:
 * they reach the menu as labels, which the menu draws with textContent.
 * deps: { state, windowRef, boards?, menu?, toast?, openBoard? }. Nothing is asked while the `project_boards` flag is off.
 * openBoard(boardId, { projectId, ... }) saves the board as the project's open one (the Board page reads that when it
 * shows), tells a Board page that is up, and moves the app to the Board view. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardPinMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const LAYOUT_STORE_SRC = 'renderer/features/board/board-layout-store.js';
  const FOLDER_REASONS = new Set(['outside', 'link', 'no_root', 'not_file']);

  const flagOn = (state) => Boolean(state && state.features && state.features.featureFlags && state.features.featureFlags.project_boards === true);

  /** The sentence for a refusal of boards.pin (or of making the board). `item` tells a missing file from a missing board. */
  function refusalText(result, item) {
    const reason = result && typeof result.reason === 'string' ? result.reason : '';
    if (reason === 'limit') return jt('board.pin.error.full', 'That board is full');
    if (FOLDER_REASONS.has(reason)) return jt('board.pin.error.folder', 'Only files in this project\'s folder can be pinned');
    if (reason === 'read_only') return jt('board.pin.error.readOnly', 'That board cannot be changed');
    if (reason === 'disabled') return jt('board.pin.error.disabled', 'Boards are turned off');
    if (reason === 'too_large') return jt('board.pin.error.tooLarge', 'That picture is too big to pin');
    if (reason === 'not_found') {
      return item && item.kind === 'file' ? jt('board.pin.error.fileGone', 'That file is not there any more') : jt('board.pin.error.gone', 'That board no longer exists');
    }
    return jt('board.pin.error.failed', 'Could not pin that');
  }

  function windowOf(deps) { return (deps && deps.windowRef) || globalThis; }

  function toaster(deps) {
    if (typeof deps.toast === 'function') return deps.toast;
    const host = windowOf(deps).rendererSuggestedChangesHost;
    return host && typeof host.showToastMessage === 'function' ? host.showToastMessage.bind(host) : () => {};
  }
  function say(deps, message, options) {
    try { toaster(deps)(message, options || {}); } catch (_error) { /* a toast is best-effort */ }
  }

  async function layoutStoreOf(win) {
    if (!win.rendererBoardLayoutStore) {
      const loader = win.scriptLoaderUtils;
      if (loader && typeof loader.ensureScript === 'function') {
        try { await loader.ensureScript({ src: LAYOUT_STORE_SRC, isReady: () => Boolean(win.rendererBoardLayoutStore) }); } catch (_error) { /* told by the result */ }
      }
    }
    return win.rendererBoardLayoutStore || null;
  }

  /** Moves the app to the Board on `boardId`. True when the view was changed. */
  async function openBoard(boardId, deps) {
    const settings = deps || {};
    const win = windowOf(settings);
    try {
      const store = await layoutStoreOf(win);
      const storage = (() => { try { return win.localStorage; } catch (_error) { return null; } })();
      if (store && storage && settings.projectId) store.createLayoutStore({ storage, model: null }).saveOpenBoard(settings.projectId, boardId);
      // A Board page that is already up read its open board when it loaded: tell it, then move to the tab.
      try { Promise.resolve(win.rendererBoardPage && win.rendererBoardPage.openBoard && win.rendererBoardPage.openBoard(boardId)).catch(() => {}); } catch (_error) { /* the tab opens it */ }
      const actions = settings.state && settings.state.harness && settings.state.harness.agentActions;
      const setView = typeof settings.setActiveView === 'function' ? settings.setActiveView : (actions && actions.setActiveView);
      if (typeof setView !== 'function') return false;
      setView('board');
      return true;
    } catch (_error) {
      return false;
    }
  }

  function bridgeOf(deps) {
    if (deps.boards) return deps.boards;
    const shell = windowOf(deps).jennyShell;
    return shell && shell.boards ? shell.boards : null;
  }

  async function pinTo(boardId, args, deps) {
    const bridge = bridgeOf(deps);
    let answer;
    try { answer = await bridge.pin({ boardId, item: args.item }); } catch (_error) { answer = { ok: false, reason: 'io' }; }
    if (!answer || answer.ok !== true) { say(deps, refusalText(answer, args.item), { tone: 'warning' }); return false; }
    const name = typeof answer.boardName === 'string' ? answer.boardName : '';
    say(deps, jt('board.pin.pinned', 'Pinned to {name}', { name }), {
      tone: 'success',
      actions: [{ id: 'board-pin-open', kind: 'secondary', label: jt('board.pin.openBoard', 'Open board'), onClick: () => { void openOn(boardId, args, deps); } }],
    });
    return true;
  }

  function openOn(boardId, args, deps) {
    if (typeof deps.openBoard === 'function') return Promise.resolve(deps.openBoard(boardId, { ...deps, projectId: args.projectId }));
    return openBoard(boardId, { ...deps, projectId: args.projectId });
  }

  async function pinToNewBoard(args, deps) {
    const bridge = bridgeOf(deps);
    let made;
    try { made = await bridge.create({ projectId: args.projectId, name: jt('board.new.defaultName', 'New board') }); } catch (_error) { made = { ok: false, reason: 'io' }; }
    if (!made || made.ok !== true || !made.board) {
      // Too many boards in the project is not "that board is full".
      say(deps, made && made.reason === 'limit' ? jt('board.error.limit', 'This project already has the most boards it can hold.') : refusalText(made, args.item), { tone: 'warning' });
      return false;
    }
    return pinTo(made.board.id, args, deps);
  }

  async function holdingBoards(bridge, args) {
    if (!args.sessionId || !args.messageId || typeof bridge.chatRefs !== 'function') return [];
    let answer;
    try { answer = await bridge.chatRefs({ projectId: args.projectId, sessionId: args.sessionId }); } catch (_error) { return []; }
    return answer && answer.ok === true && Array.isArray(answer.refs)
      ? answer.refs.filter((ref) => ref && ref.messageId === args.messageId && typeof ref.boardId === 'string' && typeof ref.boardName === 'string')
      : [];
  }

  /** Shows the picker. Resolves true when a menu was shown. */
  async function open(options) {
    const args = options || {};
    const deps = args.deps || {};
    if (!flagOn(deps.state)) return false;
    const bridge = bridgeOf(deps);
    if (!bridge || typeof bridge.list !== 'function' || typeof bridge.pin !== 'function') return false;
    const win = windowOf(deps);
    const menu = deps.menu || win.inventoryContextMenu;
    if (!menu || typeof menu.show !== 'function') return false;
    let listed;
    try { listed = await bridge.list({ projectId: args.projectId }); } catch (_error) { listed = { ok: false, reason: 'io' }; }
    if (!listed || listed.ok !== true || !Array.isArray(listed.boards)) { say(deps, refusalText(listed, args.item), { tone: 'warning' }); return false; }
    const holding = await holdingBoards(bridge, args);
    const items = holding.map((ref) => ({
      label: jt('board.pin.onBoard', 'On board: {name}', { name: ref.boardName }),
      action: () => openOn(ref.boardId, args, deps),
    }));
    if (items.length && listed.boards.length) items.push({ separator: true });
    if (listed.boards.length) {
      for (const board of listed.boards) {
        if (board && typeof board.id === 'string') items.push({ label: String(board.name), value: board.id, action: () => pinTo(board.id, args, deps) });
      }
    } else {
      items.push({ label: jt('board.pin.newBoard', 'New board'), action: () => pinToNewBoard(args, deps) });
    }
    const heading = args.heading || jt('board.pin.heading', 'Pin to board');
    menu.show({
      items, heading, ariaLabel: heading, className: 'board-pin-menu',
      anchorEl: args.anchorEl || undefined, anchorX: args.anchorX, anchorY: args.anchorY,
      rootEl: args.rootEl || (args.anchorEl && args.anchorEl.ownerDocument && args.anchorEl.ownerDocument.body) || undefined,
      restoreFocusTo: args.anchorEl || undefined,
    });
    return true;
  }

  return { open, openBoard, refusalText, LAYOUT_STORE_SRC };
});
