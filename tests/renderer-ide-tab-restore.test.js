'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeTabRestore } = require('../renderer/features/renderer-ide-tab-restore');
const ideState = require('../renderer/features/renderer-ide-state');
const { createHarness } = require('./helpers/renderer-ide-harness');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

test('snapshot keeps pinned tabs first and the newest 30 activations, capturing or carrying lines', async (t) => {
  const ide = ideState.createIdeUiState();
  for (let i = 0; i < 35; i += 1) ideState.openTab(ide, `f${i}.js`);
  ideState.toggleTabPinned(ide, 'f0.js');
  ide.openTabs.find((tab) => tab.path === 'f1.js').restore = { line: 20, top: 15 };
  const restore = createIdeTabRestore({ editorHost: {
    getViewLines: (path) => path === 'f2.js' ? { line: 7, top: 4 } : null,
  } });
  for (let i = 0; i < 35; i += 1) restore.recordActivation(`f${i}.js`);
  restore.recordActivation('f1.js');
  restore.recordActivation('f2.js');
  const snapshot = restore.capture(ideState.toPersistedState(ide), ide);
  assert.equal(snapshot.openTabs.length, 30);
  assert.equal(snapshot.openTabs[0].path, 'f0.js');
  assert.deepEqual(snapshot.openTabs.slice(0, 4).map((tab) => tab.path), ['f0.js', 'f1.js', 'f2.js', 'f8.js'], 'survivors keep strip order');
  for (const dropped of ['f3.js', 'f7.js']) assert.equal(snapshot.openTabs.some((tab) => tab.path === dropped), false, dropped);
  assert.deepEqual(snapshot.openTabs[1], { path: 'f1.js', line: 20, top: 15 });
  assert.deepEqual(snapshot.openTabs[2], { path: 'f2.js', line: 7, top: 4 });

  const dom = new JSDOM('<div id="editor"></div><textarea></textarea>');
  let state = { cursorState: [{ position: { lineNumber: 2 } }], viewState: { firstPosition: { lineNumber: 1 } } };
  let top = 0;
  const editor = {
    addCommand() {}, onDidChangeModelContent() {}, updateOptions() {}, setModel() {}, dispose() {},
    saveViewState: () => state, restoreViewState: (value) => { state = value; },
    setPosition: (position) => { state = { ...state, cursorState: [{ position }] }; },
    getTopForLineNumber: (line) => line * 19, setScrollTop: (value) => { top = value / 19; },
  };
  const monaco = {
    KeyMod: {}, KeyCode: {}, Uri: { parse: (value) => value },
    editor: { create: () => editor, getModel: () => null,
      createModel: (value) => ({ getValue: () => value, getLineCount: () => value.split('\n').length,
        getAlternativeVersionId: () => 1, dispose() {} }),
    },
  };
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('editor'), ideEditorFallback: dom.window.document.querySelector('textarea') }),
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => monaco },
  });
  t.after(() => { host.dispose(); dom.window.close(); });
  await host.openDocument({ path: 'a.js', content: 'one\ntwo\nthree' });
  host.activateDocument('a.js');
  assert.deepEqual(host.getViewLines('a.js'), { line: 2, top: 1 });
  await host.openDocument({ path: 'b.js', content: 'b' });
  host.activateDocument('b.js');
  assert.deepEqual(host.getViewLines('a.js'), { line: 2, top: 1 }, 'background document carries stashed lines');
  assert.equal(host.getViewLines('absent.js'), null);
  host.activateDocument('a.js');
  assert.equal(host.revealTopLine('a.js', 99, 99), true);
  assert.equal(state.cursorState[0].position.lineNumber, 3);
  assert.equal(top, 3, 'both lines clamp to the end of the changed file');
});

test('parallel missing-file probe ignores failures and feeds a dismissible muted strip', async (t) => {
  const dom = new JSDOM('<div><div class="ide-tabbar"><div id="tabs"></div></div><div id="editor"></div></div>');
  t.after(() => dom.window.close());
  const strip = dom.window.document.getElementById('tabs');
  const calls = [];
  const restore = createIdeTabRestore({
    getDom: () => ({ ideTabStrip: strip }),
    getWorkspaceFsApi: () => ({ stat: async ({ path }) => {
      calls.push(path);
      if (path === 'unknown.js') throw new Error('offline');
      return { exists: path === 'ok.js' };
    } }),
  });
  const probed = await restore.probe({ openTabs: [{ path: 'dir/gone.js' }, { path: 'ok.js' }, { path: 'unknown.js' }], activeTabPath: 'dir/gone.js' });
  assert.deepEqual(calls, ['dir/gone.js', 'ok.js', 'unknown.js']);
  assert.deepEqual(probed.snapshot.openTabs.map((tab) => tab.path), ['ok.js', 'unknown.js']);
  restore.hydrate(probed.snapshot, probed.missing);
  restore.render();
  const notice = strip.parentElement.nextElementSibling;
  assert.equal(notice.className, 'ide-restore-strip');
  assert.match(notice.textContent, /One file from last time is gone: gone.js/);
  assert.equal(notice.querySelector('button').className, 'ide-restore-strip-dismiss');
  assert.equal(notice.querySelector('button').getAttribute('aria-label'), 'Dismiss');
  notice.querySelector('button').click();
  assert.equal(notice.hidden, true);
  for (let i = 0; i < 7; i += 1) restore.recordMissing(`dir/missing${i}.js`);
  restore.render();
  assert.match(notice.textContent, /missing0.js, missing1.js, missing2.js, missing3.js, missing4.js, …/);
  restore.tabAction();
  assert.equal(notice.hidden, true);
  const before = calls.length;
  await restore.probe({ openTabs: Array.from({ length: 35 }, (_, i) => ({ path: `file${i}.js` })) });
  assert.equal(calls.length - before, 30, 'probes are bounded');
  restore.recordMissing('later.js');
  restore.render({ openTabs: [], activeTabPath: '', groupActive: {} });
  assert.match(notice.textContent, /later.js/, 'a lazy restore failure survives its own close/render');
});

test('controller boot keeps a restored preview, drops missing files before clicks, and next open replaces preview', async (t) => {
  const harness = createHarness({ bridgeOptions: {
    files: { 'preview.js': 'one\ntwo\nthree', 'next.js': 'next' },
    persisted: { openTabs: [{ path: 'preview.js', preview: true, line: 99, top: 99 }, { path: 'gone.js' }], activeTabPath: 'preview.js' },
  } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  assert.deepEqual(harness.state.ui.ide.openTabs.map((tab) => tab.path), ['preview.js']);
  assert.equal(harness.state.ui.ide.openTabs[0].transientPreview, true);
  assert.equal(harness.state.ui.ide.openTabs[0].restore, undefined);
  const fallback = harness.dom.window.document.getElementById('ideEditorFallback');
  assert.equal(fallback.selectionStart, 'one\ntwo\n'.length, 'past-EOF cursor clamps to last line');
  assert.equal(harness.toasts.length, 0);
  assert.match(harness.dom.window.document.querySelector('.ide-restore-strip').textContent, /gone.js/);
  await harness.controller.openFile('next.js', { preview: true });
  assert.deepEqual(harness.state.ui.ide.openTabs.map((tab) => tab.path), ['next.js']);
  assert.equal(harness.dom.window.document.querySelector('.ide-restore-strip').hidden, true);
});
