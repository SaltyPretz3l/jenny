/* renderer/features/board/board-tidy-tool.js - the toolbar's Tidy tool (UMD, global rendererBoardTidyTool).
 *
 * "Tidy" arranges the selected group or cards in an even grid; with nothing selected it arranges the whole board. The work is
 * the editor's `tidy()` command (one batch, one Undo step), which asks the pure services/boards/board-tidy.js for the
 * operations. This part only adds the button. The toolbar disables kind tools on a board that cannot be changed.
 *
 * It joins the page through the card kinds seam (board-card-kinds.js) and names no kind: it draws nothing. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererBoardTidyTool = api;
  if (root.rendererBoardCardKinds && typeof root.rendererBoardCardKinds.register === 'function') {
    root.rendererBoardCardKinds.register('tidy', api.createTidyTool);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createTidyTool(ctx) {
    const editor = ctx && ctx.editor;
    if (!editor || typeof editor.tidy !== 'function') return null;
    return {
      tools: [{
        id: 'tidy',
        order: 60,
        label: jt('board.tidy.tool', 'Tidy'),
        title: jt('board.tidy.toolTitle', 'Arrange the selected group or cards in a grid. With nothing selected, the whole board.'),
        run: () => editor.tidy(),
      }],
    };
  }

  return { createTidyTool };
});
