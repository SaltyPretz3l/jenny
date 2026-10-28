'use strict';

// Editor-mode containment, hash-based dirty tracking, find readout, reading
// position, load failure and base64 paths of the IDE PDF pane.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  FIXTURE_PATH, FakePDFViewer, click, keydown, loadFixture, makePane, makePdfjsHarness, tick,
} = require('./helpers/ide-pdf-pane-harness');

function fire(env, target, Type, type) {
  target.dispatchEvent(new env.dom.window[Type](type, { bubbles: true }));
}

function hashStorage(initial = '') {
  return {
    hash: initial,
    onSetModified: null,
    onResetModified: null,
    size: 0,
    resetModified() {},
    get serializable() { return { hash: this.hash }; },
  };
}

async function editingPane(t) {
  const env = makePane();
  t.after(() => env.pane.dispose());
  const composer = env.dom.window.document.createElement('textarea');
  env.dom.window.document.body.appendChild(composer);
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  return { env, composer, pdfViewer: FakePDFViewer.instances[0] };
}

test('an editor mode is suspended while the user works outside the pane and resumed on return', async (t) => {
  const { env, composer, pdfViewer } = await editingPane(t);
  const highlight = click(env, '[data-ide-pdf-action="highlight"]');
  assert.equal(pdfViewer.annotationEditorMode.mode, 9);

  // pdf.js editing listens on window/document and swallows Backspace, Ctrl+Z
  // and the clipboard in every textarea while a mode is on.
  fire(env, composer, 'FocusEvent', 'focusin');
  assert.equal(pdfViewer.annotationEditorMode.mode, 0, 'focus outside the pane drops the pdf.js mode');
  assert.equal(highlight.getAttribute('aria-pressed'), 'true', 'the toolbar keeps the chosen mode');
  assert.equal(env.pane.getState('docs/text.pdf').editorMode, 'highlight');

  fire(env, pdfViewer.options.viewer, 'MouseEvent', 'pointerdown');
  assert.equal(pdfViewer.annotationEditorMode.mode, 9, 'returning to the document resumes the mode');

  click(env, '[data-ide-pdf-action="select"]');
  fire(env, composer, 'FocusEvent', 'focusin');
  fire(env, pdfViewer.options.viewer, 'MouseEvent', 'pointerdown');
  assert.equal(pdfViewer.annotationEditorMode.mode, 0, 'an explicit Select clears the remembered mode');
});

test('hiding or switching documents suspends the mode and activation alone does not resume it', async (t) => {
  const { env, composer, pdfViewer } = await editingPane(t);
  click(env, '[data-ide-pdf-action="draw"]');
  env.pane.hide();
  assert.equal(pdfViewer.annotationEditorMode.mode, 0, 'a hidden pane never keeps pdf.js editing armed');
  composer.focus();
  env.pane.show('docs/text.pdf');
  assert.equal(pdfViewer.annotationEditorMode.mode, 0, 'a tab activation with focus in the composer stays suspended');
  fire(env, pdfViewer.options.viewer, 'MouseEvent', 'pointerdown');
  assert.equal(pdfViewer.annotationEditorMode.mode, 15);

  await loadFixture(env, 'other.pdf');
  env.pane.show('other.pdf');
  assert.equal(pdfViewer.annotationEditorMode.mode, 0, 'switching documents suspends the previous one');
});

test('a mode pdf.js enters late, after a suspension, is undone', async (t) => {
  const { env, composer, pdfViewer } = await editingPane(t);
  click(env, '[data-ide-pdf-action="highlight"]');
  fire(env, composer, 'FocusEvent', 'focusin');
  assert.equal(pdfViewer.annotationEditorMode.mode, 0);
  // pdf.js waits for annotated pages to render before entering a mode.
  pdfViewer.options.eventBus.dispatch('annotationeditormodechanged', { mode: 9 });
  assert.equal(pdfViewer.annotationEditorMode.mode, 0);
  assert.equal(env.pane.getState('docs/text.pdf').editorMode, 'highlight');
});

test('dirty state follows the serialized annotation hash, including in-place edits and removals', async (t) => {
  const storage = hashStorage();
  const edits = [];
  const env = makePane({ harness: makePdfjsHarness({ annotationStorage: storage }), onEdit: (p) => edits.push(p) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pageLayer = FakePDFViewer.instances[0].options.viewer;

  // Entering an edit mode loads existing annotations; they serialize to null.
  storage.onSetModified();
  assert.equal(env.pane.isDirty('docs/text.pdf'), false, 'an unchanged hash is not an edit');
  assert.deepEqual(edits, []);

  storage.hash = 'added';
  storage.size = 1;
  storage.onSetModified();
  assert.equal(env.pane.isDirty('docs/text.pdf'), true);
  env.pane.markSaved('docs/text.pdf');
  await tick();
  assert.equal(env.pane.isDirty('docs/text.pdf'), false);

  // Moving or deleting an editor already in storage never calls setValue.
  storage.hash = 'moved';
  fire(env, env.host.querySelector('[data-ide-pdf-find]'), 'KeyboardEvent', 'keyup');
  await tick();
  assert.equal(env.pane.isDirty('docs/text.pdf'), false, 'toolbar typing does not serialize storage');
  fire(env, pageLayer, 'MouseEvent', 'pointerup');
  await tick();
  assert.equal(env.pane.isDirty('docs/text.pdf'), true, 'an in-place change is detected after the gesture');
  assert.deepEqual(edits, ['docs/text.pdf', 'docs/text.pdf'], 'each change advances the save fence');

  storage.hash = 'added';
  fire(env, pageLayer, 'KeyboardEvent', 'keyup');
  await tick();
  assert.equal(env.pane.isDirty('docs/text.pdf'), false, 'undoing back to the saved state is clean again');
  assert.equal(edits.length, 3);
});

test('page gestures serialize annotation storage only while editing or once it holds values', async (t) => {
  const storage = hashStorage();
  let reads = 0;
  Object.defineProperty(storage, 'serializable', { get() { reads += 1; return { hash: this.hash }; } });
  const env = makePane({ harness: makePdfjsHarness({ annotationStorage: storage }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pageLayer = FakePDFViewer.instances[0].options.viewer;
  await tick();
  const baseline = reads;
  fire(env, pageLayer, 'MouseEvent', 'pointerup');
  fire(env, pageLayer, 'KeyboardEvent', 'keyup');
  await tick();
  assert.equal(reads, baseline, 'reading a PDF never hashes its empty storage');

  click(env, '[data-ide-pdf-action="highlight"]');
  await tick();
  const editing = reads;
  fire(env, pageLayer, 'MouseEvent', 'pointerup');
  await tick();
  assert.equal(reads, editing + 1, 'a gesture in an editor mode re-checks');

  click(env, '[data-ide-pdf-action="highlight"]');
  storage.size = 1;
  await tick();
  const filled = reads;
  fire(env, pageLayer, 'MouseEvent', 'pointerup');
  await tick();
  assert.equal(reads, filled + 1, 'stored values (forms, past edits) keep the check on');
});

test('markSaved keeps the exported state as the baseline and re-detects a later silent change', async (t) => {
  const storage = hashStorage('exported');
  storage.size = 1;
  const env = makePane({ harness: makePdfjsHarness({ annotationStorage: storage }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  storage.hash = 'edited';
  storage.onSetModified();
  storage.hash = 'exported-2';
  storage.onSetModified();
  await env.pane.exportBytes('docs/text.pdf');
  storage.hash = 'dragged during the write'; // pdf.js never announced it
  env.pane.markSaved('docs/text.pdf');
  assert.equal(env.pane.isDirty('docs/text.pdf'), false);
  await tick();
  assert.equal(env.pane.isDirty('docs/text.pdf'), true, 'the disk holds the exported state, not the drag');
});

test('only content that would be written makes the export run saveDocument', async (t) => {
  const storage = hashStorage();
  storage.size = 3; // existing annotations loaded by an edit mode, unchanged
  const env = makePane({ harness: makePdfjsHarness({ annotationStorage: storage }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  assert.equal(await env.pane.exportBytes('docs/text.pdf'), 'JVBERg==', 'nothing to write: getData');
  storage.hash = 'edited';
  assert.equal(await env.pane.exportBytes('docs/text.pdf'), 'JVBERi0=');
});

test('stamp bitmaps cloned for the hash are released', async (t) => {
  const closed = [];
  const storage = hashStorage();
  Object.defineProperty(storage, 'serializable', {
    get() { return { hash: 'stamp', transfer: [{ close: () => closed.push('bitmap') }] }; },
  });
  const env = makePane({ harness: makePdfjsHarness({ annotationStorage: storage }) });
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  assert.deepEqual(closed, ['bitmap']);
});

test('the find readout follows the selected match and resets for a new query', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const eventBus = FakePDFViewer.instances[0].options.eventBus;
  const findField = env.host.querySelector('[data-ide-pdf-find]');
  const readout = env.host.querySelector('.ide-pdf-find-readout');

  findField.value = 'needle';
  keydown(env, findField, { key: 'Enter' });
  eventBus.dispatch('updatefindmatchescount', { matchesCount: { current: 1, total: 5 } });
  // pdf.js reports next/previous only through the control state event.
  eventBus.dispatch('updatefindcontrolstate', { state: 0, matchesCount: { current: 2, total: 5 } });
  assert.equal(readout.textContent, '2 of 5');

  findField.value = 'nothing';
  keydown(env, findField, { key: 'Enter' });
  assert.equal(readout.textContent, '0 of 0', 'a query with no hits never emits a count');
});

test('pane shortcuts ignore Shift and Alt chords and the page field ignores invalid input', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const paneEl = env.host.querySelector('.ide-pdf-pane');
  const findField = env.host.querySelector('[data-ide-pdf-find]');

  assert.equal(keydown(env, paneEl, { key: 'F', ctrlKey: true, shiftKey: true }).defaultPrevented, false, 'Ctrl+Shift+F is workspace search');
  assert.equal(keydown(env, paneEl, { key: 'S', ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(keydown(env, paneEl, { key: 's', ctrlKey: true, altKey: true }).defaultPrevented, false);
  assert.equal(env.saveRequests, 0);
  findField.value = 'previous query';
  assert.equal(keydown(env, paneEl, { key: 'f', ctrlKey: true }).defaultPrevented, true);
  assert.equal(env.dom.window.document.activeElement, findField);
  assert.equal(findField.selectionEnd - findField.selectionStart, 'previous query'.length, 'Ctrl+F selects the query');

  const pdfViewer = FakePDFViewer.instances[0];
  click(env, '[data-ide-pdf-action="next"]');
  const pageField = env.host.querySelector('[data-ide-pdf-page]');
  for (const value of ['', '  ', 'abc']) {
    pageField.value = value;
    keydown(env, pageField, { key: 'Enter' });
    assert.equal(pdfViewer.currentPageNumber, 2, `"${value}" is not a page`);
    assert.equal(pageField.value, '2', 'the field shows the current page again');
  }
  pageField.value = '1';
  keydown(env, pageField, { key: 'Enter', isComposing: true });
  assert.equal(pdfViewer.currentPageNumber, 2, 'Enter that ends an IME composition does not navigate');
});

test('a document keeps its scroll offset across tab switches and its place and zoom across a reload', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env, 'one.pdf');
  await loadFixture(env, 'two.pdf');
  env.pane.show('one.pdf');
  const scroller = FakePDFViewer.instances[0].options.container;
  scroller.scrollTop = 840;
  scroller.scrollLeft = 12;
  env.pane.show('two.pdf');
  scroller.scrollTop = 0; // display:none drops the offset
  scroller.scrollLeft = 0;
  env.pane.show('one.pdf');
  assert.equal(scroller.scrollTop, 840);
  assert.equal(scroller.scrollLeft, 12);
  scroller.scrollTop = 1200;
  env.pane.show('one.pdf'); // re-activating the visible tab
  assert.equal(scroller.scrollTop, 1200, 'the offset is restored once, not on every activation');
  scroller.scrollTop = 840;

  click(env, '[data-ide-pdf-action="zoom-in"]');
  const zoomed = env.pane.getState('one.pdf').scale;
  assert.equal(typeof zoomed, 'number');
  await loadFixture(env, 'one.pdf');
  const reloaded = FakePDFViewer.instances.at(-1);
  assert.equal(reloaded.currentScaleValue, zoomed, 'an external-change reload keeps the zoom');
  assert.equal(reloaded.options.container.scrollTop, 840, 'and the reading position');
});

test('a reload that finishes after the user switched away does not re-show the pane', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const reload = env.pane.load('docs/text.pdf', { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 2 });
  env.pane.hide(); // the user activated a text tab while the reload parsed
  assert.equal((await reload).ok, true);
  assert.equal(env.host.querySelector('.ide-pdf-pane').classList.contains('hidden'), true);
});

test('a broken first page is refused before commit and a viewer that never initializes fails the load', async (t) => {
  const env = makePane();
  t.after(() => env.pane.dispose());
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const original = env.harness.pdfjs.getDocument;
  env.harness.pdfjs.getDocument = (params) => {
    const task = original.call(env.harness.pdfjs, params);
    task.promise = task.promise.then((doc) => {
      doc.getPage = async () => { throw Object.assign(new Error('bad page tree'), { name: 'InvalidPDFException' }); };
      return doc;
    });
    return task;
  };
  const broken = await loadFixture(env);
  assert.equal(broken.result.code, 'document_corrupt');
  assert.equal(env.harness.documents[0].destroyCalls, 0, 'the live document survives a broken reload');
  assert.equal(env.pane.hasDocument('docs/text.pdf'), true);

  env.harness.pdfjs.getDocument = original;
  FakePDFViewer.failPages = true;
  const outcome = await Promise.race([loadFixture(env), new Promise((resolve) => setTimeout(() => resolve('hung'), 200))]);
  assert.notEqual(outcome, 'hung', 'pagesPromise rejection settles the load');
  assert.equal(outcome.result.code, 'document_engine_unavailable');
  assert.equal(env.host.querySelector('.ide-pdf-error').classList.contains('hidden'), false,
    'the visible document failed after commit, so the error shows in its place');
});

const settleRefit = () => new Promise((resolve) => setTimeout(resolve, 150));

test('fit presets are re-applied when the editor column resizes', async () => {
  const observers = [];
  const env = makePane({
    setupWindow: (window) => {
      window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
      };
    },
  });
  await loadFixture(env);
  env.pane.show('docs/text.pdf');
  const pdfViewer = FakePDFViewer.instances[0];
  assert.equal(observers.length, 1);
  assert.ok(observers[0].target.matches('.ide-pdf-documents'));

  pdfViewer.currentScaleValue = 1.37; // pdf.js resolved page-width at the old size
  observers[0].callback([]);
  observers[0].callback([]);
  assert.equal(pdfViewer.currentScaleValue, 1.37, 'a splitter drag does not re-fit every frame');
  await settleRefit();
  assert.equal(pdfViewer.currentScaleValue, 'page-width');
  click(env, '[data-ide-pdf-action="zoom-in"]');
  const manual = pdfViewer.currentScaleValue;
  observers[0].callback([]);
  await settleRefit();
  assert.equal(pdfViewer.currentScaleValue, manual, 'a manual zoom is left alone');
  env.pane.dispose();
  assert.equal(observers[0].disconnected, true);
});

test('native Uint8Array base64 codecs are used when the engine has them', async (t) => {
  const calls = [];
  Uint8Array.fromBase64 = (text) => { calls.push('from'); return new Uint8Array(Buffer.from(text, 'base64')); };
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    configurable: true,
    value() { calls.push('to'); return Buffer.from(this).toString('base64'); },
  });
  t.after(() => {
    delete Uint8Array.fromBase64;
    delete Uint8Array.prototype.toBase64;
  });
  const env = makePane();
  t.after(() => env.pane.dispose());
  const { bytes } = await loadFixture(env);
  assert.deepEqual(Buffer.from(env.harness.params[0].data), bytes);
  env.harness.documents[0].annotationStorage.size = 1;
  assert.equal(await env.pane.exportBytes('docs/text.pdf'), 'JVBERi0=');
  assert.deepEqual(calls, ['from', 'to']);
});
