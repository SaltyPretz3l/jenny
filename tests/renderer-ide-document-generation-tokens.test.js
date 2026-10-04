'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdePdfPane } = require('../renderer/features/renderer-ide-pdf-host');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Observe retained entries through a Map fake during synchronous construction.
// No production source text or new production introspection API is needed.
function captureMaps(create) {
  const NativeMap = globalThis.Map;
  const maps = [];
  globalThis.Map = class extends NativeMap {
    constructor(...args) { super(...args); maps.push(this); }
  };
  try { return { pane: create(), maps }; } finally { globalThis.Map = NativeMap; }
}

function harness(t, format, wait = null) {
  const dom = new JSDOM('<div id="host"></div>', { url: 'file:///app/index.html' });
  const hostEl = dom.window.document.querySelector('#host');
  let reads = 0;
  let destroyed = 0;
  let workers = 0;
  const modules = {
    pdfjs: {
      AnnotationEditorType: { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 },
      AnnotationMode: { ENABLE_FORMS: 2 },
      getDocument() {
        workers += 1;
        return {
          promise: Promise.resolve({ numPages: 1, annotationStorage: { resetModified() {} } }),
          destroy() { destroyed += 1; },
        };
      },
    },
    viewer: {
      EventBus: class {
        constructor() { this.listeners = new Map(); }
        on(name, fn) { this.listeners.set(name, fn); }
        off(name) { this.listeners.delete(name); }
        dispatch(name, detail) { this.listeners.get(name)?.(detail); }
      },
      PDFLinkService: class { setDocument() {} setViewer() {} },
      PDFFindController: class {},
      PDFViewer: class {
        constructor(options) { this.options = options; }
        setDocument(doc) { if (doc) this.options.eventBus.dispatch('pagesinit', {}); }
        cleanup() {} update() {}
      },
    },
  };
  const zip = { entries: new Map([['word/document.xml', {}]]), order: [] };
  const { pane, maps } = captureMaps(() => format === 'pdf'
    ? createIdePdfPane({
      getHost: () => hostEl,
      loadPdfjs: async () => {
        if (++reads === 1 && wait) await wait.promise;
        return modules;
      },
    })
    : createIdeDocxPane({
      getHost: () => hostEl, richUtils: {},
      zipUtils: {
        async readZip() {
          if (++reads === 1 && wait) await wait.promise;
          return zip;
        },
        readEntryText: async () => '<document/>',
      },
      modelUtils: { createDocxModel: () => ({ getBlocks: () => [], getWarnings: () => [], isDirty: () => false }) },
      renderUtils: { renderBlocks: doc => doc.createDocumentFragment() },
    }));
  t.after(() => { pane.dispose(); dom.window.close(); });
  const tokens = () => maps.flatMap(map => [...map.entries()])
    .filter(([key, value]) => String(key).startsWith('docs/') && typeof value === 'number');
  return { pane, tokens, workerCount: () => workers, destroyedCount: () => destroyed, hostEl };
}

for (const format of ['pdf', 'docx']) {
  test(`${format}: closing 50 distinct paths leaves no generation entries`, async t => {
    const h = harness(t, format);
    const values = new Set();
    for (let index = 0; index < 50; index += 1) {
      const path = `docs/${index}.${format}`;
      assert.equal((await h.pane.load(path, { base64: 'AA==' })).ok, true);
      const active = h.tokens();
      assert.equal(active.length, 1, 'only the active path owns a token');
      assert.equal(values.has(active[0][1]), false, 'tokens are unique across paths');
      values.add(active[0][1]);
      h.pane.close(path);
      assert.equal(h.tokens().length, 0, 'close removes generation entry');
    }
    h.pane.dispose();
    assert.equal(h.tokens().length, 0);
    if (format === 'pdf') assert.equal(h.destroyedCount(), 50);
  });

  test(`${format}: close and reopen rejects an older in-flight load`, async t => {
    const wait = deferred();
    const h = harness(t, format, wait);
    const path = `docs/reopen.${format}`;
    const old = h.pane.load(path, { base64: 'AA==' });
    const oldToken = h.tokens()[0][1];
    h.pane.close(path);
    assert.equal(h.tokens().length, 0, 'pending path token removed at close');
    assert.equal((await h.pane.load(path, { base64: 'AA==' })).ok, true);
    assert.notEqual(h.tokens()[0][1], oldToken, 'reopen never reuses the old token');
    wait.resolve();
    assert.equal((await old).ok, false, 'old load must not commit over reopened path');
    assert.equal(h.pane.hasDocument(path), true, 'reopened document survives old completion');
    h.pane.close(path);
    assert.equal(h.tokens().length, 0);
    if (format === 'pdf') assert.equal(h.workerCount(), 1, 'old lazy load starts no worker');
  });

  test(`${format}: a vetoed first open leaves no generation entry`, async t => {
    const h = harness(t, format);
    assert.equal((await h.pane.load(`docs/live.${format}`, { base64: 'AA==' })).ok, true);
    for (let index = 0; index < 5; index += 1) {
      const result = await h.pane.load(`docs/v${index}.${format}`, { base64: 'AA==', shouldCommit: () => false });
      assert.equal(result.code, 'document_stale');
    }
    assert.deepEqual(h.tokens().map(([key]) => key), [`docs/live.${format}`]);
  });

  test(`${format}: disposal clears tokens for an unresolved load`, async t => {
    const wait = deferred();
    const h = harness(t, format, wait);
    const old = h.pane.load(`docs/pending.${format}`, { base64: 'AA==' });
    assert.equal(h.tokens().length, 1);
    h.pane.dispose();
    assert.equal(h.tokens().length, 0, 'dispose clears pending generation entries');
    wait.resolve();
    assert.equal((await old).ok, false);
    assert.equal(h.hostEl.children.length, 0);
    if (format === 'pdf') assert.equal(h.workerCount(), 0);
  });
}
