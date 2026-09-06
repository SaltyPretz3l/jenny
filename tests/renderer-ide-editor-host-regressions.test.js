'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeDom() {
  const dom = new JSDOM('<div id="host"></div><textarea id="fallback"></textarea>');
  return {
    dom,
    getDom: () => ({
      ideEditorHost: dom.window.document.getElementById('host'),
      ideEditorFallback: dom.window.document.getElementById('fallback'),
    }),
  };
}

function fakeMonaco({ actionRun } = {}) {
  const calls = { create: 0, editorDispose: 0, saveCommand: null };
  let value = '';
  let alternativeVersionId = 1;
  let modelChangeListener = () => {};
  const model = {
    getValue: () => value,
    setValue(next) {
      value = String(next);
      alternativeVersionId += 1;
      modelChangeListener();
    },
    getAlternativeVersionId: () => alternativeVersionId,
    dispose() {},
  };
  const editor = {
    addCommand(_keybinding, handler) { calls.saveCommand = handler; },
    onDidChangeModelContent(handler) { modelChangeListener = handler; },
    onDidChangeCursorSelection() {},
    onMouseDown() {},
    setModel() {},
    getAction: () => ({ run: actionRun || (() => undefined) }),
    focus() {},
    dispose() { calls.editorDispose += 1; },
    updateOptions() {},
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => value },
    languages: { typescript: { typescriptDefaults: {}, javascriptDefaults: {} } },
    editor: {
      create: () => { calls.create += 1; return editor; },
      createModel: (text) => { value = String(text); return model; },
      getModel: () => null,
      onDidChangeMarkers: () => ({ dispose() {} }),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    },
  };
  return { api, calls, model };
}

test('model-backed documents release duplicate buffers while preserving their full value', async () => {
  const fake = fakeMonaco();
  const fixture = makeDom();
  const host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => fake.api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  const content = 'const first = 1;\nconst second = 2;\n';

  const doc = await host.openDocument({ path: 'model.js', content });

  assert.equal(doc.buffer, null);
  assert.equal(doc.savedBuffer, null);
  assert.equal(host.getValue('model.js'), content);
  host.dispose();
});

test('saving a model-backed edit writes the current model text', async () => {
  const fake = fakeMonaco();
  const fixture = makeDom();
  const writes = [];
  let host;
  host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => fake.api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
    onSaveRequest: () => {
      const path = host.getActivePath();
      const savedContent = host.getValue(path);
      writes.push(savedContent);
      host.markSaved(path, { savedVersionId: host.getAltVersionId(path), savedContent });
    },
  });
  await host.openDocument({ path: 'save.js', content: 'before' });
  host.activateDocument('save.js');

  fake.model.setValue('after edit');
  fake.calls.saveCommand();

  assert.deepEqual(writes, ['after edit']);
  host.dispose();
});

test('model-backed dirty tracking clears after the edited version is saved', async () => {
  const fake = fakeMonaco();
  const fixture = makeDom();
  const dirtyChanges = [];
  const host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => fake.api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
    onDirtyChange: (path, dirty) => dirtyChanges.push({ path, dirty }),
  });
  await host.openDocument({ path: 'dirty.js', content: 'clean' });
  host.activateDocument('dirty.js');

  fake.model.setValue('edited');
  assert.equal(host.isDirty('dirty.js'), true);
  host.markSaved('dirty.js', {
    savedVersionId: host.getAltVersionId('dirty.js'),
    savedContent: host.getValue('dirty.js'),
  });

  assert.equal(host.isDirty('dirty.js'), false);
  assert.deepEqual(dirtyChanges, [
    { path: 'dirty.js', dirty: true },
    { path: 'dirty.js', dirty: false },
  ]);
  host.dispose();
});

test('textarea fallback retains its buffer and returns it as the document value', async () => {
  const fixture = makeDom();
  const host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => null },
    imageHostUtils: {},
    previewHostUtils: {},
  });

  const doc = await host.openDocument({ path: 'fallback.txt', content: 'fallback text' });

  assert.equal(doc.buffer, 'fallback text');
  assert.equal(host.getValue('fallback.txt'), 'fallback text');
  host.dispose();
});

test('disposing during a delayed Monaco load prevents editor creation and document registration', async () => {
  const loader = deferred();
  const fake = fakeMonaco();
  const fixture = makeDom();
  const host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: () => loader.promise, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
  });

  const opening = host.openDocument({ path: 'late.js', content: 'late' });
  host.dispose();
  loader.resolve(fake.api);
  const result = await opening;

  assert.equal(fake.calls.create, 0, 'the stale loader continuation cannot create an editor');
  assert.equal(host.hasDocument('late.js'), false, 'the stale open cannot register a document');
  assert.equal(result, null);
});

test('fallback input listeners are removed on dispose before a host is recreated on the same textarea', async () => {
  const fixture = makeDom();
  const textarea = fixture.getDom().ideEditorFallback;
  const listeners = new Set();
  const add = textarea.addEventListener.bind(textarea);
  const remove = textarea.removeEventListener.bind(textarea);
  textarea.addEventListener = (type, listener, options) => {
    if (type === 'input') listeners.add(listener);
    add(type, listener, options);
  };
  textarea.removeEventListener = (type, listener, options) => {
    if (type === 'input') listeners.delete(listener);
    remove(type, listener, options);
  };
  const options = {
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => null },
    imageHostUtils: {},
    previewHostUtils: {},
  };

  const first = createIdeEditorHost(options);
  await first.openDocument({ path: 'first.js', content: 'one' });
  first.activateDocument('first.js');
  assert.equal(listeners.size, 1);
  first.dispose();
  assert.equal(listeners.size, 0, 'the first host releases its input listener');

  const second = createIdeEditorHost(options);
  await second.openDocument({ path: 'second.js', content: 'two' });
  second.activateDocument('second.js');
  assert.equal(listeners.size, 1, 'recreation installs exactly one live listener');
  second.dispose();
  assert.equal(listeners.size, 0);
});

test('runAction observes a returned thenable rejection while preserving its synchronous result', async () => {
  let thenCalls = 0;
  const rejectedThenable = {
    then(_resolve, reject) {
      thenCalls += 1;
      reject(new Error('action failed'));
    },
  };
  const fake = fakeMonaco({ actionRun: () => rejectedThenable });
  const fixture = makeDom();
  const host = createIdeEditorHost({
    getDom: fixture.getDom,
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => fake.api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  await host.openDocument({ path: 'action.js', content: '' });

  assert.equal(host.runAction('editor.action.test'), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(thenCalls, 1, 'the returned thenable is observed and its rejection is contained');
  host.dispose();
});
