'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  renderTestRunnerHistoryStrip,
} = require('../renderer/features/renderer-ide-test-runner-history-strip.js');

function render(runs) {
  const dom = new JSDOM('<main></main>');
  return renderTestRunnerHistoryStrip(dom.window.document, runs, { locale: 'en-US' });
}

function run(index, overrides = {}) {
  return {
    status: 'passed',
    durationMs: 1000 + index,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    ...overrides,
  };
}

test('empty history renders no strip', () => {
  assert.equal(render([]), null);
});

test('bar strip shows the last 30 runs in oldest-to-newest order', () => {
  const runs = Array.from({ length: 35 }, (_, index) => run(index, {
    status: index === 5 ? 'failed' : (index === 34 ? 'error' : 'passed'),
  }));
  const strip = render(runs);
  const bars = strip.querySelectorAll('.ide-test-runner-history-strip__bar');
  assert.equal(bars.length, 30);
  assert.equal(bars[0].dataset.status, 'failed', 'the oldest shown run is first');
  assert.equal(bars[29].dataset.status, 'error', 'the newest shown run is last');
});

test('timeout and interrupted bars carry the hang marker and hang tooltip', () => {
  const strip = render([
    run(0, { status: 'timeout', durationMs: 1200 }),
    run(1, { status: 'interrupted', durationMs: 125000 }),
  ]);
  const hangs = strip.querySelectorAll('.ide-test-runner-history-strip__bar--hang');
  assert.equal(hangs.length, 2);
  assert.equal(hangs[0].querySelector('title').textContent, 'hang: timeout after 1.2s');
  assert.equal(hangs[1].querySelector('title').textContent, 'hang: interrupted after 2m 05s');
});

test('summary reports known min, median, max and a slower recent trend', () => {
  const strip = render([
    run(0, { durationMs: 850 }),
    run(1, { durationMs: 1000 }),
    run(2, { durationMs: 1200 }),
    run(3, { durationMs: 125000 }),
  ]);
  const summary = strip.querySelector('.ide-test-runner-history-strip__summary');
  assert.match(summary.textContent, /min 850ms \/ median 1\.1s \/ max 2m 05s/);
  const trend = summary.querySelector('[data-trend]');
  assert.equal(trend.dataset.trend, 'slower');
  assert.equal(trend.textContent, '↑ slower');
});

test('trend is hidden below four durations and distinguishes faster from flat', () => {
  assert.equal(render([run(0), run(1), run(2)]).querySelector('[data-trend]'), null);
  const faster = render([run(0, { durationMs: 2000 }), run(1, { durationMs: 2200 }), run(2, { durationMs: 1000 }), run(3, { durationMs: 1100 })]);
  assert.equal(faster.querySelector('[data-trend]').dataset.trend, 'faster');
  const flat = render([run(0, { durationMs: 1000 }), run(1, { durationMs: 1000 }), run(2, { durationMs: 1090 }), run(3, { durationMs: 1090 })]);
  assert.equal(flat.querySelector('[data-trend]').dataset.trend, 'flat');
});

test('history expander caps rows at 30 and orders them newest first', () => {
  const strip = render(Array.from({ length: 35 }, (_, index) => run(index, {
    passedCount: index,
    failedCount: 35 - index,
  })));
  const rows = strip.querySelectorAll('tbody tr');
  assert.equal(rows.length, 30);
  assert.equal(rows[0].children[3].textContent, '34', 'newest run is the first table row');
  assert.equal(rows[29].children[3].textContent, '5', 'oldest retained run is last');
});

test('missing duration produces a zero-height status-colored bar', () => {
  const strip = render([run(0, { status: 'running', durationMs: null, startedAt: null })]);
  const bar = strip.querySelector('.ide-test-runner-history-strip__bar--running');
  assert.ok(bar);
  assert.equal(bar.getAttribute('height'), '0');
  assert.match(bar.querySelector('title').textContent, /— · running · —/);
});

// ---------------------------------------------------------------------------
// Verification gate Wave 3: Jenny-initiated runs carry a tick + legend, and a
// skipped run (lock held) is a first-class status.
// ---------------------------------------------------------------------------

test('jenny-initiated runs carry a 2px accent tick above the bar and a legend entry', () => {
  const strip = render([
    run(0),
    run(1, { initiator: 'jenny', status: 'failed' }),
    run(2),
  ]);
  const ticks = strip.querySelectorAll('.ide-test-runner-history-strip__tick');
  assert.equal(ticks.length, 1, 'one tick per Jenny run');
  const bars = strip.querySelectorAll('.ide-test-runner-history-strip__bar');
  assert.equal(ticks[0].getAttribute('x'), bars[1].getAttribute('x'), 'the tick sits over its own bar');
  assert.equal(ticks[0].getAttribute('y'), '0');
  assert.equal(ticks[0].getAttribute('height'), '2');
  assert.equal(ticks[0].dataset.initiator, 'jenny');
  assert.match(bars[1].querySelector('title').textContent, /· by Jenny$/);
  assert.doesNotMatch(bars[0].querySelector('title').textContent, /by Jenny/);
  const legend = strip.querySelector('.ide-test-runner-history-strip__legend');
  assert.ok(legend, 'the summary line carries a legend entry');
  assert.equal(legend.textContent, '▔ by Jenny');
  assert.match(strip.querySelector('svg').getAttribute('aria-label'), /ticks mark 1 started by Jenny/);
});

test('no Jenny runs: no ticks, no legend, aria-label unchanged', () => {
  const strip = render([run(0), run(1)]);
  assert.equal(strip.querySelector('.ide-test-runner-history-strip__tick'), null);
  assert.equal(strip.querySelector('.ide-test-runner-history-strip__legend'), null);
  assert.equal(strip.querySelector('svg').getAttribute('aria-label'), 'Durations for the last 2 test runs, oldest to newest');
});

test('a skipped run keeps its own status (not error) and the table gains a By column', () => {
  const strip = render([
    run(0, { passedCount: 3, failedCount: 0 }),
    run(1, { status: 'skipped', initiator: 'jenny', durationMs: null }),
  ]);
  const bar = strip.querySelector('.ide-test-runner-history-strip__bar--skipped');
  assert.ok(bar, 'skipped is a recognised status');
  assert.equal(bar.dataset.status, 'skipped');
  assert.equal(bar.getAttribute('height'), '0', 'no duration, no bar height -- only the tick shows');
  const headers = Array.from(strip.querySelectorAll('thead th')).map((th) => th.textContent);
  assert.deepEqual(headers, ['Started', 'Duration', 'Status', 'Passed', 'Failed', 'By'], 'By is appended after the counts');
  const rows = strip.querySelectorAll('tbody tr');
  assert.equal(rows[0].children[5].textContent, 'Jenny', 'newest first: the skipped Jenny run');
  assert.equal(rows[1].children[5].textContent, 'you');
});
