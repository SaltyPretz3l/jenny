const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const baseMarkdownUtils = require('../renderer/shared/markdown-utils');
const { renderMarkdown, renderStreamingMarkdownUnits } = baseMarkdownUtils;

function loadMarkdownUtils() {
  const modulePath = require.resolve('../renderer/shared/markdown-utils');
  delete require.cache[modulePath];
  return require('../renderer/shared/markdown-utils');
}

/* ── Empty / falsy inputs ── */

test('renderMarkdown returns empty string for null', () => {
  assert.equal(renderMarkdown(null), '');
});

test('renderMarkdown returns empty string for undefined', () => {
  assert.equal(renderMarkdown(undefined), '');
});

test('renderMarkdown returns empty string for empty string', () => {
  assert.equal(renderMarkdown(''), '');
});

/* ── Basic formatting ── */

test('renderMarkdown renders bold text', () => {
  const result = renderMarkdown('**bold**');
  assert.ok(result.includes('<strong>bold</strong>'), `Expected <strong> tag, got: ${result}`);
});

test('renderMarkdown renders italic text', () => {
  const result = renderMarkdown('*italic*');
  assert.ok(result.includes('<em>italic</em>'), `Expected <em> tag, got: ${result}`);
});

test('renderMarkdown renders strikethrough text', () => {
  const result = renderMarkdown('~~deleted~~');
  assert.ok(result.includes('<del>deleted</del>'), `Expected <del> tag, got: ${result}`);
});

/* ── Headings ── */

test('renderMarkdown renders h1', () => {
  const result = renderMarkdown('# Heading 1');
  assert.ok(result.includes('<h1>'), `Expected <h1> tag, got: ${result}`);
});

test('renderMarkdown renders h3', () => {
  const result = renderMarkdown('### Heading 3');
  assert.ok(result.includes('<h3>'), `Expected <h3> tag, got: ${result}`);
});

/* ── Code ── */

test('renderMarkdown renders inline code', () => {
  const result = renderMarkdown('Use `console.log()`');
  assert.ok(result.includes('<code>console.log()</code>'), `Expected <code> tag, got: ${result}`);
});

test('renderMarkdown renders code blocks', () => {
  const result = renderMarkdown('```js\nconst x = 1;\n```');
  const document = new JSDOM(result).window.document;
  const header = document.querySelector('.markdown-code-header');
  const wrapToggles = header.querySelectorAll('.inv-codeblock-wrap-toggle');
  const copyButton = header.querySelector('.inv-codeblock-copy');
  assert.ok(result.includes('markdown-code-header'), `Expected code header wrapper, got: ${result}`);
  assert.ok(result.includes('JavaScript'), `Expected JavaScript label, got: ${result}`);
  assert.ok(result.includes('<pre>'), `Expected <pre> tag, got: ${result}`);
  assert.ok(result.includes('<code'), `Expected <code> tag, got: ${result}`);
  assert.ok(result.includes('tok tok-default'), `Expected safe pre-warm token markup, got: ${result}`);
  assert.ok(result.includes('data-language-id="javascript"'), `Expected normalized language id, got: ${result}`);
  assert.ok(result.includes('const x = 1;'), `Expected code content, got: ${result}`);
  assert.equal(wrapToggles.length, 1);
  assert.equal(wrapToggles[0].getAttribute('aria-pressed'), 'false');
  assert.strictEqual(wrapToggles[0].nextElementSibling, copyButton);
});

// Reasoning prose is the model's raw thinking — deeply/irregularly indented
// nested bullet lists. Indented (4-space) code blocks are disabled so that prose
// never gets misparsed into a <pre><code> CODE/Copy widget. Fenced ``` blocks
// (the test above) remain the only way to produce a code block.
test('renderMarkdown does NOT turn an indented bullet block into a code block', () => {
  const result = renderMarkdown('Here is my reasoning:\n\n    * First point indented four spaces\n    * Second point indented four spaces');
  assert.ok(!result.includes('<pre>'), `Expected no <pre> code block, got: ${result}`);
  assert.ok(!result.includes('markdown-code-block'), `Expected no code-block wrapper, got: ${result}`);
  assert.ok(result.includes('First point indented four spaces'), `Expected the text preserved as prose, got: ${result}`);
});

test('renderMarkdown does NOT turn a single 4-space indented line into a code block', () => {
  const result = renderMarkdown('Normal paragraph.\n\n    just an indented line of text');
  assert.ok(!result.includes('<pre>'), `Expected no <pre> code block, got: ${result}`);
  assert.ok(result.includes('just an indented line of text'), `Expected the text preserved, got: ${result}`);
});

/* ── Lists ── */

test('renderMarkdown renders unordered lists', () => {
  const result = renderMarkdown('- item one\n- item two');
  assert.ok(result.includes('<ul>'), `Expected <ul> tag, got: ${result}`);
  assert.ok(result.includes('<li>'), `Expected <li> tag, got: ${result}`);
});

test('renderMarkdown renders ordered lists', () => {
  const result = renderMarkdown('1. first\n2. second');
  assert.ok(result.includes('<ol>'), `Expected <ol> tag, got: ${result}`);
});

/* ── Links ── */

test('renderMarkdown renders links', () => {
  const result = renderMarkdown('[example](https://example.com)');
  assert.ok(result.includes('<a'), `Expected <a> tag, got: ${result}`);
  assert.ok(result.includes('href="https://example.com"'), `Expected href attr, got: ${result}`);
});

/* ── Blockquotes ── */

test('renderMarkdown renders blockquotes', () => {
  const result = renderMarkdown('> quoted text');
  assert.ok(result.includes('<blockquote>'), `Expected <blockquote> tag, got: ${result}`);
});

/* ── Tables ── */

test('renderMarkdown renders tables', () => {
  const md = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |';
  const result = renderMarkdown(md);
  assert.ok(result.includes('<table>'), `Expected <table> tag, got: ${result}`);
  assert.ok(result.includes('<th>'), `Expected <th> tag, got: ${result}`);
  assert.ok(result.includes('<td>'), `Expected <td> tag, got: ${result}`);
});

/* ── Horizontal rules ── */

test('renderMarkdown renders horizontal rules', () => {
  const result = renderMarkdown('---');
  assert.ok(result.includes('<hr'), `Expected <hr> tag, got: ${result}`);
});

/* ── XSS prevention ── */

test('renderMarkdown strips script tags', () => {
  const result = renderMarkdown('<script>alert("xss")</script>');
  assert.ok(!result.includes('<script>'), `Expected no <script> tag, got: ${result}`);
});

test('renderMarkdown strips event handler attributes', () => {
  const result = renderMarkdown('<img src="x" onerror="alert(1)">');
  assert.ok(!result.includes('onerror'), `Expected no onerror attr, got: ${result}`);
});

test('renderMarkdown strips javascript: URLs', () => {
  const result = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!result.includes('javascript:'), `Expected no javascript: URL, got: ${result}`);
});

/* ── Streaming edge cases ── */

test('renderMarkdown handles incomplete bold (streaming) without throwing', () => {
  let result;
  assert.doesNotThrow(() => { result = renderMarkdown('**incomplete bold'); });
  // marked leaves the unclosed ** literal; the text is wrapped in a sanitized <p>.
  assert.ok(result.includes('<p>'), `Expected paragraph wrapper, got: ${result}`);
  assert.ok(result.includes('**incomplete bold'), `Expected literal source preserved, got: ${result}`);
});

test('renderMarkdown handles unclosed code fence without throwing', () => {
  let result;
  assert.doesNotThrow(() => { result = renderMarkdown('```js\nconst x = 1;'); });
  assert.ok(result.includes('markdown-code-header'), `Expected code-header wrapper from unclosed fence, got: ${result}`);
  assert.ok(result.includes('const x = 1;'), `Expected source text preserved, got: ${result}`);
});

test('renderMarkdown preserves a bounded label for unknown fenced languages', () => {
  const result = renderMarkdown('```brainfuck\n++++++++[>++++[>++>+++>+++>+<<<<-]\n```');
  assert.ok(result.includes('markdown-code-language'), `Expected language label wrapper, got: ${result}`);
  assert.ok(result.includes('brainfuck'), `Expected normalized fence label, got: ${result}`);
});

test('renderMarkdown handles incomplete list without throwing', () => {
  let result;
  assert.doesNotThrow(() => { result = renderMarkdown('- item one\n-'); });
  assert.ok(result.includes('<ul>'), `Expected <ul> tag for incomplete list, got: ${result}`);
  assert.ok(result.includes('item one'), `Expected list item text preserved, got: ${result}`);
});

test('renderStreamingMarkdownUnits keeps paragraphs as top-level reveal units', () => {
  const result = renderStreamingMarkdownUnits('First paragraph.\n\nSecond paragraph.');

  assert.equal(result.units.length, 2);
  assert.match(result.units[0].html, /<p>First paragraph\.<\/p>/);
  assert.match(result.units[1].html, /<p>Second paragraph\.<\/p>/);
  assert.equal(result.changedStartIndex, 0);
});

test('renderStreamingMarkdownUnits keeps lists as a single reveal unit', () => {
  const result = renderStreamingMarkdownUnits('- item one\n- item two');

  assert.equal(result.units.length, 1);
  assert.match(result.units[0].html, /<ul>/);
});

test('renderStreamingMarkdownUnits keeps tables as a single reveal unit', () => {
  const result = renderStreamingMarkdownUnits('| A | B |\n| - | - |\n| 1 | 2 |');

  assert.equal(result.units.length, 1);
  assert.match(result.units[0].html, /<table>/);
});

test('renderStreamingMarkdownUnits keeps blockquotes and code fences as single reveal units', () => {
  const blockquote = renderStreamingMarkdownUnits('> quoted text');
  const codeBlock = renderStreamingMarkdownUnits('```js\nconst x = 1;\n```');

  assert.equal(blockquote.units.length, 1);
  assert.match(blockquote.units[0].html, /<blockquote>/);
  assert.equal(codeBlock.units.length, 1);
  assert.match(codeBlock.units[0].html, /markdown-code-header/);
  assert.match(codeBlock.units[0].html, /JavaScript/);
  assert.match(codeBlock.units[0].html, /<pre>/);
});

test('renderStreamingMarkdownUnits fingerprints unchanged prefixes and flags only appended units', () => {
  const previous = renderStreamingMarkdownUnits('First paragraph.');
  const next = renderStreamingMarkdownUnits('First paragraph.\n\nSecond paragraph.', {
    previousFingerprints: previous.fingerprints,
  });

  assert.equal(next.changedStartIndex, 1);
  assert.deepEqual(next.fingerprints.slice(0, 1), previous.fingerprints);
});

test('renderStreamingMarkdownUnits detects trailing block reflow from incomplete markdown', () => {
  const previous = renderStreamingMarkdownUnits('**incomplete bold');
  const next = renderStreamingMarkdownUnits('**incomplete bold**\n\nDone.', {
    previousFingerprints: previous.fingerprints,
  });

  assert.equal(next.changedStartIndex, 0);
  assert.equal(next.units.length, 2, 'the reflowed stream yields exactly two units');
});

test('renderInlineMermaidBlocks renders inline Mermaid previews and keeps source visible', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, _source, options) {
      host.innerHTML = '<iframe src="mermaid-frame.html"></iframe>';
      options?.onSuccess?.({ ok: true, height: 120 });
      return Promise.resolve();
    },
    attachMermaidControls() {},
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
  const sourceHeader = root.querySelector('.markdown-mermaid-source .markdown-code-header');
  const sourceWrapToggle = sourceHeader.querySelector('.inv-codeblock-wrap-toggle');

  renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));

  assert.ok(root.querySelector('.markdown-mermaid-preview iframe'));
  assert.ok(root.querySelector('.markdown-mermaid-source'));
  assert.equal(sourceHeader.querySelectorAll('.inv-codeblock-wrap-toggle').length, 1);
  assert.equal(sourceWrapToggle.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(sourceWrapToggle.nextElementSibling, sourceHeader.querySelector('.inv-codeblock-copy'));
  assert.ok(root.querySelector('.markdown-mermaid-source').classList.contains('markdown-mermaid-source-collapsed'));
  assert.match(root.textContent, /flowchart TD/);
  // UIUX-026: a rendered diagram opts into the chat timeline virtualizer's
  // live-state retention (renderer-chat-timeline-virtualizer.js
  // LIVE_STATE_SELECTOR) so its pan/zoom/toggle listeners survive a
  // virtualization cycle instead of going inert.
  assert.equal(root.querySelector('.markdown-mermaid-block').getAttribute('data-virtualizer-pin-live'), 'true');
});

test('renderMarkdown assigns unique Mermaid block ids across repeated render calls', () => {
  const {
    renderMarkdown: renderMermaidMarkdown,
    clearMarkdownRenderCache,
  } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const first = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  const second = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  const firstId = first.match(/id="([^"]+)"/)?.[1] || '';
  const secondId = second.match(/id="([^"]+)"/)?.[1] || '';
  assert.match(firstId, /^md-mermaid-/);
  assert.match(secondId, /^md-mermaid-/);
  assert.notEqual(firstId, secondId);
});

test('renderMarkdown caches undecorated Mermaid HTML without reusing per-render DOM ids', () => {
  const {
    renderMarkdown: renderMermaidMarkdown,
    getMarkdownRenderCacheStats,
    clearMarkdownRenderCache,
  } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const first = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');
  const second = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  assert.equal(getMarkdownRenderCacheStats().size, 1);
  assert.notEqual(first.match(/id="([^"]+)"/)?.[1], second.match(/id="([^"]+)"/)?.[1]);
});

test('renderInlineMermaidBlocks keeps Mermaid source visible when preview rendering fails', async (t) => {
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
      options?.onFailure?.({ ok: false, error: 'render failed' });
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

  assert.equal(root.querySelector('.markdown-mermaid-preview iframe'), null);
  assert.match(root.querySelector('.markdown-mermaid-preview').textContent, /preview unavailable/i);
  assert.match(root.querySelector('.markdown-mermaid-source').textContent, /A-->B/);
  assert.equal(root.querySelector('.markdown-mermaid-source').classList.contains('markdown-mermaid-source-collapsed'), false);
});

/* ── B3: content-hash memoization for renderMarkdown ── */

test('renderMarkdown caches successful renders by source string', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const before = getMarkdownRenderCacheStats().size;
  const first = renderFn('**cached**');
  const sizeAfterFirst = getMarkdownRenderCacheStats().size;
  const second = renderFn('**cached**');
  const sizeAfterSecond = getMarkdownRenderCacheStats().size;

  assert.equal(first, second, 'identical input should produce identical output');
  assert.ok(first.includes('<strong>cached</strong>'), 'first render must produce expected HTML');
  assert.equal(sizeAfterFirst, before + 1, 'first render must add one entry to the cache');
  assert.equal(sizeAfterSecond, sizeAfterFirst, 'second render must hit the cache (no new entry)');
});

test('renderMarkdown cache is bounded by an LRU cap', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const { max } = getMarkdownRenderCacheStats();
  // Push max+10 distinct inputs through; the cache must stay at <= max.
  for (let i = 0; i < max + 10; i += 1) {
    renderFn(`# heading ${i}`);
  }

  assert.equal(getMarkdownRenderCacheStats().size, max, 'cache size must be capped at the LRU max');
});

test('renderMarkdown cache evicts least-recently-used entry first', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const { max } = getMarkdownRenderCacheStats();
  const firstInput = '# first';
  renderFn(firstInput);
  // Re-touch the first input so it moves to MRU end.
  renderFn(firstInput);

  // Fill the cache with distinct inputs to evict everything OTHER than firstInput.
  for (let i = 0; i < max - 1; i += 1) {
    renderFn(`# filler ${i}`);
  }
  // Cache is now: firstInput at oldest, filler entries newer.
  // Push one more to evict the oldest (firstInput in raw insertion order)…
  // but wait — we touched firstInput AFTER initial insertion, so under
  // LRU semantics it should NOT be the first evicted. Touch it once more
  // to make sure it's at MRU end.
  renderFn(firstInput);
  // Add one more new entry that will overflow and evict the now-oldest filler.
  renderFn('# overflow');

  assert.equal(getMarkdownRenderCacheStats().size, max, 'cache must remain at cap');
  // The MRU entry (firstInput) must still be cached: rendering it should
  // not change cache size (it's a hit).
  const sizeBefore = getMarkdownRenderCacheStats().size;
  renderFn(firstInput);
  const sizeAfter = getMarkdownRenderCacheStats().size;
  assert.equal(sizeAfter, sizeBefore, 'recently-touched entry must survive LRU eviction');
});

test('renderMarkdown cache does not store falsy / empty inputs', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  renderFn('');
  renderFn(null);
  renderFn(undefined);

  assert.equal(getMarkdownRenderCacheStats().size, 0, 'empty / falsy inputs must short-circuit before caching');
});

test('renderStreamingMarkdownUnits bypasses the settled render cache', () => {
  const { renderStreamingMarkdownUnits: renderUnits, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const sizeBefore = getMarkdownRenderCacheStats().size;
  const first = renderUnits('hello **world**');
  const sizeAfterFirst = getMarkdownRenderCacheStats().size;
  const second = renderUnits('hello **world**');
  const sizeAfterSecond = getMarkdownRenderCacheStats().size;

  assert.equal(first.html, second.html, 'streaming render must return identical html for identical input');
  assert.equal(sizeAfterFirst, sizeBefore, 'streaming prefixes must not populate the settled cache');
  assert.equal(sizeAfterSecond, sizeAfterFirst, 'repeated streaming prefixes must not churn the settled cache');
  assert.equal(getMarkdownRenderCacheStats().bypasses, 2);
});

test('renderMarkdown cache keys cannot collide with embedded NUL content', () => {
  const { renderMarkdown: renderFn, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();
  const plain = renderFn('x', { mermaid: 'plain' });
  const rich = renderFn('plain\u0000x');
  assert.notEqual(rich, plain);
  assert.match(rich, /plainx/);
});

test('identical cached long code blocks receive unique aria-controls ids', () => {
  const { renderMarkdown: renderFn, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();
  const source = '```js\n' + Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n') + '\n```';
  const first = renderFn(source);
  const second = renderFn(source);
  const firstId = first.match(/aria-controls="([^"]+)"/)?.[1];
  const secondId = second.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(firstId && secondId);
  assert.notEqual(firstId, secondId);
});

test('collapsible code-block ids are scoped reproducibly by message id', () => {
  const { renderMarkdown: renderFn } = loadMarkdownUtils(); const source = '```js\n' + 'line\n'.repeat(30) + '```';
  const [first, second, repeated] = ['message-a', 'message-b', 'message-a'].map((messageId) => renderFn(source, { messageId }).match(/aria-controls="([^"]+)"/)?.[1]);
  assert.ok(first && second && repeated); assert.notEqual(first, second); assert.equal(first, repeated);
});

test('clearMarkdownRenderCache empties the cache', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  renderFn('# one');
  renderFn('# two');
  assert.ok(getMarkdownRenderCacheStats().size > 0, 'precondition: cache must contain entries');

  clearMarkdownRenderCache();
  assert.equal(getMarkdownRenderCacheStats().size, 0, 'cache must be empty after clearMarkdownRenderCache()');
});

/* ── B4: lazy Mermaid rendering via IntersectionObserver ── */

test('renderInlineMermaidBlocks uses IntersectionObserver when available', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  // Track every renderMermaidDirect call so we can assert lazy semantics.
  const renderCalls = [];

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, source, options) {
      renderCalls.push({ host, source });
      // Don't actually create iframes — just resolve. The test only cares
      // about whether the call was issued.
      options?.onSuccess?.();
      return Promise.resolve();
    },
  };

  // Install a controllable IntersectionObserver stub so the test can
  // drive viewport-entry events explicitly.
  const observers = [];
  class FakeIO {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    _fire(target) {
      this.callback([{ isIntersecting: true, target }]);
    }
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

  // Render markdown with two Mermaid blocks so the streaming-skip-last
  // rule has something to skip.
  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown(
    '```mermaid\nflowchart TD\nA-->B\n```\n\n```mermaid\nflowchart TD\nX-->Y\n```',
  );

  renderInlineMermaidBlocks(root, { isStreaming: false });

  assert.equal(observers.length, 1, 'an IntersectionObserver must be created when one is available');
  const obs = observers[0];
  assert.equal(obs.observed.size, 2, 'both eligible blocks must be observed');
  assert.equal(renderCalls.length, 0, 'no diagrams should render until they enter the viewport');

  // Fire the first block — only it should render.
  const blocks = [...root.querySelectorAll('.markdown-mermaid-block')];
  obs._fire(blocks[0]);

  assert.equal(renderCalls.length, 1, 'one block enters viewport → one render');
  assert.equal(obs.observed.size, 1, 'rendered block must be unobserved');

  // Fire the second block.
  obs._fire(blocks[1]);
  assert.equal(renderCalls.length, 2, 'second block enters viewport → second render');
  assert.equal(obs.observed.size, 0, 'all rendered blocks must be unobserved');
});

test('renderInlineMermaidBlocks skips the last block when streaming (lazy path)', async (t) => {
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
    renderMermaidDirect(_host, _source, options) {
      options?.onSuccess?.();
      return Promise.resolve();
    },
  };
  const observers = [];
  class FakeIO {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.observed.clear(); }
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
  root.innerHTML = renderMermaidMarkdown(
    '```mermaid\nflowchart TD\nA-->B\n```\n\n```mermaid\nflowchart TD\nX-->Y\n```\n\n```mermaid\nflowchart TD\nP-->Q\n```',
  );

  renderInlineMermaidBlocks(root, { isStreaming: true });

  // Three blocks total; with isStreaming=true, only the first two should be
  // observed — the last one is still being written and must be skipped.
  assert.equal(observers.length, 1, 'one IntersectionObserver created');
  assert.equal(observers[0].observed.size, 2, 'streaming: must skip the last block (only first two observed)');
});

test('renderInlineMermaidBlocks falls back to eager render when IntersectionObserver is unavailable', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  const renderCalls = [];

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(_host, source, options) {
      renderCalls.push(source);
      options?.onSuccess?.();
      return Promise.resolve();
    },
  };
  // Remove IntersectionObserver from the global to force the fallback path.
  delete global.IntersectionObserver;

  const { renderMarkdown: renderMermaidMarkdown, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();

  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    if (previousIO === undefined) {
      delete global.IntersectionObserver;
    } else {
      global.IntersectionObserver = previousIO;
    }
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = renderMermaidMarkdown('```mermaid\nflowchart TD\nA-->B\n```');

  renderInlineMermaidBlocks(root, { isStreaming: false });

  // Without IO, the eager path renders synchronously.
  assert.equal(renderCalls.length, 1, 'fallback path must render the diagram eagerly');
});

// UIUX-026: the stable-observer contract (reuse across calls, no
// disconnect-and-recreate, cross-container target retention) and the
// virtualizer live-state pin-on-render/no-pin-on-failure contract live in
// the sibling file tests/markdown-utils-mermaid-observer.test.js — kept out
// of this file to stay under the 1000-line file-size ceiling.

/* ── buildMermaidTimelineBlockMarkup (timeline tool-result wrapper) ── */

test('buildMermaidTimelineBlockMarkup escapes the source and mirrors the decorateCodeBlocks wrapper contract', () => {
  const { buildMermaidTimelineBlockMarkup } = loadMarkdownUtils();

  assert.equal(buildMermaidTimelineBlockMarkup('', 'tool-mermaid-x'), '');
  assert.equal(buildMermaidTimelineBlockMarkup('   ', 'tool-mermaid-x'), '');

  const html = buildMermaidTimelineBlockMarkup('graph TD\nA["q & <b>"] --> B', 'tool-mermaid-call-1');
  assert.ok(html.includes('class="markdown-mermaid-block"'));
  assert.ok(html.includes('id="tool-mermaid-call-1"'));
  assert.ok(html.includes('data-mermaid-source="graph TD\nA[&quot;q &amp; &lt;b&gt;&quot;] --&gt; B"'));
  assert.ok(html.includes('class="markdown-mermaid-preview"'));
  assert.ok(html.includes('markdown-mermaid-source'));
  assert.ok(html.includes('inv-codeblock-copy'));
  assert.ok(html.includes('<code class="language-mermaid">graph TD\nA[&quot;q &amp; &lt;b&gt;&quot;] --&gt; B</code>'));
  assert.doesNotMatch(html, /<b>/, 'raw source must never reach the markup unescaped');
});

test('buildMermaidTimelineBlockMarkup output is picked up by renderInlineMermaidBlocks', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  const renderedSources = [];
  global.rendererMermaidUtils = {
    renderMermaidDirect(host, source, options) {
      renderedSources.push(source);
      host.innerHTML = '<iframe src="mermaid-frame.html"></iframe>';
      options?.onSuccess?.({ ok: true, height: 120 });
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  const { buildMermaidTimelineBlockMarkup, renderInlineMermaidBlocks } = loadMarkdownUtils();

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML = buildMermaidTimelineBlockMarkup('graph TD\nA[Start] --> B[End]', 'tool-mermaid-call-pickup');

  renderInlineMermaidBlocks(root);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));

  assert.deepEqual(renderedSources, ['graph TD\nA[Start] --> B[End]'], 'escaped attribute must round-trip back to the raw source');
  assert.ok(root.querySelector('#tool-mermaid-call-pickup .markdown-mermaid-preview iframe'));
  assert.ok(root.querySelector('.markdown-mermaid-source').classList.contains('markdown-mermaid-source-collapsed'));
});

/* ── Per-surface mermaid mode (mermaid: 'plain' for reasoning panels) ── */

test('renderMarkdown mermaid:plain renders tagged mermaid fences as ordinary code blocks', () => {
  const { renderMarkdown: renderFn, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const result = renderFn('```mermaid\nflowchart TD\nA-->B\n```', { mermaid: 'plain' });

  assert.ok(!result.includes('markdown-mermaid-block'), `plain mode must not emit a mermaid block, got: ${result}`);
  assert.ok(result.includes('markdown-code-block'), `plain mode must emit an ordinary code block, got: ${result}`);
  assert.ok(result.includes('Mermaid'), `plain mode must keep the Mermaid language label, got: ${result}`);
  assert.ok(result.includes('flowchart TD'), `plain mode must keep the source text, got: ${result}`);
});

test('renderMarkdown mermaid:plain also neutralizes bare fences that look like mermaid', () => {
  const { renderMarkdown: renderFn, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const source = '```\nsequenceDiagram\nA->>B: hi\n```';
  const rich = renderFn(source);
  const plain = renderFn(source, { mermaid: 'plain' });

  assert.ok(rich.includes('markdown-mermaid-block'), 'precondition: rich mode treats the bare fence as mermaid');
  assert.ok(!plain.includes('markdown-mermaid-block'), `plain mode must not emit a mermaid block, got: ${plain}`);
  assert.ok(plain.includes('markdown-code-block'), `plain mode must emit an ordinary code block, got: ${plain}`);
});

test('renderStreamingMarkdownUnits honors mermaid:plain', () => {
  const { renderStreamingMarkdownUnits: renderUnits, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const result = renderUnits('```mermaid\nflowchart TD\nA-->B\n```', { mermaid: 'plain' });

  assert.ok(!result.html.includes('markdown-mermaid-block'), `plain mode must not emit a mermaid block, got: ${result.html}`);
  assert.ok(result.html.includes('markdown-code-block'), `plain mode must emit an ordinary code block, got: ${result.html}`);
});

test('renderMarkdown rich and plain renders of the same source stay isolated in the cache', () => {
  const { renderMarkdown: renderFn, getMarkdownRenderCacheStats, clearMarkdownRenderCache } = loadMarkdownUtils();
  clearMarkdownRenderCache();

  const source = '```mermaid\nflowchart TD\nA-->B\n```';

  // Plain first: cacheable (no per-render DOM ids in the output).
  const plainFirst = renderFn(source, { mermaid: 'plain' });
  assert.equal(getMarkdownRenderCacheStats().size, 1, 'plain render must be cached');

  // Rich after: must not serve the cached plain output, but its undecorated
  // sanitized base is safe to cache because decoration assigns fresh ids.
  const rich = renderFn(source);
  assert.ok(rich.includes('markdown-mermaid-block'), `rich render after plain must still emit a mermaid block, got: ${rich}`);
  assert.equal(getMarkdownRenderCacheStats().size, 2, 'rich and plain base HTML use distinct cache namespaces');

  // Plain again: must hit the plain cache entry, not re-render or collide.
  const plainSecond = renderFn(source, { mermaid: 'plain' });
  assert.equal(plainSecond, plainFirst, 'repeated plain render must return the cached output');
  assert.equal(getMarkdownRenderCacheStats().size, 2, 'repeated plain render must be a cache hit');
});

test('renderInlineMermaidBlocks leaves mermaid blocks inside reasoning panels inert', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousPurify = global.DOMPurify;
  const previousRendererMermaidUtils = global.rendererMermaidUtils;
  const previousIO = global.IntersectionObserver;

  const renderedSources = [];

  global.window = dom.window;
  global.document = dom.window.document;
  global.DOMPurify = createDOMPurify(dom.window);
  global.rendererMermaidUtils = {
    renderMermaidDirect(_host, source, options) {
      renderedSources.push(source);
      options?.onSuccess?.();
      return Promise.resolve();
    },
    attachMermaidControls() {},
  };
  // Force the eager path so the assertion is synchronous.
  delete global.IntersectionObserver;

  const { buildMermaidTimelineBlockMarkup, renderInlineMermaidBlocks, disposeMermaidLazyObserver } = loadMarkdownUtils();

  t.after(() => {
    disposeMermaidLazyObserver();
    global.window = previousWindow;
    global.document = previousDocument;
    global.DOMPurify = previousPurify;
    global.rendererMermaidUtils = previousRendererMermaidUtils;
    if (previousIO === undefined) {
      delete global.IntersectionObserver;
    } else {
      global.IntersectionObserver = previousIO;
    }
    dom.window.close();
  });

  const root = dom.window.document.getElementById('root');
  root.innerHTML =
    '<div class="reasoning-row-panel"><div class="reasoning-row-panel-body">'
    + buildMermaidTimelineBlockMarkup('flowchart TD\nR-->S', 'inside-reasoning')
    + '</div></div>'
    + buildMermaidTimelineBlockMarkup('flowchart TD\nA-->B', 'outside-reasoning');
  const builtHeader = root.querySelector('#inside-reasoning .markdown-code-header');
  const builtWrapToggle = builtHeader.querySelector('.inv-codeblock-wrap-toggle');

  renderInlineMermaidBlocks(root, { isStreaming: false });

  assert.equal(builtHeader.querySelectorAll('.inv-codeblock-wrap-toggle').length, 1);
  assert.equal(builtWrapToggle.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(builtWrapToggle.nextElementSibling, builtHeader.querySelector('.inv-codeblock-copy'));
  assert.deepEqual(renderedSources, ['flowchart TD\nA-->B'], 'only the block outside the reasoning panel may render');
  assert.equal(
    root.querySelector('#inside-reasoning').getAttribute('data-mermaid-rendered'),
    null,
    'the reasoning-panel block must stay untouched',
  );
});

/* ── Mermaid dedup helpers (normalizeMermaidSource / extractMermaidFenceSources) ── */

test('normalizeMermaidSource trims lines, collapses whitespace runs, drops empty lines', () => {
  const { normalizeMermaidSource } = loadMarkdownUtils();

  const a = normalizeMermaidSource('flowchart TD\r\n  A   -->  B\r\n\r\n  B-->C  \r\n');
  const b = normalizeMermaidSource('flowchart    TD\nA --> B\nB-->C');

  assert.equal(a, b, 'whitespace-variant sources must normalize to the same canonical form');
  assert.equal(normalizeMermaidSource(''), '');
  assert.equal(normalizeMermaidSource(null), '');
});

test('extractMermaidFenceSources finds tagged and bare mermaid fences and ignores other code', () => {
  const { extractMermaidFenceSources } = loadMarkdownUtils();

  const md = [
    'Intro text.',
    '```mermaid',
    'flowchart TD',
    'A-->B',
    '```',
    'Middle text.',
    '```js',
    'const flowchart = 1;',
    '```',
    '```',
    'sequenceDiagram',
    'A->>B: hi',
    '```',
  ].join('\n');

  const sources = extractMermaidFenceSources(md);

  assert.equal(sources.length, 2, `expected the tagged + bare mermaid fences only, got: ${JSON.stringify(sources)}`);
  assert.match(sources[0], /flowchart TD/);
  assert.match(sources[1], /sequenceDiagram/);
});

test('extractMermaidFenceSources returns empty for text without mermaid fences', () => {
  const { extractMermaidFenceSources } = loadMarkdownUtils();

  assert.deepEqual(extractMermaidFenceSources('plain prose, no fences'), []);
  assert.deepEqual(extractMermaidFenceSources('```py\nprint(1)\n```'), []);
  assert.deepEqual(extractMermaidFenceSources(''), []);
});

test('extractMermaidFenceSources supports tilde and long CommonMark fences', () => {
  const { extractMermaidFenceSources } = loadMarkdownUtils();
  assert.deepEqual(
    extractMermaidFenceSources('~~~~mermaid\nflowchart TD\nA-->B\n~~~~\n\n````\ngraph LR\nB-->C\n````'),
    ['flowchart TD\nA-->B', 'graph LR\nB-->C']
  );
});

test('bare graph assignments are not misclassified as Mermaid diagrams', () => {
  const html = renderMarkdown('```text\ngraph = { nodes: [] }\n```');
  assert.doesNotMatch(html, /markdown-mermaid-block/);
  assert.match(html, /markdown-code-block/);
});

/* ── KaTeX math pipeline integration (katex_math, protect-then-render) ── */

const markdownMathUtils = require('../renderer/shared/markdown-math-utils');

function withMathRendering(enabled, fn) {
  const previous = markdownMathUtils.isMathRenderingEnabled();
  markdownMathUtils.setMathRenderingEnabled(enabled);
  try {
    return fn();
  } finally {
    markdownMathUtils.setMathRenderingEnabled(previous);
  }
}

test('renderMarkdown with math enabled emits self-describing .markdown-math wrappers', () => {
  const result = withMathRendering(true, () => renderMarkdown('the square $x^2$ grows'));
  assert.ok(result.includes('class="markdown-math"'), `wrapper missing: ${result}`);
  assert.ok(result.includes('data-math-tex="x^2"'), `tex payload missing: ${result}`);
  assert.ok(result.includes('data-math-display="false"'), `mode attr missing: ${result}`);
  assert.ok(!/MJNYMATH\d+K/.test(result), `placeholder token leaked: ${result}`);
});

test('renderMarkdown with math enabled keeps display math one block-level span', () => {
  const result = withMathRendering(true, () => renderMarkdown('derivation:\n\n$$\\int_0^1 x\\,dx$$'));
  assert.ok(result.includes('data-math-display="true"'), `display mode missing: ${result}`);
  assert.ok(result.includes('data-math-tex'), result);
});

test('renderMarkdown with math enabled protects LaTeX from marked tokenizers', () => {
  // Underscores + braces would otherwise be mangled into <em> by marked.
  const result = withMathRendering(true, () => renderMarkdown('so $a_1 + b_2 = \\frac{c}{d}$ holds'));
  assert.ok(result.includes('data-math-tex="a_1 + b_2 = \\frac{c}{d}"'), `tex mangled: ${result}`);
  assert.ok(!result.includes('<em>'), `marked emphasis leaked into math: ${result}`);
});

test('renderMarkdown with math enabled leaves code-span math and prices literal', () => {
  const result = withMathRendering(true, () => renderMarkdown('price $5, code `$x$`, real $y^2$'));
  assert.ok(result.includes('$5'), `price mangled: ${result}`);
  assert.ok(result.includes('<code>$x$</code>'), `code span mangled: ${result}`);
  assert.ok(result.includes('data-math-tex="y^2"'), `real math not protected: ${result}`);
  const wrapperCount = (result.match(/class="markdown-math"/g) || []).length;
  assert.equal(wrapperCount, 1);
});

test('renderMarkdown with math DISABLED is byte-identical to raw $ text (flag-off parity)', () => {
  const source = 'the square $x^2$ grows and $$\\int f$$ centers';
  const result = withMathRendering(false, () => renderMarkdown(source));
  assert.ok(result.includes('$x^2$'), `raw inline math lost: ${result}`);
  assert.ok(result.includes('$$\\int f$$'), `raw display math lost: ${result}`);
  assert.ok(!result.includes('markdown-math'), `flag-off must not emit wrappers: ${result}`);
  assert.ok(!/MJNYMATH\d+K/.test(result), `flag-off must not emit tokens: ${result}`);
});

test('math flag flips are cache-safe (no stale math/no-math HTML served across a toggle)', () => {
  const source = 'cached $z^3$ span';
  const off1 = withMathRendering(false, () => renderMarkdown(source));
  const on = withMathRendering(true, () => renderMarkdown(source));
  const off2 = withMathRendering(false, () => renderMarkdown(source));
  assert.ok(!off1.includes('markdown-math'), off1);
  assert.ok(on.includes('markdown-math'), on);
  assert.equal(off2, off1, 'flag-off render after a flag-on render must match the original flag-off output');
});

test('reasoning (mermaid: plain) surfaces never get math wrappers', () => {
  const result = withMathRendering(true, () => renderMarkdown('thinking about $x^2$', { mermaid: 'plain' }));
  assert.ok(!result.includes('markdown-math'), `plain surface must stay inert: ${result}`);
  assert.ok(result.includes('$x^2$'), `plain surface lost raw math: ${result}`);
});

/* -- Inline path chips -- */

test('renderMarkdown decorates path-shaped inline code into a focusable path chip', () => {
  const result = renderMarkdown('Created `workspace/hellodemo.md:12:3` for you.');
  assert.match(result, /class="chat-inline-path"/);
  assert.match(result, /role="link"/);
  assert.match(result, /tabindex="0"/);
  assert.match(result, /data-chat-path-open="workspace\/hellodemo\.md"/);
  assert.match(result, /data-chat-path="workspace\/hellodemo\.md"/);
  assert.match(result, /data-chat-path-line="12"/);
  assert.match(result, /data-chat-path-column="3"/);
});

test('renderMarkdown leaves non-path inline code, escapes, and fenced blocks undecorated', () => {
  const prose = renderMarkdown('Read `state.ui.followLatest` and `a/../b.js` first.');
  assert.doesNotMatch(prose, /data-chat-path-open/);
  const fenced = renderMarkdown('```\nworkspace/in-a-block.md\n```');
  assert.doesNotMatch(fenced, /data-chat-path-open/);
});
