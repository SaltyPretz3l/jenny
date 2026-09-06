'use strict';

/* Editor-host large-file guard (Deliverable 2): openDocument flags large/minified
 * files (doc.largeFile), activateDocument applies degraded Monaco options + the
 * restore notice, and the active-file reader exposes isLargeFile() so the chat
 * composer's auto-context capture can exclude the file. Driven with a minimal
 * fake Monaco (mirrors renderer-ide-editor-host-markers.test.js) plus the real
 * monaco-utils large-file helpers. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');
const actionButton = require('../renderer/inventory/action-button');

function makeFakeMonaco() {
  const updates = [];
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
    onDidChangeCursorPosition() {},
    onDidChangeCursorSelection() {},
    setModel() {},
    saveViewState: () => null,
    restoreViewState() {},
    dispose() {},
    updateOptions: (o) => updates.push(o),
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (v) => ({ toString: () => String(v), path: '/x' }) },
    editor: {
      create: () => editor,
      getModel: () => null,
      createModel: () => model,
      onDidChangeMarkers: () => ({ dispose() {} }),
      getModelMarkers: () => [],
    },
    languages: {
      typescript: {
        typescriptDefaults: { setEagerModelSync() {} },
        javascriptDefaults: { setEagerModelSync() {} },
      },
    },
  };
  return { api, editor, updates };
}

function makeHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...monacoUtils,
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  return { host, fake, dom };
}

async function withWindow(dom, fn) {
  const prev = global.window;
  global.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  try {
    await fn();
  } finally {
    if (prev === undefined) {
      delete global.window;
    } else {
      global.window = prev;
    }
  }
}

test('a large file opens degraded and exposes the too-large signal + notice', async () => {
  const { host, fake, dom } = makeHost();
  await withWindow(dom, async () => {
    await host.openDocument({ path: 'dist/bundle.js', content: 'x'.repeat(300 * 1024) });
    host.activateDocument('dist/bundle.js');

    assert.equal(globalThis.rendererIdeActiveEditorReader.isLargeFile(), true);
    const last = fake.updates[fake.updates.length - 1];
    assert.equal(last.minimap.enabled, false, 'degraded options applied');
    assert.equal(last.stickyScroll.enabled, false);
    assert.ok(dom.window.document.querySelector('.ide-large-file-notice'), 'notice shown');
    host.setEditorOptions({ minimap: { enabled: true } });
    assert.equal(fake.updates.at(-1).minimap.enabled, false, 'preference updates cannot bypass the effective large-file override');
  });
  host.dispose();
});

test('a normal file opens with full options and no too-large signal', async () => {
  const { host, fake, dom } = makeHost();
  await withWindow(dom, async () => {
    await host.openDocument({ path: 'renderer/foo.js', content: 'const x = 1;\n' });
    host.activateDocument('renderer/foo.js');

    assert.equal(globalThis.rendererIdeActiveEditorReader.isLargeFile(), false);
    const last = fake.updates[fake.updates.length - 1];
    assert.equal(last.minimap.enabled, true, 'full options applied');
  });
  host.dispose();
});

// ── TASK 2: classification cache (length-keyed per doc) ──

// Host whose classifyLargeFile is a spy over the real classifier, so the cache
// behavior is observable via a call counter while the result stays truthful.
function makeCountingHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  let classifyCalls = 0;
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...monacoUtils,
      classifyLargeFile: (text) => { classifyCalls += 1; return monacoUtils.classifyLargeFile(text); },
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  return { host, fake, dom, getClassifyCalls: () => classifyCalls };
}

test('classifyLargeFile is skipped only when the content is unchanged, re-run on any content or length change', async () => {
  const { host, dom, getClassifyCalls } = makeCountingHost();
  await withWindow(dom, async () => {
    await host.openDocument({ path: 'a.js', content: 'a'.repeat(20) });
    assert.equal(getClassifyCalls(), 1, 'first open scans');
    // Identical content (a refresh / auto-save no-op) → cache hit.
    await host.openDocument({ path: 'a.js', content: 'a'.repeat(20) });
    assert.equal(getClassifyCalls(), 1, 'an unchanged reopen reuses the cached classification');
    // Same length, different content (e.g. a minified <-> normal rewrite) → the
    // cache key is a content fingerprint, not text.length, so this must re-scan
    // (WIDE-053: it must NOT be treated as a cache hit).
    await host.openDocument({ path: 'a.js', content: 'b'.repeat(20) });
    assert.equal(getClassifyCalls(), 2, 'a same-length content rewrite re-runs the scan');
    // Different length → re-scan.
    await host.openDocument({ path: 'a.js', content: 'c'.repeat(21) });
    assert.equal(getClassifyCalls(), 3, 'a length change re-runs the scan');
  });
  host.dispose();
});

// ── TASK 2: applyLargeFileEditorMode skip across activations ──

test('the large-file mode re-spread is skipped between consecutive normal files and re-applied on a mode change', async () => {
  const { host, fake, dom } = makeHost();
  await withWindow(dom, async () => {
    await host.openDocument({ path: 'one.js', content: 'const a = 1;\n' });
    await host.openDocument({ path: 'two.js', content: 'const b = 2;\n' });
    await host.openDocument({ path: 'big.min.js', content: 'x'.repeat(300 * 1024) });

    host.activateDocument('one.js');
    const afterFirst = fake.updates.length;
    assert.equal(afterFirst, 1, 'first normal activation applies the mode once');

    host.activateDocument('two.js');
    host.activateDocument('one.js');
    assert.equal(fake.updates.length, afterFirst, 'consecutive normal activations skip the re-spread');

    host.activateDocument('big.min.js');
    assert.equal(fake.updates.length, afterFirst + 1, 'a normal→large switch re-applies');

    host.activateDocument('one.js');
    assert.equal(fake.updates.length, afterFirst + 2, 'a large→normal switch re-applies');
  });
  host.dispose();
});
