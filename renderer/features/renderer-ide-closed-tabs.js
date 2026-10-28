/* renderer/features/renderer-ide-closed-tabs.js
 *
 * Bounded LIFO of recently closed file tabs ({ path, viewState, group, pdfView? }) backing the
 * reopen-closed-tab shortcut (Ctrl+Shift+T). Pure - no DOM, no IPC, no Monaco.
 *
 * Entries are dropped when their file is deleted or renamed (dropUnder mirrors
 * the controller's closeTabsUnder so a directory move purges every descendant),
 * so Ctrl+Shift+T never tries to reopen a vanished file. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeClosedTabs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_LIMIT = 10;
  const PDF_ZOOM_KEYWORDS = ['page-width', 'page-fit', 'page-actual', 'auto'];

  // A PDF tab's reopen memory: `{ page, zoom }` with each key kept only when valid.
  function normalizePdfView(value) {
    if (!value || typeof value !== 'object') return null;
    const view = {};
    if (Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 100000) view.page = value.page;
    if (PDF_ZOOM_KEYWORDS.includes(value.zoom)) view.zoom = value.zoom;
    else if (typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 0.25 && value.zoom <= 8) view.zoom = value.zoom;
    return Object.keys(view).length ? view : null;
  }

  function createIdeClosedTabsStack(options) {
    const limit = Math.max(1, Number(options && options.limit) || DEFAULT_LIMIT);
    const stack = [];

    // A path is an exact identity: leading/trailing whitespace is legal in file
    // names, so trim is used only to test for an empty value.
    function dropPath(path) {
      const target = String(path || '');
      if (!target.trim()) {
        return;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].path === target) {
          stack.splice(i, 1);
        }
      }
    }

    function push(entry) {
      const path = String(entry && entry.path || '');
      if (!path.trim()) {
        return;
      }
      // De-dupe: re-closing a path moves it back to the top with its newest
      // view state rather than accumulating stale duplicates.
      dropPath(path);
      const pdfView = normalizePdfView(entry && entry.pdfView);
      stack.push({
        path, viewState: (entry && entry.viewState) || null, group: typeof entry?.group === 'string' ? entry.group : '',
        ...(pdfView ? { pdfView } : {}),
      });
      while (stack.length > limit) {
        stack.shift();
      }
    }

    function pop() {
      return stack.pop() || null;
    }

    // Top entry without removing it (a reopen that can still fail peeks first).
    function peek() {
      return stack.length ? stack[stack.length - 1] : null;
    }

    // The newest entry for an exact path (a rename's own tab under later closes).
    function find(path) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].path === path) return stack[i];
      }
      return null;
    }

    // Drops a path and everything beneath it (directory delete/rename).
    function dropUnder(path) {
      const base = String(path || '');
      if (!base.trim()) {
        return;
      }
      const prefix = `${base}/`;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].path === base || stack[i].path.startsWith(prefix)) {
          stack.splice(i, 1);
        }
      }
    }

    function clear() {
      stack.length = 0;
    }

    return { push, pop, peek, find, dropPath, dropUnder, clear };
  }

  return { createIdeClosedTabsStack, normalizePdfView };
});
