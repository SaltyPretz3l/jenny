'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const { createEditorHostPanes } = require('../renderer/features/renderer-ide-editor-host-panes');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');
const { createIdePdfPane } = require('../renderer/features/renderer-ide-pdf-host');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(t, options = {}) {
  const dom = new JSDOM('<head></head><body><div id="host"></div><textarea id="fallback"></textarea></body>', {
    url: 'file:///app/index.html',
  });
  const documentRef = dom.window.document;
  const listeners = new Set();
  const add = documentRef.addEventListener.bind(documentRef);
  const remove = documentRef.removeEventListener.bind(documentRef);
  documentRef.addEventListener = (name, fn, ...rest) => {
    if (name === 'selectionchange') listeners.add(fn);
    add(name, fn, ...rest);
  };
  documentRef.removeEventListener = (name, fn, ...rest) => {
    if (name === 'selectionchange') listeners.delete(fn);
    remove(name, fn, ...rest);
  };
  const hostEl = documentRef.querySelector('#host');
  const fallback = documentRef.querySelector('#fallback');
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: hostEl, ideEditorFallback: fallback }),
    imageHostUtils: {},
    monacoUtils: { ensureMonacoEditorApi: async () => null },
    ...options,
  });
  t.after(() => { host.dispose(); dom.window.close(); });
  return { host, hostEl, fallback, listeners, dom };
}

for (const format of ['pdf', 'docx']) {
  test(`${format}: deferred factory after owner disposal creates no pane or resources`, async t => {
    const factory = deferred();
    let constructions = 0;
    let workers = 0;
    const h = harness(t, { documentPaneFactories: { [format]: () => factory.promise } });
    const opening = h.host.openBinaryDocument({ path: `late.${format}`, format, base64: 'AA==' });
    h.host.dispose();
    factory.resolve(deps => {
      constructions += 1;
      return format === 'docx' ? createIdeDocxPane(deps) : createIdePdfPane({
        ...deps, loadPdfjs: async () => {
          workers += 1;
          throw new Error('unexpected worker');
        },
      });
    });
    assert.equal(await opening, null, 'disposed open is cancelled');
    assert.equal(constructions, 0, 'no late pane inserted');
    assert.equal(h.hostEl.children.length, 0, 'no late DOM node');
    assert.equal(h.listeners.size, 0, 'no document selectionchange listener');
    assert.equal(workers, 0, 'no worker starts');
    assert.equal(h.host.hasDocument(`late.${format}`), false);
  });

  test(`${format}: superseded lazy open constructs nothing and a later open still works`, async t => {
    const factory = deferred();
    let current = true;
    let constructions = 0;
    let loads = 0;
    const h = harness(t, { documentPaneFactories: { [format]: () => factory.promise } });
    const create = () => {
      constructions += 1;
      return { load: async () => { loads += 1; return { ok: true }; }, dispose() {}, close() {} };
    };
    const opening = h.host.openBinaryDocument({ path: `stale.${format}`, format, shouldApply: () => current });
    current = false;
    factory.resolve(create);
    assert.equal(await opening, null);
    assert.equal(constructions, 0, 'superseded open must not insert a pane');
    assert.equal(loads, 0, 'superseded open must not start load');
    assert.ok(await h.host.openBinaryDocument({ path: `next.${format}`, format }));
    assert.equal(constructions, 1);
    assert.equal(loads, 1);
  });
}

test('runtime script continuation after disposal stops before styles and remaining scripts', async t => {
  const script = deferred();
  let scripts = 0;
  const h = harness(t);
  const panes = createEditorHostPanes({
    docs: new Map(), getDom: () => ({ ideEditorHost: h.hostEl }),
    resolveRuntimeModule: () => null,
    scriptLoader: { ensureScript: () => { scripts += 1; return script.promise; } },
  });
  t.after(() => panes.dispose());
  const opening = panes.openBinaryDocument({ path: 'late.docx', format: 'docx' });
  panes.dispose();
  script.resolve(true);
  assert.equal(await opening, null);
  assert.equal(scripts, 1, 'no additional lazy scripts after disposal');
  assert.equal(h.dom.window.document.head.children.length, 0, 'no styles after disposal');
});

test('construction that disposes its owner immediately releases the late pane', async t => {
  let loads = 0;
  let disposals = 0;
  const h = harness(t, { documentPaneFactories: { docx: () => deps => {
    const node = deps.getHost().ownerDocument.createElement('div');
    deps.getHost().appendChild(node);
    const listener = () => {};
    node.ownerDocument.addEventListener('selectionchange', listener);
    h.host.dispose();
    return {
      load: async () => { loads += 1; return { ok: true }; },
      dispose() {
        disposals += 1;
        node.ownerDocument.removeEventListener('selectionchange', listener);
        node.remove();
      },
    };
  } } });
  assert.equal(await h.host.openBinaryDocument({ path: 'late.docx', format: 'docx' }), null);
  assert.equal(loads, 0, 'check the owner fence before load');
  assert.equal(disposals, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.hostEl.children.length, 0);
});

test('a commit veto tears down a newly created pane and its resources', async t => {
  let current = true;
  let disposals = 0;
  let loads = 0;
  const h = harness(t, { documentPaneFactories: { docx: () => deps => {
    const real = createIdeDocxPane(deps);
    return {
      async load(path, source) {
        loads += 1;
        // Use the real pane's resource creation, then simulate a vetoed parse.
        await real.load(path, { ...source, base64: 'BAD' });
        current = false;
        return { ok: false, code: 'document_stale' };
      },
      close: path => real.close(path),
      dispose() { disposals += 1; real.dispose(); },
    };
  } } });
  assert.equal(await h.host.openBinaryDocument({ path: 'veto.docx', format: 'docx', shouldApply: () => current }), null);
  assert.equal(loads, 1);
  assert.equal(disposals, 1, 'veto must dispose the unused new pane');
  assert.equal(h.listeners.size, 0, 'veto removes selectionchange listener');
  assert.equal(h.hostEl.children.length, 0, 'veto removes pane DOM');
});

test('owner disposal during a pane load cancels the result without resurrecting resources', async t => {
  const runtime = deferred();
  let started;
  const loading = new Promise(resolve => { started = resolve; });
  let workers = 0;
  const h = harness(t, { documentPaneFactories: { pdf: () => deps => createIdePdfPane({
    ...deps, loadPdfjs: async () => {
      started();
      await runtime.promise;
      return { pdfjs: { getDocument() { workers += 1; throw new Error('unexpected worker'); } }, viewer: {} };
    },
  }) } });
  const opening = h.host.openBinaryDocument({ path: 'pending.pdf', format: 'pdf', base64: 'AA==' });
  await loading;
  h.host.dispose();
  runtime.resolve();
  // Resolving the runtime is allowed; no getDocument/viewer work may follow it.
  assert.equal(await opening, null, 'disposed in-flight open is cancelled');
  assert.equal(workers, 0, 'no worker after late runtime resolves');
  assert.equal(h.host.hasDocument('pending.pdf'), false);
  assert.equal(h.hostEl.children.length, 0);
});

test('a veto on a reused pane skips load and preserves its live document', async t => {
  let loads = 0;
  let disposals = 0;
  const h = harness(t, { documentPaneFactories: { pdf: () => () => ({
    load: async () => { loads += 1; return { ok: true }; },
    dispose() { disposals += 1; }, close() {},
  }) } });
  await h.host.openBinaryDocument({ path: 'live.pdf', format: 'pdf' });
  assert.equal(await h.host.openBinaryDocument({ path: 'skip.pdf', format: 'pdf', shouldApply: () => false }), null);
  assert.equal(loads, 1, 'veto before load on a reused pane');
  assert.equal(disposals, 0, 'live document keeps its shared pane');
  assert.equal(h.host.hasDocument('live.pdf'), true);
});

function fakeMonaco() {
  const models = [];
  const editor = { addCommand() {}, onDidChangeModelContent() {}, setModel() {}, dispose() {} };
  const diff = { setModel() {}, layout() {}, dispose() {} };
  return {
    models,
    api: {
      KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 1 },
      editor: {
        create: () => editor, createDiffEditor: () => diff,
        createModel(text) {
          const model = { value: text, getValue() { return this.value; }, setValue(value) { this.value = value; }, dispose() {} };
          models.push(model);
          return model;
        },
      },
    },
  };
}

test('diff strings serve the pre-Monaco fallback then transfer ownership to models', async t => {
  const fake = fakeMonaco();
  let ready = false;
  const h = harness(t, { monacoUtils: {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    ensureMonacoEditorApi: async () => ready ? fake.api : null,
  } });
  const id = 'diff://a.txt';
  const doc = await h.host.openDiffDocument({ id, original: 'before', modified: 'after' });
  h.host.activateDocument(id);
  assert.ok(h.fallback.value.includes('before'));
  assert.ok(h.fallback.value.includes('after'));
  await h.host.openDiffDocument({ id, original: 'old fallback', modified: 'new fallback' });
  h.host.activateDocument(id);
  assert.ok(h.fallback.value.includes('new fallback'), 'fallback updates before Monaco');
  ready = true;
  await h.host.openDiffDocument({ id, original: 'old model', modified: 'new model' });
  h.host.activateDocument(id);
  assert.equal(doc.original, null, 'original string released after Monaco ownership');
  assert.equal(doc.modified, null, 'modified string released after Monaco ownership');
  assert.deepEqual(fake.models.map(model => model.getValue()), ['old model', 'new model']);
  assert.equal(doc.modifiedModel.getValue(), 'new model');
  await h.host.openDiffDocument({ id, original: 'updated original', modified: 'updated modified' });
  assert.equal(doc.original, null, 'updates do not retain duplicate original text');
  assert.equal(doc.modified, null, 'updates do not retain duplicate modified text');
  assert.equal(doc.modifiedModel.getValue(), 'updated modified');
  assert.deepEqual(fake.models.map(model => model.getValue()), ['updated original', 'updated modified']);
});
