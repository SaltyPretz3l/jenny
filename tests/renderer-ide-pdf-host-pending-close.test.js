'use strict';

// IDE-015: a PDF whose parse has not settled is a pending candidate, not a
// committed document; closing or disposing must still cancel its parse.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createIdePdfPane } = require('../renderer/features/renderer-ide-pdf-host');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'documents', 'text.pdf');

class FakeEventBus {
  on() {}
  off() {}
  dispatch() {}
}

class FakePDFViewer {
  constructor() {
    FakePDFViewer.instances.push(this);
  }
  setDocument() {}
  cleanup() {}
  update() {}
}
FakePDFViewer.instances = [];

class FakeService {
  setDocument() {}
  setViewer() {}
}

function makeDocument() {
  return {
    numPages: 1,
    annotationStorage: { onSetModified: null, onResetModified: null, size: 0, resetModified() {} },
    destroyCalls: 0,
    destroy() { this.destroyCalls += 1; },
  };
}

// The pane with one load whose pdf.js parse neither resolves nor rejects until the test says so.
function startHungLoad(filePath = 'docs/hung.pdf') {
  FakePDFViewer.instances = [];
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', {
    url: 'file:///D:/Projects/jenny/index.html',
  });
  const host = dom.window.document.getElementById('host');
  let settle = null;
  const task = {
    destroyCalls: 0,
    promise: new Promise((resolve, reject) => { settle = { resolve, reject }; }),
    destroy() { this.destroyCalls += 1; },
  };
  const pdfjs = {
    AnnotationEditorType: { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 },
    AnnotationMode: { ENABLE_FORMS: 2 },
    getDocument: () => task,
  };
  const viewer = {
    EventBus: FakeEventBus,
    PDFLinkService: FakeService,
    PDFFindController: FakeService,
    PDFViewer: FakePDFViewer,
  };
  const pane = createIdePdfPane({
    getHost: () => host,
    loadPdfjs: async () => ({ pdfjs, viewer }),
    onDirtyChange: () => {},
    onSaveRequest: () => {},
  });
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const load = pane.load(filePath, { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 });
  return { pane, task, settle, load };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('close() on a path whose parse is still pending destroys the loading task once', async (t) => {
  const { pane, task, settle, load } = startHungLoad();
  t.after(() => pane.dispose());
  await flush();

  pane.close('docs/hung.pdf');
  assert.equal(task.destroyCalls, 1, 'the in-flight parse is cancelled at close time');

  settle.reject(new Error('Loading aborted'));
  const result = await load;
  assert.equal(result.ok, false, 'the load still resolves its failure result');
  assert.equal(task.destroyCalls, 1, 'no second destroy when the parse settles');
  assert.equal(pane.hasDocument('docs/hung.pdf'), false);
});

test('dispose() destroys every pending loading task once and a late resolve is harmless', async () => {
  const { pane, task, settle, load } = startHungLoad();
  await flush();

  pane.dispose();
  assert.equal(task.destroyCalls, 1);

  const late = makeDocument();
  settle.resolve(late);
  const result = await load;
  assert.equal(result.ok, false);
  assert.equal(task.destroyCalls, 1);
  assert.equal(FakePDFViewer.instances.length, 0, 'a disposed pane builds no viewer for the late document');
});
