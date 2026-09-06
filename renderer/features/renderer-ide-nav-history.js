/* renderer/features/renderer-ide-nav-history.js
 *
 * Bounded cross-file cursor navigation history, always available for the
 * Workspace IDE's Alt+Left / Alt+Right shortcuts. Pure - no DOM, no IPC, no
 * Monaco. The controller feeds it
 * cursor landings through recordNavigation() and walks it with back()/forward();
 * the actual reveal (open-then-position) is delegated to the injected `reveal`
 * callback so all editor plumbing stays in the controller.
 *
 * Model: entries[index] is the current location; entries after `index` are the
 * forward stack. A new jump truncates that forward stack (browser-history
 * semantics). Same-file moves smaller than `minLineDelta` lines are treated as
 * incidental (typing, arrow keys, paging) and coalesced into the current entry
 * rather than recorded - so the stack holds meaningful jumps, not every caret
 * twitch. pruneClosed() drops entries whose file is no longer open so Back never
 * reveals a dead path. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeNavHistory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const DEFAULT_LIMIT = 50;
  // A same-file cursor move below this many lines is incidental (typing /
  // arrow keys / paging) and coalesced; at or above it is a recorded "jump".
  const DEFAULT_MIN_LINE_DELTA = 10;

  function createIdeNavHistory(options) {
    const opts = options || {};
    const reveal = typeof opts.reveal === 'function' ? opts.reveal : () => {};
    const limit = Math.max(1, Number(opts.limit) || DEFAULT_LIMIT);
    const minLineDelta = Math.max(1, Number(opts.minLineDelta) || DEFAULT_MIN_LINE_DELTA);
    const asyncFence = globalRef.rendererAsyncFence
      || (typeof require === 'function' ? require('../shared/async-fence') : {});
    const revealGate = asyncFence.createGenerationGate();

    const entries = [];
    let index = -1;
    // Count pending back()/forward() reveals, so the cursor moves they cause
    // does not record a fresh (stack-corrupting) entry.
    let pendingReveals = 0;

    function current() {
      return index >= 0 && index < entries.length ? entries[index] : null;
    }

    function recordNavigation(path, line, col) {
      if (pendingReveals > 0) {
        return;
      }
      const normalizedPath = String(path || '');
      if (!normalizedPath) {
        return;
      }
      const lineNumber = Math.max(1, Number(line) || 1);
      const column = Math.max(1, Number(col) || 1);
      const top = current();
      // Same file + small delta: coalesce into the current entry (this also
      // de-dupes exact-same-location records) without growing the stack.
      if (top && top.path === normalizedPath && Math.abs(lineNumber - top.line) < minLineDelta) {
        top.line = lineNumber;
        top.col = column;
        return;
      }
      // A new jump truncates the forward stack.
      if (index < entries.length - 1) {
        entries.length = index + 1;
      }
      entries.push({ path: normalizedPath, line: lineNumber, col: column });
      // Bound the stack: drop the oldest entry (keeping the index aligned).
      while (entries.length > limit) {
        entries.shift();
      }
      index = entries.length - 1;
    }

    function applyReveal(entry) {
      if (!entry) {
        return false;
      }
      const revealToken = revealGate.capture();
      pendingReveals += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (revealGate.isCurrent(revealToken)) {
          pendingReveals -= 1;
        }
      };
      try {
        const result = reveal(entry.path, entry.line, entry.col);
        if (result && typeof result.then === 'function') {
          // Async open-then-reveal: keep the guard up across it so the cursor
          // move it triggers is suppressed, not recorded.
          result.then(release, release);
        } else {
          release();
        }
      } catch (_error) {
        // reveal is best-effort; release the guard so back/forward never wedge.
        release();
      }
      return true;
    }

    function back() {
      if (index <= 0) {
        return false;
      }
      index -= 1;
      return applyReveal(current());
    }

    function forward() {
      if (index < 0 || index >= entries.length - 1) {
        return false;
      }
      index += 1;
      return applyReveal(current());
    }

    // Drop entries whose file is no longer open (close / rename) and re-point
    // the index at the surviving current entry, clamping into range otherwise.
    function pruneClosed(openPaths) {
      // Common case (no navigation yet): nothing to prune, skip the Set build -
      // this runs from renderTabs on every open/close/activate.
      if (!entries.length) {
        index = -1;
        return;
      }
      const open = openPaths instanceof Set
        ? openPaths
        : new Set((openPaths || []).map((value) => String(value || '')));
      const currentEntry = current();
      const survivors = entries.filter((entry) => open.has(entry.path));
      entries.splice(0, entries.length, ...survivors);
      if (!entries.length) {
        index = -1;
        return;
      }
      // Re-point at the surviving current entry, else clamp into range. index is
      // >= 0 here (entries is non-empty, and it was >= 0 on entry by invariant).
      const found = currentEntry ? entries.indexOf(currentEntry) : -1;
      index = found !== -1 ? found : Math.min(index, entries.length - 1);
    }

    function clear() {
      entries.length = 0;
      index = -1;
      revealGate.bump();
      pendingReveals = 0;
    }

    return { recordNavigation, back, forward, pruneClosed, clear };
  }

  return { createIdeNavHistory };
});
