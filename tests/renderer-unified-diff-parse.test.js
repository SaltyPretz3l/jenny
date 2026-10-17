'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseUnifiedDiff, MAX_LINES, MAX_HUNKS, MAX_LINE_LENGTH } = require('../renderer/chat/renderer-unified-diff-parse');

const SAMPLE = [
  'diff --git a/src/a.js b/src/a.js',
  'index 83db48f..bf2a1c3 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -12,4 +12,5 @@ function head() {',
  ' keep one',
  '-old line',
  '+new line',
  '+added line',
  ' keep two',
  '@@ -40 +41 @@',
  '-gone',
  '+here',
  '',
].join('\n');

test('headers before the first hunk are skipped and hunks keep the renderer shape with markers', () => {
  const result = parseUnifiedDiff(SAMPLE);
  assert.equal(result.binary, false);
  assert.equal(result.truncated, false);
  assert.equal(result.hunks.length, 2);
  assert.deepEqual(result.hunks[0], {
    oldStart: 12, oldLines: 4, newStart: 12, newLines: 5,
    lines: [' keep one', '-old line', '+new line', '+added line', ' keep two'],
  });
  // A missing count means one line on that side.
  assert.deepEqual(result.hunks[1], { oldStart: 40, oldLines: 1, newStart: 41, newLines: 1, lines: ['-gone', '+here'] });
});

test('the "\\ No newline at end of file" marker is dropped, not rendered as content', () => {
  const text = ['@@ -1,2 +1,2 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file', ' c'].join('\n');
  const [hunk] = parseUnifiedDiff(text).hunks;
  assert.deepEqual(hunk.lines, ['-a', '+b', ' c']);
});

test('a removed line that looks like a file header never ends the hunk early', () => {
  // The removed content is "-- sql comment" (so the row reads "--- sql comment"), the added one "++ x".
  const text = ['@@ -1,2 +1,2 @@', '--- sql comment', '+++ x', ' tail', 'diff --git a/b b/b', '--- a/b', '+++ b/b', '@@ -5 +5 @@', '-p', '+q'].join('\n');
  const result = parseUnifiedDiff(text);
  assert.equal(result.hunks.length, 2);
  assert.deepEqual(result.hunks[0].lines, ['--- sql comment', '+++ x', ' tail']);
  assert.deepEqual(result.hunks[1].lines, ['-p', '+q']);
});

test('an empty line inside a hunk is context and CRLF endings are tolerated', () => {
  const text = '@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n';
  const [hunk] = parseUnifiedDiff(text).hunks;
  assert.deepEqual(hunk.lines, [' a', ' ', '-b', '+c']);
});

test('binary diffs report binary and no hunks', () => {
  assert.deepEqual(parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n'), { hunks: [], binary: true, truncated: false });
  assert.equal(parseUnifiedDiff('diff --git a/x b/x\nGIT binary patch\nliteral 12\n').binary, true);
});

test('non-diff input yields nothing and never throws', () => {
  for (const input of [undefined, null, 42, {}, '', 'just text\nnot a diff', '@@ broken header @@\n+x']) {
    const result = parseUnifiedDiff(input);
    assert.deepEqual(result.hunks, []);
    assert.equal(result.binary, false);
  }
});

test('the line cap truncates and reports it', () => {
  const lines = ['@@ -1,50 +1,50 @@'];
  for (let i = 0; i < 50; i += 1) lines.push(`+line ${i}`);
  const result = parseUnifiedDiff(lines.join('\n'), { maxLines: 10 });
  assert.equal(result.truncated, true);
  assert.equal(result.hunks[0].lines.length, 10);
  assert.ok(MAX_LINES >= 1000, 'the default cap is generous but finite');
  // An option above the hard cap is clamped to it.
  const big = ['@@ -1,1 +1,9000 @@'];
  for (let i = 0; i < MAX_LINES + 5; i += 1) big.push('+x');
  const clamped = parseUnifiedDiff(big.join('\n'), { maxLines: MAX_LINES * 10 });
  assert.equal(clamped.hunks[0].lines.length, MAX_LINES);
  assert.equal(clamped.truncated, true);
});

test('the hunk cap truncates and reports it', () => {
  const lines = [];
  for (let i = 0; i < 12; i += 1) lines.push(`@@ -${i + 1} +${i + 1} @@`, '-a', '+b');
  const result = parseUnifiedDiff(lines.join('\n'), { maxHunks: 5 });
  assert.equal(result.hunks.length, 5);
  assert.equal(result.truncated, true);
  assert.ok(MAX_HUNKS >= 100);
});

test('a very long line is clamped and absurd hunk counts do not allocate anything', () => {
  const long = '+' + 'x'.repeat(MAX_LINE_LENGTH * 3);
  const result = parseUnifiedDiff(`@@ -1 +1 @@\n${long}\n`);
  assert.equal(result.hunks[0].lines[0].length, MAX_LINE_LENGTH);
  const huge = parseUnifiedDiff('@@ -1,99999999999999999999 +1,2 @@\n+a\n+b\n');
  assert.equal(huge.hunks.length, 1);
  assert.equal(huge.hunks[0].lines.length, 2);
});

test('oversized text is cut before parsing and flagged truncated', () => {
  const text = '@@ -1 +1 @@\n' + '+y\n'.repeat(400000);
  const result = parseUnifiedDiff(text);
  assert.equal(result.truncated, true);
  assert.ok(result.hunks[0].lines.length <= MAX_LINES);
});
