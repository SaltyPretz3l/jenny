'use strict';

/* Editor-host cursor-handler dedup (perf): the host binds ONLY
 * onDidChangeCursorSelection (selection-change fires on bare cursor moves too),
 * never onDidChangeCursorPosition, so the statusbar + symbol-nav onCursorActivity
 * feed runs once per caret move instead of twice. Driven with a fake Monaco that
 * records which cursor handlers were registered and counts onCursorActivity. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const { offsetForLineColumn } = require('../renderer/features/renderer-ide-editor-reads');

// Fake Monaco that captures the selection-change callback and records whether the
// (now-removed) position-change handler was ever registered.
function makeFakeMonaco() {
  const captured = { selectionCb: null };
  let positionHandlerRegistered = false;
  const model = {
    getValue: () => '',
    setValue() {},
    getAlternativeVersionId: () => 1,
    getLanguageId: () => 'javascript',
    dispose() {},
  };
  const editor = {
    addCommand() {},
    onDidChangeModelContent() {},
    onDidChangeCursorPosition() { positionHandlerRegistered = true; },
    onDidChangeCursorSelection(cb) { captured.selectionCb = cb; },
    onMouseDown() {},
    setModel() {},
    saveViewState: () => null,
    restoreViewState() {},
    dispose() {},
    updateOptions() {},
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (v) => ({ toString: () => String(v) }) },
    editor: {
      create: () => editor,
      getModel: () => null,
      createModel: () => model,
      onDidChangeMarkers: () => ({ dispose() {} }),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    },
    languages: {
      typescript: {
        typescriptDefaults: { setEagerModelSync() {} },
        javascriptDefaults: { setEagerModelSync() {} },
      },
    },
  };
  return {
    api,
    fireSelection: () => captured.selectionCb && captured.selectionCb(),
    hasSelectionHandler: () => typeof captured.selectionCb === 'function',
    positionHandlerRegistered: () => positionHandlerRegistered,
  };
}

async function bootHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  let cursorActivityCalls = 0;
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...require('../renderer/features/renderer-monaco-editor-utils'),
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
    previewHostUtils: {},
    onCursorActivity: () => { cursorActivityCalls += 1; },
  });
  // openDocument runs ensureEditor, which wires the cursor handlers.
  await host.openDocument({ path: 'src/app.js', content: '' });
  return { host, fake, getCalls: () => cursorActivityCalls };
}

test('only the selection-change handler is bound (position handler is never registered)', async () => {
  const { host, fake } = await bootHost();
  assert.equal(fake.hasSelectionHandler(), true, 'selection handler bound');
  assert.equal(fake.positionHandlerRegistered(), false, 'position handler must NOT be registered');
  host.dispose();
});

test('a caret move fires onCursorActivity exactly once (no double work)', async () => {
  const { host, fake, getCalls } = await bootHost();
  fake.fireSelection();
  assert.equal(getCalls(), 1, 'one onCursorActivity per caret move');
  fake.fireSelection();
  fake.fireSelection();
  assert.equal(getCalls(), 3, 'still exactly one per move');
  host.dispose();
});

test('fallback offsets clamp oversized columns to their requested line and oversized lines to EOF', () => {
  assert.equal(offsetForLineColumn('abc\ndef', 1, 99), 3, 'column clamps to the end of line 1');
  assert.equal(offsetForLineColumn('abc\ndef', 99, 99), 7, 'line and column clamp to EOF');
});
