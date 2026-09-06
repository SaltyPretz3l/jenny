'use strict';

/* Unit tests for the Workspace IDE cursor-navigation glue facade
 * (renderer-ide-nav-bookmarks). This module owns NO feature logic - it
 * instantiates renderer-ide-nav-history + renderer-ide-bookmarks and threads
 * them into the controller's call sites behind one object. So these tests assert
 * the THREADING: recordCursorNav -> nav-history (with the active path + the null
 * drop), toggleAtGlyph/bookmarkActions -> bookmarks (with the active path +
 * cursor line), prune -> BOTH, back/forward -> nav-history, dispose -> bookmarks
 * only, and that the two underlying factories receive the wired deps. The
 * underlying modules are stubbed (their own behavior is covered by their own
 * suites); a final case resolves the REAL siblings to exercise the require path
 * and the null-instance no-ops. Pure module - no jsdom/Monaco. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeNavBookmarks } = require('../renderer/features/renderer-ide-nav-bookmarks');

// A fake editor host exposing only what the facade reads: the active path and
// the cursor line. setBookmarkDecorations/revealPosition/getValue are present so
// the REAL bookmarks module works in the resolution test below.
function fakeHost(overrides) {
  let active = 'a.js';
  let cursorLine = 1;
  return {
    setActive(path) { active = String(path || ''); },
    setCursor(line) { cursorLine = line; },
    getActivePath: () => active,
    getCursorInfo: () => ({ lineNumber: cursorLine, column: 1 }),
    getValue: () => '',
    revealPosition() { return true; },
    setBookmarkDecorations() { return 0; },
    ...overrides,
  };
}

// Records every call the facade forwards, so a test can assert the lane + args.
function captureStubs() {
  const calls = {
    record: [], pruneNav: [], pruneMarks: [], back: 0, forward: 0,
    toggle: [], next: 0, prev: 0, openList: 0, dispose: 0, clearNav: 0, clearMarks: 0,
    navInit: [], bookmarksInit: [],
  };
  const navHistoryUtils = {
    createIdeNavHistory(opts) {
      calls.navInit.push(opts);
      return {
        recordNavigation: (path, line, col) => calls.record.push({ path, line, col }),
        pruneClosed: (paths) => calls.pruneNav.push(paths),
        back: () => { calls.back += 1; return 'back'; },
        forward: () => { calls.forward += 1; return 'forward'; },
        clear: () => { calls.clearNav += 1; },
      };
    },
  };
  const bookmarksUtils = {
    createIdeBookmarks(opts) {
      calls.bookmarksInit.push(opts);
      return {
        toggle: (path, line) => { calls.toggle.push({ path, line }); return true; },
        next: () => { calls.next += 1; return true; },
        prev: () => { calls.prev += 1; return true; },
        openList: () => { calls.openList += 1; return true; },
        pruneClosed: (paths) => calls.pruneMarks.push(paths),
        clear: () => { calls.clearMarks += 1; },
        dispose: () => { calls.dispose += 1; },
      };
    },
  };
  return { calls, navHistoryUtils, bookmarksUtils };
}

function build(overrides) {
  const stubs = captureStubs();
  const host = (overrides && overrides.editorHost) || fakeHost();
  const reveals = [];
  const facade = createIdeNavBookmarks({
    editorHost: host,
    reveal: (path, line, col) => { reveals.push({ path, line, col }); },
    navHistoryUtils: stubs.navHistoryUtils,
    bookmarksUtils: stubs.bookmarksUtils,
    ...overrides,
  });
  return { facade, calls: stubs.calls, host, reveals };
}

// ── threading: cursor choke point -> nav-history ──────────────────────────────

test('recordCursorNav forwards the active path + line/col to nav-history', () => {
  const { facade, calls, host } = build();
  host.setActive('src/x.js');
  facade.recordCursorNav({ lineNumber: 42, column: 7 });
  assert.deepEqual(calls.record, [{ path: 'src/x.js', line: 42, col: 7 }]);
});

test('recordCursorNav drops a null info (non-file diff/preview tab)', () => {
  const { facade, calls } = build();
  facade.recordCursorNav(null);
  facade.recordCursorNav(undefined);
  assert.deepEqual(calls.record, [], 'no record for a null cursor info');
});

// ── threading: glyph click + bookmark thunks -> bookmarks ─────────────────────

test('toggleAtGlyph toggles a bookmark on the clicked line of the active file', () => {
  const { facade, calls, host } = build();
  host.setActive('b.js');
  facade.toggleAtGlyph(9);
  assert.deepEqual(calls.toggle, [{ path: 'b.js', line: 9 }]);
});

test('bookmarkActions.toggleBookmark uses the active path + the cursor line', () => {
  const { facade, calls, host } = build();
  host.setActive('c.js');
  host.setCursor(15);
  facade.bookmarkActions.toggleBookmark();
  assert.deepEqual(calls.toggle, [{ path: 'c.js', line: 15 }]);
});

test('bookmarkActions next/prev/list delegate to the bookmarks instance', () => {
  const { facade, calls } = build();
  facade.bookmarkActions.nextBookmark();
  facade.bookmarkActions.prevBookmark();
  facade.bookmarkActions.listBookmarks();
  assert.deepEqual([calls.next, calls.prev, calls.openList], [1, 1, 1]);
});

// ── threading: prune fans out to BOTH ─────────────────────────────────────────

test('prune drops closed paths from nav-history AND bookmarks with the same list', () => {
  const { facade, calls } = build();
  const open = ['a.js', 'b.js'];
  facade.prune(open);
  assert.deepEqual(calls.pruneNav, [open], 'nav-history pruned');
  assert.deepEqual(calls.pruneMarks, [open], 'bookmarks pruned');
});

// ── threading: back/forward + dispose ─────────────────────────────────────────

test('back/forward delegate to nav-history and pass its return value through', () => {
  const { facade, calls } = build();
  assert.equal(facade.back(), 'back');
  assert.equal(facade.forward(), 'forward');
  assert.deepEqual([calls.back, calls.forward], [1, 1]);
});

test('root reset clears both navigation history and bookmarks', () => {
  const { facade, calls } = build();
  facade.resetForRoot();
  assert.deepEqual([calls.clearNav, calls.clearMarks], [1, 1]);
});

test('dispose disposes the bookmarks instance (nav-history is pure, nothing to dispose)', () => {
  const { facade, calls } = build();
  facade.dispose();
  assert.equal(calls.dispose, 1);
});

// ── the underlying factories receive the wired deps ───────────────────────────

test('the two feature modules are constructed with the controller deps', () => {
  const host = fakeHost();
  const openFile = () => Promise.resolve(true);
  const reveal = () => {};
  const { calls } = (() => {
    const stubs = captureStubs();
    createIdeNavBookmarks({
      editorHost: host, getDom: () => ({}), windowRef: {}, escapeHtml: (v) => v,
      openFile, reveal,
      navHistoryUtils: stubs.navHistoryUtils,
      bookmarksUtils: stubs.bookmarksUtils,
    });
    return stubs;
  })();

  assert.equal(calls.navInit.length, 1, 'nav-history created once');
  assert.equal(calls.navInit[0].reveal, reveal, 'nav-history gets the reveal callback');
  assert.equal(calls.bookmarksInit.length, 1, 'bookmarks created once');
  assert.equal(calls.bookmarksInit[0].editorHost, host, 'bookmarks gets the editor host');
  assert.equal(calls.bookmarksInit[0].openFile, openFile, 'bookmarks gets openFile');
});

test('the facade exposes exactly the documented surface', () => {
  const { facade } = build();
  assert.deepEqual(
    Object.keys(facade).sort(),
    ['back', 'bookmarkActions', 'dispose', 'forward', 'prune', 'recordCursorNav', 'resetForRoot', 'toggleAtGlyph']
  );
});

// ── real sibling resolution + null-instance no-ops ────────────────────────────

test('resolves the real nav-history/bookmarks siblings via require and stays threaded', () => {
  // No *Utils injection -> the module require()s the real siblings. Go Back on a
  // fresh (empty) history is a no-op (false); a glyph toggle then back jump round
  // -trips through the real bookmarks instance without throwing.
  const host = fakeHost();
  const facade = createIdeNavBookmarks({
    editorHost: host,
    windowRef: {},
    reveal: () => {},
  });
  assert.equal(facade.back(), false, 'empty real nav-history: Back is a no-op');
  assert.equal(facade.forward(), false, 'empty real nav-history: Forward is a no-op');
  facade.recordCursorNav({ lineNumber: 5, column: 1 });
  facade.recordCursorNav({ lineNumber: 80, column: 1 });
  assert.equal(facade.back(), true, 'a recorded jump is walkable');
  assert.doesNotThrow(() => facade.toggleAtGlyph(3), 'real bookmark toggle works');
  assert.doesNotThrow(() => facade.prune(['a.js']));
  assert.doesNotThrow(() => facade.resetForRoot());
  assert.doesNotThrow(() => facade.dispose());
});

test('degrades to no-ops when the underlying factories are absent', () => {
  // Empty module objects -> createIde*?. returns undefined -> null instances ->
  // every facade method is a guarded no-op (the controller |.| null contract).
  const facade = createIdeNavBookmarks({
    editorHost: fakeHost(),
    navHistoryUtils: {},
    bookmarksUtils: {},
  });
  assert.equal(facade.back(), undefined);
  assert.equal(facade.forward(), undefined);
  assert.doesNotThrow(() => facade.recordCursorNav({ lineNumber: 1, column: 1 }));
  assert.doesNotThrow(() => facade.toggleAtGlyph(2));
  assert.doesNotThrow(() => facade.prune(['a.js']));
  assert.doesNotThrow(() => facade.resetForRoot());
  assert.doesNotThrow(() => facade.bookmarkActions.toggleBookmark());
  assert.doesNotThrow(() => facade.bookmarkActions.nextBookmark());
  assert.doesNotThrow(() => facade.dispose());
});

test('activePath is empty when no editor host is wired', () => {
  const { facade, calls } = (() => {
    const stubs = captureStubs();
    const f = createIdeNavBookmarks({
      navHistoryUtils: stubs.navHistoryUtils,
      bookmarksUtils: stubs.bookmarksUtils,
    });
    return { facade: f, calls: stubs.calls };
  })();
  facade.recordCursorNav({ lineNumber: 3, column: 1 });
  assert.deepEqual(calls.record, [{ path: '', line: 3, col: 1 }], 'no host -> empty path');
});
