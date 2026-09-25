'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const highlight = require('../renderer/chat/renderer-code-highlight');

function fakeMonaco() {
  return {
    editor: {
      tokenize(text) {
        const index = text.indexOf(' ');
        return [[{ offset: 0, type: 'keyword.js' }, ...(index >= 0 ? [{ offset: index, type: 'mystery.js' }] : [])]];
      },
    },
    languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }, { id: 'python', extensions: ['.py'] }] },
  };
}

test.beforeEach(() => highlight.disposeCodeHighlighting());
test.after(() => highlight.disposeCodeHighlighting());

test('language mapping and dots use deterministic overrides', () => {
  assert.equal(highlight.getLanguageId('src/file.tsx'), 'typescript');
  assert.equal(highlight.getLanguageId('language-py'), 'python');
  assert.equal(highlight.getLanguageDot('sql'), '#D4537E');
  assert.equal(highlight.getLanguageDot('unknown'), 'var(--tl-status-muted)');
});

test('mapTokenClass applies dotted precedence before the expanded first-segment vocabulary', () => {
  const cases = [
    ['type.identifier.js', 'tok-type'],
    ['string.key.json', 'tok-property'],
    ['attribute.value.html', 'tok-string'],
    ['attribute.name.html', 'tok-property'],
    ['keyword.flow.js', 'tok-keyword'],
    ['keyword.control.js', 'tok-keyword'],
    ['comment.line.js', 'tok-comment'],
    ['string.js', 'tok-string'],
    ['number.hex.js', 'tok-number'],
    ['type.js', 'tok-type'],
    ['function.js', 'tok-function'],
    ['delimiter.bracket.js', 'tok-delimiter'],
    ['invalid.js', 'tok-invalid'],
    ['variable.js', 'tok-variable'],
    ['identifier.js', 'tok-variable'],
    ['property.js', 'tok-property'],
    ['attribute.js', 'tok-property'],
    ['tag.html', 'tok-tag'],
    ['metatag.html', 'tok-tag'],
    ['operator.js', 'tok-operator'],
    ['operators.js', 'tok-operator'],
    ['regexp.js', 'tok-regexp'],
    ['constant.js', 'tok-constant'],
    ['annotation.java', 'tok-annotation'],
    ['predefined.js', 'tok-function'],
    ['unknown.js', 'tok-default'],
  ];
  for (const [type, expected] of cases) {
    assert.equal(highlight.mapTokenClass(type), expected, type);
  }
});

test('absent, unknown, and overlong inputs fall back to tok-default', async () => {
  assert.deepEqual(highlight.highlightLine('const x', 'javascript'), [{ text: 'const x', cls: 'tok-default' }]);
  await highlight.warmCodeHighlighting({ monacoUtils: { ensureMonacoEditorApi: async () => fakeMonaco() } });
  assert.deepEqual(highlight.highlightLine('x', 'unknown'), [{ text: 'x', cls: 'tok-default' }]);
  const long = 'x'.repeat(highlight.MAX_LINE_CHARS + 1);
  assert.deepEqual(highlight.highlightLine(long, 'javascript'), [{ text: long, cls: 'tok-default' }]);
});

test('warm-up is single-flight, maps closed token classes, and decorates existing blocks in place', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="markdown-code-block"><span class="markdown-code-language">JavaScript</span><pre><code class="language-js">const value</code></pre></div><span data-code-highlight-line data-language-id="javascript">return x</span></body>');
  let calls = 0;
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const options = { root: dom.window.document, monacoUtils: { ensureMonacoEditorApi: () => { calls += 1; return pending; } } };
  const first = highlight.warmCodeHighlighting(options);
  const second = highlight.warmCodeHighlighting(options);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(fakeMonaco());
  assert.equal(await first, true);
  assert.ok(dom.window.document.querySelector('code .tok-keyword'));
  assert.ok(dom.window.document.querySelector('[data-code-highlight-line] .tok-keyword'));
  assert.ok(dom.window.document.querySelector('[data-code-highlight-line] .tok-default'));
  assert.equal(dom.window.document.querySelector('.markdown-code-language').style.getPropertyValue('--lang-dot'), '#EF9F27');
});

test('decorateCodeBlocks tokenizes pending tool sections and skips already-highlighted nodes', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="tool-call-section"><code data-code-highlight="pending" data-language-id="javascript">const value</code><code data-code-highlight="pending" data-language-id="javascript" data-code-highlighted="tokenized"><span class="sentinel">keep me</span></code></div></body>');
  await highlight.warmCodeHighlighting({ monacoUtils: { ensureMonacoEditorApi: async () => fakeMonaco() } });

  assert.equal(highlight.decorateCodeBlocks(dom.window.document), 1);
  const nodes = dom.window.document.querySelectorAll('.tool-call-section code');
  assert.ok(nodes[0].querySelector('.tok-keyword'));
  assert.equal(nodes[0].getAttribute('data-code-highlighted'), 'tokenized');
  assert.equal(nodes[1].querySelector('.sentinel').textContent, 'keep me');
});

test('a cold default fallback is re-decorated once Monaco warms, and registered ids round-trip', async () => {
  const dom = new JSDOM('<!doctype html><body><div class="tool-call-section"><code data-code-highlight="pending" data-language-id="javascript">const value</code></div></body>');
  assert.equal(highlight.decorateCodeBlocks(dom.window.document), 1, 'cold pass paints the fallback');
  const code = dom.window.document.querySelector('code');
  assert.equal(code.getAttribute('data-code-highlighted'), 'default');
  assert.equal(code.querySelector('.tok-keyword'), null);
  await highlight.warmCodeHighlighting({ monacoUtils: { ensureMonacoEditorApi: async () => ({
    ...fakeMonaco(),
    languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }, { id: 'rust', extensions: ['.rs'] }] },
  }) } });
  assert.equal(highlight.decorateCodeBlocks(dom.window.document), 1, 'the warm pass replaces the provisional fallback');
  assert.equal(code.getAttribute('data-code-highlighted'), 'tokenized');
  assert.ok(code.querySelector('.tok-keyword'));
  assert.equal(highlight.decorateCodeBlocks(dom.window.document), 0, 'tokenized nodes are settled');
  assert.equal(highlight.getLanguageId('src/main.rs'), 'rust');
  assert.equal(highlight.getLanguageId('rust'), 'rust', 'a resolved Monaco id is not re-read as a path');
});

test('code syntax token sheet defines every expanded variable and class', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'code-syntax-tokens.css'), 'utf8');
  const names = [
    'default', 'comment', 'string', 'number', 'keyword', 'type', 'function', 'delimiter', 'invalid',
    'variable', 'property', 'tag', 'operator', 'regexp', 'constant', 'annotation',
  ];
  for (const name of names) {
    assert.match(css, new RegExp(`--tok-${name}\\s*:`), `missing --tok-${name}`);
    assert.match(css, new RegExp(`\\.tok-${name}\\s*\\{`), `missing .tok-${name}`);
  }
  for (const declaration of [
    '--tok-variable: color-mix(in srgb, var(--accent-cyan) 45%, var(--text-primary))',
    '--tok-property: var(--tok-variable)',
    '--tok-tag: var(--accent-primary)',
    '--tok-operator: var(--text-secondary)',
    '--tok-regexp: color-mix(in srgb, var(--tl-status-error) 70%, var(--text-primary))',
    '--tok-constant: var(--accent-strong)',
    '--tok-annotation: color-mix(in srgb, var(--accent-amber) 60%, var(--text-primary))',
    '--tok-function: color-mix(in srgb, var(--accent-amber) 55%, var(--text-primary))',
    '--tok-number: color-mix(in srgb, var(--tl-status-ok) 65%, var(--text-primary))',
  ]) {
    assert.ok(css.includes(declaration), `missing exact declaration: ${declaration}`);
  }
});

test('settled reasoning-phase fenced code is decorated with Monaco token spans', async () => {
  const markdownUtils = require('../renderer/shared/markdown-utils');
  const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');
  const {
    ThinkingPanelController,
    groupReasoningByPhase,
    shouldShowThinkingToggle,
  } = require('../renderer/chat/chat-thinking-utils');
  await highlight.warmCodeHighlighting({ monacoUtils: { ensureMonacoEditorApi: async () => fakeMonaco() } });
  const renderer = createReasoningV2Renderer({
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    groupReasoningByPhase,
    getReasoningEntries: (message) => message?.reasoning?.entries || [],
    renderMarkdown: markdownUtils.renderMarkdown,
    renderStreamingMarkdownUnits: (source) => ({ html: markdownUtils.renderMarkdown(source) }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
  const html = renderer.renderThinkingWidget({
    id: 'reasoning-code', role: 'assistant', status: 'complete',
    reasoning: {
      source: 'provider', status: 'complete',
      entries: [{ text: '```js\nconst value = 1;\n```', thinkingId: 'thinking-code' }],
    },
  }, 'other-message');
  assert.match(html, /class="tok tok-keyword"/);
});

test('memo evicts oldest entries and warm failures emit one bounded warning', async () => {
  let tokenizeCalls = 0;
  const monaco = fakeMonaco();
  const tokenize = monaco.editor.tokenize;
  monaco.editor.tokenize = (...args) => { tokenizeCalls += 1; return tokenize(...args); };
  await highlight.warmCodeHighlighting({ monacoUtils: { ensureMonacoEditorApi: async () => monaco } });
  highlight.highlightLine('oldest entry', 'javascript');
  for (let index = 0; index <= highlight.MAX_MEMO_ENTRIES; index += 1) {
    highlight.highlightLine(`line ${index}`, 'javascript');
  }
  const before = tokenizeCalls;
  highlight.highlightLine('oldest entry', 'javascript');
  assert.equal(tokenizeCalls, before + 1);

  highlight.disposeCodeHighlighting();
  const logs = [];
  const options = {
    monacoUtils: { ensureMonacoEditorApi: () => { throw new Error('x'.repeat(400)); } },
    log: (...args) => logs.push(args),
  };
  assert.equal(await highlight.warmCodeHighlighting(options), false);
  assert.equal(await highlight.warmCodeHighlighting(options), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'WARN');
  assert.equal(logs[0][1], 'renderer.code_highlight_warm_failed');
  assert.ok(logs[0][2].message.length <= 240);
});

test('large bodies use one default token and late warm completion cannot mutate after dispose', async () => {
  const largeDom = new JSDOM(`<div class="markdown-code-block"><pre><code class="language-js">${Array(402).fill('x').join('\n')}</code></pre></div>`);
  highlight.decorateCodeBlocks(largeDom.window.document);
  assert.equal(largeDom.window.document.querySelectorAll('code .tok-default').length, 1);

  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const dom = new JSDOM('<div class="markdown-code-block"><pre><code class="language-js">const x</code></pre></div>');
  const warm = highlight.warmCodeHighlighting({ root: dom.window.document, monacoUtils: { ensureMonacoEditorApi: () => pending } });
  highlight.disposeCodeHighlighting();
  resolve(fakeMonaco());
  assert.equal(await warm, false);
  assert.equal(dom.window.document.querySelector('code').hasAttribute('data-code-highlighted'), false);
});

test('stream decoration preserves unchanged highlighted HTML and decorates only the changed tail', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  await highlight.warmCodeHighlighting({
    monacoUtils: { ensureMonacoEditorApi: async () => fakeMonaco() },
  });
  const fingerprintHtml = (html) => `fingerprint:${html}`;
  const prefixSource = '<div class="markdown-code-block"><pre><code class="language-js">const prefix</code></pre></div>';
  const previousModel = {
    changedStartIndex: 0,
    units: [{
      html: prefixSource,
      fingerprint: 'prefix-source',
      sourceHtml: prefixSource,
      sourceFingerprint: 'prefix-source',
    }],
  };
  highlight.decorateStreamModel(previousModel, [], {
    document: dom.window.document,
    fingerprintHtml,
  });
  const priorHtml = previousModel.units[0].html;
  const model = {
    changedStartIndex: 1,
    units: [
      { html: prefixSource, fingerprint: 'prefix-source', sourceHtml: prefixSource, sourceFingerprint: 'prefix-source' },
      { html: '<div class="markdown-code-block"><pre><code class="language-js">const tail</code></pre></div>', sourceFingerprint: 'tail-source' },
    ],
  };

  highlight.decorateStreamModel(model, [
    previousModel.units[0],
    { html: '<pre><code>old tail</code></pre>', fingerprint: 'old-tail', sourceFingerprint: 'old-tail-source' },
  ], {
    document: dom.window.document,
    fingerprintHtml,
  });

  assert.equal(model.units[0].html, priorHtml);
  assert.equal(model.units[0].fingerprint, previousModel.units[0].fingerprint);
  assert.match(model.units[1].html, /tok-keyword/);
  assert.match(model.units[1].fingerprint, /^fingerprint:/);
});

// Gate A6 (2026-09-22): the first JavaScript tool output after start stayed monochrome because
// the lazy-grammar window was memoized and the block marked tokenized for good.
// Monaco 0.52 loads each language's tokenizer lazily: editor.tokenize() only
// STARTS the load (TokenizationRegistry.getOrCreate) and answers nullTokenize,
// one untyped token per line, until it lands; colorize() awaits the load.
function lazyGrammarMonaco() {
  let loaded = false;
  let loading = null;
  const load = () => loading || (loading = Promise.resolve().then(() => { loaded = true; }));
  return {
    editor: {
      tokenize(text, languageId) {
        load();
        if (!loaded) return [[{ offset: 0, type: '', language: languageId }]];
        const index = text.indexOf(' ');
        return [[{ offset: 0, type: 'keyword.js' }, ...(index >= 0 ? [{ offset: index, type: 'identifier.js' }] : [])]];
      },
      colorize: async () => { await load(); return ''; },
    },
    languages: { getLanguages: () => [{ id: 'javascript', extensions: ['.js'] }] },
  };
}

test('a grammar still loading is neither settled nor memoized as monochrome, and the body re-colors when it lands', async () => {
  const output = 'export function add(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }';
  const dom = new JSDOM(`<!doctype html><body><div class="tool-call-section"><pre><code class="language-javascript" data-code-highlight="pending" data-language-id="javascript">${output}</code></pre></div></body>`);
  await highlight.warmCodeHighlighting({ root: dom.window.document, monacoUtils: { ensureMonacoEditorApi: async () => lazyGrammarMonaco() } });
  const code = dom.window.document.querySelector('code');
  highlight.decorateCodeBlocks(dom.window.document);
  assert.notEqual(code.getAttribute('data-code-highlighted'), 'tokenized', 'first JS body while the grammar loads stays provisional');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(code.getAttribute('data-code-highlighted'), 'tokenized');
  assert.ok(code.querySelector('.tok-keyword'), 'the grammar-ready pass colors the body without another render');
  assert.ok(highlight.highlightLine('export function add(a, b) { return a + b; }', 'javascript').some((token) => token.cls === 'tok-keyword'),
    'the loading window was not memoized');
});
