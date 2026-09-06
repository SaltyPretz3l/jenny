const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

// UIUX-026: the lazy-mermaid IntersectionObserver used to be disconnected
// and recreated on every renderInlineMermaidBlocks() scan — so a diagram
// from an EARLIER, differently-scoped scan (still off-screen, not yet
// intersected) lost its watcher the moment ANY other container (a new chat
// message, a virtualizer-restored row, an artifact document, an IDE
// preview) triggered a new scan. It would never render, even after the
// user scrolled to it. Sibling of tests/markdown-utils.test.js — split out
// to stay under the file-size ceiling.

function loadMarkdownUtils() {
  const modulePath = require.resolve('../renderer/shared/markdown-utils');
  delete require.cache[modulePath];
  return require('../renderer/shared/markdown-utils');
}

test('UIUX-026: renderInlineMermaidBlocks reuses one stable observer across calls (does not disconnect it)', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(_host, _source, options) { options?.onSuccess?.(); return Promise.resolve(); },
  };

  const observers = [];
  class FakeIO {
    constructor(callback) { this.callback = callback; this.observed = new Set(); this.disconnected = false; observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  global.IntersectionObserver = FakeIO;

  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();

  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  renderInlineMermaidBlocks(root, { isStreaming: false });
  renderInlineMermaidBlocks(root, { isStreaming: false });

  // A single stable observer accumulates targets across every scoped scan
  // — it must NOT be torn down and recreated on each call (that used to
  // silently drop any block from a different container that hadn't
  // intersected yet; see the regression test below).
  assert.equal(observers.length, 1, 'renderInlineMermaidBlocks must reuse one observer, not create a fresh one per call');
  assert.equal(observers[0].disconnected, false, 'the shared observer must not be disconnected by a later scan');
});

test('UIUX-026: a block observed in an earlier, different-container scan still renders after a later scan of another container', async (t) => {
  // Regression test for the exact defect: renderInlineMermaidBlocks used to
  // disconnect + recreate its observer on every call, so a diagram from an
  // EARLIER scoped scan (e.g. a chat message rendered a while ago, still
  // off-screen) lost its watcher the moment ANY other container (e.g. a
  // virtualizer-restored, unrelated row) triggered a new scan. It would
  // never render, even after the user scrolled to it.
  const dom = new JSDOM('<div id="containerA"></div><div id="containerB"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  const renderedHosts = [];
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, _source, options) { renderedHosts.push(host); options?.onSuccess?.(); return Promise.resolve(); },
  };

  const observers = [];
  class FakeIO {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
    // Test hook: simulate the target scrolling into view.
    fireIntersect(target) { this.callback([{ target, isIntersecting: true }]); }
  }
  global.IntersectionObserver = FakeIO;

  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();

  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const containerA = dom.window.document.getElementById('containerA');
  const containerB = dom.window.document.getElementById('containerB');
  containerA.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  containerB.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nC-->D\n```');

  // Scan A first (diagram stays off-screen — never intersects yet).
  renderInlineMermaidBlocks(containerA, { isStreaming: false });
  const blockA = containerA.querySelector('.markdown-mermaid-block[data-mermaid-source]');
  assert.ok(blockA, 'expected a mermaid block in container A');

  // A later, unrelated scan of a DIFFERENT container must not stop
  // watching blockA.
  renderInlineMermaidBlocks(containerB, { isStreaming: false });

  assert.equal(observers.length, 1, 'both scans must share the same observer instance');
  const observer = observers[0];
  assert.ok(observer.observed.has(blockA), 'blockA must still be tracked by the observer after an unrelated container was scanned');

  // Now the user scrolls to blockA — it must still be able to render.
  observer.fireIntersect(blockA);
  assert.equal(blockA.getAttribute('data-mermaid-rendered'), 'true', 'blockA must render once it intersects, even though a different container was scanned in between');
});

test('UIUX-026 hygiene: the persistent observer\'s fallback render fn is the LATEST scan\'s, not the first scan that created it', async (t) => {
  // The observer's onIntersect closure is created once, on the first scan,
  // and lives across every later scan (that's the whole point of the reuse
  // fix above). If its fallback (used when renderMermaidDirect is
  // momentarily unavailable at intersect time) stayed pinned to the FIRST
  // scan's renderFn identity, a block observed by a much later scan would
  // fall back to a stale function instead of the current one.
  const dom = new JSDOM('<div id="containerA"></div><div id="containerB"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);

  const calls = [];
  const fnA = (_host, _source, options) => { calls.push('A'); options?.onSuccess?.(); return Promise.resolve(); };
  const fnB = (_host, _source, options) => { calls.push('B'); options?.onSuccess?.(); return Promise.resolve(); };
  global.rendererMermaidUtils = { renderMermaidDirect: fnA };

  const observers = [];
  class FakeIO {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
    fireIntersect(target) { this.callback([{ target, isIntersecting: true }]); }
  }
  global.IntersectionObserver = FakeIO;

  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();

  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const containerA = dom.window.document.getElementById('containerA');
  const containerB = dom.window.document.getElementById('containerB');
  containerA.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  containerB.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nC-->D\n```');

  // First scan creates the persistent observer with renderFn identity fnA
  // captured in its onIntersect closure.
  renderInlineMermaidBlocks(containerA, { isStreaming: false });
  const blockA = containerA.querySelector('.markdown-mermaid-block[data-mermaid-source]');

  // A later scan resolves a DIFFERENT renderFn identity (fnB).
  global.rendererMermaidUtils.renderMermaidDirect = fnB;
  renderInlineMermaidBlocks(containerB, { isStreaming: false });

  // At intersect time, renderMermaidDirect is momentarily unavailable, so
  // the observer must fall back to its render fn.
  global.rendererMermaidUtils.renderMermaidDirect = undefined;
  observers[0].fireIntersect(blockA);

  assert.deepEqual(calls, ['B'], 'the fallback must be the latest scan\'s renderFn (B), not the first scan\'s renderFn (A) captured when the observer was created');
});

test('an empty follow-up scan prunes a detached Mermaid observer target', (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = { renderMermaidDirect() {} };
  let observer;
  global.IntersectionObserver = class FakeIO {
    constructor() { this.observed = new Set(); observer = this; }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
  };

  const { renderMarkdown, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();
  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    global.IntersectionObserver = previousIO;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  renderInlineMermaidBlocks(root);
  const block = root.firstElementChild;
  assert.equal(observer.observed.has(block), true, 'initial scan observes the Mermaid block');

  root.textContent = '';
  renderInlineMermaidBlocks(root);

  assert.equal(block.isConnected, false);
  assert.equal(observer.observed.has(block), false, 'empty follow-up scan releases the detached block');
  assert.equal(observer.observed.size, 0);
});

test('UIUX-026: a mermaid block that fails to render does not opt into virtualizer live-state pinning', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(_host, _source, options) {
      options?.onFailure?.();
      return Promise.resolve();
    },
  };
  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks } = loadMarkdownUtils();

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));

  // No live listeners were ever attached, so there is nothing for the
  // virtualizer to preserve — pinning a failed block would only add
  // pressure to the bounded stateful-row cache for no benefit.
  assert.equal(root.querySelector('.markdown-mermaid-block').getAttribute('data-virtualizer-pin-live'), null);
});
