'use strict';

// Row 65 W3: the IDE PDF pane's outline and thumbnail sidebar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPdfSidebar, resolveOutline } = require('../renderer/features/renderer-ide-pdf-sidebar');

const PREFS_KEY = 'jenny.idePdfSidebar.v1';

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

// The thumbnail renderer reads globalThis.IntersectionObserver when the
// sidebar builds the Pages list; a fake keeps renders under test control.
function installFakeObserver(t) {
  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, init) {
      this.callback = callback;
      this.init = init;
      this.targets = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
  }
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'IntersectionObserver');
  const previous = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
  t.after(() => {
    if (had) globalThis.IntersectionObserver = previous;
    else delete globalThis.IntersectionObserver;
  });
  return observers;
}

// Explicit destinations use { index } refs that getPageIndex resolves.
function fakeDoc(options = {}) {
  const calls = { getOutline: 0, getPageLabels: 0, getPage: [] };
  const doc = {
    numPages: options.numPages || 5,
    async getOutline() {
      calls.getOutline += 1;
      if (options.outlineError) throw options.outlineError;
      return options.outline === undefined ? null : options.outline;
    },
    async getDestination(name) {
      if (options.destinationError) throw options.destinationError;
      return Object.prototype.hasOwnProperty.call(options.destinations || {}, name) ? options.destinations[name] : null;
    },
    async getPageIndex(ref) {
      if (!Number.isInteger(ref?.index)) throw new Error('bad ref');
      return ref.index;
    },
    async getPage(pageNumber) {
      calls.getPage.push(pageNumber);
      return {
        getViewport: ({ scale }) => ({ width: 200 * scale, height: 300 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
      };
    },
  };
  if (options.labels !== undefined || options.labelsError) {
    doc.getPageLabels = async () => {
      calls.getPageLabels += 1;
      if (options.labelsError) throw options.labelsError;
      return options.labels;
    };
  }
  return { doc, calls };
}

// Intro p1, Part I (heading) > [Chapter 1 p3 > Section 1.1 p4, Chapter 2 p5], Broken (unresolvable).
function bookOutline() {
  return [
    { title: 'Intro', dest: [0, { name: 'XYZ' }], items: [] },
    {
      title: 'Part I',
      dest: null,
      items: [
        { title: 'Chapter 1', dest: 'ch1', items: [{ title: '  Section 1.1 ', dest: [{ index: 3 }], items: [] }] },
        { title: 'Chapter 2', dest: [4], items: [] },
      ],
    },
    { title: 'Broken', dest: 'missing', items: [] },
  ];
}

function bookDoc(extra = {}) {
  return fakeDoc({ outline: bookOutline(), destinations: { ch1: [{ index: 2 }] }, labels: ['i', 'ii', '1', '2', '3'], ...extra });
}

function makeSidebar(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const document = dom.window.document;
  const host = document.getElementById('host');
  const logs = [];
  const pages = [];
  const destinations = [];
  const storage = 'storage' in options ? options.storage : memoryStorage(options.prefs ? { [PREFS_KEY]: JSON.stringify(options.prefs) } : {});
  const observers = installFakeObserver(t);
  const sidebar = createPdfSidebar({
    documentRef: document,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    onPage: page => pages.push(page),
    onDestination: (dest, page) => destinations.push({ dest, page }),
    storage,
  });
  host.appendChild(sidebar.element);
  const body = () => sidebar.element.querySelector('.ide-pdf-sidebar-body');
  const head = () => sidebar.element.querySelector('.ide-pdf-sidebar-head');
  const rows = () => [...sidebar.element.querySelectorAll('[data-ide-pdf-outline]')];
  const titles = () => rows().map(row => row.querySelector('.ide-pdf-outline-title').textContent);
  const row = title => rows().find(item => item.querySelector('.ide-pdf-outline-title').textContent === title);
  const currentTitles = () => rows()
    .filter(item => item.classList.contains('ide-pdf-outline-row--current'))
    .map(item => item.querySelector('.ide-pdf-outline-title').textContent);
  const thumb = page => sidebar.element.querySelector(`[data-ide-pdf-thumb="${page}"]`);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const keydown = (el, key) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  return { dom, document, host, sidebar, storage, logs, pages, destinations, observers, body, head, rows, titles, row, currentTitles, thumb, click, keydown };
}

async function openWith(t, docOptions, attach = {}, sidebarOptions = {}) {
  const env = makeSidebar(t, { prefs: { open: true }, ...sidebarOptions });
  const fake = docOptions && docOptions.doc ? docOptions : bookDoc(docOptions || {});
  env.fake = fake;
  env.sidebar.attach('docs/book.pdf', { pdfDocument: fake.doc, pageCount: fake.doc.numPages, pageNumber: 1, ...attach });
  await flush();
  return env;
}

// --- prefs ---------------------------------------------------------------

test('the sidebar starts closed by default and a toggle persists the open state', async (t) => {
  const env = makeSidebar(t);
  assert.equal(env.sidebar.isOpen(), false);
  assert.equal(env.sidebar.element.hidden, true);
  assert.equal(env.sidebar.element.tagName, 'NAV');
  assert.equal(env.sidebar.element.getAttribute('aria-label'), 'Document navigation');
  const { doc, calls } = bookDoc();
  env.sidebar.attach('a.pdf', { pdfDocument: doc, pageCount: 5, pageNumber: 1 });
  await flush();
  assert.equal(calls.getOutline, 0, 'a closed sidebar resolves nothing');
  assert.equal(env.sidebar.toggle(), true);
  assert.equal(env.sidebar.element.hidden, false);
  assert.deepEqual(JSON.parse(env.storage.getItem(PREFS_KEY)), { open: true, tab: 'outline' });
  await flush();
  assert.equal(calls.getOutline, 1);
  assert.equal(env.sidebar.toggle(), false);
  assert.equal(env.sidebar.element.hidden, true);
  assert.deepEqual(JSON.parse(env.storage.getItem(PREFS_KEY)), { open: false, tab: 'outline' });
  assert.equal(env.sidebar.setOpen('yes'), false, 'only true opens');
});

test('stored prefs reopen the sidebar on the stored tab', async (t) => {
  const env = await openWith(t, null, {}, { prefs: { open: true, tab: 'pages' } });
  assert.equal(env.sidebar.isOpen(), true);
  assert.ok(env.body().querySelector('.ide-pdf-thumbs'), 'the stored pages tab shows');
  const checked = env.head().querySelector('.inv-segmented-option[aria-checked="true"]');
  assert.equal(checked.dataset.value, 'pages');
});

test('malformed, throwing or missing storage falls back to the defaults and keeps working', async (t) => {
  const malformed = makeSidebar(t, { storage: memoryStorage({ [PREFS_KEY]: '{not json' }) });
  assert.equal(malformed.sidebar.isOpen(), false);

  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
  };
  const env = makeSidebar(t, { storage: throwing });
  assert.equal(env.sidebar.isOpen(), false);
  assert.equal(env.sidebar.toggle(), true, 'the in-memory preference still flips');
  assert.equal(env.sidebar.isOpen(), true);
  assert.equal(env.sidebar.element.hidden, false);

  const none = makeSidebar(t, { storage: null });
  assert.equal(none.sidebar.toggle(), true);
  assert.deepEqual(env.logs, []);
});

// --- outline -------------------------------------------------------------

test('the outline renders nested rows with depth, page labels and the current section revealed', async (t) => {
  const env = await openWith(t, null, { pageNumber: 4 });
  const tree = env.body().querySelector('ul.ide-pdf-outline');
  assert.equal(tree.getAttribute('role'), 'tree');
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Chapter 1', 'Section 1.1', 'Chapter 2', 'Broken']);
  const levels = env.rows().map(item => item.getAttribute('aria-level'));
  assert.deepEqual(levels, ['1', '1', '2', '3', '2', '1']);
  assert.equal(env.row('Section 1.1').closest('li').style.getPropertyValue('--ide-pdf-outline-depth'), '2');
  assert.ok(env.rows().every(item => item.getAttribute('role') === 'treeitem'));
  assert.equal(env.row('Part I').getAttribute('aria-expanded'), 'true');
  assert.equal(env.row('Intro').hasAttribute('aria-expanded'), false);
  assert.ok(env.row('Part I').querySelector('[data-ide-pdf-twisty] svg'), 'a parent has a chevron');
  assert.equal(env.row('Intro').querySelector('[data-ide-pdf-twisty]').firstChild, null, 'a leaf twisty is empty');
  const pageOf = title => env.row(title).querySelector('.ide-pdf-outline-page').textContent;
  assert.equal(pageOf('Intro'), 'i');
  assert.equal(pageOf('Chapter 1'), '1');
  assert.equal(pageOf('Section 1.1'), '2');
  assert.equal(pageOf('Chapter 2'), '3');
  assert.equal(pageOf('Part I'), '', 'a heading has no page');
  assert.equal(pageOf('Broken'), '', 'an unresolvable destination lists without a page');
  assert.deepEqual(env.currentTitles(), ['Section 1.1']);
  assert.equal(env.row('Section 1.1').getAttribute('aria-current'), 'location');
  // The header is the Outline/Pages switch.
  const options = [...env.head().querySelectorAll('.inv-segmented-option')].map(option => option.dataset.value);
  assert.deepEqual(options, ['outline', 'pages']);
  assert.equal(env.fake.calls.getPageLabels, 1);
  assert.deepEqual(env.logs, []);
});

test('outline titles are escaped and an empty title gets a placeholder', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [{ title: '<img src=x onerror=1>', dest: [0] }, { title: '', dest: [1] }] }));
  assert.equal(env.body().querySelector('img'), null);
  assert.deepEqual(env.titles(), ['<img src=x onerror=1>', 'Untitled section']);
  assert.equal(env.row('Intro'), undefined);
  assert.equal(env.rows()[1].querySelector('.ide-pdf-outline-page').textContent, '2', 'no labels falls back to the page number');
});

test('clicking a row with a destination calls onDestination; a heading toggles its children', async (t) => {
  const env = await openWith(t);
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Broken'], 'a heading off the current page starts collapsed');
  env.click(env.row('Intro').querySelector('.ide-pdf-outline-title'));
  assert.deepEqual(env.destinations, [{ dest: [0, { name: 'XYZ' }], page: 1 }]);

  env.click(env.row('Part I'));
  assert.equal(env.destinations.length, 1, 'a heading without a destination does not navigate');
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Chapter 1', 'Chapter 2', 'Broken']);
  assert.equal(env.row('Part I').getAttribute('aria-expanded'), 'true');
  assert.equal(env.document.activeElement, env.row('Part I'), 'focus follows the re-rendered row');

  // The twisty toggles even a row that has a destination.
  env.click(env.row('Chapter 1').querySelector('[data-ide-pdf-twisty]'));
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Chapter 1', 'Section 1.1', 'Chapter 2', 'Broken']);
  assert.equal(env.destinations.length, 1);
  env.click(env.row('Chapter 1'));
  assert.deepEqual(env.destinations.at(-1), { dest: 'ch1', page: 3 });
  env.click(env.row('Broken'));
  assert.deepEqual(env.destinations.at(-1), { dest: 'missing', page: null });

  env.click(env.row('Part I').querySelector('[data-ide-pdf-twisty]'));
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Broken']);
  assert.equal(env.sidebar.isOpen(), true, 'a docked sidebar stays open after a navigation');
});

test('a row without a destination or children is disabled', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [{ title: 'Note', dest: null, items: [] }, { title: 'Go', dest: [0] }] }));
  assert.equal(env.row('Note').disabled, true);
  assert.equal(env.row('Go').disabled, false);
});

test('the current-row mark follows setPage onto the nearest visible ancestor', async (t) => {
  const env = await openWith(t, null, { pageNumber: 4 });
  assert.deepEqual(env.currentTitles(), ['Section 1.1']);
  env.sidebar.setPage('docs/book.pdf', 5);
  assert.deepEqual(env.currentTitles(), ['Chapter 2']);
  env.sidebar.setPage('docs/book.pdf', 2);
  assert.deepEqual(env.currentTitles(), ['Intro'], 'the last section starting at or before the page');
  env.sidebar.setPage('docs/book.pdf', 4);
  // Collapsing Chapter 1 moves the mark to it, collapsing Part I moves it up again.
  env.click(env.row('Chapter 1').querySelector('[data-ide-pdf-twisty]'));
  assert.deepEqual(env.currentTitles(), ['Chapter 1']);
  env.click(env.row('Part I'));
  assert.deepEqual(env.currentTitles(), ['Part I']);
  assert.equal(env.row('Part I').getAttribute('aria-current'), 'location');
  env.sidebar.setPage('docs/book.pdf', 1);
  assert.deepEqual(env.currentTitles(), ['Intro']);
  assert.equal(env.row('Part I').hasAttribute('aria-current'), false);
  // Ignored inputs.
  env.sidebar.setPage('docs/book.pdf', 2.5);
  env.sidebar.setPage('other.pdf', 3);
  assert.deepEqual(env.currentTitles(), ['Intro']);
});

test('a closed sidebar records the page and marks it when reopened', async (t) => {
  const env = await openWith(t, null, { pageNumber: 1 });
  env.sidebar.setOpen(false);
  env.sidebar.setPage('docs/book.pdf', 5);
  assert.deepEqual(env.currentTitles(), ['Intro'], 'nothing re-marks while hidden');
  env.sidebar.setOpen(true);
  assert.deepEqual(env.currentTitles(), ['Part I']);
});

test('arrow keys move focus, expand and collapse tree rows', async (t) => {
  const env = await openWith(t);
  env.row('Intro').focus();
  let event = env.keydown(env.row('Intro'), 'ArrowDown');
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.document.activeElement, env.row('Part I'));
  env.keydown(env.row('Part I'), 'ArrowRight');
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Chapter 1', 'Chapter 2', 'Broken']);
  assert.equal(env.document.activeElement, env.row('Part I'));
  event = env.keydown(env.row('Part I'), 'ArrowRight');
  assert.equal(event.defaultPrevented, false, 'Right on an open row is not taken');
  env.keydown(env.row('Part I'), 'ArrowDown');
  assert.equal(env.document.activeElement, env.row('Chapter 1'));
  env.keydown(env.row('Chapter 1'), 'ArrowRight');
  assert.ok(env.row('Section 1.1'));
  env.keydown(env.row('Chapter 1'), 'ArrowDown');
  assert.equal(env.document.activeElement, env.row('Section 1.1'));
  env.keydown(env.row('Section 1.1'), 'ArrowLeft');
  assert.equal(env.document.activeElement, env.row('Chapter 1'), 'Left on a leaf steps to the parent');
  env.keydown(env.row('Chapter 1'), 'ArrowLeft');
  assert.equal(env.row('Section 1.1'), undefined, 'Left on an open row collapses it');
  assert.equal(env.document.activeElement, env.row('Chapter 1'));
  env.keydown(env.row('Chapter 1'), 'ArrowUp');
  assert.equal(env.document.activeElement, env.row('Part I'));
  env.keydown(env.row('Part I'), 'ArrowLeft');
  assert.deepEqual(env.titles(), ['Intro', 'Part I', 'Broken']);
  env.keydown(env.row('Intro'), 'ArrowUp');
  event = env.keydown(env.row('Intro'), 'ArrowLeft');
  assert.equal(event.defaultPrevented, false, 'Left on a top-level leaf does nothing');
  event = env.keydown(env.row('Intro'), 'Enter');
  assert.equal(event.defaultPrevented, false, 'Enter stays with the button');
  const chord = new env.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true });
  env.row('Intro').dispatchEvent(chord);
  assert.equal(chord.defaultPrevented, false, 'modified arrows are left alone');
});

test('the Outline/Pages switch persists the tab and builds thumbnails in the sidebar body', async (t) => {
  const env = await openWith(t);
  const pagesOption = env.head().querySelector('.inv-segmented-option[data-value="pages"]');
  env.click(pagesOption);
  assert.deepEqual(JSON.parse(env.storage.getItem(PREFS_KEY)), { open: true, tab: 'pages' });
  const thumbs = env.body().querySelector('.ide-pdf-thumbs');
  assert.ok(thumbs);
  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].init.root, env.body(), 'the thumbnails scroll inside the sidebar body');
  assert.equal(env.observers[0].targets.size, 5);
  assert.equal(env.thumb(3).querySelector('.ide-pdf-thumb-label').textContent, '1', 'thumb labels use page labels');
  assert.equal(env.thumb(3).getAttribute('aria-label'), 'Page 1');
  assert.ok(env.thumb(1).classList.contains('ide-pdf-thumb--current'));
  env.click(env.head().querySelector('.inv-segmented-option[data-value="outline"]'));
  assert.ok(env.body().querySelector('.ide-pdf-outline'));
  assert.deepEqual(JSON.parse(env.storage.getItem(PREFS_KEY)).tab, 'outline');
});

// --- thumbnails ------------------------------------------------------------

test('no outline shows a Pages title and the thumbnails; clicks and setPage follow', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [], numPages: 4 }), { pageNumber: 2 }, { prefs: { open: true, tab: 'outline' } });
  assert.equal(env.head().querySelector('.inv-segmented'), null);
  assert.equal(env.head().querySelector('.ide-pdf-sidebar-title').textContent, 'Pages');
  const buttons = [...env.body().querySelectorAll('.ide-pdf-thumbs > .ide-pdf-thumb[data-ide-pdf-thumb]')];
  assert.equal(buttons.length, 4);
  assert.equal(env.thumb(2).getAttribute('aria-label'), 'Page 2');
  assert.equal(env.thumb(2).querySelector('.ide-pdf-thumb-label').textContent, '2');
  assert.ok(env.thumb(2).classList.contains('ide-pdf-thumb--current'));
  assert.equal(env.thumb(2).getAttribute('aria-current'), 'page');
  env.click(env.thumb(3).querySelector('.ide-pdf-thumb-label'));
  assert.deepEqual(env.pages, [3]);
  env.sidebar.setPage('docs/book.pdf', 4);
  assert.equal(env.body().querySelectorAll('.ide-pdf-thumb--current').length, 1);
  assert.ok(env.thumb(4).classList.contains('ide-pdf-thumb--current'));
  assert.equal(env.thumb(2).hasAttribute('aria-current'), false);
  assert.equal(env.fake.calls.getPage.length, 0, 'nothing renders until a thumb scrolls into view');
  assert.equal(JSON.parse(env.storage.getItem(PREFS_KEY) || '{"tab":"outline"}').tab, 'outline', 'the fallback does not overwrite the tab pref');
});

test('an intersecting thumbnail renders into its image', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [], numPages: 2 }));
  env.dom.window.HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
    setImmediate(() => callback(new Blob(['png'], { type: 'image/png' })));
  };
  const observer = env.observers[0];
  const paper = env.thumb(2).querySelector('.ide-pdf-thumb-paper');
  const image = env.thumb(2).querySelector('img');
  assert.equal(image.hidden, true);
  observer.callback([{ target: paper, isIntersecting: true }]);
  await flush();
  assert.deepEqual(env.fake.calls.getPage, [2]);
  assert.equal(image.hidden, false);
  assert.match(image.getAttribute('src'), /^blob:/);
  env.sidebar.dispose();
  assert.equal(observer.disconnected, true);
  assert.deepEqual(env.logs, []);
});

test('a narrow overlay closes after an outline or thumbnail navigation', async (t) => {
  const env = await openWith(t);
  env.sidebar.element.style.position = 'absolute';
  env.click(env.row('Intro'));
  assert.equal(env.destinations.length, 1);
  assert.equal(env.sidebar.isOpen(), false);
  assert.equal(env.sidebar.element.hidden, true);
  assert.equal(JSON.parse(env.storage.getItem(PREFS_KEY)).open, false);
  env.sidebar.setOpen(true);
  env.click(env.row('Part I'));
  assert.equal(env.sidebar.isOpen(), true, 'a heading toggle is not a navigation');

  const thumbsEnv = await openWith(t, fakeDoc({ outline: [] }));
  thumbsEnv.sidebar.element.style.position = 'absolute';
  thumbsEnv.click(thumbsEnv.thumb(2));
  assert.deepEqual(thumbsEnv.pages, [2]);
  assert.equal(thumbsEnv.sidebar.isOpen(), false);
});

// --- lifecycle -------------------------------------------------------------

test('detach empties the sidebar and a re-attach reuses the resolved outline', async (t) => {
  const env = await openWith(t);
  env.sidebar.detach();
  assert.equal(env.body().childElementCount, 0);
  assert.equal(env.head().childElementCount, 0);
  env.sidebar.setPage('docs/book.pdf', 3);
  env.sidebar.attach('docs/book.pdf', { pdfDocument: env.fake.doc, pageCount: 5 });
  await flush();
  assert.equal(env.fake.calls.getOutline, 1, 'the outline resolved once per document');
  assert.deepEqual(env.currentTitles(), ['Part I'], 'the page recorded while detached is kept');
  env.sidebar.attach('docs/none.pdf', {});
  env.sidebar.attach('docs/none.pdf', null);
  assert.ok(env.row('Intro'), 'an attach without a document is ignored');
});

test('forget disposes the document state and a stale load does not render', async (t) => {
  const env = await openWith(t, null, {}, { prefs: { open: true, tab: 'pages' } });
  assert.equal(env.observers.length, 1);
  env.sidebar.forget('docs/book.pdf');
  assert.equal(env.observers[0].disconnected, true);
  assert.equal(env.body().childElementCount, 0);
  env.sidebar.forget('docs/book.pdf');
  env.sidebar.forget('unknown.pdf');

  // A load still resolving when its document is forgotten never renders.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = bookDoc();
  const getOutline = slow.doc.getOutline;
  slow.doc.getOutline = async () => { await gate; return getOutline(); };
  env.sidebar.attach('slow.pdf', { pdfDocument: slow.doc, pageCount: 5, pageNumber: 1 });
  env.sidebar.forget('slow.pdf');
  release();
  await flush();
  assert.equal(env.body().childElementCount, 0);

  env.sidebar.attach('docs/book.pdf', { pdfDocument: env.fake.doc, pageCount: 5, pageNumber: 1 });
  await flush();
  assert.equal(env.fake.calls.getOutline, 2, 'a forgotten document resolves again');
  assert.ok(env.body().querySelector('.ide-pdf-thumbs'));
});

test('forgetting a background document keeps the visible one', async (t) => {
  const env = await openWith(t);
  const other = bookDoc();
  env.sidebar.attach('other.pdf', { pdfDocument: other.doc, pageCount: 5 });
  await flush();
  env.sidebar.attach('docs/book.pdf', { pdfDocument: env.fake.doc, pageCount: 5 });
  await flush();
  env.sidebar.forget('other.pdf');
  assert.ok(env.row('Intro'));
  env.sidebar.setPage('other.pdf', 3);
});

test('dispose removes the element, disconnects every thumbnail observer and ignores later calls', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [] }));
  const other = fakeDoc({ outline: [] });
  env.sidebar.attach('other.pdf', { pdfDocument: other.doc, pageCount: 3 });
  await flush();
  assert.equal(env.observers.length, 2);
  const staleThumb = env.thumb(1);
  env.sidebar.dispose();
  assert.equal(env.sidebar.element.isConnected, false);
  assert.ok(env.observers.every(observer => observer.disconnected));
  env.click(staleThumb);
  assert.deepEqual(env.pages, []);
  const fresh = bookDoc();
  env.sidebar.attach('late.pdf', { pdfDocument: fresh.doc, pageCount: 5 });
  env.sidebar.setPage('late.pdf', 2);
  env.sidebar.setOpen(true);
  env.sidebar.detach();
  env.sidebar.forget('late.pdf');
  await flush();
  assert.equal(fresh.calls.getOutline, 0);
  assert.deepEqual(env.logs, []);
});

// --- failures and bounds ---------------------------------------------------

test('a getOutline rejection is logged and falls back to the thumbnails', async (t) => {
  const env = await openWith(t, fakeDoc({ outlineError: new Error('broken xref') }));
  assert.deepEqual(env.logs, [{ level: 'warn', event: 'ide.pdf.outline_failed', fields: { message: 'broken xref' } }]);
  assert.equal(env.head().querySelector('.ide-pdf-sidebar-title').textContent, 'Pages');
  assert.ok(env.body().querySelector('.ide-pdf-thumbs'));
});

test('a page-label failure keeps the resolved outline', async (t) => {
  const env = await openWith(t, bookDoc({ labels: undefined, labelsError: new Error('bad labels') }));
  assert.ok(env.row('Intro'), 'the outline still shows');
});

test('a huge outline is capped at 2000 nodes', async (t) => {
  const huge = Array.from({ length: 2500 }, (_, index) => ({ title: `S${index}`, dest: null, items: [] }));
  const env = await openWith(t, fakeDoc({ outline: huge }));
  assert.equal(env.rows().length, 2000);
  assert.equal(env.titles().at(-1), 'S1999');
  assert.deepEqual(env.logs, []);
});

test('a cyclic outline is bounded by the node cap', async () => {
  const loop = { title: 'Loop', dest: [0] };
  loop.items = [loop, loop];
  const nodes = await resolveOutline(fakeDoc({ outline: [loop] }).doc);
  let count = 0;
  let depth = 0;
  const walk = (list) => {
    for (const node of list) {
      count += 1;
      depth = Math.max(depth, node.depth);
      walk(node.children);
    }
  };
  walk(nodes);
  assert.equal(count, 2000);
  assert.ok(depth > 1);
});

test('a non-iterable child list is logged rather than thrown', async (t) => {
  const env = await openWith(t, fakeDoc({ outline: [{ title: 'Bad', dest: [0], items: { length: 1 } }] }));
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].event, 'ide.pdf.outline_failed');
  assert.ok(env.body().querySelector('.ide-pdf-thumbs'));
});

// --- resolveOutline ----------------------------------------------------------

test('resolveOutline returns [] for a missing or empty outline', async () => {
  assert.deepEqual(await resolveOutline(fakeDoc({ outline: null }).doc), []);
  assert.deepEqual(await resolveOutline(fakeDoc({ outline: [] }).doc), []);
  assert.deepEqual(await resolveOutline(fakeDoc({ outline: { title: 'x' } }).doc), []);
});

test('resolveOutline resolves named, explicit and index destinations to 1-based pages', async () => {
  const { doc } = fakeDoc({
    outline: [
      { title: ' Named ', dest: 'n', items: [{ title: 'Ref', dest: [{ index: 6 }, { name: 'Fit' }] }] },
      { title: 'Index', dest: [2] },
      { title: 'Unknown name', dest: 'nope' },
      { title: 'Bad ref', dest: [{ num: 9 }] },
      { title: 'Not array', dest: { index: 1 } },
      { dest: [0] },
      null,
    ],
    destinations: { n: [{ index: 4 }] },
  });
  const nodes = await resolveOutline(doc);
  assert.deepEqual(nodes.map(node => [node.title, node.page, node.depth, node.parent]), [
    ['Named', 5, 0, null],
    ['Index', 3, 0, null],
    ['Unknown name', null, 0, null],
    ['Bad ref', null, 0, null],
    ['Not array', null, 0, null],
    ['', 1, 0, null],
    ['', null, 0, null],
  ]);
  const child = nodes[0].children[0];
  assert.equal(child.title, 'Ref');
  assert.equal(child.page, 7);
  assert.equal(child.depth, 1);
  assert.equal(child.parent, nodes[0]);
  assert.deepEqual(child.children, []);
  assert.equal('item' in child, false, 'the raw pdf.js item is dropped');
  assert.deepEqual(child.dest, [{ index: 6 }, { name: 'Fit' }]);
  assert.equal(new Set([...nodes, child].map(node => node.id)).size, 8, 'ids are unique');
});

test('resolveOutline lists a destination that throws without a page', async () => {
  const { doc } = fakeDoc({ outline: [{ title: 'A', dest: 'x' }], destinationError: new Error('gone') });
  const [node] = await resolveOutline(doc);
  assert.equal(node.page, null);
  assert.equal(node.dest, 'x');
});

test('resolveOutline propagates a getOutline rejection', async () => {
  await assert.rejects(resolveOutline(fakeDoc({ outlineError: new Error('nope') }).doc), /nope/);
});
