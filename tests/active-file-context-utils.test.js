'use strict';

// Coverage for services/backend/active-file-context-utils.js — the pure
// formatter that turns the renderer-supplied active editor slice + @-mention
// contents into a single system-message block.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildActiveFileContextBlock,
  fenceLanguageForPath,
} = require('../services/backend/active-file-context-utils');

const ACTIVE = {
  path: 'renderer/foo.js',
  languageId: 'javascript',
  cursor: { lineNumber: 5, column: 2 },
  startLine: 1,
  endLine: 9,
  totalLines: 9,
  slice: 'const x = 1;\nconst y = 2;',
};

test('builds an active-file section with header, path/line detail, fenced slice', () => {
  const block = buildActiveFileContextBlock(ACTIVE, []);
  assert.match(block, /Active editor context/);
  assert.match(block, /File: renderer\/foo\.js \(lines 1-9 of 9, cursor on line 5, javascript\)/);
  assert.match(block, /```js\nconst x = 1;\nconst y = 2;\n```/);
});

test('builds a mentions section with one block per file (extension-fenced)', () => {
  const block = buildActiveFileContextBlock(null, [
    { path: 'docs/readme.md', content: '# Title' },
    { path: 'src/a.py', content: 'print(1)' },
  ]);
  assert.match(block, /Files the user referenced with @/);
  assert.match(block, /=== docs\/readme\.md ===\n```md\n# Title\n```/);
  assert.match(block, /=== src\/a\.py ===\n```py\nprint\(1\)\n```/);
});

test('combines active slice and mentions when both are present', () => {
  const block = buildActiveFileContextBlock(ACTIVE, [{ path: 'b.txt', content: 'hi' }]);
  assert.match(block, /Active editor context/);
  assert.match(block, /=== b\.txt ===/);
});

test('returns null when there is no slice and no mentions', () => {
  assert.equal(buildActiveFileContextBlock(null, []), null);
  assert.equal(buildActiveFileContextBlock({ path: 'x.js', slice: '   ' }, []), null);
  assert.equal(buildActiveFileContextBlock(undefined, undefined), null);
});

test('ignores an active context with a path but blank slice', () => {
  const block = buildActiveFileContextBlock(
    { path: 'x.js', slice: '\n\n' },
    [{ path: 'y.js', content: 'kept' }]
  );
  assert.doesNotMatch(block, /Active editor context/);
  assert.match(block, /=== y\.js ===/);
});

test('dedupes repeated mention paths and caps the count', () => {
  const many = [];
  for (let i = 0; i < 20; i += 1) {
    many.push({ path: `f${i}.js`, content: `x${i}` });
  }
  many.push({ path: 'f0.js', content: 'dup-should-be-ignored' });
  const block = buildActiveFileContextBlock(null, many);
  const headerCount = (block.match(/^=== /gm) || []).length;
  assert.ok(headerCount <= 8, `expected <= 8 mention blocks, got ${headerCount}`);
  assert.doesNotMatch(block, /dup-should-be-ignored/);
});

test('truncates an oversized slice with a note', () => {
  const big = 'a'.repeat(20000);
  const block = buildActiveFileContextBlock({ ...ACTIVE, slice: big }, []);
  assert.match(block, /active file truncated at \d+ chars/);
});

test('keeps fence delimiters balanced when multiple mentions exceed the overall budget', () => {
  const block = buildActiveFileContextBlock(null, Array.from({ length: 4 }, (_, index) => ({
    path: `f${index}.js`,
    content: 'x'.repeat(6000),
  })));
  const openingFences = block.match(/^```js$/gm) || [];
  const closingFences = block.match(/^```$/gm) || [];

  assert.equal(openingFences.length, closingFences.length);
  assert.match(block, /active-file context truncated at 20000 chars/);
});

test('fenceLanguageForPath derives a fence from the extension', () => {
  assert.equal(fenceLanguageForPath('a/b/c.tsx'), 'tsx');
  assert.equal(fenceLanguageForPath('Makefile'), '');
  assert.equal(fenceLanguageForPath('weird.NAME.JS'), 'js');
});

test('a slice containing ``` is wrapped in a longer fence so it cannot break out', () => {
  const slice = 'before\n```js\ninner();\n```\nafter';
  const block = buildActiveFileContextBlock({ ...ACTIVE, slice }, []);
  // The opening fence must be >=4 backticks (longer than the inner 3-run) and the
  // inner ``` must survive verbatim inside it.
  assert.match(block, /````js\nbefore\n```js\ninner\(\);\n```\nafter\n````/);
});

test('a mention containing a longer backtick run gets an even longer fence', () => {
  const block = buildActiveFileContextBlock(null, [
    { path: 'doc.md', content: 'a\n````\nnested\n````\nb' },
  ]);
  // Inner run is 4 backticks, so the wrapping fence must be >=5.
  assert.match(block, /=== doc\.md ===\n`````md\na\n````\nnested\n````\nb\n`````/);
});
