'use strict';

// Large-file guard helpers in renderer/features/renderer-monaco-editor-utils.js:
// classifyLargeFile (pure size/line/minified detection), largeFileEditorOptions
// (degraded chrome), applyLargeFileEditorMode (option apply + "restore" notice),
// and the extracted composeFallbackDiffText.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');
const actionButton = require('../renderer/inventory/action-button');

test('classifyLargeFile: small/normal files are not large', () => {
  assert.equal(monacoUtils.classifyLargeFile(''), false);
  assert.equal(monacoUtils.classifyLargeFile('function foo() { return 1; }'), false);
  // 60 KB of normal multi-line code (avg line well under 2000 chars).
  const normal = ('const x = doThing(1, 2, 3);\n').repeat(2200); // ~60 KB, ~2200 lines
  assert.equal(monacoUtils.classifyLargeFile(normal), false);
});

test('classifyLargeFile: oversized byte count is large', () => {
  assert.equal(monacoUtils.classifyLargeFile('X'.repeat(300 * 1024)), true);
});

test('classifyLargeFile: too many lines is large', () => {
  assert.equal(monacoUtils.classifyLargeFile('a\n'.repeat(20001)), true);
});

test('classifyLargeFile: minified (lots of bytes, few lines) is large', () => {
  // 60 KB packed into a single line.
  assert.equal(monacoUtils.classifyLargeFile('y'.repeat(60 * 1024)), true);
});

test('largeFileEditorOptions: disables expensive chrome but keeps the base', () => {
  const degraded = monacoUtils.largeFileEditorOptions({ wordWrap: 'on', fontSize: 13 });
  assert.equal(degraded.wordWrap, 'on'); // base preserved
  assert.equal(degraded.fontSize, 13);
  assert.equal(degraded.minimap.enabled, false);
  assert.equal(degraded.stickyScroll.enabled, false);
  assert.equal(degraded.occurrencesHighlight, 'off');
  assert.equal(degraded.bracketPairColorization.enabled, false);
  assert.equal(degraded.folding, false);
});

test('composeFallbackDiffText: placeholder vs stacked versions', () => {
  assert.equal(monacoUtils.composeFallbackDiffText({ placeholderText: 'gone' }), 'gone');
  const stacked = monacoUtils.composeFallbackDiffText({ original: 'A', modified: 'B' });
  assert.match(stacked, /Original \(before change\)/);
  assert.match(stacked, /A/);
  assert.match(stacked, /Current/);
  assert.match(stacked, /B/);
});

test('applyLargeFileEditorMode: degrades + shows a restorable notice for large files', () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const prevWindow = global.window;
  global.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  try {
    const host = dom.window.document.getElementById('host');
    const updates = [];
    const editor = { updateOptions: (opts) => updates.push(opts) };
    const fullOptions = { minimap: { enabled: true }, stickyScroll: { enabled: true } };

    monacoUtils.applyLargeFileEditorMode(editor, host, true, fullOptions);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].minimap.enabled, false, 'degraded options applied');
    const notice = host.querySelector('.ide-large-file-notice');
    assert.ok(notice, 'notice rendered');
    assert.ok(!notice.classList.contains('hidden'));

    // Restore click re-applies the full options and hides the notice.
    const restore = host.querySelector('[data-large-file-restore]');
    assert.ok(restore, 'restore control rendered via inventory primitive');
    restore.click();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].minimap.enabled, true, 'full options restored');
    assert.ok(notice.classList.contains('hidden'));
  } finally {
    if (prevWindow === undefined) {
      delete global.window;
    } else {
      global.window = prevWindow;
    }
  }
});

test('applyLargeFileEditorMode: restore uses the LATEST options across files', () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const prevWindow = global.window;
  global.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  try {
    const host = dom.window.document.getElementById('host');
    const updates = [];
    const editor = { updateOptions: (opts) => updates.push(opts) };
    // First large file, then a second (the notice element is reused).
    monacoUtils.applyLargeFileEditorMode(editor, host, true, { wordWrap: 'off', minimap: { enabled: true } });
    monacoUtils.applyLargeFileEditorMode(editor, host, true, { wordWrap: 'on', minimap: { enabled: true } });
    updates.length = 0; // ignore the two degrade updates
    host.querySelector('[data-large-file-restore]').click();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].wordWrap, 'on', 'restore applies the SECOND file options, not a stale snapshot');
  } finally {
    if (prevWindow === undefined) {
      delete global.window;
    } else {
      global.window = prevWindow;
    }
  }
});

test('applyLargeFileEditorMode: normal files get full options and the notice hidden', () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>');
  const host = dom.window.document.getElementById('host');
  const updates = [];
  const editor = { updateOptions: (opts) => updates.push(opts) };
  const fullOptions = { minimap: { enabled: true } };

  monacoUtils.applyLargeFileEditorMode(editor, host, false, fullOptions);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].minimap.enabled, true);
  // No notice is created for a normal file (none existed to hide).
  assert.equal(host.querySelector('.ide-large-file-notice'), null);
});
