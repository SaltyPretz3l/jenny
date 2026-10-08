'use strict';

// Type-scale rebase (2026-09-28): every code surface (Monaco main/diff/artifact
// editors, the PTY terminal) sizes from one resolver - the explicit editor font
// size when set, otherwise the code role (13px) times the Text size axis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function loadMonacoUtils() {
  const modulePath = require.resolve('../renderer/features/renderer-monaco-editor-utils');
  delete require.cache[modulePath];
  return require('../renderer/features/renderer-monaco-editor-utils');
}

function installDom(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
  return dom;
}

const flushObservers = async (dom) => {
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });
  await new Promise((resolve) => { dom.window.queueMicrotask(resolve); });
};

test('resolveCodeFontPx follows --font-scale until an explicit editor size is set', (t) => {
  const dom = installDom(t);
  const utils = loadMonacoUtils();
  const doc = dom.window.document;
  assert.equal(utils.resolveCodeFontPx(doc), 13, 'no --font-scale on the root: the bare code role');
  doc.documentElement.style.setProperty('--font-scale', '1.2');
  assert.equal(utils.resolveCodeFontPx(doc), 16, 'Default (1.2) rounds 15.6 up');
  assert.equal(utils.resolveCodeFontPx(doc, 18), 18, 'an explicit px wins');

  const events = [];
  doc.addEventListener(utils.CODE_FONT_SIZE_EVENT, (event) => events.push(event.detail.fontSize));
  assert.equal(utils.setCodeFontSizePreference(15, doc), 15);
  assert.equal(utils.resolveCodeFontPx(doc), 15, 'the shared preference now wins everywhere');
  assert.equal(utils.setCodeFontSizePreference(0, doc), 16, '0 returns to Match text size');
  assert.deepEqual(events, [15, 16], 'non-Monaco surfaces (the terminal) are told');
  assert.equal(utils.withMonacoFontFamily({ fontSize: 13 }, doc).fontSize, 16, 'new editors take the resolved size');
});

test('a Text size change retunes registered editors with fontSize only', async (t) => {
  const dom = installDom(t);
  const utils = loadMonacoUtils();
  const doc = dom.window.document;
  const applied = [];
  const unregister = utils.registerMonacoFontConsumer({ updateOptions(options) { applied.push(options); } }, doc);
  t.after(() => unregister());

  doc.documentElement.style.setProperty('--font-scale', '1.1');
  doc.documentElement.dataset.fontScale = 'large';
  await flushObservers(dom);
  assert.deepEqual(applied, [{ fontSize: 14 }]);
});

test('an explicit editor size change retunes already-open editors (artifact editors included)', (t) => {
  const dom = installDom(t);
  const utils = loadMonacoUtils();
  const doc = dom.window.document;
  const applied = [];
  const unregister = utils.registerMonacoFontConsumer({ updateOptions(options) { applied.push(options); } }, doc);
  t.after(() => unregister());

  utils.setCodeFontSizePreference(18, doc);
  utils.setCodeFontSizePreference(18, doc);
  utils.setCodeFontSizePreference(0, doc);
  assert.deepEqual(applied, [{ fontSize: 18 }, { fontSize: 13 }], 'only real changes are pushed');
});

async function assertDiffFontSize(t, omitUpdate = false) {
  const { window } = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const applied = [];
  const diffEditor = {
    model: null,
    setModel(model) { this.model = model; },
    getModel() { return this.model; },
    updateOptions: omitUpdate ? undefined : (options) => applied.push(options),
    layout() {}, dispose() {},
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({ addCommand() {}, onDidChangeModelContent() {}, setModel() {}, updateOptions() {}, dispose() {} }),
      createDiffEditor: () => diffEditor, getModel: () => null,
      createModel: (text) => ({ getValue: () => text, getAlternativeVersionId: () => 1, getLanguageId: () => 'javascript', dispose() {} }),
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  };
  const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: window.document.getElementById('ideEditorHost') }),
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
  });
  t.after(() => { host.dispose(); window.close(); });
  await host.openDiffDocument({ id: 'diff://a.js', languagePath: 'a.js', original: 'old', modified: 'new' });
  host.activateDocument('diff://a.js');
  assert.ok(diffEditor.model, 'activate the actual Monaco diff before changing preferences');
  applied.length = 0;
  host.setEditorOptions({ fontSize: 18 });
  assert.deepEqual(applied, [{ fontSize: 18 }], 'the active diff must receive the font-size update');
}

test('the IDE host pushes the editor font size to the diff editor too', async (t) => {
  await assertDiffFontSize(t);
  await assert.rejects(() => assertDiffFontSize(t, true), {
    code: 'ERR_ASSERTION', message: /the active diff must receive the font-size update/,
  });
});
