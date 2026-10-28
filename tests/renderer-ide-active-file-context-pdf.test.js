'use strict';

// Row 65 W2: a Workspace IDE PDF tab feeds the explicit active-file context
// (renderer/features/renderer-ide-active-file-context.js) from the pane's
// reading context: the page being read or the reader's selection, a pointer
// for a scanned or not-yet-extracted page, and "Ask Jenny" arming.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createActiveFileContextController,
  computeActiveSlice,
} = require('../renderer/features/renderer-ide-active-file-context');
const actionButton = require('../renderer/inventory/action-button');

const PDF_EVENT = 'ide:pdf-reading-context-changed';

function buildDom() {
  return new JSDOM(
    '<!doctype html><html><body><div id="composerWrap"><textarea class="composer-input"></textarea></div>'
      + '<div id="composerActiveFileActionHost" class="hidden"></div></body></html>',
    { url: 'https://jenny.local/' },
  );
}

// A fake editor-host reader on a PDF tab; `view` is what the pane reports.
function makePdfReader(view = {}) {
  const state = {
    path: 'docs/paper.pdf',
    kind: 'document',
    view: { page: 4, pageCount: 12, selection: null, text: 'Results on page four.', textState: 'ready', ...view },
    calls: [],
  };
  return {
    state,
    getActivePath: () => state.path,
    getDocumentKind: () => state.kind,
    getCursorInfo: () => null,
    getValue: () => '',
    getWorkspaceId: () => 'root-a',
    getPdfReadingContext: (path, options) => {
      state.calls.push({ path, want: options?.want });
      return path === state.path ? { ...state.view } : null;
    },
  };
}

function makeController(reader) {
  const dom = buildDom();
  const win = dom.window;
  const doc = win.document;
  const logs = [];
  const controller = createActiveFileContextController({
    document: doc,
    window: win,
    getReader: () => reader,
    actionButton,
    isEnabled: () => true,
    appendClientLog: (level, code, detail) => logs.push([code, detail]),
  });
  controller.attach();
  return { controller, win, doc, logs };
}

const chipLabel = (doc) => doc.querySelector('.active-file-context-chip-label').textContent;
const chipBudget = (doc) => doc.querySelector('.active-file-context-chip-budget').textContent;
const chipHidden = (doc) => doc.getElementById('activeFileContextChip')?.classList.contains('hidden') ?? true;
const menuLabel = (doc) => doc.querySelector('[data-active-file-arm] .composer-menu-label').textContent;

test('a PDF page becomes a kind:pdf slice with its page, total and text', () => {
  const reader = makePdfReader();
  assert.deepEqual(computeActiveSlice(reader, 60, { want: true }), {
    path: 'docs/paper.pdf',
    workspace_id: 'root-a',
    kind: 'pdf',
    pages: { start: 4, end: 4, total: 12 },
    selection: false,
    scanned: false,
    pending: false,
    slice: 'Results on page four.',
  });
  assert.deepEqual(reader.state.calls.at(-1), { path: 'docs/paper.pdf', want: true });
});

test('looking at a PDF only peeks: text extraction is asked for only with want', () => {
  const reader = makePdfReader();
  computeActiveSlice(reader, 60);
  assert.equal(reader.state.calls.at(-1).want, false);
});

test('a selection spanning pages sends its text and the page range', () => {
  const reader = makePdfReader({ selection: { text: 'a passage', startPage: 4, endPage: 5 }, textState: 'pending' });
  const info = computeActiveSlice(reader, 60, { want: true });
  assert.deepEqual(info.pages, { start: 4, end: 5, total: 12 });
  assert.equal(info.selection, true);
  assert.equal(info.pending, false);
  assert.equal(info.slice, 'a passage');
});

test('a scanned page and a page still extracting send a pointer, not text', () => {
  const scanned = computeActiveSlice(makePdfReader({ text: '', textState: 'empty' }), 60, { want: true });
  assert.equal(scanned.scanned, true);
  assert.equal(scanned.pending, false);
  assert.equal(scanned.slice, '');
  const pending = computeActiveSlice(makePdfReader({ text: '', textState: 'pending' }), 60, { want: true });
  assert.equal(pending.scanned, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.slice, '');
});

test('other document tabs and an unopened PDF offer nothing', () => {
  const docx = makePdfReader();
  docx.state.path = 'docs/report.docx';
  assert.equal(computeActiveSlice(docx, 60, { want: true }), null);
  const unopened = makePdfReader({ pageCount: 0 });
  assert.equal(computeActiveSlice(unopened, 60, { want: true }), null);
});

test('the + menu offers the page, the chip follows the page being read', (t) => {
  const reader = makePdfReader();
  const { controller, win, doc } = makeController(reader);
  t.after(() => controller.dispose());

  assert.equal(menuLabel(doc), 'Add Page 4');
  assert.equal(chipHidden(doc), true);
  doc.querySelector('[data-active-file-arm]').click();
  assert.equal(menuLabel(doc), 'Page 4 Added');
  assert.equal(chipLabel(doc), 'Jenny can see p. 4 of paper.pdf');
  assert.match(chipBudget(doc), /^~\d+ tokens$/);

  reader.state.view = { ...reader.state.view, page: 5, text: 'Page five.' };
  win.dispatchEvent(new win.CustomEvent(PDF_EVENT, { detail: { path: 'docs/paper.pdf' } }));
  assert.equal(chipLabel(doc), 'Jenny can see p. 5 of paper.pdf');
  assert.equal(controller.readActiveFileContextForTurn({}).pages.start, 5);
});

test('the chip names a selection and a scanned page; a pointer shows no token count', (t) => {
  const reader = makePdfReader({ selection: { text: 'quoted', startPage: 4, endPage: 4 } });
  const { controller, win, doc } = makeController(reader);
  t.after(() => controller.dispose());
  doc.querySelector('[data-active-file-arm]').click();
  assert.equal(chipLabel(doc), 'Jenny can see p. 4 (selection)');

  reader.state.view = { ...reader.state.view, selection: null, text: '', textState: 'empty' };
  win.dispatchEvent(new win.CustomEvent(PDF_EVENT, { detail: { path: 'docs/paper.pdf' } }));
  assert.equal(chipLabel(doc), 'Jenny can see p. 4 (scanned, read with OCR)');
  assert.equal(chipBudget(doc), '');
});

test('a reading-context change for another path does not touch the chip', (t) => {
  const reader = makePdfReader();
  const { controller, win, doc } = makeController(reader);
  t.after(() => controller.dispose());
  doc.querySelector('[data-active-file-arm]').click();
  reader.state.view = { ...reader.state.view, page: 9 };
  win.dispatchEvent(new win.CustomEvent(PDF_EVENT, { detail: { path: 'docs/other.pdf' } }));
  assert.equal(chipLabel(doc), 'Jenny can see p. 4 of paper.pdf');
});

test('Ask Jenny arms the PDF and focuses the composer, and never disarms', (t) => {
  const reader = makePdfReader({ selection: { text: 'quoted', startPage: 4, endPage: 4 } });
  const { controller, doc, logs } = makeController(reader);
  t.after(() => controller.dispose());

  assert.equal(controller.askAboutActiveFile(), true);
  assert.equal(controller.isArmed(), true);
  assert.equal(doc.activeElement, doc.querySelector('textarea.composer-input'));
  assert.equal(controller.askAboutActiveFile(), true);
  assert.equal(controller.isArmed(), true);
  assert.equal(logs.filter(([code]) => code === 'chat.active_file_context_armed').length, 1);

  const sent = controller.readActiveFileContextForTurn({});
  assert.equal(sent.kind, 'pdf');
  assert.equal(sent.selection, true);
  assert.equal(sent.slice, 'quoted');
  assert.equal(sent.workspace_id, 'root-a');
});

test('an @-mention of the same PDF still wins over the page context', (t) => {
  const reader = makePdfReader();
  const { controller } = makeController(reader);
  t.after(() => controller.dispose());
  controller.askAboutActiveFile();
  assert.equal(controller.readActiveFileContextForTurn({ mentionedPaths: ['docs/paper.pdf'] }), null);
});
