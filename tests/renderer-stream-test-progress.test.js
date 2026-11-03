'use strict';

/* Row 96 live test-run progress: the live block under a running run_command row
   (renderer-stream-test-progress.js) and the finished record and header meta
   (renderer-tool-test-summary.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createToolTestProgress } = require('../renderer/chat/renderer-stream-test-progress.js');
const summary = require('../renderer/chat/renderer-tool-test-summary.js');

function setup() {
  const dom = new JSDOM(`<body><div id="timeline">
    <div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call_1" data-tool-status="running" data-expanded="false">
      <div class="tool-call-row-header"><div class="tool-call-row-toggle" role="button">
        <span class="tool-call-status-cluster"><span class="tool-call-status">Running</span></span>
      </div></div>
      <div class="tool-call-row-body"></div>
    </div></div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const timeline = window.document.getElementById('timeline');
  const progress = createToolTestProgress({ getChatTimeline: () => timeline });
  const flush = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  return { window, timeline, progress, flush, row: timeline.querySelector('.tool-call-row') };
}

function event(extra = {}) {
  return {
    type: 'tool_test_progress', sessionId: 's1', streamId: 'st1', callId: 'call_1', toolName: 'run_command', sequence: 1,
    runner: 'pytest', unit: 'file', total: 16068, totalUnit: 'tests', done: 8677, tests: 8677, passed: 8609, failed: 3,
    skipped: 65, percent: 54, elapsedMs: 48_000, etaMs: 38_000,
    failures: [
      { file: 'ai/tools/builtins/test_shell_background_wait.py', name: 'test_wait_ms_returns_as_soon_as_the_job_finishes', at: 0.18 },
      { file: 'ai/engines/test_generate_cancellation.py', name: 'test_cancel_mid_stream_releases_the_slot', at: 0.41 },
      { file: 'ai/context/test_compaction_truncated_summary.py', name: 'test_truncated_summary_keeps_tool_pairs', at: 0.52 },
    ],
    grid: { count: 4, group: 1, px: 6, states: 'pfr-' },
    labelsFrom: 0, labels: ['a/test_a.py', 'a/test_b.py', 'a/test_c.py', 'a/test_d.py'], final: false,
    ...extra,
  };
}

test('a progress event paints the bar, counts, grid, failures and the header %', async () => {
  const { window, progress, flush, row } = setup();
  assert.equal(progress.apply(event()), true);
  await flush();
  const block = row.querySelector(':scope > .tool-test-progress[data-test-progress-state="live"]');
  assert.ok(block, 'the live block sits under the header');
  assert.equal(block.previousElementSibling.className, 'tool-call-row-header');
  assert.equal(row.querySelector('[data-test-progress-meta]').textContent, '54%');
  assert.equal(row.querySelector('.tool-call-status-cluster').firstElementChild.hasAttribute('data-test-progress-meta'), true);
  assert.equal(block.querySelector('.inv-progress-fill').style.getPropertyValue('--progress'), '54.00%');
  assert.equal(block.querySelectorAll('.tool-test-progress-tick').length, 3);
  assert.match(block.querySelector('[data-test-progress-slot="counts"]').textContent, /^8,677 of 16,068 tests · 3 failed · 65 skipped · about 0:38 left$/);
  const cells = [...block.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')];
  assert.deepEqual(cells.map((cell) => cell.getAttribute('data-s')), ['ok', 'bad', 'run', '']);
  assert.equal(cells[1].getAttribute('title'), 'a/test_b.py');
  assert.equal(block.querySelectorAll('.tool-test-progress-fail').length, 3);
  assert.deepEqual([...block.querySelectorAll('[data-test-progress-action]')].map((link) => link.textContent), ['Hide files', 'Show output']);
  window.close();
});

test('a later event patches only the changed cells and keeps the bar element', async () => {
  const { window, progress, flush, row } = setup();
  progress.apply(event());
  await flush();
  const fill = row.querySelector('.inv-progress-fill');
  const cells = [...row.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')];
  cells[0].setAttribute('data-marker', 'kept');
  progress.apply(event({ sequence: 2, percent: 60, grid: { count: 4, group: 1, px: 6, states: 'pfpr' }, labels: undefined, labelsFrom: undefined }));
  await flush();
  assert.equal(row.querySelector('.inv-progress-fill'), fill, 'the fill element survives so its width transition runs');
  assert.equal(fill.style.getPropertyValue('--progress'), '60.00%');
  const after = [...row.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')];
  assert.equal(after[0].getAttribute('data-marker'), 'kept', 'unchanged cells are not rebuilt');
  assert.deepEqual(after.map((cell) => cell.getAttribute('data-s')), ['ok', 'bad', 'ok', 'run']);
  assert.equal(after[3].getAttribute('title'), 'a/test_d.py', 'labels from the first event persist');
  window.close();
});

test('a new stage of a multi-stage command drops the previous stage labels', async () => {
  const { window, progress, flush, row } = setup();
  progress.apply(event());
  await flush();
  progress.apply(event({ sequence: 2, stage: 1, percent: 5, grid: { count: 4, group: 1, px: 6, states: 'p---' }, labels: undefined, labelsFrom: undefined }));
  await flush();
  const cells = [...row.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')];
  assert.equal(cells.length, 4);
  assert.ok(cells.every((cell) => !String(cell.getAttribute('title') || '').startsWith('a/test_')), 'no label of the old stage survives');
  window.close();
});

test('a re-rendered row gets its block back; settle removes the block and the header %', async () => {
  const { window, timeline, progress, flush, row } = setup();
  progress.apply(event());
  await flush();
  const replacement = row.cloneNode(true);
  replacement.querySelector('.tool-test-progress')?.remove();
  replacement.querySelector('[data-test-progress-meta]')?.remove();
  row.replaceWith(replacement);
  await flush();
  await flush();
  assert.ok(replacement.querySelector('.tool-test-progress[data-test-progress-state="live"]'), 'the observer repaints a replaced row');
  progress.settle({ sessionId: 's1', streamId: 'st1', callId: 'call_1' });
  assert.equal(timeline.querySelector('.tool-test-progress'), null);
  assert.equal(timeline.querySelector('[data-test-progress-meta]'), null);
  window.close();
});

test('TAP progress has no bar, no grid and no %: a running count with elapsed time', async () => {
  const { window, progress, flush, row } = setup();
  progress.apply(event({ runner: 'tap', unit: 'none', total: null, percent: null, etaMs: null, done: 412, tests: 412, failed: 2, skipped: 0, elapsedMs: 41_000, grid: null, labels: undefined, labelsFrom: undefined, failures: [] }));
  await flush();
  assert.equal(row.querySelector('.inv-progress'), null);
  assert.equal(row.querySelector('.tool-test-progress-grid'), null);
  assert.equal(row.querySelector('[data-test-progress-meta]'), null);
  assert.equal(row.querySelector('[data-test-progress-slot="counts"]').textContent, '412 tests · 2 failed · 0:41');
  window.close();
});

test('node_safe counts files and tests; time left reads "estimating" before 10%', () => {
  const html = summary.countsText({ total: 2486, totalUnit: 'files', done: 120, tests: 1030, failed: 0, skipped: 0, percent: 4.8, etaMs: null, elapsedMs: 9000 });
  assert.equal(html, '120 of 2,486 files · 1,030 tests · estimating time left');
});

test('the finished record: header meta, skipped, a folded grid and the failures', () => {
  const metadata = { test_summary: {
    runner: 'pytest', unit: 'file', total: 16068, total_unit: 'tests', tests: 16068, passed: 15944, failed: 3, skipped: 121, duration_ms: 86_000,
    failures: [{ file: 'a/test_x.py', name: 'test_x', at: 0.2 }],
    grid: { count: 3, group: 1, px: 6, states: 'pfs' },
  } };
  assert.equal(summary.headerMeta('run_command', metadata), '3 failed · 15,944 passed');
  assert.equal(summary.headerMeta('read_file', metadata), '');
  assert.equal(summary.headerMeta('run_command', { test_summary: { ...metadata.test_summary, failed: 0, failures: [] } }), '15,944 passed');
  const dom = new JSDOM(`<body>${summary.renderFinished('run_command', metadata)}</body>`);
  const block = dom.window.document.querySelector('.tool-test-progress');
  assert.equal(block.getAttribute('data-test-progress-state'), 'finished');
  assert.equal(block.getAttribute('data-grid-open'), 'false');
  assert.match(block.querySelector('.tool-test-progress-line').textContent, /121 skipped/);
  assert.equal(block.querySelector('.tool-test-progress-cell'), null, 'the folded grid builds no cells until Files is clicked');
  summary.installActions(dom.window.document);
  block.querySelector('[data-test-progress-action="grid"]').click();
  assert.deepEqual([...block.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')].map((cell) => cell.getAttribute('data-s')), ['ok', 'bad', 'skip']);
  assert.equal(block.querySelectorAll('.tool-test-progress-fail').length, 1);
  assert.equal(summary.renderFinished('run_command', {}), '');
  dom.window.close();
});

test('the Files link folds the grid; more than five failures collapse to "+N more"', () => {
  const failures = Array.from({ length: 7 }, (_, index) => ({ file: `t/test_${index}.py`, name: `test_${index}`, at: index / 10 }));
  const metadata = { test_summary: { runner: 'pytest', unit: 'order', total: 7, total_unit: 'tests', tests: 7, passed: 0, failed: 7, skipped: 0, failures, grid: { count: 7, group: 1, px: 6, states: 'fffffff' } } };
  const dom = new JSDOM(`<body><div class="tool-call-row" data-expanded="false">${summary.renderFinished('run_command', metadata)}</div></body>`);
  summary.installActions(dom.window.document);
  const block = dom.window.document.querySelector('.tool-test-progress');
  assert.equal(block.querySelectorAll('.tool-test-progress-fail').length, 5);
  assert.equal(block.querySelector('.tool-test-progress-more').textContent, '+2 more');
  const link = block.querySelector('[data-test-progress-action="grid"]');
  link.click();
  assert.equal(block.getAttribute('data-grid-open'), 'true');
  assert.equal(link.textContent, 'Hide files');
  assert.match(block.querySelector('.tool-test-progress-unit').textContent, /each cell is 1 test, in the order they finished/);
  link.click();
  link.click();
  assert.equal(block.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell').length, 7, 'reopening does not rebuild or duplicate the cells');
  dom.window.close();
});

test('grouped grids say what a cell is; px 4 grids carry their size', () => {
  const html = summary.gridHtml('file', { count: 3, group: 4, px: 4, states: 'p-f' }, 160420, null);
  const dom = new JSDOM(`<body>${html}</body>`);
  assert.equal(dom.window.document.querySelector('.tool-test-progress-grid').getAttribute('data-px'), '4');
  assert.equal(dom.window.document.querySelector('.tool-test-progress-unit').textContent, '3 cells · each is 4 files');
  dom.window.close();
});

test('the hosted snake_case wire paints the same block (total unit, time left, grid labels)', async () => {
  const { window, progress, flush, row } = setup();
  const hosted = event({ totalUnit: undefined, elapsedMs: undefined, etaMs: undefined, labelsFrom: undefined,
    total_unit: 'tests', elapsed_ms: 48_000, eta_ms: 38_000, labels_from: 0, call_id: 'call_1' });
  assert.equal(progress.apply(hosted), true);
  await flush();
  assert.match(row.querySelector('[data-test-progress-slot="counts"]').textContent, /of 16,068 tests .* about 0:38 left$/);
  assert.equal(row.querySelectorAll('.tool-test-progress-grid .tool-test-progress-cell')[1].getAttribute('title'), 'a/test_b.py');
  window.close();
});

test('an out-of-order older batch is ignored', async () => {
  const { window, progress, flush, row } = setup();
  progress.apply(event({ sequence: 5, percent: 60 }));
  assert.equal(progress.apply(event({ sequence: 4, percent: 40, labels: undefined, labelsFrom: undefined })), false);
  await flush();
  assert.equal(row.querySelector('[data-test-progress-meta]').textContent, '60%');
  window.close();
});
