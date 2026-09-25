'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createIdePdfPane, createPdfjsLoader } = require('../renderer/features/renderer-ide-pdf-host');
const { createViewKeydownHandler } = require('../renderer/features/renderer-ide-commands');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'documents', 'text.pdf');

test('the PDF viewer imports only after its core global is ready, and concurrent loads share work', async () => {
  const imports = [];
  const core = { GlobalWorkerOptions: {} };
  let resolveCore;
  const pendingCore = new Promise(resolve => { resolveCore = resolve; });
  const load = createPdfjsLoader({
    resolveUrl: value => `file:///app/${value}`,
    importModule: url => {
      imports.push(url);
      return url.endsWith('/pdf.mjs') ? pendingCore : Promise.resolve({ PDFViewer: 'viewer' });
    },
  });
  const first = load();
  const second = load();
  assert.equal(first, second);
  assert.deepEqual(imports, ['file:///app/node_modules/pdfjs-dist/build/pdf.mjs']);
  resolveCore(core);
  const result = await first;
  assert.equal(result.pdfjs, core);
  assert.equal(result.viewer.PDFViewer, 'viewer');
  assert.equal(imports.length, 2);
  assert.equal(core.GlobalWorkerOptions.workerSrc, 'file:///app/node_modules/pdfjs-dist/build/pdf.worker.mjs');
  assert.equal(await load(), result);
});

test('a transient core import failure allows the PDF loader to retry', async () => {
  let calls = 0;
  const load = createPdfjsLoader({
    resolveUrl: value => value,
    importModule: async url => {
      if (++calls === 1) throw new Error('temporary load failure');
      return url.endsWith('/pdf.mjs') ? { GlobalWorkerOptions: {} } : { PDFViewer: 'viewer' };
    },
  });
  await assert.rejects(load(), /temporary load failure/);
  assert.equal((await load()).viewer.PDFViewer, 'viewer');
});

class FakeEventBus {
  constructor() {
    this.listeners = new Map();
    this.events = [];
  }

  on(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, detail) {
    this.events.push({ name, detail });
    for (const listener of this.listeners.get(name) || []) {
      listener(detail || {});
    }
  }
}

class FakePDFLinkService {
  constructor(options) {
    this.options = options;
    this.externalLinkTarget = null;
  }

  setDocument(document, baseUrl) {
    this.document = document;
    this.baseUrl = baseUrl;
  }

  setViewer(viewer) {
    this.viewer = viewer;
  }
}

class FakePDFFindController {
  constructor(options) {
    this.options = options;
  }
}

class FakePDFViewer {
  constructor(options) {
    this.options = options;
    this.currentPageNumber = 1;
    this.currentScaleValue = 1;
    this.annotationEditorMode = { mode: 0 };
    this.cleanupCalls = 0;
    FakePDFViewer.instances.push(this);
  }

  setDocument(document) {
    this.document = document;
    if (document) {
      this.options.eventBus.dispatch('pagesinit', { source: this });
    }
  }

  cleanup() {
    this.cleanupCalls += 1;
  }

  update() {
    this.updatedWhileVisible = !this.options.container.closest('.hidden');
  }
}
FakePDFViewer.instances = [];

function makeDocument(label = '') {
  const storage = {
    onSetModified: null,
    onResetModified: null,
    resetCalls: 0,
    size: 0,
    resetModified() {
      this.resetCalls += 1;
      this.onResetModified?.();
    },
  };
  return {
    label,
    numPages: 2,
    annotationStorage: storage,
    destroyCalls: 0,
    async saveDocument() {
      return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    },
    destroy() {
      this.destroyCalls += 1;
    },
  };
}

function makePdfjsHarness(options = {}) {
  const params = [];
  const tasks = [];
  const documents = [];
  let loadCount = 0;
  FakePDFViewer.instances = [];
  const pdfjs = {
    AnnotationEditorType: { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 },
    AnnotationMode: { ENABLE_FORMS: 2 },
    getDocument(loadParams) {
      params.push(loadParams);
      const document = makeDocument(`doc-${loadCount}`);
      if (options.annotationStorage) document.annotationStorage = options.annotationStorage;
      documents.push(document);
      const rejection = options.rejections?.[loadCount];
      loadCount += 1;
      const task = {
        destroyCalls: 0,
        promise: rejection ? Promise.reject(rejection) : Promise.resolve(document),
        destroy() {
          this.destroyCalls += 1;
          document.destroy();
        },
      };
      tasks.push(task);
      return task;
    },
  };
  const viewer = {
    EventBus: FakeEventBus,
    PDFLinkService: FakePDFLinkService,
    PDFFindController: FakePDFFindController,
    PDFViewer: FakePDFViewer,
  };
  return {
    documents,
    params,
    pdfjs,
    tasks,
    viewer,
    loadPdfjs: options.importError
      ? async () => { throw options.importError; }
      : async () => ({ pdfjs, viewer }),
  };
}

function makePane(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', {
    url: 'file:///D:/Projects/jenny/index.html',
  });
  const host = dom.window.document.getElementById('host');
  const harness = options.harness || makePdfjsHarness();
  const dirtyEvents = [];
  let saveRequests = 0;
  const pane = createIdePdfPane({
    getHost: () => host,
    loadPdfjs: harness.loadPdfjs,
    onDirtyChange: (filePath, dirty) => dirtyEvents.push([filePath, dirty]),
    onEdit: options.onEdit,
    onSaveRequest: () => { saveRequests += 1; },
  });
  return { dom, host, harness, pane, dirtyEvents, get saveRequests() { return saveRequests; } };
}

async function loadFixture(env, filePath = 'docs/text.pdf') {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const result = await env.pane.load(filePath, {
    base64: bytes.toString('base64'),
    size: bytes.length,
    mtimeMs: 123,
  });
  return { bytes, result };
}

test('Ctrl+S in a focused FreeText editor is saved by the pane after pdf.js commits it', async (t) => {
  const order = [];
  const env = makePane({ onEdit: () => order.push(`edit after ${env.saveRequests} saves`) });
  t.after(() => env.pane.dispose());
  const documentRef = env.dom.window.document;
  const viewKeydown = createViewKeydownHandler({ state: { ui: { activeView: 'ide' } }, saveActiveFile: () => order.push('view-save') });
  documentRef.addEventListener('keydown', viewKeydown, true);
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const note = documentRef.createElement('div');
  note.addEventListener('keydown', () => env.harness.documents[0].annotationStorage.onSetModified());
  FakePDFViewer.instances[0].options.viewer.appendChild(note);
  const event = new env.dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  note.dispatchEvent(event);
  assert.deepEqual(order, ['edit after 0 saves'], 'the #ideView capture handler defers to the pane');
  assert.equal(env.saveRequests, 1, 'the pane saves once, in the bubble phase after the commit');
  assert.equal(event.defaultPrevented, true);
});

function click(env, selector) {
  const element = env.host.querySelector(selector);
  assert.ok(element, `missing ${selector}`);
  element.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true }));
  return element;
}

test('load decodes exact bytes, uses hardened PDF.js options, and stays hidden until show', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  const { bytes, result } = await loadFixture(env);

  assert.deepEqual(result, { ok: true, pageCount: 2 });
  assert.deepEqual(Buffer.from(env.harness.params[0].data), bytes);
  assert.equal(env.harness.params[0].isEvalSupported, false);
  assert.equal(env.harness.params[0].enableXfa, false);
  assert.equal(env.harness.params[0].disableAutoFetch, true);
  assert.match(env.harness.params[0].cMapUrl, /\/cmaps\/$/);
  assert.match(env.harness.params[0].standardFontDataUrl, /\/standard_fonts\/$/);
  assert.match(env.harness.params[0].wasmUrl, /\/wasm\/$/);
  assert.equal(env.harness.params[0].cMapPacked, true);
  assert.ok(env.host.querySelector('.ide-pdf-pane.hidden'));
  assert.equal(FakePDFViewer.instances[0].currentScaleValue, 1, 'loading does not measure a hidden pane');
  assert.equal(env.pane.hasDocument('docs/text.pdf'), true);
  assert.deepEqual(env.pane.getState('docs/text.pdf'), {
    pageNumber: 1,
    pageCount: 2,
    scale: 'page-width',
    editorMode: 'none',
    findQuery: '',
    findMatch: null,
  });
});

test('show switches document containers and hide conceals the pane', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env, 'one.pdf');
  await loadFixture(env, 'two.pdf');

  assert.equal(env.pane.show('one.pdf'), true);
  const docs = [...env.host.querySelectorAll('.ide-pdf-doc')];
  assert.equal(env.host.querySelector('.ide-pdf-pane').classList.contains('hidden'), false);
  assert.equal(docs[0].classList.contains('hidden'), false);
  assert.equal(docs[1].classList.contains('hidden'), true);
  assert.equal(FakePDFViewer.instances[0].currentScaleValue, 'page-width');
  assert.equal(FakePDFViewer.instances[0].updatedWhileVisible, true, 'activation starts rendering after showing the pane');

  assert.equal(env.pane.show('two.pdf'), true);
  assert.equal(docs[0].classList.contains('hidden'), true);
  assert.equal(docs[1].classList.contains('hidden'), false);
  assert.equal(env.pane.show('missing.pdf'), false);
  env.pane.hide();
  assert.equal(env.host.querySelector('.ide-pdf-pane').classList.contains('hidden'), true);
});

test('dirty transitions are deduplicated and markSaved resets annotation storage', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  const storage = env.harness.documents[0].annotationStorage;

  storage.onSetModified();
  storage.onSetModified();
  assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true]]);
  assert.equal(env.pane.isDirty('docs/text.pdf'), true);

  env.pane.markSaved('docs/text.pdf');
  assert.equal(storage.resetCalls, 3, 'each edit re-arms notifications, then markSaved resets');
  assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true], ['docs/text.pdf', false]]);
  assert.equal(env.pane.isDirty('docs/text.pdf'), false);
});

test('exportBytes returns saved PDF bytes as base64 and unknown paths return null', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  assert.equal(await env.pane.exportBytes('docs/text.pdf'), 'JVBERi0=');
  assert.equal(await env.pane.exportBytes('missing.pdf'), null);
});

test('toolbar controls pages, zoom, fit, and editor modes', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pdfViewer = FakePDFViewer.instances[0];

  click(env, '[data-ide-pdf-action="next"]');
  assert.equal(pdfViewer.currentPageNumber, 2);
  assert.equal(env.host.querySelector('.ide-pdf-page-readout').textContent, '2 / 2');
  click(env, '[data-ide-pdf-action="prev"]');
  assert.equal(pdfViewer.currentPageNumber, 1);

  const pageField = env.host.querySelector('[data-ide-pdf-page]');
  pageField.value = '2';
  pageField.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(pdfViewer.currentPageNumber, 2);

  pdfViewer.currentScaleValue = 2;
  click(env, '[data-ide-pdf-action="zoom-in"]');
  assert.equal(pdfViewer.currentScaleValue, 2.5);
  click(env, '[data-ide-pdf-action="fit-width"]');
  assert.equal(pdfViewer.currentScaleValue, 'page-width');
  click(env, '[data-ide-pdf-action="fit-page"]');
  assert.equal(pdfViewer.currentScaleValue, 'page-fit');

  const modes = { highlight: 9, text: 3, draw: 15, select: 0 };
  for (const [action, mode] of Object.entries(modes)) {
    const button = click(env, `[data-ide-pdf-action="${action}"]`);
    assert.equal(pdfViewer.annotationEditorMode.mode, mode);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
  }
});

test('search dispatches find and match-count events update the readout', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pdfViewer = FakePDFViewer.instances[0];
  const eventBus = pdfViewer.options.eventBus;
  const findField = env.host.querySelector('[data-ide-pdf-find]');

  findField.value = 'needle';
  findField.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const findEvent = eventBus.events.find((event) => event.name === 'find');
  assert.equal(findEvent.detail.query, 'needle');
  assert.equal(findEvent.detail.highlightAll, true);
  assert.equal(findEvent.detail.findPrevious, false);

  eventBus.dispatch('updatefindmatchescount', { matchesCount: { current: 2, total: 5 } });
  assert.equal(env.host.querySelector('.ide-pdf-find-readout').textContent, '2 of 5');
  assert.deepEqual(env.pane.getState('docs/text.pdf').findMatch, { current: 2, total: 5 });
});

test('Ctrl+S inside the pane requests save and prevents default', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const event = new env.dom.window.KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  env.host.querySelector('.ide-pdf-pane').dispatchEvent(event);
  assert.equal(env.saveRequests, 1);
  assert.equal(event.defaultPrevented, true);
});

test('load failures map to stable codes and reveal the error state', async (t) => {
  const cases = [
    { harness: makePdfjsHarness({ importError: new Error('no engine') }), code: 'document_engine_unavailable' },
    { harness: makePdfjsHarness({ rejections: [{ name: 'InvalidPDFException' }] }), code: 'document_corrupt' },
    { harness: makePdfjsHarness({ rejections: [{ name: 'PasswordException' }] }), code: 'document_unsupported' },
  ];
  for (const item of cases) {
    const env = makePane({ harness: item.harness });
    t.after(() => env.pane.dispose());
    const result = await env.pane.load(`${item.code}.pdf`, { base64: 'JVBERg==', size: 4, mtimeMs: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, item.code);
    const error = env.host.querySelector('.ide-pdf-error');
    assert.equal(error.classList.contains('hidden'), false);
    if (item.code === 'document_unsupported') {
      assert.match(result.message, /password-protected/i);
    }
  }
});

test('reload replaces resources, close removes a document, and dispose removes the pane', async () => {
  const env = makePane();
  await loadFixture(env);
  env.harness.documents[0].annotationStorage.onSetModified();
  await loadFixture(env);

  assert.equal(env.harness.tasks[0].destroyCalls, 1);
  assert.equal(env.harness.documents[0].destroyCalls, 1);
  assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true], ['docs/text.pdf', false]]);
  assert.equal(env.host.querySelectorAll('.ide-pdf-doc').length, 1);

  env.pane.close('docs/text.pdf');
  assert.equal(env.harness.tasks[1].destroyCalls, 1);
  assert.equal(env.host.querySelectorAll('.ide-pdf-doc').length, 0);
  assert.equal(env.pane.hasDocument('docs/text.pdf'), false);

  await loadFixture(env, 'other.pdf');
  env.pane.dispose();
  assert.equal(env.host.querySelector('.ide-pdf-pane'), null);
});

test('toolbar inputs and buttons are emitted by inventory primitives', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);

  const controls = [...env.host.querySelectorAll('button, input')];
  assert.ok(controls.length > 0);
  for (const control of controls) {
    if (control.tagName === 'BUTTON') {
      assert.ok(control.matches('.ide-pdf-button[data-ide-pdf-action]'));
    } else {
      assert.ok(control.matches('.inv-text-field-control[data-ide-pdf-page], .inv-text-field-control[data-ide-pdf-find]'));
    }
  }
});

// ── Astra review regressions (2026-09-22) ──

for (const failExport of [false, true]) {
  test(`real PDF storage reports edits across a ${failExport ? 'failed' : 'successful'} pending export`, async (t) => {
    // Use the pinned library's real modification latch, not direct callback calls.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/documents/annotated.pdf'))),
    });
    t.after(() => task.destroy());
    const pdf = await task.promise;
    const fields = await (await pdf.getPage(1)).getAnnotations();
    const fieldId = fields.find((item) => item.fieldName === 'note').id;
    const storage = pdf.annotationStorage;
    let revision = 0;
    const env = makePane({
      harness: makePdfjsHarness({ annotationStorage: storage }),
      onEdit: () => { revision += 1; },
    });
    t.after(() => { env.pane.dispose(); env.dom.window.close(); });
    await loadFixture(env);
    storage.setValue(fieldId, { value: 'first' });
    const savedRevision = revision;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    env.harness.documents[0].saveDocument = async () => {
      const snapshot = storage.getRawValue(fieldId).value;
      try {
        await gate;
        if (failExport) throw new Error('export failed');
        return new Uint8Array(Buffer.from(`%PDF-${snapshot}`));
      } finally {
        storage.resetModified(); // The real saveDocument completion contract.
      }
    };
    const exporting = env.pane.exportBytes('docs/text.pdf');
    storage.setValue(fieldId, { value: 'during export' });
    release();
    if (failExport) await assert.rejects(exporting, /export failed/);
    else assert.equal(Buffer.from(await exporting, 'base64').toString(), '%PDF-first');
    assert.equal(revision, savedRevision + 1, 'the lifecycle fence sees the newer edit');
    assert.equal(env.pane.isDirty('docs/text.pdf'), true);
    storage.setValue(fieldId, { value: 'during write or retry' });
    assert.equal(revision, savedRevision + 2);
    storage.setValue(fieldId, { value: 'during write or retry' });
    assert.equal(revision, savedRevision + 2, 'unchanged values are not edits');
    assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true]]);
    const latest = await pdf.saveDocument();
    const reopenedTask = pdfjs.getDocument({ data: latest });
    t.after(() => reopenedTask.destroy());
    const reopened = await reopenedTask.promise;
    const savedFields = await (await reopened.getPage(1)).getAnnotations();
    assert.equal(savedFields.find((item) => item.fieldName === 'note').fieldValue,
      'during write or retry', 'a subsequent real PDF save/reopen preserves the latest edit');
    env.pane.markSaved('docs/text.pdf');
    assert.equal(env.pane.isDirty('docs/text.pdf'), false);
  });
}

test('saveDocument resetting pdf.js modified state never clears the pane dirty flag', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  const storage = env.harness.documents[0].annotationStorage;
  storage.onSetModified();
  // pdf.js saveDocument() calls resetModified() in its finally block
  storage.resetModified();
  assert.equal(env.pane.isDirty('docs/text.pdf'), true, 'dirty survives the export-time reset');
  assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true]]);
  env.pane.markSaved('docs/text.pdf');
  assert.equal(env.pane.isDirty('docs/text.pdf'), false);
});

test('every annotation mutation reports an edit and external links are disabled on the real field', async (t) => {
  const edits = [];
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'file:///D:/Projects/jenny/index.html' });
  const harness = makePdfjsHarness();
  const pane = createIdePdfPane({
    getHost: () => dom.window.document.getElementById('host'),
    loadPdfjs: harness.loadPdfjs,
    onEdit: (filePath) => edits.push(filePath),
  });
  t.after(() => pane.dispose());
  const bytes = fs.readFileSync(FIXTURE_PATH);
  await pane.load('docs/text.pdf', { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 });
  const record = harness.documents[0];
  record.annotationStorage.onSetModified();
  record.annotationStorage.onSetModified();
  assert.deepEqual(edits, ['docs/text.pdf', 'docs/text.pdf'], 'edits are not deduplicated like dirty transitions');
  const linkService = FakePDFViewer.instances[0].options.linkService;
  assert.equal(linkService.externalLinkEnabled, false, 'assigned after construction, not passed as an option');
  assert.equal(Object.hasOwn(linkService.options, 'externalLinkEnabled'), false);
});

test('a document over the page budget is refused and its loading task destroyed', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  const original = env.harness.pdfjs.getDocument;
  env.harness.pdfjs.getDocument = (params) => {
    const task = original.call(env.harness.pdfjs, params);
    task.promise = task.promise.then((doc) => { doc.numPages = 5001; return doc; });
    return task;
  };
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const result = await env.pane.load('docs/text.pdf', { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'document_too_large');
  assert.equal(env.harness.tasks[0].destroyCalls, 1);
  assert.equal(env.pane.hasDocument('docs/text.pdf'), false);
});

test('a vetoed reload keeps the live record, its dirty state, and its resources', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.harness.documents[0].annotationStorage.onSetModified();
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const result = await env.pane.load('docs/text.pdf', {
    base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 2, shouldCommit: () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'document_stale');
  assert.equal(env.pane.isDirty('docs/text.pdf'), true);
  assert.equal(env.harness.documents[0].destroyCalls, 0, 'live document untouched');
  assert.equal(env.harness.tasks[1].destroyCalls, 1, 'candidate destroyed');
  assert.equal(env.host.querySelectorAll('.ide-pdf-doc').length, 1);
  assert.deepEqual(env.dirtyEvents, [['docs/text.pdf', true]]);

  const committed = await env.pane.load('docs/text.pdf', { base64: 'JVBERi0=', size: 5, mtimeMs: 3, shouldCommit: () => true });
  assert.equal(committed.ok, true);
  assert.equal(env.harness.documents[0].destroyCalls, 1, 'previous record destroyed only on commit');
  assert.equal(env.pane.isDirty('docs/text.pdf'), false);
});

test('viewer is built with a highlight palette so pdf.js can name highlight colors', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  const palette = FakePDFViewer.instances[0].options.annotationEditorHighlightColors;
  // pdf.js splits on ',' then '=' and maps name -> color; a missing option
  // leaves highlightColorNames null and every new highlight throws.
  const pairs = String(palette || '').split(',').map((pair) => pair.split('=').map((part) => part.trim()));
  assert.ok(pairs.length >= 1);
  for (const [name, color] of pairs) {
    assert.match(name, /^[a-z]+$/);
    assert.match(color, /^#[0-9A-F]{6}$/i);
  }
});
