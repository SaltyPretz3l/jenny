/* renderer/features/board/board-ask-tool.js - "Ask Jenny" on the Board's toolbar (UMD, global rendererBoardAskTool),
 * row 150 slice C5.
 *
 * A helper part of the card kinds seam (board-card-kinds.js): it names no card kind and draws nothing. Its one tool,
 * `ask` (order 70), opens the chat docked beside the board and puts the caret in its composer, so the person can
 * type a question about the cards they selected. It changes nothing about what is sent: the selection is already
 * reported to the main process (board-selection-report.js), and the next turn from this chat carries those cards
 * whole. With no card selected it tells the person to select some and opens nothing.
 * The page provides the hook as context.openChat(), which answers false when the chat dock could not be built. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rendererBoardAskTool = api;
  if (root && root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('ask', api.createAskPart);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ASK_ORDER = 70;

  function createAskPart(ctx) {
    const editor = ctx && ctx.editor;
    if (!editor || typeof editor.getSelection !== 'function') return null;

    function tell(message) {
      try { if (typeof ctx.notify === 'function') ctx.notify(message, { tone: 'info' }); } catch (_error) { /* a toast must not break the tool */ }
    }

    function run() {
      const board = typeof editor.getBoard === 'function' ? editor.getBoard() : null;
      const cards = (board && board.cards) || {};
      const selected = editor.getSelection().filter((id) => Object.prototype.hasOwnProperty.call(cards, id));
      if (!selected.length) { tell(jt('board.ask.none', 'Select one or more cards first')); return; }
      const hook = ctx.context && ctx.context.openChat;
      if ((typeof hook === 'function' ? hook() : false) === false) tell(jt('board.ask.noChat', 'The chat is not available here.'));
    }

    return {
      tools: [{ id: 'ask', label: jt('board.toolbar.ask', 'Ask Jenny'), title: jt('board.toolbar.askTitle', 'Ask Jenny about the selected cards'), order: ASK_ORDER, run }],
    };
  }

  return { createAskPart, ASK_ORDER };
});
