'use strict';

/* Editor-host diagnostics surface (getMarkers / onMarkersChanged): the Monaco
 * marker access + jenny-workspace model-URI -> workspace-relative-path mapping
 * that the Problems panel used to own. Drives the host factory directly with a
 * minimal fake Monaco (boot via openDocument so monacoApi is live), then reads
 * markers and fires the change fan-out. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

// Minimal Monaco namespace: enough for ensureEditor + openDocument to boot, plus
// the marker surface getMarkers/onMarkersChanged read. state.markers is mutable;
// fireMarkers() invokes whatever onDidChangeMarkers listener the host wired.
function makeFakeMonaco() {
  const captured = { markerCb: null };
  const state = { markers: [] };
  const model = {
    getValue: () => '',
    setValue() {},
    getAlternativeVersionId: () => 1,
    getLanguageId: () => 'javascript',
    dispose() {},
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({ addCommand() {}, onDidChangeModelContent() {}, dispose() {} }),
      getModel: () => null,
      createModel: () => model,
      getModelMarkers: () => state.markers,
      onDidChangeMarkers: (cb) => { captured.markerCb = cb; return { dispose() {} }; },
    },
  };
  return { api, state, fireMarkers: () => captured.markerCb && captured.markerCb() };
}

function makeHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...require('../renderer/features/renderer-monaco-editor-utils'),
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    // Stub the overlay panes so node doesn't load the browser-only host modules.
    imageHostUtils: {},
    previewHostUtils: {},
  });
  return { host, fake, dom };
}

async function bootHost() {
  const ctx = makeHost();
  // openDocument runs ensureEditor, which sets monacoApi and wires the marker fan-out.
  await ctx.host.openDocument({ path: 'src/app.js', content: '' });
  return ctx;
}

function rawMarker(scheme, path, severity, extra) {
  return Object.assign({
    resource: scheme === null ? null : { scheme, path },
    severity,
    message: 'msg',
    startLineNumber: 3,
    startColumn: 5,
    source: 'ts',
    code: '',
  }, extra || {});
}

test('getMarkers maps file-model markers to the path-centric view-model', async () => {
  const { host, fake } = await bootHost();
  fake.state.markers = [
    rawMarker('jenny-workspace', '/src/app.js', 8, {
      message: 'Cannot find name foo', code: '2304', startLineNumber: 12, startColumn: 7,
    }),
  ];
  assert.deepEqual(host.getMarkers(), [
    { path: 'src/app.js', severity: 'error', message: 'Cannot find name foo', line: 12, column: 7, source: 'ts', code: '2304' },
  ]);
});

test('getMarkers keeps only jenny-workspace file models (other schemes / no resource skipped)', async () => {
  const { host, fake } = await bootHost();
  fake.state.markers = [
    rawMarker('jenny-workspace', '/src/app.js', 8),
    rawMarker('inmemory', '/1', 8),
    rawMarker(null, '', 4),
  ];
  const out = host.getMarkers();
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'src/app.js');
});

test('getMarkers buckets each MarkerSeverity value', async () => {
  const { host, fake } = await bootHost();
  fake.state.markers = [
    rawMarker('jenny-workspace', '/a.js', 8),
    rawMarker('jenny-workspace', '/b.js', 4),
    rawMarker('jenny-workspace', '/c.js', 2),
    rawMarker('jenny-workspace', '/d.js', 1),
    rawMarker('jenny-workspace', '/e.js', 99),
  ];
  assert.deepEqual(host.getMarkers().map((m) => m.severity), ['error', 'warning', 'info', 'hint', 'info']);
});

test('getMarkers strips only the leading slash (Uri.path is already decoded, never re-decoded)', async () => {
  const { host, fake } = await bootHost();
  fake.state.markers = [
    rawMarker('jenny-workspace', '/src/my file.js', 8),
    rawMarker('jenny-workspace', '/src/a%20b.js', 4),
  ];
  assert.deepEqual(host.getMarkers().map((m) => m.path), ['src/my file.js', 'src/a%20b.js']);
});

test('getMarkers unwraps an object-shaped marker code', async () => {
  const { host, fake } = await bootHost();
  fake.state.markers = [rawMarker('jenny-workspace', '/a.js', 8, { code: { value: 'TS2304', target: {} } })];
  assert.equal(host.getMarkers()[0].code, 'TS2304');
});

test('getMarkers returns [] before Monaco boots (textarea fallback)', () => {
  const { host } = makeHost(); // never openDocument -> monacoApi stays null
  assert.deepEqual(host.getMarkers(), []);
});

test('onMarkersChanged fans out marker events; the disposable detaches the listener', async () => {
  const { host, fake } = await bootHost();
  let hits = 0;
  const sub = host.onMarkersChanged(() => { hits += 1; });
  fake.fireMarkers();
  fake.fireMarkers();
  assert.equal(hits, 2, 'listener fired on each marker change');
  sub.dispose();
  fake.fireMarkers();
  assert.equal(hits, 2, 'no more fires after dispose');
});

test('onMarkersChanged ignores a non-function callback', async () => {
  const { host, fake } = await bootHost();
  const sub = host.onMarkersChanged(null);
  assert.equal(typeof sub.dispose, 'function');
  assert.doesNotThrow(() => fake.fireMarkers());
});

// ── WIDE-054: monaco.editor.onDidChangeMarkers targets Monaco's GLOBAL
// namespace (not this editor instance), so a host must retain that disposable
// and release it exactly once on dispose(), or repeated create/dispose cycles
// (renderer rebootstrap) leak listeners on the shared namespace forever. ──

function makeSharedFakeMonaco() {
  const counts = { subscribed: 0, disposed: 0 };
  const model = { getValue: () => '', setValue() {}, getAlternativeVersionId: () => 1, getLanguageId: () => 'javascript', dispose() {} };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({ addCommand() {}, onDidChangeModelContent() {}, dispose() {} }),
      getModel: () => null,
      createModel: () => model,
      getModelMarkers: () => [],
      onDidChangeMarkers: () => {
        counts.subscribed += 1;
        return { dispose() { counts.disposed += 1; } };
      },
    },
  };
  return { api, counts };
}

function makeSharingHost(api) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  return createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: { ...require('../renderer/features/renderer-monaco-editor-utils'), ensureMonacoEditorApi: async () => api, normalizeEditorLanguage: () => 'javascript' },
    imageHostUtils: {},
    previewHostUtils: {},
  });
}

test('dispose() releases the global marker subscription exactly once per host lifecycle', async () => {
  const { api, counts } = makeSharedFakeMonaco();

  const host1 = makeSharingHost(api);
  await host1.openDocument({ path: 'a.js', content: '' });
  assert.equal(counts.subscribed, 1, 'boot subscribes once');
  host1.dispose();
  assert.equal(counts.disposed, 1, 'dispose releases the subscription');

  // A second dispose() call must not double-release (subscription was nulled).
  host1.dispose();
  assert.equal(counts.disposed, 1, 'a repeat dispose is a no-op');

  // Renderer rebootstrap: a fresh host instance against the same global Monaco
  // namespace re-subscribes and, on its own dispose, releases its own handle -
  // the running total must stay in lockstep (no accumulation across cycles).
  const host2 = makeSharingHost(api);
  await host2.openDocument({ path: 'b.js', content: '' });
  assert.equal(counts.subscribed, 2, 'a fresh host resubscribes');
  host2.dispose();
  assert.equal(counts.disposed, 2, 'the second host releases its own subscription too');
});
