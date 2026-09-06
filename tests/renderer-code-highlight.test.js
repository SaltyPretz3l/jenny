'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
