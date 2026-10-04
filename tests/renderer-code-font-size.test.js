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

test('the IDE host pushes the editor font size to the diff editor too', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'renderer-ide-editor-host.js'), 'utf8');
  const body = source.slice(source.indexOf('function setEditorOptions('), source.indexOf('function getEol('));
  assert.match(body, /diffEditor\?\.updateOptions\?\.\(\{ fontSize: next\.fontSize \}\)/);
});
