'use strict';

// new-test-file: a new surface (the DOCX pane's Read / Edit / Pages views);
// renderer-ide-docx-host.test.js is at 572 of its 600-line cap.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const modelUtils = require('../renderer/features/renderer-ide-docx-model');
const renderUtils = require('../renderer/features/renderer-ide-docx-render');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');

const FIXTURES = path.join(__dirname, 'fixtures', 'documents');
const MODE = (name) => `[data-ide-docx-mode="${name}"]`;

function fixtureSource(name) {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 };
}

// docx-preview builds its DOM through the global document, so each harness
// points the globals at its own jsdom window (tests in this file run in turn).
function installDomGlobals(dom) {
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, DOMParser: window.DOMParser, Node: window.Node, HTMLElement: window.HTMLElement,
  });
  globalThis.JSZip = require('jszip');
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function harness(t, options = {}) {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  installDomGlobals(dom);
  const host = dom.window.document.querySelector('#host');
  const logs = [];
  let saves = 0;
  const pane = createIdeDocxPane({
    getHost: () => host,
    onSaveRequest: () => { saves += 1; },
    log: (level, event, fields) => logs.push({ level, event, fields }),
    zipUtils,
    modelUtils,
    renderUtils,
    getWorkspaceFsApi: () => options.api ?? null,
    loadPdfViewer: options.loadPdfViewer,
    scriptLoader: options.scriptLoader,
    docxPreview: options.docxPreview,
  });
  t.after(() => { pane.dispose(); dom.window.close(); });
  return { dom, host, pane, logs, saveCount: () => saves };
}

async function open(h, name, filePath = `C:/${name}`) {
  assert.deepEqual(await h.pane.load(filePath, fixtureSource(name)), { ok: true });
  assert.equal(h.pane.show(filePath), true);
  return filePath;
}

const readShadow = (h) => h.host.querySelector('.ide-docx-read:not(.hidden) .ide-docx-read-body')?.shadowRoot || null;
const readText = (h) => h.host.querySelector('.ide-docx-read-body')?.shadowRoot?.textContent || '';
const click = (h, selector) => h.host.querySelector(selector).dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a document opens in Read by default and docx-preview draws it, header included', async (t) => {
  const h = harness(t);
  await open(h, 'images-headers.docx');
  const pane = h.host.querySelector('.ide-docx-pane');
  assert.equal(pane.dataset.mode, 'read');
  assert.equal(h.host.querySelector(MODE('read')).getAttribute('aria-pressed'), 'true');
  assert.equal(h.host.querySelector(MODE('edit')).getAttribute('aria-pressed'), 'false');
  await waitFor(() => readText(h).includes('Confidential header'), 'the read view');
  const shadow = readShadow(h);
  assert.ok(shadow.querySelector('.docx-wrapper'), 'docx-preview wrapper');
  assert.match(shadow.textContent, /Bookmarked paragraph with a link/);
});

test('with no require, Read loads JSZip then docx-preview as scripts with Monaco\'s AMD marker hidden', async (t) => {
  const amdMarker = { jQuery: true };
  const define = () => {};
  define.amd = amdMarker;
  const loads = [];
  const scriptLoader = {
    ensureScript: async ({ src, isReady }) => {
      loads.push({ src, amd: define.amd });
      if (src.endsWith('jszip.min.js')) globalThis.JSZip = require('jszip');
      if (src.endsWith('docx-preview.min.js')) globalThis.docx = require('docx-preview');
      return isReady();
    },
  };
  const h = harness(t, { scriptLoader });
  delete globalThis.JSZip;
  globalThis.define = define;
  t.after(() => { delete globalThis.define; delete globalThis.docx; globalThis.JSZip = require('jszip'); });
  await open(h, 'images-headers.docx');
  await waitFor(() => readText(h).includes('Confidential header'), 'the read view');
  assert.deepEqual(loads.map((entry) => entry.src),
    ['node_modules/jszip/dist/jszip.min.js', 'node_modules/docx-preview/dist/docx-preview.min.js']);
  assert.ok(loads.every((entry) => entry.amd === undefined), 'define.amd is hidden while the two scripts load');
  assert.equal(define.amd, amdMarker, 'the AMD marker comes back after the loads');
});

test('Edit shows the patch editor and its toolbar and hides the read view', async (t) => {
  const h = harness(t);
  await open(h, 'paragraphs.docx');
  await waitFor(() => readText(h).includes('Quarterly summary'), 'the read view');
  click(h, MODE('edit'));
  assert.equal(h.host.querySelector('.ide-docx-pane').dataset.mode, 'edit');
  assert.equal(h.host.querySelector(MODE('edit')).getAttribute('aria-pressed'), 'true');
  const editor = h.host.querySelector('.ide-docx-doc:not(.hidden)');
  assert.equal(editor.getAttribute('contenteditable'), 'true');
  assert.ok(h.host.querySelector('.ide-docx-toolbar'));
  assert.equal(h.host.querySelector('.ide-docx-read').classList.contains('hidden'), true);
  click(h, MODE('read'));
  assert.equal(h.host.querySelector('.ide-docx-read').classList.contains('hidden'), false);
});

test('a dirty document reads from the bytes the editor would save', async (t) => {
  const h = harness(t);
  const filePath = await open(h, 'paragraphs.docx');
  await waitFor(() => readText(h).includes('Plain bold'), 'the first read render');
  click(h, MODE('edit'));
  const doc = h.host.querySelector('.ide-docx-doc:not(.hidden)');
  const runText = doc.querySelectorAll('.ide-docx-p')[1].querySelector('.ide-docx-run').firstChild;
  h.dom.window.getSelection().setBaseAndExtent(runText, 6, runText, 6);
  const event = new h.dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: 'X', bubbles: true, cancelable: true });
  doc.dispatchEvent(event);
  assert.equal(h.pane.isDirty(filePath), true);
  click(h, MODE('read'));
  await waitFor(() => readText(h).includes('Plain Xbold'), 'the dirty re-render');
});

test('links inside the read view never navigate; #anchors scroll inside the shadow root', async (t) => {
  const h = harness(t);
  await open(h, 'images-headers.docx');
  await waitFor(() => readText(h).includes('Confidential header'), 'the read view');
  const shadow = readShadow(h);
  const external = shadow.querySelector('a[href^="https://"]');
  assert.ok(external, 'the fixture has an external link');
  const clickEvent = new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  external.dispatchEvent(clickEvent);
  assert.equal(clickEvent.defaultPrevented, true);
  const auxEvent = new h.dom.window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  external.dispatchEvent(auxEvent);
  assert.equal(auxEvent.defaultPrevented, true);

  let scrolled = 0;
  shadow.getElementById('anchor').scrollIntoView = () => { scrolled += 1; };
  const internal = h.dom.window.document.createElement('a');
  internal.setAttribute('href', '#anchor');
  internal.textContent = 'jump';
  shadow.querySelector('article').appendChild(internal);
  const internalEvent = new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  internal.dispatchEvent(internalEvent);
  assert.equal(internalEvent.defaultPrevented, true);
  assert.equal(scrolled, 1);
});

test('Pages is disabled with its reason when the bridge has no engine', async (t) => {
  const unavailable = 'Pages needs Microsoft Word or LibreOffice installed.';
  const cases = [
    ['no bridge method', {}],
    ['no engines', { getDocumentPageEngines: async () => ({ engines: [], enabled: true }) }],
    ['switched off', { getDocumentPageEngines: async () => ({ engines: ['word'], enabled: false }) }],
    ['a rejected query', { getDocumentPageEngines: async () => { throw new Error('boom'); } }],
  ];
  for (const [label, api] of cases) {
    const h = harness(t, { api });
    await open(h, 'paragraphs.docx');
    const button = h.host.querySelector(MODE('pages'));
    await waitFor(() => button.disabled && button.title === unavailable, `Pages disabled for ${label}`);
    click(h, MODE('pages'));
    assert.equal(h.host.querySelector('.ide-docx-pane').dataset.mode, 'read', `${label}: the mode did not change`);
  }
  const ok = harness(t, { api: { getDocumentPageEngines: async () => ({ engines: ['word'], enabled: true }) } });
  await open(ok, 'paragraphs.docx');
  const button = ok.host.querySelector(MODE('pages'));
  await waitFor(() => !button.disabled, 'Pages enabled');
});

test('Open in default app calls the bridge with the open path and is disabled without it', async (t) => {
  const calls = [];
  const h = harness(t, { api: { openInDefaultApp: async (arg) => { calls.push(arg); return { ok: true }; } } });
  const filePath = await open(h, 'paragraphs.docx');
  click(h, '[data-ide-docx-open-default]');
  await waitFor(() => calls.length === 1, 'the bridge call');
  assert.deepEqual(calls, [{ path: filePath }]);
  const bare = harness(t);
  await open(bare, 'paragraphs.docx');
  assert.equal(bare.host.querySelector('[data-ide-docx-open-default]').disabled, true);
});

test('Pages shows a busy message with Retry, then retries', async (t) => {
  let renders = 0;
  const seen = [];
  const api = {
    getDocumentPageEngines: async () => ({ engines: ['libreoffice'], enabled: true }),
    renderDocumentPages: async (arg) => { renders += 1; seen.push(arg.base64); return { ok: false, reason: 'busy' }; },
  };
  const h = harness(t, { api });
  await open(h, 'paragraphs.docx');
  const button = h.host.querySelector(MODE('pages'));
  await waitFor(() => !button.disabled, 'Pages enabled');
  click(h, MODE('pages'));
  const status = () => h.host.querySelector('.ide-docx-pages:not(.hidden) .ide-docx-view-status')?.textContent || '';
  await waitFor(() => status().includes('Another document is being converted. Try again in a moment.'), 'the busy message');
  assert.equal(seen[0], fixtureSource('paragraphs.docx').base64, 'a clean document sends the bytes it was loaded from');
  assert.ok(h.host.querySelector('[data-ide-docx-pages-retry]'));
  click(h, '[data-ide-docx-pages-retry]');
  await waitFor(() => renders === 2, 'the retry');
});

test('Pages failure reasons map to their messages', async (t) => {
  const expected = {
    timeout: 'Making pages took too long.',
    too_large: 'This document is too large to convert.',
    failed: 'Pages could not be made from this document.',
    no_engine: 'Pages could not be made from this document.',
  };
  for (const [reason, message] of Object.entries(expected)) {
    const h = harness(t, {
      api: {
        getDocumentPageEngines: async () => ({ engines: ['word'], enabled: true }),
        renderDocumentPages: async () => ({ ok: false, reason }),
      },
    });
    await open(h, 'paragraphs.docx');
    await waitFor(() => !h.host.querySelector(MODE('pages')).disabled, 'Pages enabled');
    click(h, MODE('pages'));
    await waitFor(() => (h.host.querySelector('.ide-docx-pages .ide-docx-view-status')?.textContent || '').includes(message), `the ${reason} message`);
  }
});

function fakePdfRuntime(record) {
  return {
    decodeBase64: (value) => new Uint8Array(Buffer.from(value, 'base64')),
    repoUrl: (relative) => `app://${relative}`,
    createPdfjsLoader: () => async () => ({
      pdfjs: {
        getDocument: (options) => {
          record.options = options;
          const pdfDocument = { destroy: async () => { record.destroyed += 1; }, numPages: 1 };
          record.documents.push(pdfDocument);
          return { promise: Promise.resolve(pdfDocument), destroy: async () => {} };
        },
      },
      viewer: {},
    }),
    createViewerParts: (_modules, parts) => {
      record.parts.push(parts);
      const listeners = new Map();
      const eventBus = {
        on: (name, listener) => listeners.set(name, listener),
        off: () => {},
      };
      return {
        eventBus,
        linkService: { setDocument: () => {} },
        pdfViewer: {
          pagesPromise: Promise.resolve(),
          cleanup: () => {},
          update: () => {},
          setDocument: () => queueMicrotask(() => listeners.get('pagesinit')?.()),
          currentScaleValue: '',
        },
      };
    },
  };
}

test('Pages shows the converted PDF read-only and frees it on close', async (t) => {
  const record = { destroyed: 0, documents: [], parts: [] };
  const pdfBase64 = Buffer.from('%PDF-1.4 fake').toString('base64');
  const api = {
    getDocumentPageEngines: async () => ({ engines: ['word', 'libreoffice'], enabled: true }),
    renderDocumentPages: async () => ({ ok: true, base64: pdfBase64, engine: 'word' }),
  };
  const h = harness(t, { api, loadPdfViewer: async () => fakePdfRuntime(record) });
  const filePath = await open(h, 'paragraphs.docx');
  await waitFor(() => !h.host.querySelector(MODE('pages')).disabled, 'Pages enabled');
  click(h, MODE('pages'));
  await waitFor(() => record.parts.length === 1, 'the pdf viewer');
  assert.deepEqual(Array.from(record.options.data), Array.from(Buffer.from('%PDF-1.4 fake')));
  assert.equal(record.options.isEvalSupported, false);
  assert.ok(record.parts[0].container.closest('.ide-docx-pages'), 'the viewer lives in the pages container');
  assert.equal(record.destroyed, 0);
  h.pane.close(filePath);
  assert.equal(record.destroyed, 1, 'the pdf.js document is destroyed on close');
  assert.equal(h.host.querySelector('.ide-docx-pages'), null);
});

test('without a host loader, Pages lazy-loads the PDF runtime and its stylesheet once', async (t) => {
  const record = { destroyed: 0, documents: [], parts: [] };
  const loaded = [];
  const scriptLoader = {
    async ensureScript({ src, isReady }) {
      loaded.push(src);
      if (src.includes('pdf')) globalThis.rendererIdePdfRuntime = fakePdfRuntime(record);
      return isReady();
    },
  };
  t.after(() => { delete globalThis.rendererIdePdfRuntime; });
  const api = {
    getDocumentPageEngines: async () => ({ engines: ['libreoffice'], enabled: true }),
    renderDocumentPages: async () => ({ ok: true, base64: Buffer.from('%PDF-1.4').toString('base64'), engine: 'libreoffice' }),
  };
  const h = harness(t, { api, scriptLoader });
  await open(h, 'paragraphs.docx');
  await waitFor(() => !h.host.querySelector(MODE('pages')).disabled, 'Pages enabled');
  click(h, MODE('pages'));
  await waitFor(() => record.parts.length === 1, 'the pdf viewer');
  // The Read view's docx-preview script goes through the same loader; the PDF runtime loads once.
  assert.deepEqual(loaded.filter((src) => src.includes('pdf')), ['renderer/features/renderer-ide-pdf-runtime.js']);
  const links = h.dom.window.document.head.querySelectorAll('link[data-ide-document-style="styles/ide-pdf-pane.css"]');
  assert.equal(links.length, 1);
});

test('a read render that finishes after close is discarded', async (t) => {
  const gate = deferred();
  const rendered = [];
  const docxPreview = {
    renderAsync: async (_bytes, body, style) => {
      rendered.push({ body, style });
      await gate.promise;
      body.appendChild(body.ownerDocument.createElement('p')).textContent = 'late';
    },
  };
  const h = harness(t, { docxPreview });
  const filePath = await open(h, 'paragraphs.docx');
  await waitFor(() => rendered.length === 1, 'the render to start');
  h.pane.close(filePath);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.host.querySelector('.ide-docx-read'), null);
  assert.equal(rendered[0].body.isConnected, false, 'the late result is not attached anywhere');
  assert.equal(h.logs.some((entry) => entry.event === 'ide.docx_read_failed'), false);
});

test('the read view drops document resources that are not blob: or data:', async (t) => {
  const docxPreview = {
    renderAsync: async (_bytes, body, style) => {
      const doc = body.ownerDocument;
      style.appendChild(doc.createElement('style')).textContent = '.a{background:url(file://share/x.png)} .b{background:url(blob:ok)} @import "http://x/y.css";';
      const shape = body.appendChild(doc.createElement('div'));
      shape.setAttribute('style', 'background-image:url("file://share/y.png");color:red');
      body.appendChild(doc.createElement('img')).setAttribute('src', 'file:///C:/secret.png');
      body.appendChild(doc.createElement('img')).setAttribute('src', 'data:image/png;base64,AA==');
      const link = body.appendChild(doc.createElement('a'));
      link.setAttribute('href', 'https://example.test/');
      link.textContent = 'marker';
    },
  };
  const h = harness(t, { docxPreview });
  await open(h, 'paragraphs.docx');
  await waitFor(() => readText(h).includes('marker'), 'the read view');
  const shadow = readShadow(h);
  const css = shadow.querySelector('style').textContent;
  assert.doesNotMatch(css, /file:|@import/);
  assert.match(css, /url\(blob:ok\)/);
  assert.equal(shadow.querySelector('div[style]').getAttribute('style'), 'background-image:none;color:red');
  assert.deepEqual([...shadow.querySelectorAll('img')].map((img) => img.getAttribute('src')), [null, 'data:image/png;base64,AA==']);
  assert.equal(shadow.querySelector('a').getAttribute('href'), 'https://example.test/', 'links keep their href; clicks are blocked');
});

test('a render failure shows the fallback message and logs a warning', async (t) => {
  const docxPreview = { renderAsync: async () => { throw new Error('boom'); } };
  const h = harness(t, { docxPreview });
  await open(h, 'paragraphs.docx');
  await waitFor(() => (h.host.querySelector('.ide-docx-read .ide-docx-view-status')?.textContent || '').length > 0, 'the failure message');
  assert.equal(
    h.host.querySelector('.ide-docx-read .ide-docx-view-status').textContent,
    'This document could not be shown in the reading view. Switch to Edit to work on it.',
  );
  assert.equal(h.logs.find((entry) => entry.event === 'ide.docx_read_failed')?.level, 'WARN');
});

test('Ctrl+S saves from Read mode', async (t) => {
  const h = harness(t);
  await open(h, 'paragraphs.docx');
  const event = new h.dom.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  h.host.querySelector(MODE('read')).dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.saveCount(), 1);
});

test('the mode stays when another document is shown', async (t) => {
  const h = harness(t);
  await open(h, 'paragraphs.docx');
  await open(h, 'lists-tables.docx');
  click(h, MODE('edit'));
  h.pane.show('C:/paragraphs.docx');
  assert.equal(h.host.querySelector('.ide-docx-pane').dataset.mode, 'edit');
});
