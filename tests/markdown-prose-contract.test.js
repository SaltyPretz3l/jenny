'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const markdownUtils = require('../renderer/shared/markdown-utils');

test('per-call hard breaks stay isolated in the settled render cache', () => {
  const source = 'line one\nline two';
  markdownUtils.clearMarkdownRenderCache();
  const defaultHtml = markdownUtils.renderMarkdown(source);
  const breaksHtml = markdownUtils.renderMarkdown(source, { breaks: true });
  assert.doesNotMatch(defaultHtml, /<br\s*\/?>/);
  assert.match(breaksHtml, /line one<br>line two/);
  assert.equal(markdownUtils.renderMarkdown(source), defaultHtml);
  assert.equal(markdownUtils.getMarkdownRenderCacheStats().size, 2);
});

test('nested lists, nested blockquotes, and fenced-code-like table cells remain contained', () => {
  const nested = markdownUtils.renderMarkdown('- outer\n  1. ordered\n     - inner');
  const quoted = markdownUtils.renderMarkdown('- item\n  > quoted under item');
  const table = markdownUtils.renderMarkdown('| Snippet |\n| --- |\n| ```js const x = 1; ``` |');
  assert.match(nested, /<ul>[\s\S]*<ol>[\s\S]*<ul>/);
  assert.match(quoted, /<li>[\s\S]*<blockquote>/);
  assert.match(table, /<td><code>js const x = 1; <\/code><\/td>/);
  assert.equal((table.match(/<table>/g) || []).length, 1);
});

test('streaming reuses exact highlighted prefix HTML and supports legacy fingerprints', () => {
  const first = markdownUtils.renderStreamingMarkdownUnits('```js\nconst value = 1;\n```\n\nFirst paragraph.');
  assert.match(first.units[0].html, /tok tok-default/);
  const prefixHtml = first.units[0].html;
  const next = markdownUtils.renderStreamingMarkdownUnits(
    '```js\nconst value = 1;\n```\n\nFirst paragraph.\n\nSecond paragraph.',
    { previousUnits: first.units }
  );
  assert.equal(next.changedStartIndex, 2);
  assert.equal(next.units[0].html, prefixHtml);
  const fingerprintsOnly = markdownUtils.renderStreamingMarkdownUnits(
    '```js\nconst value = 1;\n```\n\nFirst paragraph.',
    { previousFingerprints: first.fingerprints }
  );
  assert.equal(fingerprintsOnly.changedStartIndex, -1);
});

test('streaming rejects tampered highlighted units and rebuilds sanitized HTML', () => {
  const first = markdownUtils.renderStreamingMarkdownUnits('Safe.');
  const forgedUnits = first.units.map((unit) => ({
    ...unit,
    html: '<img src=x onerror=alert(1)>',
  }));
  const next = markdownUtils.renderStreamingMarkdownUnits('Safe.', { previousUnits: forgedUnits });

  assert.equal(next.changedStartIndex, 0);
  assert.doesNotMatch(next.html, /onerror|<img/i);
  assert.match(next.html, /<p>Safe\.<\/p>/);
});
