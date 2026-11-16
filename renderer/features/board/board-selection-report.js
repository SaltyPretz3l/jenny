/* renderer/features/board/board-selection-report.js - tells the main process which cards are selected (UMD, global
 * rendererBoardSelectionReport).
 *
 * A turn sent from the chat docked beside the board shows the selected cards first and whole (plan
 * PROJECT_BOARD_2026-11-13 section 7.2). The main process writes that text from the stored board, so it has to
 * know the selection. This part reports it through the board source: card ids only, a moment after the selection
 * settles, and an empty list when the page goes away. Nothing else leaves the page, and a turn sent from anywhere
 * else never reads it.
 *
 * It joins the page through the card kinds seam (board-card-kinds.js) and names no kind: it draws nothing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererBoardSelectionReport = api;
  if (root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('selection-report', api.createSelectionReport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SETTLE_MS = 120;

  function createSelectionReport(ctx) {
    const editor = ctx && ctx.editor;
    const source = ctx && ctx.source;
    const windowRef = ctx && ctx.windowRef;
    if (!editor || !source || typeof source.setSelection !== 'function' || !windowRef) return null;
    let timer = 0;
    let sent = ''; // `${boardId}|${ids}` of the last report
    let sentBoard = '';

    function send(boardId, ids) {
      const key = `${boardId}|${ids.join(',')}`;
      if (!boardId || key === sent) return;
      sent = key;
      sentBoard = boardId;
      try { Promise.resolve(source.setSelection({ boardId, ids })).catch(() => {}); } catch (_error) { /* the next change reports again */ }
    }

    function report() {
      timer = 0;
      const board = editor.getBoard();
      const boardId = board && typeof board.id === 'string' ? board.id : '';
      // Leaving a board clears what was reported for it.
      if (sentBoard && sentBoard !== boardId) send(sentBoard, []);
      const cards = (board && board.cards) || {};
      const ids = editor.getSelection().filter((id) => cards[id]);
      // A board nothing was ever selected on has nothing to report.
      if (ids.length || sentBoard === boardId) send(boardId, ids);
    }

    const off = editor.onChange(() => {
      if (!timer) timer = windowRef.setTimeout(report, SETTLE_MS);
    });

    return {
      dispose() {
        if (typeof off === 'function') off();
        if (timer) windowRef.clearTimeout(timer);
        timer = 0;
        if (sentBoard) send(sentBoard, []);
      },
    };
  }

  return { createSelectionReport, SETTLE_MS };
});
