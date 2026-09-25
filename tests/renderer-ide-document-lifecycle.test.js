'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');

const FILES = {
  'docs/report.pdf': '%PDF-fake',
  'docs/memo.docx': 'PK\u0003\u0004fake',
  'notes.txt': 'text',
};

function createFakePane(kind) {
  const docs = new Map();
  const loads = [];
  let deps = null;
  let root = null;
  let visible = '';
  const pane = {
    async load(path, payload) {
      if (kind === 'pdf' && !root) {
        const host = deps.getHost();
        root = host.ownerDocument.createElement('div');
        root.className = 'ide-pdf-pane';
        root.dataset.ideSaveShortcut = 'pane';
        root.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            deps.onSaveRequest();
          }
        });
        host.appendChild(root);
      }
      loads.push({ path, base64: payload.base64 });
      docs.set(path, { dirty: false, exportBase64: payload.base64 });
      return { ok: true, pageCount: 1 };
    },
    show(path) { visible = docs.has(path) ? path : ''; return visible === path; },
    hide() { visible = ''; },
    close(path) { docs.delete(path); if (visible === path) visible = ''; },
    hasDocument(path) { return docs.has(path); },
    isDirty(path) { return docs.get(path)?.dirty === true; },
    markSaved(path) { if (docs.has(path)) docs.get(path).dirty = false; },
    async exportBytes(path) { if (pane.exportGate) await pane.exportGate; return docs.get(path)?.exportBase64 ?? null; },
    exportGate: null,
    dispose() { docs.clear(); visible = ''; },
    setDirty(path, dirty) {
      const doc = docs.get(path);
      if (doc) doc.dirty = dirty === true;
      if (dirty) deps.onEdit?.(path);
      deps.onDirtyChange(path, dirty);
    },
    setExport(path, base64) { if (docs.has(path)) docs.get(path).exportBase64 = base64; },
    startFreeTextNote(path, committedBase64) {
      const editor = root.ownerDocument.createElement('div');
      editor.contentEditable = 'true';
      editor.addEventListener('keydown', (event) => {
        if (event.ctrlKey && String(event.key).toLowerCase() === 's') {
          pane.setExport(path, committedBase64);
          deps.onEdit(path);
          if (!pane.isDirty(path)) {
            docs.get(path).dirty = true;
            deps.onDirtyChange(path, true);
          }
        }
      });
      root.appendChild(editor);
      return editor;
    },
    get loads() { return loads; },
  };
  return { pane, module: { createPane: (paneDeps) => { deps = paneDeps; return pane; } } };
}

function createDocumentHarness(t, options = {}) {
  const pdf = createFakePane('pdf');
  const docx = createFakePane('docx');
  const previousPdf = globalThis.rendererIdePdfHost;
  const previousDocx = globalThis.rendererIdeDocxHost;
  globalThis.rendererIdePdfHost = { createIdePdfPane: pdf.module.createPane };
  globalThis.rendererIdeDocxHost = { createIdeDocxPane: docx.module.createPane };
  const harness = createHarness({
    bridgeOptions: { files: { ...FILES }, ...(options.bridgeOptions || {}) },
    ...options,
  });
  t.after(() => {
    harness.dispose();
    globalThis.rendererIdePdfHost = previousPdf;
    globalThis.rendererIdeDocxHost = previousDocx;
  });
  return { harness, pdf: pdf.pane, docx: docx.pane };
}

function confirmButton(harness, action) {
  return harness.dom.window.document.body.querySelector(`[data-ide-confirm-action="${action}"]`);
}

test('opening a PDF uses the versioned document lane and document pane', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  assert.equal(await harness.controller.openFile('docs/report.pdf'), true);
  await settle();

  assert.deepEqual(harness.bridge.calls.readDocument.map((call) => call.path), ['docs/report.pdf']);
  assert.deepEqual(harness.bridge.calls.readText, []);
  assert.deepEqual(harness.bridge.calls.readImage, []);
  assert.deepEqual(pdf.loads, [{
    path: 'docs/report.pdf', base64: Buffer.from('%PDF-fake').toString('base64'),
  }]);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="docs/report.pdf"]'));
  assert.equal(harness.getDom().ideStatusBar.classList.contains('hidden'), true);
  assert.equal(harness.getDom().ideBreadcrumbs.classList.contains('hidden'), false);
});

test('document edits save exported bytes with the opened format and file version', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  const expectedFileVersion = harness.bridge.fileVersions.get('docs/report.pdf');
  const exported = Buffer.from('%PDF-exported').toString('base64');
  pdf.setExport('docs/report.pdf', exported);
  pdf.setDirty('docs/report.pdf', true);

  assert.equal(harness.state.ui.ide.dirtyByPath['docs/report.pdf'], true);
  assert.equal(await harness.controller.saveActiveFile(), true);
  assert.equal(harness.bridge.calls.writeDocument.length, 1);
  assert.deepEqual(harness.bridge.calls.writeDocument[0], {
    path: 'docs/report.pdf', base64: exported, format: 'pdf',
    expectedGeneration: 1, expectedFileVersion,
  });
  assert.equal(harness.bridge.state.files['docs/report.pdf'], '%PDF-exported');
  assert.equal(harness.state.ui.ide.dirtyByPath['docs/report.pdf'], undefined);
});

test('Ctrl+S from a focused PDF annotation editor saves the committed edit and clears dirty', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  await settle();
  pdf.setExport('docs/report.pdf', Buffer.from('%PDF-field+highlight').toString('base64'));
  pdf.setDirty('docs/report.pdf', true);
  const note = pdf.startFreeTextNote(
    'docs/report.pdf',
    Buffer.from('%PDF-field+highlight+note').toString('base64'),
  );
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    key: 's', ctrlKey: true, bubbles: true, cancelable: true,
  });

  note.dispatchEvent(event);
  await settle(30);

  assert.equal(harness.bridge.calls.writeDocument.length, 1);
  assert.equal(
    Buffer.from(harness.bridge.calls.writeDocument[0].base64, 'base64').toString(),
    '%PDF-field+highlight+note',
  );
  assert.equal(harness.state.ui.ide.dirtyByPath['docs/report.pdf'], undefined);
  assert.equal(event.defaultPrevented, true);
});

test('a stale document version surfaces Save Conflict and leaves the pane dirty', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  const openedVersion = harness.bridge.fileVersions.get('docs/report.pdf');
  await harness.bridge.jennyShell.workspaceFs.writeText({
    path: 'docs/report.pdf', content: '%PDF-external', expectedGeneration: 1,
    expectedFileVersion: openedVersion,
  });
  pdf.setExport('docs/report.pdf', Buffer.from('%PDF-local').toString('base64'));
  pdf.setDirty('docs/report.pdf', true);

  assert.equal(await harness.controller.saveActiveFile(), false);
  assert.equal(harness.toasts.at(-1).meta.title, 'Save Conflict');
  assert.equal(harness.state.ui.ide.dirtyByPath['docs/report.pdf'], true);
});

test('external document changes reload only a clean pane', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  harness.bridge.state.files['docs/report.pdf'] = '%PDF-external';
  harness.bridge.emitChange({ changes: [{ relPath: 'docs/report.pdf', kind: 'modified' }] });
  await settle();

  assert.equal(harness.bridge.calls.readDocument.length, 2);
  assert.equal(pdf.loads.length, 2);
  assert.equal(pdf.loads.at(-1).base64, Buffer.from('%PDF-external').toString('base64'));

  pdf.setDirty('docs/report.pdf', true);
  harness.bridge.state.files['docs/report.pdf'] = '%PDF-newer';
  harness.bridge.emitChange({ changes: [{ relPath: 'docs/report.pdf', kind: 'modified' }] });
  await settle();
  assert.equal(harness.bridge.calls.readDocument.length, 2, 'dirty documents are not reloaded');
  assert.equal(harness.state.ui.ide.staleByPath['docs/report.pdf'], true);
});

test('document read failures close the tab and use document refusal copy', async (t) => {
  const { harness } = createDocumentHarness(t);
  await harness.controller.activateIde();
  assert.equal(await harness.controller.openFile('docs/missing.docx'), false);
  assert.equal(harness.toasts.at(-1).meta.title, 'Could Not Open');
  assert.equal(harness.state.ui.ide.openTabs.length, 0);

  const originalRead = harness.bridge.jennyShell.workspaceFs.readDocument;
  harness.bridge.jennyShell.workspaceFs.readDocument = async (payload) => {
    harness.bridge.calls.readDocument.push(payload);
    return { ok: false, code: 'CMP-WORKSPACEFS-0015', message: 'corrupt', details: {} };
  };
  assert.equal(await harness.controller.openFile('docs/memo.docx'), false);
  assert.match(harness.toasts.at(-1).message, /could not be opened as a document/);
  harness.bridge.jennyShell.workspaceFs.readDocument = originalRead;
});

test('dirty documents participate in close orchestration and forced close releases the pane', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  pdf.setDirty('docs/report.pdf', true);
  const orchestrator = harness.controller.getCloseOrchestrator();
  assert.deepEqual(orchestrator.getDirtyPaths(), ['docs/report.pdf']);

  const pendingClose = orchestrator.requestClose('docs/report.pdf');
  await settle();
  assert.ok(confirmButton(harness, 'cancel'));
  confirmButton(harness, 'cancel').click();
  await pendingClose;

  const plan = await orchestrator.preflight(['docs/report.pdf'], { allowPrompt: false });
  assert.equal(orchestrator.commit(plan).committed, true);
  assert.equal(pdf.hasDocument('docs/report.pdf'), false);
});

test('root reset closes documents and requires a fresh versioned open', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  harness.bridge.state.rootGeneration = 2;
  await harness.controller.handleWorkspaceRootCommitted({
    context: { rootPath: 'G:/other-root', rootId: 'root-test', generation: 2 },
  });
  assert.equal(pdf.hasDocument('docs/report.pdf'), false);
  assert.equal(await harness.controller.openFile('docs/report.pdf'), true);
  assert.equal(harness.bridge.calls.readDocument.length, 2, 'reset cleared the prior document token');
});

test('a null document export shows Save Failed and does not write', async (t) => {
  const { harness, docx } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/memo.docx');
  docx.setExport('docs/memo.docx', null);
  docx.setDirty('docs/memo.docx', true);

  assert.equal(await harness.controller.saveActiveFile(), false);
  assert.equal(harness.toasts.at(-1).meta.title, 'Save Failed');
  assert.equal(harness.bridge.calls.writeDocument.length, 0);
});

// ── Astra review regression (2026-09-22): edits during export/write are never marked saved ──

test('an edit made while the export is in flight leaves the document dirty after the write lands', async (t) => {
  const { harness, pdf } = createDocumentHarness(t);
  await harness.controller.activateIde();
  await harness.controller.openFile('docs/report.pdf');
  pdf.setExport('docs/report.pdf', Buffer.from('%PDF-first').toString('base64'));
  pdf.setDirty('docs/report.pdf', true);
  let releaseExport = null;
  pdf.exportGate = new Promise((resolve) => { releaseExport = resolve; });
  const saving = harness.controller.saveActiveFile();
  await settle();
  // a second mutation while the pane is still exporting (already dirty: no transition)
  pdf.setDirty('docs/report.pdf', true);
  releaseExport();
  assert.equal(await saving, true, 'the exported state is written');
  assert.equal(harness.bridge.state.files['docs/report.pdf'], '%PDF-first');
  assert.equal(harness.state.ui.ide.dirtyByPath['docs/report.pdf'], true, 'newer edit still unsaved');
  assert.equal(pdf.isDirty('docs/report.pdf'), true, 'pane was not marked saved');
});
