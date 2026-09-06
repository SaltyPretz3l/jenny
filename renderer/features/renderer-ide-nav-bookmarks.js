/* renderer/features/renderer-ide-nav-bookmarks.js - facade that composes the
 * Workspace IDE's navigation history and bookmarks and threads controller
 * dependencies into both. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeNavBookmarks = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdeNavBookmarks(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const openFile = typeof options.openFile === 'function'
      ? options.openFile
      : () => Promise.resolve(false);
    // The nav-history reveal (open-then-position); the controller backs it with
    // the same handleSearchResultOpen path search results use.
    const reveal = typeof options.reveal === 'function' ? options.reveal : () => {};
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : noop;
    // Injectable for unit tests; default to the resolved sibling modules - the
    // SAME factories the controller used to resolve + call inline.
    const navHistoryUtils = options.navHistoryUtils
      || resolveModule('rendererIdeNavHistory', './renderer-ide-nav-history');
    const bookmarksUtils = options.bookmarksUtils
      || resolveModule('rendererIdeBookmarks', './renderer-ide-bookmarks');

    function activePath() {
      return editorHost?.getActivePath?.() || '';
    }

    // Runtime line bookmarks: glyph toggle + next/prev (wrap) + "list all"
    // Quick-pick. Session-only, pruned on tab close like nav-history;
    // self-paints glyphs and self-subscribes to ide:active-file-changed.
    const bookmarks = bookmarksUtils.createIdeBookmarks?.({
      editorHost, getDom, windowRef, escapeHtml, openFile,
      appendClientLog: (...args) => appendClientLog(...args),
    }) || null;
    // Cross-file Go Back / Go Forward. recordNavigation is fed from the cursor
    // choke point; pruneClosed runs on tab close (both via the facade below).
    const navHistory = navHistoryUtils.createIdeNavHistory?.({ reveal }) || null;

    // Bookmark action thunks shared by the keydown handler + the palette commands.
    const bookmarkActions = {
      toggleBookmark: () => bookmarks?.toggle(activePath(), editorHost?.getCursorInfo()?.lineNumber || 0),
      nextBookmark: () => bookmarks?.next(),
      prevBookmark: () => bookmarks?.prev(),
      listBookmarks: () => bookmarks?.openList(),
    };

    // Central cursor choke point -> nav-history. info is null for non-file tabs
    // (diff/preview), which aren't navigable; nav-history coalesces the rest so
    // only meaningful jumps are recorded.
    function recordCursorNav(info) {
      if (!info) {
        return;
      }
      navHistory?.recordNavigation(activePath(), info.lineNumber, info.column);
    }

    // Glyph-margin click toggles a bookmark on that line of the active file.
    function toggleAtGlyph(line) {
      bookmarks?.toggle(activePath(), line);
    }

    // Drop nav-history entries + bookmarks for files no longer open (close /
    // rename) so Go Back never reveals a dead path and stale glyphs are gone.
    function prune(openPaths) {
      navHistory?.pruneClosed(openPaths);
      bookmarks?.pruneClosed(openPaths);
    }

    function back() {
      return navHistory?.back();
    }

    function forward() {
      return navHistory?.forward();
    }

    function resetForRoot() {
      navHistory?.clear?.();
      bookmarks?.clear?.();
    }

    function dispose() {
      // nav-history is pure (no listeners) and is GC'd with the controller;
      // only bookmarks holds the ide:active-file-changed subscription + picker.
      bookmarks?.dispose();
    }

    return {
      recordCursorNav,
      toggleAtGlyph,
      prune,
      back,
      forward,
      resetForRoot,
      bookmarkActions,
      dispose,
    };
  }

  return {
    createIdeNavBookmarks,
  };
});
