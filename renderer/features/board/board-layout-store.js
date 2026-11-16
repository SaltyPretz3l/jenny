/* renderer/features/board/board-layout-store.js - what the Board page remembers (UMD).
 *
 * Two small records in localStorage, read when the page opens and written when they change:
 *   the column layout, a workbench tree that is read back through the layout model with
 *   `normalizeLayout(value, 'board')`, so a stored tree can never gain a Workspace view, and
 *   the open board of each project, so a restart lands where the person left.
 * A third small record keeps the chosen view of each project, `canvas` or `outline` (row 150, slice B5).
 * They are separate from the Workspace's saved layout (`workspaceIde`), which this file never touches.
 * Every access is guarded: no storage, a full one or a damaged value reads as "nothing saved". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardLayoutStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LAYOUT_KEY = 'jenny.board.layout.v1';
  const OPEN_KEY = 'jenny.board.open.v1';
  const VIEW_KEY = 'jenny.board.view.v1';
  const VIEWS = Object.freeze(['canvas', 'outline']);
  const MAX_PROJECTS = 100;

  function createLayoutStore({ storage, model }) {
    function read(key) {
      try { return JSON.parse(storage.getItem(key)); } catch (_error) { return null; }
    }
    function write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); } catch (_error) { /* a full or blocked store only costs the memory */ }
    }

    function loadLayout() {
      const saved = read(LAYOUT_KEY);
      const layout = saved && typeof saved === 'object' ? model.normalizeLayout(saved, 'board') : null;
      return layout || model.createDefaultLayout('board');
    }
    function saveLayout(layout) {
      write(LAYOUT_KEY, layout);
    }

    function readOpen() {
      const map = read(OPEN_KEY);
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }
    function openBoardOf(projectId) {
      const id = readOpen()[projectId];
      return typeof id === 'string' ? id : '';
    }
    function saveOpenBoard(projectId, boardId) {
      const map = readOpen();
      delete map[projectId];
      if (boardId) map[projectId] = boardId;
      Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - MAX_PROJECTS)).forEach((key) => { delete map[key]; });
      write(OPEN_KEY, map);
    }

    function viewOf(projectId) {
      const map = read(VIEW_KEY);
      const view = map && typeof map === 'object' && !Array.isArray(map) ? map[projectId] : null;
      return VIEWS.includes(view) ? view : 'canvas';
    }
    function saveView(projectId, view) {
      if (!VIEWS.includes(view) || !projectId) return;
      const saved = read(VIEW_KEY);
      const map = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      delete map[projectId];
      map[projectId] = view;
      Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - MAX_PROJECTS)).forEach((key) => { delete map[key]; });
      write(VIEW_KEY, map);
    }

    return { loadLayout, saveLayout, openBoardOf, saveOpenBoard, viewOf, saveView };
  }

  return { createLayoutStore, LAYOUT_KEY, OPEN_KEY, VIEW_KEY };
});
