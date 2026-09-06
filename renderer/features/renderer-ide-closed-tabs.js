/* renderer/features/renderer-ide-closed-tabs.js
 *
 * Bounded LIFO of recently closed file tabs ({ path, viewState }) backing the
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

  function createIdeClosedTabsStack(options) {
    const limit = Math.max(1, Number(options && options.limit) || DEFAULT_LIMIT);
    const stack = [];

    function dropPath(path) {
      const target = String(path || '').trim();
      if (!target) {
        return;
      }
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].path === target) {
          stack.splice(i, 1);
        }
      }
    }

    function push(entry) {
      const path = String(entry && entry.path || '').trim();
      if (!path) {
        return;
      }
      // De-dupe: re-closing a path moves it back to the top with its newest
      // view state rather than accumulating stale duplicates.
      dropPath(path);
      stack.push({ path, viewState: (entry && entry.viewState) || null });
      while (stack.length > limit) {
        stack.shift();
      }
    }

    function pop() {
      return stack.pop() || null;
    }

    // Drops a path and everything beneath it (directory delete/rename).
    function dropUnder(path) {
      const base = String(path || '').trim();
      if (!base) {
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

    return { push, pop, dropPath, dropUnder, clear };
  }

  return { createIdeClosedTabsStack };
});
