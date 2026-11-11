'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  findAffectedPages,
  PAGE_FINDER_LIMITS,
} = require('../services/change-pictures/page-finder');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// The finder gets an already-resolved root, so the temp directory is resolved
// the same way (the temp folder can sit behind a short-name or link).
function makeRoot(files) {
  const root = fs.realpathSync(createTrackedTempDir('jenny-pagefind-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function pagePaths(result) {
  return result.pages.map((page) => page.path);
}

const link = (href) => `<html><link rel="stylesheet" href="${href}"></html>`;

test('limits are frozen with the documented defaults', () => {
  assert.equal(Object.isFrozen(PAGE_FINDER_LIMITS), true);
  assert.deepEqual({ ...PAGE_FINDER_LIMITS }, {
    maxHtmlFiles: 300,
    maxFileBytes: 512 * 1024,
    maxDepth: 6,
    timeBudgetMs: 250,
    maxLinkedFiles: 40,
  });
});

test('changed pages are returned with their status and need no disk access', async () => {
  const explode = () => { throw new Error('disk touched'); };
  const fsImpl = {
    promises: new Proxy({}, { get: () => explode }),
    ...new Proxy({}, { get: () => explode }),
  };
  const result = await findAffectedPages({
    realRoot: path.join(path.parse(process.cwd()).root, 'no-such-root'),
    files: [
      { path: 'gone.html', status: 'deleted' },
      { path: 'Sub/New.HTM', status: 'created' },
      { path: 'edited.html', status: 'modified' },
    ],
    maxPages: 5,
    fsImpl,
  });
  assert.deepEqual(result, {
    pages: [
      { path: 'edited.html', status: 'modified' },
      { path: 'gone.html', status: 'deleted' },
      { path: 'Sub/New.HTM', status: 'created' },
    ],
    scanned: 0,
    truncated: false,
  });
});

test('a page that links a changed stylesheet is found as unchanged', async () => {
  const root = makeRoot({
    'index.html': link('css/site.css'),
    'other.html': link('css/other.css'),
    'css/site.css': 'body{}',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 'css/site.css', status: 'modified' }],
  });
  assert.deepEqual(result.pages, [{ path: 'index.html', status: 'unchanged' }]);
  assert.equal(result.truncated, false);
  assert.equal(result.scanned, 2);
});

test('a page is found through an unchanged stylesheet that imports the change (one hop)', async () => {
  const root = makeRoot({
    'index.html': link('main.css'),
    'plain.html': link('unrelated.css'),
    'main.css': '@import "parts/theme.css";\nbody{}',
    'unrelated.css': 'body{color:red}',
    'parts/theme.css': 'h1{}',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 'parts/theme.css', status: 'modified' }],
  });
  assert.deepEqual(pagePaths(result), ['index.html']);
});

test('a script that imports a changed module links its page', async () => {
  const root = makeRoot({
    'app.html': '<script type="module" src="./main.mjs"></script>',
    'main.mjs': "import { x } from './lib/util.js';",
    'lib/util.js': 'export const x = 1;',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 'lib/util.js', status: 'modified' }],
  });
  assert.deepEqual(pagePaths(result), ['app.html']);
});

test('a page with no link to the change is not returned', async () => {
  const root = makeRoot({
    'index.html': link('a.css'),
    'a.css': 'body{}',
    'b.css': 'p{}',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 'b.css', status: 'created' }],
  });
  assert.deepEqual(result.pages, []);
});

test('url() and @import inside inline HTML count as references', async () => {
  const root = makeRoot({
    'a.html': '<style>body{background:url("img/bg.png")}</style>',
    'b.html': '<style>@import \'theme/dark.css\';</style>',
    'c.html': '<style>i{background:url(img/other.png)}</style>',
    'img/bg.png': 'x',
    'theme/dark.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [
      { path: 'img/bg.png', status: 'modified' },
      { path: 'theme/dark.css', status: 'modified' },
    ],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['a.html', 'b.html']);
});

test('changed pages come first and index pages and shallow pages sort first', async () => {
  const root = makeRoot({
    'a.html': link('s.css'),
    'index.html': link('s.css'),
    'sub/index.html': link('../s.css'),
    'sub/deep/x.html': link('../../s.css'),
    'sub/b.html': link('../s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [
      { path: 's.css', status: 'modified' },
      { path: 'z-changed.html', status: 'deleted' },
      { path: 'sub/Index.htm', status: 'created' },
    ],
    maxPages: 10,
  });
  assert.deepEqual(result.pages, [
    { path: 'sub/Index.htm', status: 'created' },
    { path: 'z-changed.html', status: 'deleted' },
    { path: 'index.html', status: 'unchanged' },
    { path: 'sub/index.html', status: 'unchanged' },
    { path: 'a.html', status: 'unchanged' },
    { path: 'sub/b.html', status: 'unchanged' },
    { path: 'sub/deep/x.html', status: 'unchanged' },
  ]);
  assert.equal(result.truncated, false);
});

test('a changed page that also references the change appears once', async () => {
  const root = makeRoot({ 'index.html': link('s.css'), 's.css': 'x' });
  const result = await findAffectedPages({
    realRoot: root,
    files: [
      { path: 'index.html', status: 'modified' },
      { path: 's.css', status: 'modified' },
    ],
  });
  assert.deepEqual(result.pages, [{ path: 'index.html', status: 'modified' }]);
});

test('maxPages cuts the list and marks it truncated', async () => {
  const root = makeRoot({
    'a.html': link('s.css'),
    'b.html': link('s.css'),
    'c.html': link('s.css'),
    'd.html': link('s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 3,
  });
  assert.deepEqual(pagePaths(result), ['a.html', 'b.html', 'c.html']);
  assert.equal(result.truncated, true);
});

test('node_modules and dot directories are not walked', async () => {
  const root = makeRoot({
    'node_modules/pkg/page.html': link('/s.css'),
    '.hidden/page.html': link('/s.css'),
    '.git/page.html': link('/s.css'),
    'visible/page.html': link('/s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['visible/page.html']);
  assert.equal(result.truncated, false);
});

test('a linked directory is not walked', async (t) => {
  const outside = fs.realpathSync(createTrackedTempDir('jenny-pagefind-out-'));
  fs.writeFileSync(path.join(outside, 'outside.html'), link('/s.css'));
  const root = makeRoot({ 's.css': 'x', 'real.html': link('s.css') });
  try {
    // A junction needs no privilege on Windows; elsewhere it is a plain link.
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'junction');
  } catch (error) {
    t.skip(`links are not available here: ${error.code || error.message}`);
    return;
  }
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['real.html']);
});

test('a symbolic link to a page file is skipped', async (t) => {
  const outside = fs.realpathSync(createTrackedTempDir('jenny-pagefind-out-'));
  fs.writeFileSync(path.join(outside, 'outside.html'), link('/s.css'));
  const root = makeRoot({ 's.css': 'x', 'real.html': link('s.css') });
  try {
    fs.symlinkSync(path.join(outside, 'outside.html'), path.join(root, 'linked.html'), 'file');
  } catch (error) {
    t.skip(`symbolic links are not available here: ${error.code || error.message}`);
    return;
  }
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['real.html']);
});

test('a linked stylesheet behind a symbolic link is not read', async (t) => {
  const outside = fs.realpathSync(createTrackedTempDir('jenny-pagefind-out-'));
  fs.writeFileSync(path.join(outside, 'theme.css'), 'mentions s.css here');
  const root = makeRoot({ 's.css': 'x', 'page.html': link('theme.css') });
  try {
    fs.symlinkSync(path.join(outside, 'theme.css'), path.join(root, 'theme.css'), 'file');
  } catch (error) {
    t.skip(`symbolic links are not available here: ${error.code || error.message}`);
    return;
  }
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
  });
  assert.deepEqual(result.pages, []);
});

test('references with a scheme or a protocol-relative host are ignored', async () => {
  const root = makeRoot({
    'a.html': link('https://example.com/s.css'),
    'b.html': link('//cdn.example.com/s.css'),
    'c.html': '<img src="data:image/png;base64,AAA/s.css">',
    'd.html': '<a href="mailto:s.css">x</a><a href="javascript:s.css">y</a>',
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(result.pages, []);
});

test('query strings, hashes and percent-encoding are normalized', async () => {
  const root = makeRoot({
    'a.html': link('s.css?v=3#top'),
    'b.html': link('my%20style.css'),
    'c.html': link('bad%E0%A4%A.css'),
    'd.html': link('s.css%3Fnot-a-query'),
    's.css': 'x',
    'my style.css': 'x',
    'bad%E0%A4%A.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [
      { path: 's.css', status: 'modified' },
      { path: 'my style.css', status: 'modified' },
      { path: 'bad%E0%A4%A.css', status: 'modified' },
    ],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['a.html', 'b.html', 'c.html']);
});

test('a leading slash resolves from the root, other values from the page directory', async () => {
  const root = makeRoot({
    'sub/rooted.html': link('/css/app.css'),
    'sub/relative.html': link('css/app.css'),
    'sub/up.html': link('../css/app.css'),
    'css/app.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 'css/app.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(pagePaths(result), ['sub/rooted.html', 'sub/up.html']);
});

test('a reference that climbs out of the root is ignored', async () => {
  const root = makeRoot({
    'a.html': link('../s.css'),
    'sub/b.html': link('../../s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
  });
  assert.deepEqual(result.pages, []);
});

test('path comparison follows the platform case rules', async () => {
  const root = makeRoot({ 'a.html': link('CSS/Site.css'), 'css/site.css': 'x' });
  const files = [{ path: 'css/site.css', status: 'modified' }];
  const windows = await findAffectedPages({ realRoot: root, files, platform: 'win32' });
  assert.deepEqual(pagePaths(windows), ['a.html']);
  const linux = await findAffectedPages({ realRoot: root, files, platform: 'linux' });
  assert.deepEqual(linux.pages, []);
});

test('unsafe changed-file paths are ignored', async () => {
  const root = makeRoot({ 'a.html': link('s.css'), 's.css': 'x' });
  const result = await findAffectedPages({
    realRoot: root,
    files: [
      { path: '', status: 'modified' },
      { path: '../escape.html', status: 'modified' },
      { path: 'a/../b.html', status: 'modified' },
      { path: '/abs.html', status: 'modified' },
      { path: 'C:/abs.html', status: 'modified' },
      { path: 'back\\slash.html', status: 'modified' },
      { path: 42, status: 'modified' },
      null,
    ],
  });
  assert.deepEqual(result, { pages: [], scanned: 0, truncated: false });
});

test('invalid input returns the empty result', async () => {
  const empty = { pages: [], scanned: 0, truncated: false };
  assert.deepEqual(await findAffectedPages({ realRoot: '', files: [] }), empty);
  assert.deepEqual(await findAffectedPages({ realRoot: 7, files: [] }), empty);
  assert.deepEqual(await findAffectedPages({ realRoot: process.cwd(), files: null }), empty);
  assert.deepEqual(await findAffectedPages({}), empty);
  assert.deepEqual(await findAffectedPages(), empty);
});

test('an unreadable root yields no pages and does not throw', async () => {
  const root = path.join(fs.realpathSync(createTrackedTempDir('jenny-pagefind-')), 'missing');
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
  });
  assert.deepEqual(result.pages, []);
});

test('the time budget stops the walk and marks it truncated', async () => {
  const files = { 's.css': 'x' };
  for (let i = 0; i < 10; i += 1) files[`p${i}.html`] = link('s.css');
  const root = makeRoot(files);
  let clock = 0;
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 20,
    now: () => { clock += 100; return clock; },
    limits: { timeBudgetMs: 250 },
  });
  assert.equal(result.truncated, true);
  assert.ok(result.scanned < 10, `scanned ${result.scanned}`);
  assert.ok(result.pages.length < 10);
});

test('maxHtmlFiles stops the walk and marks it truncated', async () => {
  const files = { 's.css': 'x' };
  for (let i = 0; i < 5; i += 1) files[`p${i}.html`] = link('s.css');
  const root = makeRoot(files);
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 20,
    limits: { maxHtmlFiles: 2 },
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(pagePaths(result), ['p0.html', 'p1.html']);
});

test('directories below maxDepth are not entered', async () => {
  const root = makeRoot({
    'top.html': link('s.css'),
    'a/one.html': link('../s.css'),
    'a/b/two.html': link('../../s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
    limits: { maxDepth: 1 },
  });
  assert.deepEqual(pagePaths(result), ['top.html', 'a/one.html']);
  assert.equal(result.truncated, true);
});

test('a page larger than maxFileBytes is skipped without being read', async () => {
  const root = makeRoot({
    'big.html': `${link('s.css')}${' '.repeat(2000)}`,
    'small.html': link('s.css'),
    's.css': 'x',
  });
  const result = await findAffectedPages({
    realRoot: root,
    files: [{ path: 's.css', status: 'modified' }],
    maxPages: 10,
    limits: { maxFileBytes: 1000 },
  });
  assert.deepEqual(pagePaths(result), ['small.html']);
  assert.equal(result.scanned, 1);
});

test('only maxLinkedFiles linked files are read per call', async () => {
  const root = makeRoot({
    'a.html': link('a.css'),
    'b.html': link('b.css'),
    'a.css': 'nothing here',
    'b.css': '@import "s.css";',
    's.css': 'x',
  });
  const files = [{ path: 's.css', status: 'modified' }];
  const limited = await findAffectedPages({
    realRoot: root,
    files,
    maxPages: 10,
    limits: { maxLinkedFiles: 1 },
  });
  assert.deepEqual(limited.pages, []);
  const unlimited = await findAffectedPages({ realRoot: root, files, maxPages: 10 });
  assert.deepEqual(pagePaths(unlimited), ['b.html']);
});
