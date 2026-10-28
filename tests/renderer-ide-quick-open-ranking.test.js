'use strict';

/* Quick Open review fixes: bounded top-N ranking (score desc, then plain
 * code-unit path order, no localeCompare) and a cache reset while the picker is
 * open re-indexing instead of stranding it on "Indexing…". */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeQuickOpen } = require('../renderer/features/renderer-ide-quick-open');
const paletteUtils = require('../renderer/shell/renderer-command-palette');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function build(files) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const calls = { listAllFiles: 0 };
  const quickOpen = createIdeQuickOpen({
    getDom: () => ({ ideEditorStage: stage }),
    callbacks: {
      getWorkspaceFsApi: () => ({
        async listAllFiles() {
          calls.listAllFiles += 1;
          return { files: files.slice(), truncated: false };
        },
      }),
    },
  });
  const rows = () => [...stage.querySelectorAll('[data-ide-quick-open-path]')].map((row) => row.dataset.ideQuickOpenPath);
  const status = () => stage.querySelector('.ide-quick-open-status')?.textContent || '';
  const type = (value) => {
    const field = stage.querySelector('[data-ide-quick-open-input]');
    field.value = value;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, stage, quickOpen, calls, rows, status, type };
}

test('ranking keeps the top 50 by score with a deterministic code-unit tie order', async (t) => {
  const files = [];
  for (let i = 0; i < 120; i += 1) files.push(`pkg${String(i).padStart(3, '0')}/index.js`);
  files.push('B/index.js', 'a/index.js', 'index.js');
  const ctx = build(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.toggle();
  await settle();
  ctx.type('index');
  const got = ctx.rows();

  const expected = files
    .map((path) => ({ path, match: paletteUtils.scoreMatch(path, 'index') }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match.score - a.match.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 50)
    .map((entry) => entry.path);
  assert.equal(got.length, 50);
  assert.deepEqual(got, expected);
  const ties = got.filter((path) => path === 'B/index.js' || path === 'a/index.js');
  if (ties.length === 2) assert.deepEqual(ties, ['B/index.js', 'a/index.js'], 'plain code-unit order, not locale order');
});

test('a cache reset while the picker is open re-indexes and repaints the rows', async (t) => {
  const files = ['a.js'];
  const ctx = build(files);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.toggle();
  await settle();
  assert.deepEqual(ctx.rows(), ['a.js']);

  files.push('b.js');
  ctx.quickOpen.handleExternalChanges([], { truncated: true });
  await settle();
  assert.equal(ctx.calls.listAllFiles, 2, 'the open picker re-fetched after the truncated batch');
  assert.deepEqual(ctx.rows().sort(), ['a.js', 'b.js']);
  assert.doesNotMatch(ctx.status(), /Indexing/);

  files.push('c.js');
  ctx.quickOpen.invalidate();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 3, 'an invalidate while open re-fetches too');
  assert.deepEqual(ctx.rows().sort(), ['a.js', 'b.js', 'c.js']);
});

test('a cache reset while the picker is closed waits for the next open', async (t) => {
  const ctx = build(['a.js']);
  t.after(() => ctx.quickOpen.dispose());
  ctx.quickOpen.invalidate();
  await settle();
  assert.equal(ctx.calls.listAllFiles, 0);
});
