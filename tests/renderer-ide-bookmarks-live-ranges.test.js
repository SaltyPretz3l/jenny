'use strict';

/* Bookmarks follow edits (live decoration ranges read back into state), clear()
 * on a workspace root switch, and picker rows built once per open from
 * model.getLineContent. Pure fakes - no Monaco/jsdom. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeBookmarks, BOOKMARK_GLYPH_CLASS } = require('../renderer/features/renderer-ide-bookmarks');

// A host whose models keep the applied bookmark decorations, so a test can
// shift them the way Monaco does when lines are inserted above.
function liveHost() {
  const models = new Map();
  const calls = { setBookmark: [], reveal: [], getValue: 0, getLineContent: 0 };
  let active = 'a.js';
  let cursorLine = 1;
  function modelFor(path) {
    if (!models.has(path)) {
      const model = {
        lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'],
        decorations: [],
        getAllDecorations() { return [...this.decorations, { range: { startLineNumber: 1 }, options: { className: 'other' } }]; },
        getLineContent(line) { calls.getLineContent += 1; return this.lines[line - 1] || ''; },
      };
      models.set(path, model);
    }
    return models.get(path);
  }
  return {
    calls,
    models,
    modelFor,
    setActive(path) { active = path; },
    setCursor(line) { cursorLine = line; },
    shift(path, delta) {
      for (const d of modelFor(path).decorations) {
        d.range = { ...d.range, startLineNumber: d.range.startLineNumber + delta, endLineNumber: d.range.endLineNumber + delta };
      }
    },
    getActivePath: () => active,
    getCursorInfo: () => ({ lineNumber: cursorLine, column: 1 }),
    getModel: (path) => modelFor(path),
    getValue: (path) => { calls.getValue += 1; return modelFor(path).lines.join('\n'); },
    revealPosition(path, line) { calls.reveal.push({ path, line }); return true; },
    setBookmarkDecorations(path, decorations) {
      calls.setBookmark.push({ path, decorations });
      modelFor(path).decorations = decorations.map((d) => ({ range: { ...d.range }, options: { ...d.options } }));
      return decorations.length;
    },
  };
}

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
    emit(type, detail) { if (listeners[type]) { listeners[type]({ detail }); } },
  };
}

function build(pickerOverlayUtils) {
  const host = liveHost();
  const win = fakeWindow();
  const bookmarks = createIdeBookmarks({
    editorHost: host,
    windowRef: win,
    openFile: () => Promise.resolve(true),
    pickerOverlayUtils: pickerOverlayUtils || { createIdePickerOverlay: () => null },
  });
  return { bookmarks, host, win };
}

test('clear() drops every mark and wipes the glyphs of each bookmarked file', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 2);
  bookmarks.toggle('b.js', 3);
  assert.equal(typeof bookmarks.clear, 'function');
  bookmarks.clear();
  assert.deepEqual(bookmarks.listRows(), []);
  const cleared = host.calls.setBookmark.slice(-2);
  assert.deepEqual(cleared.map((c) => c.path).sort(), ['a.js', 'b.js']);
  assert.ok(cleared.every((c) => c.decorations.length === 0), 'glyph decorations removed');
  // The counters reset too: a full new set can be added after a clear.
  assert.equal(bookmarks.toggle('a.js', 2), true);
});

test('marks follow edits: a file switch re-applies the moved lines, not the stale ones', () => {
  const { bookmarks, host, win } = build();
  bookmarks.toggle('a.js', 3);
  host.shift('a.js', 2); // two lines inserted above the mark
  win.emit('ide:active-file-changed', { path: 'a.js' });
  assert.deepEqual(host.calls.setBookmark.at(-1).decorations.map((d) => d.range.startLineNumber), [5]);
  assert.deepEqual(bookmarks.listRows().map((r) => r.line), [5]);
});

test('next/toggle use the live line after an edit moved the mark', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 3);
  host.shift('a.js', 4);
  host.setCursor(1);
  assert.equal(bookmarks.next(), true);
  assert.equal(host.calls.reveal.at(-1).line, 7);
  // Toggling the moved line removes the mark rather than adding a second one.
  assert.equal(bookmarks.toggle('a.js', 7), false);
  assert.deepEqual(bookmarks.listRows(), []);
});

test('collapsed marks (deleted lines) merge without corrupting the total count', () => {
  const { bookmarks, host } = build();
  bookmarks.toggle('a.js', 3);
  bookmarks.toggle('a.js', 4);
  host.modelFor('a.js').decorations[1].range.startLineNumber = 3; // line 4 deleted onto 3
  assert.deepEqual(bookmarks.listRows().map((r) => r.line), [3]);
  assert.equal(bookmarks.toggle('a.js', 3), false);
  assert.deepEqual(bookmarks.listRows(), []);
});

test('picker rows are built once per open and read snippets via getLineContent', () => {
  let captured = null;
  const { bookmarks, host } = build({
    createIdePickerOverlay(opts) { captured = opts; return { open() { return true; }, dispose() {} }; },
  });
  bookmarks.toggle('a.js', 2);
  bookmarks.toggle('b.js', 5);
  bookmarks.openList();
  const first = captured.callbacks.computeMatches('');
  captured.callbacks.computeMatches('l');
  captured.callbacks.computeMatches('l5');
  assert.deepEqual(first.map((r) => r.snippet), ['l2', 'l5']);
  assert.deepEqual(captured.callbacks.computeMatches('l5').map((r) => r.path), ['b.js']);
  assert.equal(host.calls.getValue, 0, 'no full-buffer reads for snippets');
  assert.equal(host.calls.getLineContent, 2, 'one line read per mark per open, not per keystroke');
  bookmarks.openList();
  captured.callbacks.computeMatches('');
  assert.equal(host.calls.getLineContent, 4, 're-opening rebuilds the rows');
});

test('the glyph class constant is the one read back from the model', () => {
  assert.equal(BOOKMARK_GLYPH_CLASS, 'ide-bookmark-glyph');
});
