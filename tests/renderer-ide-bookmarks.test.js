'use strict';

/* Unit tests for the Workspace IDE runtime line bookmarks
 * (renderer-ide-bookmarks): toggle add/remove + glyph decoration application,
 * next/prev ordering with wrap-around, the Quick-pick row data (file/line/
 * snippet) and its filter, pruneClosed dropping closed paths, the
 * active-file-changed re-paint, and - critically - that bookmark decorations go
 * through the SEPARATE bookmark decoration path (setBookmarkDecorations), never
 * the git change-bars (setGutterDecorations). Pure module - no Monaco/jsdom. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeBookmarks,
  basenameOf,
  MAX_MARKS_PER_FILE,
  MAX_MARKS_TOTAL,
} = require('../renderer/features/renderer-ide-bookmarks');

// Records every decoration/reveal call so a test can assert which lane was
// painted and where a jump landed. Cursor + active path + per-file values are
// settable so next/prev and the snippet read are deterministic.
function fakeHost(overrides) {
  const calls = { setBookmark: [], setGutter: [], reveal: [], focus: 0 };
  let active = 'a.js';
  let cursorLine = 1;
  const values = {};
  return {
    calls,
    setActive(path) { active = String(path || ''); },
    setCursor(line) { cursorLine = line; },
    setValue(path, value) { values[path] = value; },
    getActivePath: () => active,
    getCursorInfo: () => ({ lineNumber: cursorLine, column: 1 }),
    getValue: (path) => values[path] || '',
    revealPosition(path, line, col) { calls.reveal.push({ path, line, col }); return true; },
    setBookmarkDecorations(path, decorations) { calls.setBookmark.push({ path, decorations }); return decorations.length; },
    setGutterDecorations(path, decorations) { calls.setGutter.push({ path, decorations }); return decorations.length; },
    focus() { calls.focus += 1; },
    ...overrides,
  };
}

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
    emit(type, detail) { if (listeners[type]) { listeners[type]({ detail }); } },
    listeners,
  };
}

// A bookmarks instance with the picker stubbed out (no overlay needed for the
// pure-state tests). openFile + window are injectable for the cross-file tests.
function build(overrides) {
  const host = (overrides && overrides.host) || fakeHost();
  const openCalls = [];
  const win = (overrides && overrides.windowRef) || fakeWindow();
  const bookmarks = createIdeBookmarks({
    editorHost: host,
    windowRef: win,
    openFile: (path) => { openCalls.push(path); return Promise.resolve(true); },
    pickerOverlayUtils: (overrides && overrides.pickerOverlayUtils) || { createIdePickerOverlay: () => null },
    ...overrides,
  });
  return { bookmarks, host, openCalls, win };
}

// ── toggle + decoration lane ──────────────────────────────────────────────────

test('toggle adds then removes a bookmark and reports added/removed', () => {
  const { bookmarks, host } = build();
  assert.equal(bookmarks.toggle('a.js', 5), true, 'first toggle adds');
  assert.deepEqual(host.calls.setBookmark.at(-1).decorations.map((d) => d.range.startLineNumber), [5]);

  assert.equal(bookmarks.toggle('a.js', 5), false, 'second toggle on the same line removes');
  assert.deepEqual(host.calls.setBookmark.at(-1).decorations, [], 'gutter clears when the last mark goes');
});

test('toggle paints the bookmark lane, never the git change-bars lane', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 3);

  assert.equal(host.calls.setGutter.length, 0, 'must NOT touch setGutterDecorations (change-bars)');
  assert.equal(host.calls.setBookmark.length, 1, 'bookmark decorations go through setBookmarkDecorations');
  const decoration = host.calls.setBookmark[0].decorations[0];
  assert.equal(decoration.options.glyphMarginClassName, 'ide-bookmark-glyph');
  assert.equal(decoration.options.description, 'jenny-bookmark');
});

test('toggle keeps multiple marks per file sorted in the decoration set', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 12);
  bookmarks.toggle('a.js', 2);
  bookmarks.toggle('a.js', 7);
  assert.deepEqual(host.calls.setBookmark.at(-1).decorations.map((d) => d.range.startLineNumber), [2, 7, 12]);
});

test('toggle rejects a missing path or non-positive line without painting', () => {
  const { bookmarks, host } = build();
  assert.equal(bookmarks.toggle('', 5), false);
  assert.equal(bookmarks.toggle('a.js', 0), false);
  assert.equal(bookmarks.toggle('a.js', -3), false);
  assert.equal(host.calls.setBookmark.length, 0, 'no decoration call for a rejected toggle');
});

// ── caps: reject (never evict) at the per-file / total ceiling ───────────────

test('per-file cap rejects the next add, does not grow decorations, and listRows stays at the cap', () => {
  const { bookmarks, host } = build();
  for (let line = 1; line <= MAX_MARKS_PER_FILE; line += 1) {
    assert.equal(bookmarks.toggle('a.js', line), true, `add #${line} should succeed under the cap`);
  }
  const decorationCallsAtCap = host.calls.setBookmark.length;

  assert.equal(bookmarks.toggle('a.js', MAX_MARKS_PER_FILE + 1), false, 'add beyond the per-file cap is rejected');
  assert.equal(host.calls.setBookmark.length, decorationCallsAtCap, 'rejected add must not repaint the gutter');
  assert.equal(bookmarks.listRows().filter((r) => r.path === 'a.js').length, MAX_MARKS_PER_FILE);
});

test('removing an existing mark at the per-file cap still works (cap blocks adds, never removes)', () => {
  const { bookmarks } = build();
  for (let line = 1; line <= MAX_MARKS_PER_FILE; line += 1) {
    bookmarks.toggle('a.js', line);
  }
  assert.equal(bookmarks.toggle('a.js', 1), false, 'removing an existing mark reports removed');
  assert.equal(bookmarks.listRows().filter((r) => r.path === 'a.js').length, MAX_MARKS_PER_FILE - 1);
});

test('total cap rejects an add in a fresh, under-cap file once MAX_MARKS_TOTAL is reached', () => {
  const { bookmarks } = build();
  let line = 1;
  let fileIndex = 0;
  let added = 0;
  // Spread marks across many files, each staying comfortably under its own
  // per-file cap, to isolate the total-cap branch from the per-file branch.
  while (added < MAX_MARKS_TOTAL) {
    const path = `file${fileIndex}.js`;
    const perFile = Math.min(MAX_MARKS_PER_FILE - 1, MAX_MARKS_TOTAL - added);
    for (let i = 0; i < perFile; i += 1) {
      assert.equal(bookmarks.toggle(path, line + i), true);
      added += 1;
    }
    fileIndex += 1;
    line += perFile;
  }

  assert.equal(added, MAX_MARKS_TOTAL);
  assert.equal(bookmarks.toggle('brand-new-file.js', 1), false, 'total cap rejects add in a fresh file');
  assert.deepEqual(bookmarks.listRows().filter((r) => r.path === 'brand-new-file.js'), []);
});

test('a rejected add logs ide.bookmark_limit_reached WARN; a plain remove logs nothing', () => {
  const logs = [];
  const { bookmarks } = build({
    appendClientLog: (level, code, extra) => logs.push({ level, code, extra }),
  });
  for (let line = 1; line <= MAX_MARKS_PER_FILE; line += 1) {
    bookmarks.toggle('a.js', line);
  }
  logs.length = 0; // only care about what happens from here

  assert.equal(bookmarks.toggle('a.js', MAX_MARKS_PER_FILE + 1), false);
  assert.equal(logs.length, 1, 'rejected add fires exactly one WARN log');
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].code, 'ide.bookmark_limit_reached');
  assert.equal(logs[0].extra.cap, 'per_file');
  assert.equal(logs[0].extra.path, 'a.js');
  assert.equal(logs[0].extra.line, MAX_MARKS_PER_FILE + 1);

  logs.length = 0;
  assert.equal(bookmarks.toggle('a.js', 1), false, 'plain remove of an existing mark');
  assert.equal(logs.length, 0, 'a plain remove fires no limit-reached log');
});

test('listRows at the total cap returns exactly MAX_MARKS_TOTAL rows; a rejected toggle after leaves it unchanged', () => {
  const { bookmarks } = build();
  let added = 0;
  let fileIndex = 0;
  while (added < MAX_MARKS_TOTAL) {
    const path = `f${fileIndex}.js`;
    const perFile = Math.min(MAX_MARKS_PER_FILE - 1, MAX_MARKS_TOTAL - added);
    for (let i = 1; i <= perFile; i += 1) {
      bookmarks.toggle(path, i);
      added += 1;
    }
    fileIndex += 1;
  }

  const rowsAtCap = bookmarks.listRows();
  assert.equal(rowsAtCap.length, MAX_MARKS_TOTAL);
  const sorted = [...rowsAtCap].sort((a, b) => a.basename.localeCompare(b.basename) || a.line - b.line);
  assert.deepEqual(rowsAtCap.map((r) => `${r.basename}:${r.line}`), sorted.map((r) => `${r.basename}:${r.line}`), 'listRows is sorted');

  assert.equal(bookmarks.toggle('fresh-overflow.js', 1), false);
  const rowsAfterReject = bookmarks.listRows();
  assert.equal(rowsAfterReject.length, MAX_MARKS_TOTAL, 'row count unchanged after a rejected toggle');
  assert.deepEqual(rowsAfterReject.map((r) => `${r.basename}:${r.line}`), rowsAtCap.map((r) => `${r.basename}:${r.line}`), 'row contents unchanged');
});

// ── next / prev with wrap-around ──────────────────────────────────────────────

test('next jumps to the first bookmark after the caret, wrapping at the end', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 3);
  bookmarks.toggle('a.js', 7);
  bookmarks.toggle('a.js', 12);

  host.setCursor(5);
  assert.equal(bookmarks.next(), true);
  assert.equal(host.calls.reveal.at(-1).line, 7);

  host.setCursor(12); // on the last mark -> wrap to the first
  assert.equal(bookmarks.next(), true);
  assert.equal(host.calls.reveal.at(-1).line, 3);

  host.setCursor(1); // before all marks
  bookmarks.next();
  assert.equal(host.calls.reveal.at(-1).line, 3);
});

test('prev jumps to the last bookmark before the caret, wrapping at the start', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 3);
  bookmarks.toggle('a.js', 7);
  bookmarks.toggle('a.js', 12);

  host.setCursor(8);
  assert.equal(bookmarks.prev(), true);
  assert.equal(host.calls.reveal.at(-1).line, 7);

  host.setCursor(3); // on the first mark -> wrap to the last
  assert.equal(bookmarks.prev(), true);
  assert.equal(host.calls.reveal.at(-1).line, 12);
});

test('next/prev are no-ops with no bookmarks in the active file', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 4);
  host.setActive('b.js'); // different file, no marks
  assert.equal(bookmarks.next(), false);
  assert.equal(bookmarks.prev(), false);
  assert.equal(host.calls.reveal.length, 0, 'no reveal without a target');
});

// ── Quick-pick row data ───────────────────────────────────────────────────────

test('listRows yields file basename + line + trimmed snippet, sorted', () => {
  const { bookmarks, host } = build();
  host.setValue('src/alpha.js', 'line one\n  const x = 1;  \nthird');
  host.setValue('zeta.js', 'only line');
  bookmarks.toggle('src/alpha.js', 2);
  bookmarks.toggle('zeta.js', 1);
  bookmarks.toggle('src/alpha.js', 3);

  const rows = bookmarks.listRows();
  assert.deepEqual(rows.map((r) => `${r.basename}:${r.line}`), ['alpha.js:2', 'alpha.js:3', 'zeta.js:1']);
  const alphaLine2 = rows.find((r) => r.basename === 'alpha.js' && r.line === 2);
  assert.equal(alphaLine2.snippet, 'const x = 1;', 'snippet is the trimmed line text');
  assert.equal(alphaLine2.path, 'src/alpha.js', 'row carries the full path for the jump');
});

test('the picker is wired with the bookmark rows, filter, and jump-on-select', async () => {
  let captured = null;
  const pickerOverlayUtils = {
    createIdePickerOverlay(opts) {
      captured = opts;
      return { open() { captured.opened = true; return true; }, dispose() {} };
    },
  };
  const { bookmarks, host, openCalls } = build({ pickerOverlayUtils });
  host.setValue('a.js', 'alpha\nbeta\ngamma');
  host.setValue('b.js', 'delta');
  bookmarks.toggle('a.js', 2);
  bookmarks.toggle('b.js', 1);

  assert.equal(bookmarks.openList(), true);
  assert.equal(captured.opened, true, 'openList opens the shared picker overlay');

  const { callbacks } = captured;
  assert.equal(callbacks.computeMatches('').length, 2, 'empty query returns every bookmark');
  assert.deepEqual(callbacks.computeMatches('delta').map((r) => r.basename), ['b.js'], 'filters by snippet text');

  const markup = callbacks.buildRowMarkup({ path: 'a.js', line: 2, basename: 'a.js', snippet: 'beta' }, 0, true);
  assert.match(markup, /data-ide-bookmark-path="a\.js"/);
  assert.match(markup, /data-ide-bookmark-line="2"/);
  assert.match(markup, /ide-picker-row--selected/);
  assert.doesNotMatch(markup, /<button|<input/i, 'rows carry no raw control primitives');

  let closed = false;
  callbacks.onRowClick({ dataset: { ideBookmarkPath: 'b.js', ideBookmarkLine: '1' } }, { close: () => { closed = true; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closed, true, 'selecting a row closes the picker');
  assert.deepEqual(openCalls, ['b.js'], 'the file opens before the reveal');
  assert.deepEqual(host.calls.reveal.at(-1), { path: 'b.js', line: 1, col: 1 });
});

// ── pruneClosed + active-file re-paint ────────────────────────────────────────

test('pruneClosed drops bookmarks for files no longer open', () => {
  const { bookmarks, host } = build();
  host.setValue('a.js', 'a');
  host.setValue('b.js', 'b');
  bookmarks.toggle('a.js', 1);
  bookmarks.toggle('b.js', 1);

  bookmarks.pruneClosed(['a.js']);
  assert.deepEqual(bookmarks.listRows().map((r) => r.basename), ['a.js'], 'b.js bookmarks pruned');

  bookmarks.pruneClosed(new Set()); // accepts a Set too
  assert.deepEqual(bookmarks.listRows(), [], 'all pruned when nothing is open');
});

test('an ide:active-file-changed event re-paints the now-active file glyphs', () => {
  const win = fakeWindow();
  const { bookmarks, host } = build({ windowRef: win });
  bookmarks.toggle('a.js', 4);
  const beforeCount = host.calls.setBookmark.length;

  win.emit('ide:active-file-changed', { path: 'a.js' });
  assert.equal(host.calls.setBookmark.length, beforeCount + 1, 're-applies on file switch');
  assert.deepEqual(host.calls.setBookmark.at(-1).decorations.map((d) => d.range.startLineNumber), [4]);

  bookmarks.dispose();
  win.emit('ide:active-file-changed', { path: 'a.js' });
  assert.equal(host.calls.setBookmark.length, beforeCount + 1, 'no re-paint after dispose');
});

test('basenameOf handles both separators', () => {
  assert.equal(basenameOf('src\\nested\\file.ts'), 'file.ts');
  assert.equal(basenameOf('plain.js'), 'plain.js');
});

test('the factory exposes the documented surface', () => {
  const { bookmarks } = build();
  assert.deepEqual(
    Object.keys(bookmarks).sort(),
    ['applyDecorations', 'dispose', 'listRows', 'next', 'openList', 'prev', 'pruneClosed', 'toggle']
  );
});
