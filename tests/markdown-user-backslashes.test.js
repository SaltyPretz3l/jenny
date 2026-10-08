'use strict';

// HB-041: the user bubble renders markdown, and a backslash before
// punctuation (C:\repo\.venv) was read as an escape and vanished.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const markdownUtils = require('../renderer/shared/markdown-utils');

const USER = { breaks: true, literalBackslashes: true };
function body(source, options = USER) {
  return new JSDOM(`<body>${markdownUtils.renderMarkdown(source, options)}</body>`).window.document.body;
}
const text = (source, options) => body(source, options).textContent.trim();

test('a typed HTML entity shows as typed in the user bubble', () => {
  const cases = ['Tom &amp; Jerry', '&lt;b&gt;x&lt;/b&gt;', '&#65;', '&#x41;', 'Tom & Jerry', '&copy;'];
  for (const typed of cases) {
    const user = body(typed);
    assert.equal(user.textContent.trim(), typed);
    assert.equal(user.querySelector('b'), null);
    assert.equal(body('`' + typed + '`').querySelector('code').textContent, typed);
    assert.equal(body(['```', typed, '```'].join('\n')).querySelector('pre code').textContent.trim(), typed);
  }
  assert.equal(text('<code>&amp;</code>'), '<code>&amp;</code>');
  const formatted = body('**&amp;** and [&copy;](https://example.com) and <https://example.com>');
  assert.equal(formatted.querySelector('strong').textContent, '&amp;');
  const links = [...formatted.querySelectorAll('a')];
  assert.deepEqual(links.map(link => link.textContent), ['&copy;', 'https://example.com']);
  assert.deepEqual(links.map(link => link.getAttribute('href')), ['https://example.com', 'https://example.com']);
  markdownUtils.clearMarkdownRenderCache();
  for (let pass = 0; pass < 2; pass += 1) {
    assert.equal(text('Tom &amp; Jerry'), 'Tom &amp; Jerry');
    assert.equal(text('Tom &amp; Jerry', { breaks: true }), 'Tom & Jerry');
  }
});

test('user messages keep a backslash before punctuation as typed', () => {
  const typed = String.raw`Run D:\Work\bank_recon\.venv\Scripts\python -m pytest`;
  assert.equal(text(typed), typed);
  assert.equal(text(String.raw`\\server\share\*.csv`), String.raw`\\server\share\*.csv`);
  // Without the option CommonMark still reads it as an escape (assistant replies).
  assert.equal(text(typed, { breaks: true }),
    String.raw`Run D:\Work\bank_recon.venv\Scripts\python -m pytest`);
});

test('the literal and escaping renders never share a cache entry', () => {
  const typed = String.raw`C:\a\.b`;
  markdownUtils.clearMarkdownRenderCache();
  for (let pass = 0; pass < 2; pass += 1) {
    assert.equal(text(typed), typed);
    assert.equal(text(typed, { breaks: true }), String.raw`C:\a.b`);
  }
});

test('code keeps its backslashes once, wherever the parser finds it', () => {
  // A code span that continues onto the next line.
  assert.equal(body('hello `C:\\a\\.b\nnext` end').querySelector('code').textContent, String.raw`C:\a\.b next`);
  // Fences in a list item and in a block quote.
  for (const source of ['- ```\n  C:\\a\\.b\n  ```', '> ```\n> C:\\a\\.b\n> ```']) {
    assert.equal(body(source).querySelector('pre code').textContent.trim(), String.raw`C:\a\.b`);
  }
  const fenced = body(['```', String.raw`C:\a\.b`, '```', String.raw`after C:\x\.y`].join('\n'));
  assert.equal(fenced.querySelector('pre code').textContent.trim(), String.raw`C:\a\.b`);
  assert.equal(fenced.querySelector('p').textContent.trim(), String.raw`after C:\x\.y`);
});

test('an indented continuation line stays prose and keeps its backslash', () => {
  assert.match(text('hello\n    C:\\a\\.b'), /C:\\a\\\.b$/);
});

test('an escaped table pipe stays inside its cell', () => {
  const cells = [...body('| Path | Other |\n| --- | --- |\n| a\\|b | c |').querySelectorAll('tbody td')]
    .map(cell => cell.textContent);
  assert.deepEqual(cells, ['a|b', 'c']);
});

test('markdown formatting in user messages still renders and raw markup stays inert', () => {
  const html = markdownUtils.renderMarkdown('**bold** and `code`', USER);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  const escaped = body(String.raw`x \<script>alert(1)</script> y`);
  assert.equal(escaped.querySelector('script'), null);
  assert.match(escaped.textContent, /^x \\<script>/);
});

// Live recheck 2026-10-06: typed <p> tags became paragraphs and a typed
// <button> vanished, so the bubble did not show what was typed.
test('raw HTML typed by the user is shown as typed, while an assistant reply keeps allowed tags', () => {
  const typed = 'Add <p>Hello</p> and <button class="go">Go</button> here';
  const user = body(typed);
  assert.equal(user.querySelector('button'), null, 'no element is created from typed markup');
  assert.equal(user.querySelectorAll('p').length, 1, 'only the paragraph the bubble wraps the text in');
  assert.equal(user.textContent.trim(), typed);
  const block = body('<div>\n<b>block</b>\n</div>');
  assert.equal(block.querySelector('div, b'), null);
  assert.equal(block.textContent.trim(), '<div>\n<b>block</b>\n</div>');
  // Search highlight renders the same bubble through the same options.
  assert.equal(text('<p>same</p>', { breaks: true, literalBackslashes: true }), '<p>same</p>');
  // The assistant policy is unchanged: allowed HTML still renders.
  const assistant = body('Add <p>Hello</p> and <button>Go</button> here', { breaks: true });
  assert.ok(assistant.querySelectorAll('p').length > 1, 'the typed <p> still becomes markup in an assistant reply');
  assert.equal(assistant.querySelector('button'), null, 'button is outside the sanitizer allowlist');
});
