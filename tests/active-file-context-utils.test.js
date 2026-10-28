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

// --- PDF documents (kind: 'pdf') ---

const PDF = {
  path: 'docs/q3-review.pdf',
  kind: 'pdf',
  pages: { start: 4, end: 4, total: 38 },
  selection: false,
  scanned: false,
  slice: 'Revenue grew 12% quarter over quarter.',
};

test('pdf: a single page renders the document header, citation hint and fenced page text', () => {
  const block = buildActiveFileContextBlock(PDF, []);
  assert.match(block, /^\[Active document context — what the user is reading in their PDF viewer\]\n/);
  assert.match(block, /File: docs\/q3-review\.pdf \(page 4 of 38\)\n/);
  assert.doesNotMatch(block, /text the user selected/);
  assert.match(block, /Cite it as "docs\/q3-review\.pdf, page 4"/);
  assert.match(block, /read_file with pages="N" or pages="N-M"/);
  assert.match(block, /\n```\nRevenue grew 12% quarter over quarter\.\n```$/);
  assert.doesNotMatch(block, /Active editor context/);
});

test('pdf: a page range renders "pages 4-5" and cites the range', () => {
  const block = buildActiveFileContextBlock({ ...PDF, pages: { start: 4, end: 5, total: 38 } }, []);
  assert.match(block, /File: docs\/q3-review\.pdf \(pages 4-5 of 38\)/);
  assert.match(block, /Cite it as "docs\/q3-review\.pdf, pages 4-5"/);
});

test('pdf: a selection is labelled as user-selected text', () => {
  const block = buildActiveFileContextBlock({ ...PDF, selection: true, slice: 'grew 12%' }, []);
  assert.match(block, /File: docs\/q3-review\.pdf \(page 4 of 38, text the user selected\)/);
  assert.match(block, /the text the user selected/);
  assert.match(block, /\n```\ngrew 12%\n```$/);
});

test('pdf: a scanned page has no fence and points at read_file with pages (OCR)', () => {
  const block = buildActiveFileContextBlock({ ...PDF, scanned: true, slice: '' }, []);
  assert.match(block, /File: docs\/q3-review\.pdf \(page 4 of 38\)/);
  assert.match(block, /no text layer/);
  assert.match(block, /read_file with pages="4"/);
  assert.match(block, /OCR/);
  assert.doesNotMatch(block, /```/);
});

test('pdf: a page sent before its text was extracted points at read_file without claiming a scan', () => {
  const block = buildActiveFileContextBlock({ ...PDF, pending: true, slice: '' }, []);
  assert.match(block, /File: docs\/q3-review\.pdf \(page 4 of 38\)/);
  assert.match(block, /was not ready when the message was sent/);
  assert.doesNotMatch(block, /no text layer/);
  assert.match(block, /read_file with pages="4"/);
  assert.doesNotMatch(block, /```/);
});

test('pdf: a scanned page range suggests the range in pages', () => {
  const block = buildActiveFileContextBlock(
    { ...PDF, scanned: true, slice: '', pages: { start: 2, end: 3, total: 9 } },
    []
  );
  assert.match(block, /read_file with pages="2-3"/);
});

test('pdf: invalid page numbers drop the section', () => {
  const bad = [
    { start: 0, end: 1, total: 38 },
    { start: 5, end: 4, total: 38 },
    { start: 4, end: 39, total: 38 },
    { start: 1.5, end: 2, total: 38 },
    { start: 1, end: 2.5, total: 38 },
    { start: 1, end: 2, total: 38.5 },
    { start: '4', end: 4, total: 38 },
    { start: 1, end: 1, total: 100001 },
    { start: 1, end: 1, total: 0 },
    { start: NaN, end: 1, total: 3 },
    null,
  ];
  for (const pages of bad) {
    assert.equal(buildActiveFileContextBlock({ ...PDF, pages }, []), null, JSON.stringify(pages));
  }
  assert.equal(buildActiveFileContextBlock({ ...PDF, pages: undefined }, []), null);
});

test('pdf: a non-.pdf path or an empty path drops the section', () => {
  assert.equal(buildActiveFileContextBlock({ ...PDF, path: 'docs/notes.txt' }, []), null);
  assert.equal(buildActiveFileContextBlock({ ...PDF, path: '' }, []), null);
  assert.equal(buildActiveFileContextBlock({ ...PDF, path: 'docs/pdf' }, []), null);
  assert.match(buildActiveFileContextBlock({ ...PDF, path: 'docs/Q3.PDF' }, []), /File: docs\/Q3\.PDF \(page 4 of 38\)/);
});

test('pdf: an empty slice without scanned drops the section but mentions survive', () => {
  assert.equal(buildActiveFileContextBlock({ ...PDF, slice: '' }, []), null);
  assert.equal(buildActiveFileContextBlock({ ...PDF, slice: '  \n ' }, []), null);
  const block = buildActiveFileContextBlock({ ...PDF, slice: '' }, [{ path: 'a.js', content: 'kept' }]);
  assert.doesNotMatch(block, /Active document context/);
  assert.match(block, /=== a\.js ===/);
});

test('pdf: an oversized page slice is truncated with the shared note', () => {
  const block = buildActiveFileContextBlock({ ...PDF, slice: 'p'.repeat(8000) }, []);
  assert.match(block, /active file truncated at 6000 chars/);
  assert.ok(!block.includes('p'.repeat(6001)));
});

test('pdf: page text containing ``` is wrapped in a longer fence', () => {
  const block = buildActiveFileContextBlock({ ...PDF, slice: 'a\n```\nb' }, []);
  assert.match(block, /\n````\na\n```\nb\n````$/);
});

test('pdf: an unknown kind or a missing kind keeps the code section', () => {
  assert.match(buildActiveFileContextBlock({ ...ACTIVE, kind: 'code' }, []), /Active editor context/);
  assert.match(buildActiveFileContextBlock({ ...ACTIVE, kind: undefined }, []), /Active editor context/);
});

test('pdf: coexists with @-mentions; the renderer owns active-vs-mention dedupe', () => {
  const block = buildActiveFileContextBlock(PDF, [{ path: 'src/a.py', content: 'print(1)' }]);
  assert.match(block, /Active document context/);
  assert.match(block, /\n\n\[Files the user referenced with @ in their message\]/);
  assert.match(block, /=== src\/a\.py ===/);
});
