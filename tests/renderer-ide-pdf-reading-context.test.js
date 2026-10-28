'use strict';

// Row 65 W2: the IDE PDF reading context (page text, selection, Ask Jenny).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  CHANGED_EVENT,
  MAX_TEXT_CHARS,
  createPdfReadingContext,
  extractPageText,
} = require('../renderer/features/renderer-ide-pdf-reading-context');

const KEY = 'docs/paper.pdf';

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

// Page changes settle (PAGE_SETTLE_MS, 150 ms) before extraction and the announce.
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 200));
  await flush();
}

// `pages` maps a page number to its text items, an Error to reject with, or
// a function returning a promise of the content.
function fakeDoc(pages = {}) {
  const textCalls = [];
  const doc = {
    async getPage(pageNumber) {
      return {
        getTextContent() {
          textCalls.push(pageNumber);
          const value = pages[pageNumber];
          if (value instanceof Error) return Promise.reject(value);
          if (typeof value === 'function') return value();
          return Promise.resolve({ items: value || [{ str: `Page ${pageNumber} text` }] });
        },
      };
    },
  };
  return { doc, textCalls };
}

const VIEWER_HTML = '<div id="host"><div id="viewer">'
  + '<div class="page" data-page-number="1"><span id="p1">Alpha beta</span></div>'
  + '<div class="page" data-page-number="2"><span id="p2">Gamma delta</span></div>'
  + '<div id="loose">Loose words</div>'
  + '</div></div><p id="outside">Outside text</p>';

function makeContext(t, options = {}) {
  const dom = new JSDOM(`<!doctype html><body>${VIEWER_HTML}</body>`);
  const { window } = dom;
  const document = window.document;
  // jsdom has no Range layout; Chromium gives the selection's line boxes.
  window.Range.prototype.getClientRects = () => [{ top: 120, right: 300, left: 200, bottom: 136 }];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 120, right: 300, left: 200, bottom: 136 });
  const host = document.getElementById('host');
  const viewer = document.getElementById('viewer');
  host.getBoundingClientRect = () => ({ top: 20, left: 10, width: 800, height: 600, right: 810, bottom: 620 });
  const listeners = { document: new Map(), host: new Map() };
  const track = (target, bucket) => {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => { listeners[bucket].set(`${type}:${Boolean(opts)}`, fn); add(type, fn, opts); };
    target.removeEventListener = (type, fn, opts) => {
      if (listeners[bucket].get(`${type}:${Boolean(opts)}`) === fn) listeners[bucket].delete(`${type}:${Boolean(opts)}`);
      remove(type, fn, opts);
    };
  };
  track(document, 'document');
  track(host, 'host');
  const logs = [];
  const asks = [];
  const events = [];
  window.addEventListener(CHANGED_EVENT, event => events.push(event.detail.path));
  const ctx = createPdfReadingContext({
    documentRef: document,
    hostEl: host,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    onAsk: key => asks.push(key),
    ...(options.canAsk ? { canAsk: options.canAsk } : {}),
  });
  t.after(() => ctx.dispose());
  const fake = options.fake || fakeDoc(options.pages);
  if (options.attach !== false) {
    ctx.attach(KEY, { pdfDocument: fake.doc, viewerEl: viewer, pageCount: 2, pageNumber: options.pageNumber || 1, ...options.attachDoc });
  }
  const askEl = ctx.element;
  const askButton = askEl.querySelector('.ide-pdf-ask-button[data-ide-pdf-ask]');
  const select = (startNode, startOffset, endNode, endOffset) => {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };
  const text = id => document.getElementById(id).firstChild;
  const fire = (target, type, init = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const key = (target, type, keyName) => {
    const event = new window.KeyboardEvent(type, { key: keyName, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { dom, window, document, host, viewer, ctx, fake, logs, asks, events, askEl, askButton, listeners, select, text, fire, key };
}

// --- page text ------------------------------------------------------------

test('exports the event name and the shared text cap', () => {
  assert.equal(CHANGED_EVENT, 'ide:pdf-reading-context-changed');
  assert.equal(MAX_TEXT_CHARS, 6000);
});

test('getContext without want only peeks and never extracts text', async (t) => {
  const env = makeContext(t);
  await flush();
  assert.deepEqual(env.fake.textCalls, [], 'attach alone does not extract');
  assert.deepEqual(env.ctx.getContext(KEY), { page: 1, pageCount: 2, selection: null, text: '', textState: 'pending' });
  assert.deepEqual(env.ctx.getContext(KEY, { want: 'yes' }), { page: 1, pageCount: 2, selection: null, text: '', textState: 'pending' });
  await flush();
  assert.deepEqual(env.fake.textCalls, []);
  assert.deepEqual(env.events, []);
  assert.equal(env.ctx.getContext('unknown.pdf', { want: true }), null);
});

test('getContext with want reports pending, then ready, and announces the change', async (t) => {
  const env = makeContext(t, { pages: { 1: [{ str: 'Hello', hasEOL: true }, { str: 'world' }, { str: '' }, {}] } });
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 1, pageCount: 2, selection: null, text: '', textState: 'pending' });
  assert.equal(env.ctx.getContext(KEY, { want: true }).textState, 'pending', 'still pending on a second call');
  await flush();
  assert.deepEqual(env.fake.textCalls, [1], 'one extraction per page');
  assert.deepEqual(env.events, [KEY]);
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 1, pageCount: 2, selection: null, text: 'Hello\nworld', textState: 'ready' });
  assert.deepEqual(env.ctx.getContext(KEY), { page: 1, pageCount: 2, selection: null, text: 'Hello\nworld', textState: 'ready' }, 'a peek reads the cache');
  assert.deepEqual(env.fake.textCalls, [1]);
});

test('an empty or whitespace-only text layer reports empty', async (t) => {
  const env = makeContext(t, { pages: { 1: [], 2: [{ str: '  ', hasEOL: true }] } });
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 1, pageCount: 2, selection: null, text: '', textState: 'empty' });
  env.ctx.setPage(KEY, 2);
  await settle();
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 2, pageCount: 2, selection: null, text: '', textState: 'empty' });
  assert.deepEqual(env.logs, []);
});

test('a getTextContent rejection reports empty and logs a warning', async (t) => {
  const env = makeContext(t, { pages: { 1: new Error('stream broke') } });
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.equal(env.ctx.getContext(KEY, { want: true }).textState, 'empty');
  assert.deepEqual(env.logs, [{ level: 'warn', event: 'ide.pdf.page_text_failed', fields: { page: 1, message: 'stream broke' } }]);
  assert.deepEqual(env.events, [KEY], 'the failure still announces so the chat stops waiting');
});

test('page text is capped at MAX_TEXT_CHARS', async (t) => {
  const env = makeContext(t, { pages: { 1: [{ str: 'x'.repeat(4000) }, { str: 'y'.repeat(4000) }, { str: 'z'.repeat(4000) }] } });
  env.ctx.getContext(KEY, { want: true });
  await flush();
  const { text, textState } = env.ctx.getContext(KEY, { want: true });
  assert.equal(textState, 'ready');
  assert.equal(text.length, MAX_TEXT_CHARS);
  assert.equal(text.includes('z'), false);
});

test('setPage while wanted prefetches and announces once settled; the cache keeps at most 8 pages', async (t) => {
  const env = makeContext(t);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.deepEqual(env.events, [KEY]);
  env.ctx.setPage(KEY, 2);
  assert.deepEqual(env.events, [KEY], 'nothing until the page settles');
  assert.deepEqual(env.fake.textCalls, [1]);
  await settle();
  assert.deepEqual(env.fake.textCalls, [1, 2], 'the settled page is extracted');
  assert.deepEqual(env.events, [KEY, KEY, KEY], 'announced on settle and again when its text lands');
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 2, pageCount: 2, selection: null, text: 'Page 2 text', textState: 'ready' });
  env.ctx.setPage(KEY, 2);
  assert.equal(env.events.length, 3, 'the same page is a no-op');
  env.ctx.setPage(KEY, 1.5);
  assert.equal(env.events.length, 3);

  // Pages crossed quickly are not extracted: only where the reader stops.
  for (let page = 3; page <= 9; page += 1) env.ctx.setPage(KEY, page);
  await settle();
  assert.deepEqual(env.fake.textCalls, [1, 2, 9]);
  // A send-time read extracts at once; eight more pages evict page 1.
  for (let page = 3; page <= 8; page += 1) {
    env.ctx.setPage(KEY, page);
    env.ctx.getContext(KEY, { want: true });
  }
  await settle();
  assert.deepEqual(env.fake.textCalls, [1, 2, 9, 3, 4, 5, 6, 7, 8]);
  env.ctx.setPage(KEY, 2);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.equal(env.fake.textCalls.length, 9, 'page 2 is still cached');
  env.ctx.setPage(KEY, 1);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.deepEqual(env.fake.textCalls.slice(9), [1], 'page 1 was evicted and is extracted again');
});

test('a peek turns prefetching off again', async (t) => {
  const env = makeContext(t);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  env.ctx.getContext(KEY);
  env.ctx.setPage(KEY, 2);
  await flush();
  assert.deepEqual(env.fake.textCalls, [1]);
  assert.equal(env.ctx.getContext(KEY).textState, 'pending');
});

test('text that lands after the reader moved on does not announce', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeContext(t, { pages: { 1: () => gate.then(() => ({ items: [{ str: 'late' }] })) } });
  env.ctx.getContext(KEY, { want: true });
  env.ctx.setPage(KEY, 2);
  await flush();
  const count = env.events.length;
  release();
  await flush();
  assert.equal(env.events.length, count);
  env.ctx.setPage(KEY, 1);
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), { page: 1, pageCount: 2, selection: null, text: 'late', textState: 'ready' });
});

test('setPage for a background document neither prefetches nor announces', async (t) => {
  const env = makeContext(t);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  const other = fakeDoc();
  env.ctx.attach('other.pdf', { pdfDocument: other.doc, viewerEl: env.viewer, pageCount: 4, pageNumber: 1 });
  const count = env.events.length;
  env.ctx.setPage(KEY, 2);
  await flush();
  assert.equal(env.events.length, count);
  assert.deepEqual(env.fake.textCalls, [1]);
  assert.equal(env.ctx.getContext(KEY).page, 2, 'the page is still recorded');
  env.ctx.setPage('missing.pdf', 3);
});

test('reset clears the cached text and the selection', async (t) => {
  const env = makeContext(t);
  env.ctx.getContext(KEY, { want: true });
  await flush();
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha');
  env.ctx.reset(KEY);
  env.ctx.reset('missing.pdf');
  assert.deepEqual(env.ctx.getContext(KEY), { page: 1, pageCount: 2, selection: null, text: '', textState: 'pending' });
  env.ctx.getContext(KEY, { want: true });
  await flush();
  assert.deepEqual(env.fake.textCalls, [1, 1], 'the page is extracted again after a reset');
});

test('extractPageText joins items, adds EOL breaks and tolerates missing content', async () => {
  const doc = {
    async getPage(page) {
      return {
        async getTextContent() {
          if (page === 2) return null;
          return { items: [{ str: 'a', hasEOL: true }, { str: 'b' }, null, { str: 7 }, { hasEOL: true }] };
        },
      };
    },
  };
  assert.equal(await extractPageText(doc, 1), 'a\nb7\n');
  assert.equal(await extractPageText(doc, 2), '');
});

// --- selection and Ask Jenny ------------------------------------------------

test('a selection across pages is recorded with its page span and shows the ask button', async (t) => {
  const env = makeContext(t);
  assert.equal(env.askEl.className, 'ide-pdf-ask');
  assert.equal(env.askEl.parentElement, env.host);
  assert.equal(env.askEl.hidden, true);
  assert.ok(env.askButton, 'the ask button renders');
  assert.equal(env.askButton.getAttribute('aria-label'), 'Ask Jenny about the selected text');

  env.select(env.text('p1'), 6, env.text('p2'), 5);
  env.fire(env.text('p2').parentElement, 'pointerup');
  assert.deepEqual(env.ctx.getContext(KEY, { want: true }), {
    page: 1,
    pageCount: 2,
    selection: { text: 'betaGamma', startPage: 1, endPage: 2 },
    text: 'betaGamma',
    textState: 'ready',
  });
  assert.deepEqual(env.fake.textCalls, [], 'a selection answers without page text');
  assert.deepEqual(env.events, [KEY]);
  assert.equal(env.askEl.hidden, false);
  assert.match(env.askEl.style.top, /px$/);
  assert.match(env.askEl.style.left, /px$/);
  // The snapshot is a copy.
  env.ctx.getContext(KEY).selection.text = 'mutated';
  assert.equal(env.ctx.getContext(KEY).selection.text, 'betaGamma');

  env.askButton.querySelector('span').dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(env.asks, [KEY]);
  assert.equal(env.askEl.hidden, true);
  assert.equal(env.ctx.getContext(KEY).selection.text, 'betaGamma', 'the selection outlives the click');
});

test('keyup reads a keyboard selection, and text off the pages uses the current page', async (t) => {
  const env = makeContext(t, { pageNumber: 2 });
  env.select(env.text('loose'), 0, env.text('loose'), 5);
  env.key(env.viewer, 'keyup', 'ArrowRight');
  assert.deepEqual(env.ctx.getContext(KEY).selection, { text: 'Loose', startPage: 2, endPage: 2 });
  assert.equal(env.askEl.hidden, false);
});

test('a long selection is capped at MAX_TEXT_CHARS', async (t) => {
  const env = makeContext(t);
  env.document.getElementById('p1').textContent = 'q'.repeat(MAX_TEXT_CHARS + 50);
  env.select(env.text('p1'), 0, env.text('p1'), MAX_TEXT_CHARS + 50);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text.length, MAX_TEXT_CHARS);
});

test('a collapsed selection inside the viewer clears the selection and hides the button', async (t) => {
  const env = makeContext(t);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.askEl.hidden, false);
  env.select(env.text('p2'), 2, env.text('p2'), 2);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection, null);
  assert.equal(env.askEl.hidden, true);
  assert.deepEqual(env.events, [KEY, KEY]);
  env.fire(env.viewer, 'pointerup');
  assert.deepEqual(env.events, [KEY, KEY], 'clearing an empty selection does not announce');
  // A whitespace-only selection counts as empty.
  env.document.getElementById('p1').textContent = '   ';
  env.select(env.text('p1'), 0, env.text('p1'), 3);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection, null);
});

test('a selection outside the viewer, or a gesture outside it, is ignored', async (t) => {
  const env = makeContext(t);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  env.select(env.text('outside'), 0, env.text('outside'), 7);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'a range outside the pages keeps the passage');
  env.document.getSelection().removeAllRanges();
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'no range at all keeps the passage');
  assert.deepEqual(env.events, [KEY]);
  // A drag on the pages released outside them is still the reader's passage.
  env.select(env.text('p2'), 0, env.text('p2'), 5);
  env.fire(env.document.getElementById('outside'), 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Gamma');
  // The same selection again tells the chat nothing new.
  env.fire(env.document.getElementById('outside'), 'pointerup');
  assert.deepEqual(env.events, [KEY, KEY]);
});

test('Escape, a scroll and a collapsing selection hide the ask button', async (t) => {
  const env = makeContext(t);
  const show = () => {
    env.select(env.text('p1'), 0, env.text('p1'), 5);
    env.fire(env.viewer, 'pointerup');
    assert.equal(env.askEl.hidden, false);
  };
  show();
  env.key(env.askButton, 'keydown', 'Enter');
  assert.equal(env.askEl.hidden, false);
  env.key(env.askButton, 'keydown', 'Escape');
  assert.equal(env.askEl.hidden, true);

  show();
  env.key(env.viewer, 'keydown', 'Escape');
  assert.equal(env.askEl.hidden, true, 'Esc with focus on the pages hides it too');

  show();
  env.fire(env.viewer, 'scroll', { bubbles: false });
  assert.equal(env.askEl.hidden, true, 'a scroll inside the host hides it (capture)');

  show();
  env.fire(env.document, 'selectionchange', { bubbles: false });
  assert.equal(env.askEl.hidden, false, 'a live selection keeps it');
  env.document.getSelection().removeAllRanges();
  env.fire(env.document, 'selectionchange', { bubbles: false });
  assert.equal(env.askEl.hidden, true);
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'hiding the button keeps the passage');
});

test('detach hides the button and forget drops the document', async (t) => {
  const env = makeContext(t);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  env.ctx.detach();
  assert.equal(env.askEl.hidden, true);
  env.askButton.click();
  assert.deepEqual(env.asks, [], 'a detached context does not ask');
  env.select(env.text('p2'), 0, env.text('p2'), 5);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'a detached context reads no selection');

  const other = fakeDoc();
  env.ctx.attach('other.pdf', { pdfDocument: other.doc, viewerEl: env.viewer, pageCount: 1 });
  env.ctx.forget(KEY);
  assert.equal(env.ctx.getContext(KEY), null);
  assert.equal(env.ctx.getContext('other.pdf').page, 1, 'forgetting a background document keeps the current one');
  env.ctx.forget('other.pdf');
  assert.equal(env.ctx.getContext('other.pdf'), null);
  env.fire(env.viewer, 'pointerup');
  assert.deepEqual(env.logs, []);
});

test('a document attached without a pdf reports no context', async (t) => {
  const env = makeContext(t, { attachDoc: { pdfDocument: null } });
  assert.equal(env.ctx.getContext(KEY, { want: true }), null);
  env.ctx.setPage(KEY, 2);
  await flush();
  assert.deepEqual(env.logs, []);
});

test('dispose removes the ask element and every listener', async (t) => {
  const env = makeContext(t);
  assert.deepEqual([...env.listeners.document.keys()].sort(), ['keyup:true', 'pointerup:true', 'selectionchange:false']);
  assert.deepEqual([...env.listeners.host.keys()].sort(), ['keydown:false', 'scroll:true']);
  const button = env.askButton;
  env.ctx.dispose();
  assert.equal(env.askEl.isConnected, false);
  assert.equal(env.listeners.document.size, 0);
  assert.equal(env.listeners.host.size, 0);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  env.fire(env.viewer, 'scroll', { bubbles: false });
  button.click();
  assert.deepEqual(env.events, []);
  assert.deepEqual(env.asks, []);
  assert.equal(env.ctx.getContext(KEY), null);
  env.ctx.attach(KEY, { pdfDocument: env.fake.doc, viewerEl: env.viewer, pageCount: 2 });
  assert.equal(env.ctx.getContext(KEY), null, 'attach after dispose is a no-op');
  env.ctx.dispose();
});

// ── Review fixes (2026-10-19) ──

test('the ask button stays hidden while the chat cannot take it', async (t) => {
  const env = makeContext(t, { canAsk: () => false });
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  assert.equal(env.askEl.hidden, true);
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'the selection is still the chat context');
});

test('scrolling away from a selection makes the page being read the subject again', async (t) => {
  const env = makeContext(t);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  env.ctx.setPage(KEY, 1);
  assert.equal(env.ctx.getContext(KEY).selection.text, 'Alpha', 'still on the selected page');
  env.ctx.setPage(KEY, 2);
  assert.equal(env.ctx.getContext(KEY).selection, null);
});

test('a reload reset announces so the chat drops a stale selection label', async (t) => {
  const env = makeContext(t);
  env.select(env.text('p1'), 0, env.text('p1'), 5);
  env.fire(env.viewer, 'pointerup');
  const before = env.events.length;
  env.ctx.reset(KEY);
  assert.equal(env.events.length, before + 1);
  assert.equal(env.ctx.getContext(KEY).selection, null);
});
