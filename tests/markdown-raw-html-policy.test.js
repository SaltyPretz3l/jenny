'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const markdownUtils = require('../renderer/shared/markdown-utils');

test('plain mode escapes every raw HTML token', () => {
  const rawText = markdownUtils.renderMarkdown('a <script>b c', { mermaid: 'plain' });
  const block = markdownUtils.renderMarkdown('x <div>y', { mermaid: 'plain' });
  const inline = markdownUtils.renderMarkdown('k <kbd>Ctrl</kbd>', { mermaid: 'plain' });

  assert.match(rawText, /&lt;script&gt;b c/);
  assert.doesNotMatch(rawText, /<script/i);
  assert.match(block, /&lt;div&gt;y/);
  assert.match(inline, /&lt;kbd&gt;/);
});

test('answer mode escapes swallowing constructs and preserves safe inline HTML', () => {
  assert.match(markdownUtils.renderMarkdown('a <script>b c'), /&lt;script&gt;b c/);
  assert.match(markdownUtils.renderMarkdown('s <style>x'), /&lt;style&gt;x/);
  assert.match(markdownUtils.renderMarkdown('n <!-- open comment then text'), /&lt;!-- open comment then text/);
  assert.match(markdownUtils.renderMarkdown('k <kbd>Ctrl</kbd>'), /<kbd>Ctrl<\/kbd>/);

  const closedComment = markdownUtils.renderMarkdown('closed <!-- c --> after');
  assert.match(closedComment, /after/);
  assert.doesNotMatch(closedComment, /&lt;!--/);
});

test('plain mode preserves a long reasoning stream after an inline raw-text tag', () => {
  const source = 'Implementation structure (all in one<script>):- Helpers: '
    + 'more visible reasoning '.repeat(30);
  const html = markdownUtils.renderMarkdown(source, { mermaid: 'plain' });
  const visibleText = JSDOM.fragment(html).textContent;

  assert.ok(source.length > 500);
  assert.ok(visibleText.length > 400);
});

test('answer mode: a raw-text tag nested inside a block HTML token is escaped, not swallowed', () => {
  const nested = markdownUtils.renderMarkdown('<div>\nhello\n<script>\nalert(1)\nmore text after here', {});
  assert.ok(nested.includes('more text after here'));
  assert.ok(!nested.includes('<script'));
  const textarea = markdownUtils.renderMarkdown('<div>\n<textarea>\nrest of the answer text', {});
  assert.ok(textarea.includes('rest of the answer text'));
  assert.ok(!textarea.includes('<textarea'));
});

test('createPlainMarked returns null when the marked build has no Marked export', () => {
  const policy = require('../renderer/shared/markdown-raw-html-policy');
  assert.equal(policy.createPlainMarked({}, {}), null);
});
