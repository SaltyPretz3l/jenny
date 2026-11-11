'use strict';

/* Follow Jenny (row 121): the seams a draft tab crosses outside its own controller.
 * - the documents store's draft buffer (openDraft / writeDraft);
 * - the editor host's read-only lock, line numbering and fallback textarea;
 * - the tab strip's draft markup;
 * - the status bar's Follow switch;
 * - the presentation controller's "may I take the editor" answer. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createEditorDocuments } = require('../renderer/features/renderer-ide-editor-documents');
const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');
const { createIdeStatusBar } = require('../renderer/features/renderer-ide-statusbar');
const { createWorkspacePresentationController } = require('../renderer/features/renderer-workspace-presentation-controller');
const ideTabs = require('../renderer/features/renderer-ide-tabs');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');
const actionButton = require('../renderer/inventory/action-button');
const { escapeHtml } = require('../renderer/shared/string-utils');

const DRAFT_ID = 'diff://live/call-1';

// A text model that really holds its text, so a splice can be checked against the result.
function makeModel(initial) {
  let value = String(initial);
  let version = 1;
  const calls = { applyEdits: [], setValue: 0, decorations: [], eol: null };
  const offsetOf = (line, column) => {
    const lines = value.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1; i += 1) offset += lines[i].length + 1;
    return offset + column - 1;
  };
  return {
    calls,
    getValue: () => value,
    setValue(next) { value = String(next); version += 1; calls.setValue += 1; },
    getValueLength: () => value.length,
    getPositionAt(offset) {
      const lines = value.slice(0, offset).split('\n');
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
    applyEdits(edits) {
      calls.applyEdits.push(edits);
      for (const edit of edits) {
        const from = offsetOf(edit.range.startLineNumber, edit.range.startColumn);
        const to = offsetOf(edit.range.endLineNumber, edit.range.endColumn);
        value = value.slice(0, from) + edit.text + value.slice(to);
      }
      version += 1;
    },
    getAlternativeVersionId: () => version,
    getLanguageId: () => 'javascript',
    setEOL(eol) { calls.eol = eol; },
    deltaDecorations(old, next) {
      calls.decorations.push({ old, next });
      return next.map((_, index) => `d${calls.decorations.length}-${index}`);
    },
    dispose() {},
  };
}

function makeFakeMonaco() {
  const updates = [];
  const models = [];
  const shown = [];
  const editor = {
    addCommand() {},
    onDidChangeModelContent() {},
    onDidChangeCursorSelection() {},
    setModel: (model) => shown.push(model),
    saveViewState: () => null,
    restoreViewState() {},
    dispose() {},
    updateOptions: (options) => updates.push(options),
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (v) => ({ toString: () => String(v), path: '/x' }) },
    editor: {
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      create: () => editor,
      getModel: () => null,
      createModel: (text) => {
        const model = makeModel(text);
        models.push(model);
        return model;
      },
      onDidChangeMarkers: () => ({ dispose() {} }),
      getModelMarkers: () => [],
    },
    languages: {},
  };
  return { api, editor, updates, models, shown };
}

function makeHost({ monaco = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div><textarea id="fallback" class="hidden"></textarea></body>');
  const doc = dom.window.document;
  const fake = makeFakeMonaco();
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: doc.getElementById('ideEditorHost'), ideEditorFallback: doc.getElementById('fallback') }),
    monacoUtils: {
      ...monacoUtils,
      ensureMonacoEditorApi: async () => (monaco ? fake.api : null),
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
  });
  return { host, fake, dom, textarea: doc.getElementById('fallback') };
}

async function withWindow(dom, fn) {
  const prev = global.window;
  global.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete global.window;
    else global.window = prev;
  }
}

// ── documents store ─────────────────────────────────────────────────────────

test('a draft without Monaco is a plain buffer: kind "file" marked draft, never dirty', () => {
  const store = createEditorDocuments({ monacoUtils });
  const numbers = (line) => String(line);
  const doc = store.openDraft({ id: DRAFT_ID, languagePath: 'src/app.js', text: 'one', lineNumbers: numbers });
  assert.equal(doc.draft, true);
  assert.equal(doc.model, null);
  assert.equal(doc.buffer, 'one');
  assert.equal(doc.lineNumbers, numbers);
  assert.equal(store.isDirty(DRAFT_ID), false);

  assert.equal(store.writeDraft(DRAFT_ID, 'one\ntwo'), true);
  assert.equal(store.getDoc(DRAFT_ID).buffer, 'one\ntwo');
  assert.equal(store.getDoc(DRAFT_ID).savedBuffer, 'one\ntwo', 'the saved copy moves with it, so it never reads as unsaved work');
  assert.equal(store.isDirty(DRAFT_ID), false);

  assert.equal(store.openDraft({ id: DRAFT_ID, text: 'ignored' }), doc, 'opening again returns the same draft');
  assert.equal(doc.lineNumbers, null, 'and takes the new numbering (none)');
  assert.equal(store.writeDraft('diff://live/unknown', 'x'), false);
});

test('a draft with Monaco gets an LF model and writes only the changed characters', () => {
  const store = createEditorDocuments({ monacoUtils: { ...monacoUtils, normalizeEditorLanguage: () => 'javascript' } });
  const fake = makeFakeMonaco();
  const doc = store.openDraft({ id: DRAFT_ID, languagePath: 'src/app.js', text: 'const a = 1;\n', monacoApi: fake.api });
  const model = fake.models[0];
  assert.equal(doc.model, model);
  assert.equal(doc.buffer, null);
  assert.equal(model.calls.eol, 0, 'LF, so offsets in the arriving text match the model');

  let applyingDuringWrite = null;
  const realApply = model.applyEdits;
  model.applyEdits = (edits) => { applyingDuringWrite = store.isApplyingValue(); realApply(edits); };

  // Growth at the end: one edit, no setValue.
  const grown = 'const a = 1;\nconst b = 2;\n';
  assert.equal(store.writeDraft(DRAFT_ID, grown, { start: 13, end: 13, text: 'const b = 2;\n' }), true);
  assert.equal(model.getValue(), grown);
  assert.equal(model.calls.applyEdits.length, 1);
  assert.deepEqual(model.calls.applyEdits[0][0].range, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 });
  assert.equal(model.calls.applyEdits[0][0].forceMoveMarkers, true);
  assert.equal(model.calls.setValue, 0);
  assert.equal(applyingDuringWrite, true, 'the write is flagged as the app\'s own, so it never reads as the user typing');
  assert.equal(store.isApplyingValue(), false);
  assert.equal(doc.savedAltVersionId, model.getAlternativeVersionId(), 'never dirty');

  // A replacement in the middle.
  const swapped = 'const a = 9;\nconst b = 2;\n';
  store.writeDraft(DRAFT_ID, swapped, { start: 10, end: 11, text: '9' });
  assert.equal(model.getValue(), swapped);
  assert.equal(model.calls.applyEdits.length, 2);

  // A splice that does not add up to the new text falls back to a whole write.
  store.writeDraft(DRAFT_ID, 'fresh', { start: 0, end: 1, text: 'zz' });
  assert.equal(model.getValue(), 'fresh');
  assert.equal(model.calls.setValue, 1);

  // The same text again writes nothing.
  store.writeDraft(DRAFT_ID, 'fresh');
  assert.equal(model.calls.setValue, 1);
  assert.equal(model.calls.applyEdits.length, 2);
});

test('a draft opened unnamed takes its language when its path arrives, and keeps its text', () => {
  const byExtension = (extension) => (extension === 'js' ? 'javascript' : 'plaintext');
  const store = createEditorDocuments({ monacoUtils: { ...monacoUtils, normalizeEditorLanguage: byExtension } });
  const fake = makeFakeMonaco();
  const languages = [];
  fake.api.editor.setModelLanguage = (model, language) => languages.push([model, language]);
  const doc = store.openDraft({ id: DRAFT_ID, text: 'const a = 1;', monacoApi: fake.api });
  assert.deepEqual(languages, []);
  assert.equal(store.openDraft({ id: DRAFT_ID, languagePath: 'src/app.js', monacoApi: fake.api }), doc);
  assert.deepEqual(languages, [[fake.models[0], 'javascript']]);
  assert.equal(fake.models.length, 1);
  assert.equal(fake.models[0].getValue(), 'const a = 1;');
});

test('a draft id never takes over a real document', () => {
  const store = createEditorDocuments({ monacoUtils });
  store.openFile({ path: 'src/app.js', content: 'real' });
  assert.equal(store.openDraft({ id: 'src/app.js', text: 'draft' }), null);
  assert.equal(store.writeDraft('src/app.js', 'draft'), false);
  assert.equal(store.docText(store.getDoc('src/app.js')), 'real');
});

// ── editor host ─────────────────────────────────────────────────────────────

test('the editor is read-only with the draft\'s own line numbers, then handed back to the next file', async () => {
  const { host, fake, dom } = makeHost();
  await withWindow(dom, async () => {
    const numbers = (line) => `old ${line}`;
    await host.openDocument({ path: 'src/a.js', content: 'const a = 1;\n' });
    host.activateDocument('src/a.js');
    assert.equal(fake.updates.some((o) => o.readOnly === true), false);

    const doc = await host.openDraftDocument({ id: DRAFT_ID, languagePath: 'src/b.js', text: 'x', lineNumbers: numbers });
    assert.equal(doc.draft, true);
    assert.equal(host.hasDocument(DRAFT_ID), true);
    assert.equal(host.activateDocument(DRAFT_ID), true);
    assert.equal(fake.shown.at(-1), doc.model);
    assert.equal(fake.updates.at(-1).readOnly, true);
    assert.equal(fake.updates.at(-1).lineNumbers, numbers);

    assert.equal(host.writeDraftDocument(DRAFT_ID, 'xy', { start: 1, end: 1, text: 'y' }), true);
    assert.equal(doc.model.getValue(), 'xy');
    assert.equal(host.isDirty(DRAFT_ID), false);

    assert.equal(host.setFollowDecorations(DRAFT_ID, [{ range: {}, options: { className: 'ide-follow-line--added' } }]), 1);
    assert.equal(host.setFollowDecorations(DRAFT_ID, []), 0);
    assert.deepEqual(doc.model.calls.decorations[1].old, ['d1-0'], 'the previous marks are replaced, not stacked');
    assert.equal(host.setFollowDecorations('src/missing.js', [{}]), 0);

    const before = fake.updates.length;
    host.activateDocument('src/a.js');
    const handedBack = fake.updates.slice(before).find((o) => 'readOnly' in o);
    assert.equal(handedBack.readOnly, false);
    assert.notEqual(handedBack.lineNumbers, numbers, 'the file gets the normal numbering back');

    const settled = fake.updates.length;
    host.activateDocument('src/a.js');
    assert.equal(fake.updates.slice(settled).some((o) => 'readOnly' in o), false, 'file to file touches the lock no more');
  });
  host.dispose();
});

test('a draft without its own numbering keeps the normal line numbers', async () => {
  const { host, fake, dom } = makeHost();
  await withWindow(dom, async () => {
    await host.openDraftDocument({ id: DRAFT_ID, languagePath: 'src/new.js', text: '' });
    host.activateDocument(DRAFT_ID);
    assert.equal(fake.updates.at(-1).readOnly, true);
    assert.notEqual(typeof fake.updates.at(-1).lineNumbers, 'function');
    assert.equal(await host.openDraftDocument({ id: '' }), null);
  });
  host.dispose();
});

test('without Monaco the draft shows in the read-only fallback box and follows each write', async () => {
  const { host, dom, textarea } = makeHost({ monaco: false });
  await withWindow(dom, async () => {
    const doc = await host.openDraftDocument({ id: DRAFT_ID, languagePath: 'notes.txt', text: 'one' });
    assert.equal(doc.model, null);
    host.activateDocument(DRAFT_ID);
    assert.equal(textarea.value, 'one');
    assert.equal(textarea.readOnly, true);
    assert.equal(textarea.classList.contains('hidden'), false);

    host.writeDraftDocument(DRAFT_ID, 'one\ntwo');
    assert.equal(textarea.value, 'one\ntwo');

    await host.openDocument({ path: 'real.txt', content: 'mine' });
    host.activateDocument('real.txt');
    assert.equal(textarea.readOnly, false, 'a real file is editable again');
    host.writeDraftDocument(DRAFT_ID, 'one\ntwo\nthree');
    assert.equal(textarea.value, 'mine', 'a background draft never writes into the visible file');
  });
  host.dispose();
});

// ── tab strip ───────────────────────────────────────────────────────────────

function renderStrip(openTabs, activeTabPath) {
  const dom = new JSDOM('<!doctype html><body><div class="ide-tabbar"><div id="strip" class="ide-tabstrip" role="tablist"></div></div></body>');
  const strip = dom.window.document.getElementById('strip');
  dom.window.Element.prototype.scrollIntoView = () => {};
  const tabStrip = ideTabs.createIdeTabStrip({ getDom: () => ({ ideTabStrip: strip }), escapeHtml });
  const prev = global.window;
  global.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  try {
    tabStrip.renderTabs({ openTabs, activeTabPath });
  } finally {
    if (prev === undefined) delete global.window;
    else global.window = prev;
  }
  return strip;
}

test('a draft tab reads as the file, marked "draft", with a dot only while it is arriving', () => {
  const draft = { path: DRAFT_ID, kind: 'diff', label: 'app.js', draft: true, filePath: 'src/app.js', live: true };
  const strip = renderStrip([{ path: 'src/a.js', kind: 'file' }, draft], DRAFT_ID);
  const tab = strip.querySelector(`[data-ide-tab="${DRAFT_ID}"]`);
  assert.ok(tab.classList.contains('ide-tab--draft'));
  assert.ok(tab.classList.contains('ide-tab--draft-live'));
  assert.equal(tab.querySelector('.ide-tab-name').textContent, 'app.js');
  assert.equal(tab.querySelector('.ide-tab-dir').textContent, 'draft');
  assert.equal(tab.querySelector('.ide-tab-glyph'), null, 'the file\'s own icon, not the diff glyph');
  assert.ok(tab.querySelector('.ide-tab-mark'));
  const label = tab.querySelector('.ide-tab-label');
  assert.equal(label.getAttribute('aria-label'), 'app.js (draft, not saved)');
  assert.equal(label.getAttribute('title'), "Jenny's draft of src/app.js. Not saved.");
  assert.ok(tab.querySelector('.ide-tab-close'), 'a draft can always be closed');

  const ended = renderStrip([{ ...draft, live: false }], DRAFT_ID).querySelector('.ide-tab');
  assert.ok(ended.classList.contains('ide-tab--draft'));
  assert.equal(ended.classList.contains('ide-tab--draft-live'), false);
  assert.equal(ended.querySelector('.ide-tab-mark'), null);

  const plainDiff = renderStrip([{ path: 'diff://x', kind: 'diff', label: 'app.js' }], 'diff://x').querySelector('.ide-tab');
  assert.equal(plainDiff.classList.contains('ide-tab--draft'), false, 'an ordinary diff tab is unchanged');
});

// ── status bar ──────────────────────────────────────────────────────────────

function makeStatusBar(callbacks) {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div></body>');
  const prev = globalThis.window;
  globalThis.window = dom.window;
  dom.window.inventoryActionButton = actionButton;
  const statusBar = createIdeStatusBar({
    getDom: () => ({ ideStatusBar: dom.window.document.getElementById('sb'), ideBreadcrumbs: null }),
    getIde: () => ({ activeTabPath: 'a.js', wordWrap: 'off' }),
    callbacks: { getDocumentKind: () => 'file', ...callbacks },
  });
  const find = () => dom.window.document.querySelector('[data-ide-status-action="toggle-follow"]');
  return {
    statusBar, find,
    click: (el) => el.dispatchEvent(new dom.window.Event('click', { bubbles: true })),
    restore: () => { statusBar.dispose?.(); globalThis.window = prev; },
  };
}

test('the status bar shows the Follow switch only while the feature is on, and toggles it', () => {
  let following = null;
  let toggles = 0;
  const h = makeStatusBar({ getFollowJenny: () => following, onToggleFollowJenny: () => { toggles += 1; following = !following; } });
  try {
    h.statusBar.bindEvents();
    h.statusBar.render();
    assert.equal(h.find(), null, 'feature off: no switch');

    following = true;
    h.statusBar.render();
    assert.equal(h.find().textContent.trim(), 'Follow Jenny');
    assert.equal(h.find().getAttribute('aria-pressed'), 'true');
    assert.ok(h.find().classList.contains('ide-statusbar-action--active'));

    h.click(h.find());
    assert.equal(toggles, 1);
    h.statusBar.render();
    assert.equal(h.find().getAttribute('aria-pressed'), 'false');
    assert.equal(h.find().classList.contains('ide-statusbar-action--active'), false);
  } finally {
    h.restore();
  }
});

test('a status bar built without the Follow callbacks has no switch', () => {
  const h = makeStatusBar({});
  try {
    h.statusBar.render();
    assert.equal(h.find(), null);
  } finally {
    h.restore();
  }
});

// ── presentation controller ─────────────────────────────────────────────────

function makePresentation(getActiveView = () => 'ide') {
  const dom = new JSDOM('<div id="ideMain"></div>');
  let clock = 100_000;
  const controller = createWorkspacePresentationController({
    getDom: () => ({ ideMain: dom.window.document.getElementById('ideMain') }),
    windowRef: { addEventListener() {}, removeEventListener() {}, setTimeout() {}, clearTimeout() {}, document: dom.window.document, jennyShell: {} },
    escapeHtml,
    appendClientLog() {},
    getActiveView,
    now: () => clock,
  });
  return { controller, advance: (ms) => { clock += ms; } };
}

test('the editor may be taken on the Workspace page, but not while the user types', () => {
  const h = makePresentation();
  assert.equal(h.controller.canTakeEditor(), true);
  h.controller.noteEdit();
  assert.equal(h.controller.canTakeEditor(), false);
  h.advance(h.controller.TYPING_GUARD_MS - 1);
  assert.equal(h.controller.canTakeEditor(), false);
  h.advance(1);
  assert.equal(h.controller.canTakeEditor(), true);
  h.controller.dispose();

  const elsewhere = makePresentation(() => 'chat');
  assert.equal(elsewhere.controller.canTakeEditor(), false, 'another page is never interrupted');
  elsewhere.controller.dispose();
});

test('three automatic takes in ten seconds stop the fourth', () => {
  const h = makePresentation();
  h.controller.noteTaken();
  h.controller.noteTaken();
  assert.equal(h.controller.canTakeEditor(), true);
  h.controller.noteTaken();
  assert.equal(h.controller.canTakeEditor(), false, 'the editor stops hopping between files');
  h.advance(10_001);
  assert.equal(h.controller.canTakeEditor(), true);
  h.controller.dispose();
});
