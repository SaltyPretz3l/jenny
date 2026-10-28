'use strict';

/* Shared file:line link detection (row 82, plan section 5.7): the terminal link provider,
 * the run and test output views and the task problem matchers all read it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findLinks, LINKS_MAX } = require('../renderer/shared/file-link-detect');

const WIN_ROOT = 'D:\\Work\\app';
const POSIX_ROOT = '/home/dev/app';

function only(text, rootPath = WIN_ROOT) {
  const links = findLinks(text, { rootPath });
  assert.equal(links.length, 1, `expected one link in ${JSON.stringify(text)}, got ${JSON.stringify(links)}`);
  return links[0];
}

test('path:line:col links a relative path with its line and column and indexes the link text', () => {
  const text = 'error at src/app.js:12:3 here';
  const link = only(text);
  assert.deepEqual(link, { start: 9, end: 24, path: 'src/app.js', line: 12, col: 3 });
  assert.equal(text.slice(link.start, link.end), 'src/app.js:12:3');
});

test('path:line without a column carries no col', () => {
  assert.deepEqual(only('tests/test_x.py:40: AssertionError'), { start: 0, end: 18, path: 'tests/test_x.py', line: 40 });
});

test('path(line,col) and path(line) link (tsc, MSBuild)', () => {
  const tsc = only('src/app.ts(12,3): error TS2304');
  assert.equal(tsc.path, 'src/app.ts');
  assert.equal(tsc.line, 12);
  assert.equal(tsc.col, 3);
  const msb = only('lib\\util.cs(7): warning');
  assert.equal(msb.path, 'lib/util.cs');
  assert.equal(msb.line, 7);
  assert.equal(msb.col, undefined);
});

test('a Python traceback File "path", line N links the path under the root', () => {
  const text = '  File "D:\\Work\\app\\pkg\\mod.py", line 88, in run';
  const link = only(text);
  assert.equal(link.path, 'pkg/mod.py');
  assert.equal(link.line, 88);
  assert.equal(text.slice(link.start, link.start + 2), 'D:');
});

test('a node stack frame links the absolute path inside the parentheses, also behind file:///', () => {
  const frame = only('    at run (D:\\Work\\app\\src\\main.js:5:17)');
  assert.deepEqual([frame.path, frame.line, frame.col], ['src/main.js', 5, 17]);
  const esm = only('    at file:///D:/Work/app/src/esm.mjs:9:1');
  assert.deepEqual([esm.path, esm.line, esm.col], ['src/esm.mjs', 9, 1]);
});

test('Windows absolute paths compare the root case-insensitively with either slash', () => {
  assert.equal(only('d:/work/APP/src/a.js:1').path, 'src/a.js');
});

test('POSIX absolute paths link only under a POSIX root', () => {
  assert.equal(only('/home/dev/app/src/a.py:3:1', POSIX_ROOT).path, 'src/a.py');
  assert.deepEqual(findLinks('/home/dev/other/a.py:3', { rootPath: POSIX_ROOT }), []);
  assert.deepEqual(findLinks('/home/dev/app/a.py:3', { rootPath: WIN_ROOT }), []);
});

test('paths outside the root, escaping it, or absolute without a root never link', () => {
  assert.deepEqual(findLinks('C:\\Windows\\system32\\x.dll:1', { rootPath: WIN_ROOT }), []);
  assert.deepEqual(findLinks('D:\\Work\\application\\a.js:1', { rootPath: WIN_ROOT }), []);
  assert.deepEqual(findLinks('../outside/a.js:3', { rootPath: WIN_ROOT }), []);
  assert.deepEqual(findLinks('D:\\Work\\app\\a.js:3', { rootPath: '' }), []);
  assert.equal(only('./src/../lib/a.js:2').path, 'lib/a.js');
});

test('times, ports, versions, URLs and prose do not link', () => {
  for (const text of [
    'started at 12:30',
    'listening on localhost:8080',
    'version 1.2.3:4',
    'see https://example.com/src/app.js:12 for details',
    'Error: something failed',
    'line 0 at src/a.js:0',
  ]) {
    assert.deepEqual(findLinks(text, { rootPath: WIN_ROOT }), [], text);
  }
});

test('several links on one line come back in order', () => {
  const links = findLinks('a.js:1 and lib/b.ts(2,3) and c.py:4:5', { rootPath: WIN_ROOT });
  assert.deepEqual(links.map((l) => l.path), ['a.js', 'lib/b.ts', 'c.py']);
});

test('bounded and total: null input, huge input and many links never throw', () => {
  assert.deepEqual(findLinks(null), []);
  assert.deepEqual(findLinks(undefined, null), []);
  const many = Array.from({ length: LINKS_MAX + 50 }, (_, i) => `f${i}.js:${i + 1}`).join(' ');
  assert.equal(findLinks(many, { rootPath: WIN_ROOT }).length, LINKS_MAX);
});
