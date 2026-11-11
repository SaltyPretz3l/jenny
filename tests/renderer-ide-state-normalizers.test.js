'use strict';

/* The pure value normalizers split out of renderer-ide-state.js: editor preference clamps and
 * whitelists, the workspace-relative path gate, and the replace-journal / search-history
 * sanitizers. renderer-ide-state.js re-exports these names, so one identity check pins that. */

const test = require('node:test');
const assert = require('node:assert/strict');

const normalizers = require('../renderer/features/renderer-ide-state-normalizers');
const ideState = require('../renderer/features/renderer-ide-state');

test('renderer-ide-state re-exports the normalizers it split out', () => {
  for (const name of ['normalizeEditorFontSize', 'normalizeFontFamily', 'normalizeRulers', 'normalizeIdeRelativePath',
    'normalizePreviewSourcePath', 'normalizeEditorPrefs']) {
    assert.equal(ideState[name], normalizers[name], name);
  }
});

test('normalizeIdeRelativePath keeps workspace-relative POSIX paths only', () => {
  assert.equal(normalizers.normalizeIdeRelativePath('src\\a//b/./c.js'), 'src/a/b/c.js');
  for (const bad of ['', '/abs', 'C:/x', '../x', 'a/../b', 'a\0b', undefined]) {
    assert.equal(normalizers.normalizeIdeRelativePath(bad), '', String(bad));
  }
  assert.equal(normalizers.normalizePreviewSourcePath('preview://a.md'), '');
  assert.equal(normalizers.normalizePreviewSourcePath('docs/a.md'), 'docs/a.md');
  assert.equal(normalizers.normalizePreviewSourcePath(7), '');
});

test('editor preferences clamp, whitelist and migrate the legacy auto-save boolean', () => {
  const prefs = normalizers.normalizeEditorPrefs({
    fontSize: 13, tabSize: 3, lineNumbers: 'nope', autoSaveEnabled: true, terminalScrollback: 1e9,
    fontFamily: 'bad;font', rulers: [80, '120', 80, -1, 9999],
  });
  assert.equal(prefs.fontSize, 0, 'the legacy 13 reads as Match text size');
  assert.equal(prefs.tabSize, normalizers.TAB_SIZE_DEFAULT);
  assert.equal(prefs.lineNumbers, 'on');
  assert.equal(prefs.autoSaveMode, 'afterDelay');
  assert.equal(prefs.autoSaveEnabled, true);
  assert.equal(prefs.terminalScrollback, normalizers.TERMINAL_SCROLLBACK_MAX);
  assert.equal(prefs.fontFamily, '');
  assert.deepEqual(prefs.rulers, [80, 120]);
  assert.equal(normalizers.normalizeEditorPrefs({ autoSaveMode: 'off', autoSaveEnabled: true }).autoSaveEnabled, false);
});

test('replace journal and search history sanitizers bound what they keep', () => {
  assert.equal(normalizers.normalizeReplaceJournal(undefined), null);
  assert.equal(normalizers.normalizeReplaceJournal({ startedAt: 1, query: 'q', total: -1, applied: [] }), null);
  const journal = normalizers.normalizeReplaceJournal({ startedAt: 1, query: 'q', total: 2, applied: ['a', '/b', 'c/d'] });
  assert.deepEqual(journal.applied, ['a', 'c/d']);
  assert.deepEqual(normalizers.normalizeSearchHistory(['a', ' b ', 'a', 3, '']), ['b', 'a']);
  assert.deepEqual(normalizers.normalizeSearchHistory('x'), []);
});
