'use strict';

/* Binary-document kind of the Workspace IDE editor host
 * (docs/plans/WORKSPACE_DOCUMENT_EDITING.md): the host routes PDF/DOCX
 * documents through per-format panes that share one interface. These tests
 * drive the real editor host (jsdom, no Monaco) with a fake pane factory so
 * the contract between host, panes module and pane is pinned without pdf.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function createFakePane(record) {
  const docs = new Map();
  let deps = null;
  let visible = '';
  const pane = {
    async load(path, payload) {
      record.push(['load', path, payload.base64]);
      if (payload.base64 === 'BAD') return { ok: false, code: 'document_corrupt', message: 'corrupt' };
      docs.set(path, { dirty: false });
      return { ok: true, pageCount: 1 };
    },
    show(path) { record.push(['show', path]); visible = docs.has(path) ? path : ''; return visible === path; },
    hide() { record.push(['hide']); visible = ''; },
    close(path) { record.push(['close', path]); docs.delete(path); },
    hasDocument(path) { return docs.has(path); },
    isDirty(path) { return docs.get(path)?.dirty === true; },
    markSaved(path) { record.push(['markSaved', path]); if (docs.has(path)) docs.get(path).dirty = false; },
    async exportBytes(path) { record.push(['exportBytes', path]); return docs.has(path) ? 'QUJD' : null; },
    dispose() { record.push(['dispose']); docs.clear(); },
    // test hooks
    setDirty(path, dirty) { docs.get(path).dirty = dirty; deps.onDirtyChange(path, dirty); },
    get visible() { return visible; },
    get deps() { return deps; },
  };
  return {
    pane,
    factory: () => (paneDeps) => { deps = paneDeps; return pane; },
  };
}

function createHost({ withPdf = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div><textarea id="ideEditorFallback" class="hidden"></textarea></body>');
  const doc = dom.window.document;
  const record = [];
  const dirtyEvents = [];
  const saveRequests = [];
  const fake = createFakePane(record);
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: doc.getElementById('ideEditorHost'), ideEditorFallback: doc.getElementById('ideEditorFallback') }),
    onDirtyChange: (path, dirty) => dirtyEvents.push([path, dirty]),
    onSaveRequest: () => saveRequests.push(1),
    monacoUtils: { ensureMonacoEditorApi: async () => null, normalizeEditorLanguage: () => 'plaintext' },
    documentPaneFactories: withPdf ? { pdf: fake.factory, docx: () => null } : { pdf: () => null, docx: () => null },
  });
  return { dom, host, record, dirtyEvents, saveRequests, pane: fake.pane };
}

test('a binary document opens through its format pane, activates, and reports its kind', async (t) => {
  const { host, record, pane } = createHost();
  t.after(() => host.dispose());
  let applied = 0;
  const doc = await host.openBinaryDocument({
    path: 'docs/report.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 10,
    shouldApply: () => true, onApplied: () => { applied += 1; },
  });
  assert.ok(doc, 'document created');
  assert.equal(applied, 1);
  assert.equal(host.hasDocument('docs/report.pdf'), true);
  assert.equal(host.getDocumentKind('docs/report.pdf'), 'document');
  assert.equal(host.getDocumentFormat('docs/report.pdf'), 'pdf');
  assert.equal(host.isDirty('docs/report.pdf'), false);
  assert.deepEqual(record[0], ['load', 'docs/report.pdf', 'JVBERi0=']);

  assert.equal(host.activateDocument('docs/report.pdf'), true);
  assert.equal(pane.visible, 'docs/report.pdf');
  assert.equal(host.getActivePath(), 'docs/report.pdf');
  assert.equal(globalThis.rendererIdeActiveEditorReader.getDocumentKind('docs/report.pdf'), 'document');
  assert.equal(host.getValue('docs/report.pdf'), '', 'documents expose no text buffer');
});

test('pane dirty transitions flow to the host and markSaved clears them', async (t) => {
  const { host, dirtyEvents, pane, record } = createHost();
  t.after(() => host.dispose());
  await host.openBinaryDocument({ path: 'a.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1 });
  pane.setDirty('a.pdf', true);
  assert.equal(host.isDirty('a.pdf'), true);
  assert.deepEqual(dirtyEvents, [['a.pdf', true]]);

  host.markSaved('a.pdf', { mtimeMs: 22 });
  assert.equal(host.isDirty('a.pdf'), false);
  assert.equal(host.getMtime('a.pdf'), 22);
  assert.deepEqual(dirtyEvents, [['a.pdf', true], ['a.pdf', false]]);
  assert.ok(record.some((entry) => entry[0] === 'markSaved' && entry[1] === 'a.pdf'));

  assert.equal(await host.getDocumentBytes('a.pdf'), 'QUJD');
  assert.equal(await host.getDocumentBytes('missing.pdf'), null);
});

test('a reload keeps the same document entry and resets dirty; close releases the pane copy', async (t) => {
  const { host, dirtyEvents, pane, record } = createHost();
  t.after(() => host.dispose());
  await host.openBinaryDocument({ path: 'a.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1 });
  pane.setDirty('a.pdf', true);
  const reloaded = await host.openBinaryDocument({ path: 'a.pdf', base64: 'JVBERi1=', format: 'pdf', size: 5, mtimeMs: 2 });
  assert.ok(reloaded);
  assert.equal(host.isDirty('a.pdf'), false);
  assert.deepEqual(dirtyEvents.at(-1), ['a.pdf', false]);

  host.activateDocument('a.pdf');
  host.closeDocument('a.pdf');
  assert.equal(host.hasDocument('a.pdf'), false);
  assert.equal(pane.hasDocument('a.pdf'), false);
  assert.equal(pane.visible, '');
  assert.ok(record.some((entry) => entry[0] === 'close' && entry[1] === 'a.pdf'));
  assert.equal(host.getActivePath(), '');
});

test('a vetoed apply closes the pane copy and returns null; refused bytes throw the document code', async (t) => {
  const { host, pane } = createHost();
  t.after(() => host.dispose());
  const vetoed = await host.openBinaryDocument({
    path: 'b.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1, shouldApply: () => false,
  });
  assert.equal(vetoed, null);
  assert.equal(host.hasDocument('b.pdf'), false);
  assert.equal(pane.hasDocument('b.pdf'), false, 'pane copy released after the veto');

  await assert.rejects(
    host.openBinaryDocument({ path: 'c.pdf', base64: 'BAD', format: 'pdf', size: 3, mtimeMs: 1 }),
    (error) => error.code === 'CMP-WORKSPACEFS-0015' && /corrupt/.test(error.message)
  );
  assert.equal(host.hasDocument('c.pdf'), false);
  await assert.rejects(
    host.openBinaryDocument({ path: 'd.docx', base64: 'UEsDBA==', format: 'docx', size: 4, mtimeMs: 1 }),
    (error) => error.code === 'CMP-WORKSPACEFS-0015'
  );
});

test('activating another document hides the pane; showEmpty and dispose tear it down', async (t) => {
  const { host, pane, record, dom } = createHost();
  t.after(() => { try { host.dispose(); } catch (_error) { /* already disposed */ } });
  await host.openBinaryDocument({ path: 'a.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1 });
  host.activateDocument('a.pdf');
  await host.openDocument({ path: 'notes.txt', content: 'hello', mtimeMs: 1, eol: 'lf' });
  host.activateDocument('notes.txt');
  assert.equal(pane.visible, '', 'text activation hides the document pane');
  assert.equal(dom.window.document.getElementById('ideEditorFallback').classList.contains('hidden'), false);

  host.activateDocument('a.pdf');
  assert.equal(pane.visible, 'a.pdf');
  assert.equal(dom.window.document.getElementById('ideEditorFallback').classList.contains('hidden'), true, 'fallback hidden under the pane');
  host.showEmpty();
  assert.equal(pane.visible, '');
  host.dispose();
  assert.ok(record.some((entry) => entry[0] === 'dispose'));
  assert.equal(host.hasDocument('a.pdf'), false);
});

test('a format without a pane is refused with the document code', async (t) => {
  const { host } = createHost({ withPdf: false });
  t.after(() => host.dispose());
  await assert.rejects(
    host.openBinaryDocument({ path: 'a.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1 }),
    (error) => error.code === 'CMP-WORKSPACEFS-0015'
  );
});

test('the real-app path lazy-loads a format runtime once, in order, and injects its stylesheets', async (t) => {
  const { createEditorHostPanes, DOCUMENT_RUNTIMES } = require('../renderer/features/renderer-ide-editor-host-panes');
  const dom = new JSDOM('<!doctype html><head></head><body><div id="ideEditorHost"></div></body>');
  const doc = dom.window.document;
  const loaded = [];
  const record = [];
  const fake = createFakePane(record);
  const scriptLoader = {
    async ensureScript({ src, isReady }) {
      loaded.push(src);
      if (src.endsWith('renderer-ide-docx-host.js')) globalThis.rendererIdeDocxHost = { createIdeDocxPane: fake.factory() };
      else {
        const descriptor = DOCUMENT_RUNTIMES.docx.scripts.find(script => script.src === src);
        globalThis[descriptor.global] = {};
      }
      return isReady();
    },
  };
  t.after(() => {
    for (const script of DOCUMENT_RUNTIMES.docx.scripts) delete globalThis[script.global];
  });
  const panes = createEditorHostPanes({
    docs: new Map(), getDom: () => ({ ideEditorHost: doc.getElementById('ideEditorHost') }),
    scriptLoader, resolveRuntimeModule: () => null,
  });
  const opened = await panes.openBinaryDocument({ path: 'memo.docx', base64: 'UEsDBA==', format: 'docx', size: 4, mtimeMs: 1 });
  assert.ok(opened);
  assert.deepEqual(loaded, DOCUMENT_RUNTIMES.docx.scripts.map((script) => script.src), 'scripts load in dependency order');
  const links = [...doc.head.querySelectorAll('link[data-ide-document-style]')].map((link) => link.getAttribute('href'));
  assert.deepEqual(links, DOCUMENT_RUNTIMES.docx.stylesheets);

  await panes.openBinaryDocument({ path: 'other.docx', base64: 'UEsDBA==', format: 'docx', size: 4, mtimeMs: 1 });
  assert.equal(loaded.length, DOCUMENT_RUNTIMES.docx.scripts.length, 'runtime loads once');
  assert.equal(doc.head.querySelectorAll('link[data-ide-document-style]').length, links.length, 'stylesheets inject once');

  const failing = createEditorHostPanes({
    docs: new Map(), getDom: () => ({ ideEditorHost: doc.getElementById('ideEditorHost') }),
    scriptLoader: { async ensureScript() { return false; } }, resolveRuntimeModule: () => null,
  });
  await assert.rejects(
    failing.openBinaryDocument({ path: 'x.pdf', base64: 'JVBERi0=', format: 'pdf', size: 5, mtimeMs: 1 }),
    (error) => error.code === 'CMP-WORKSPACEFS-0015'
  );
});
