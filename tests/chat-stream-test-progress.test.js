'use strict';

// Row 96: the trust-boundary normalizer for `test_progress` on tool.output_chunk
// (services/backend/chat-stream-test-progress.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_FAILURES,
  MAX_GRID_CELLS,
  MAX_LABEL_CHARS,
  normalizeTestProgress,
} = require('../services/backend/chat-stream-test-progress');

function base(overrides = {}) {
  return {
    runner: 'pytest',
    unit: 'file',
    total: 16068,
    total_unit: 'tests',
    done: 8677,
    tests: 8677,
    passed: 8600,
    failed: 3,
    skipped: 65,
    percent: 54.0,
    elapsed_ms: 41000,
    eta_ms: 38000,
    failures: [{ file: 'tests/a.py', name: 'test_a', at: 0.4 }],
    grid: { count: 4, group: 1, px: 6, states: 'ppfr' },
    labels_from: 0,
    labels: ['a', 'b', 'c', 'd'],
    final: false,
    ...overrides,
  };
}

test('normalizes a well-formed object to camelCase event fields', () => {
  assert.deepEqual(normalizeTestProgress(base()), {
    runner: 'pytest',
    unit: 'file',
    total: 16068,
    totalUnit: 'tests',
    done: 8677,
    tests: 8677,
    passed: 8600,
    failed: 3,
    skipped: 65,
    percent: 54,
    elapsedMs: 41000,
    etaMs: 38000,
    failures: [{ file: 'tests/a.py', name: 'test_a', at: 0.4 }],
    grid: { count: 4, group: 1, px: 6, states: 'ppfr' },
    labelsFrom: 0,
    labels: ['a', 'b', 'c', 'd'],
    stage: 0,
    final: false,
  });
  assert.equal(normalizeTestProgress(base({ stage: 2 })).stage, 2, 'a multi-stage command names its followed stage');
});

test('non-objects and unknown runner or unit drop the whole progress', () => {
  for (const raw of [null, undefined, 'x', 4, [], base({ runner: 'jest' }), base({ unit: 'suite' }), base({ runner: undefined })]) {
    assert.equal(normalizeTestProgress(raw), null);
  }
  for (const runner of ['pytest', 'tap', 'node_safe']) {
    for (const unit of ['file', 'order', 'none']) {
      assert.ok(normalizeTestProgress(base({ runner, unit })));
    }
  }
});

test('integers clamp to safe non-negative values and percent to 0..100 or null', () => {
  const out = normalizeTestProgress(base({
    done: -5, tests: 1e300, passed: 'many', failed: 2.9, skipped: NaN, elapsed_ms: -1,
    percent: 140, eta_ms: -3,
  }));
  assert.equal(out.done, 0);
  assert.equal(out.tests, Number.MAX_SAFE_INTEGER);
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.elapsedMs, 0);
  assert.equal(out.percent, 100);
  assert.equal(out.etaMs, 0);
  assert.equal(normalizeTestProgress(base({ percent: -4 })).percent, 0);
  assert.equal(normalizeTestProgress(base({ percent: null })).percent, null);
  assert.equal(normalizeTestProgress(base({ percent: 'half' })).percent, null);
});

test('total and eta are null-able; total_unit falls back to tests', () => {
  const out = normalizeTestProgress(base({ total: null, eta_ms: null, total_unit: 'files' }));
  assert.equal(out.total, null);
  assert.equal(out.etaMs, null);
  assert.equal(out.totalUnit, 'files');
  assert.equal(normalizeTestProgress(base({ total_unit: 'bogus' })).totalUnit, 'tests');
  assert.equal(normalizeTestProgress(base({ total: 'lots' })).total, null);
});

test('failures are capped at 50, strings clipped to 160, at clamped 0..1', () => {
  const failures = Array.from({ length: 80 }, (_, i) => ({
    file: 'f'.repeat(500), name: `n${i}`.padEnd(400, 'x'), at: i === 0 ? 7 : i === 1 ? -2 : 0.5,
  }));
  failures.splice(2, 0, null, 'bad', 12);
  const out = normalizeTestProgress(base({ failures }));
  assert.equal(out.failures.length, MAX_FAILURES);
  assert.equal(out.failures[0].file.length, MAX_LABEL_CHARS);
  assert.equal(out.failures[0].name.length, MAX_LABEL_CHARS);
  assert.equal(out.failures[0].at, 1);
  assert.equal(out.failures[1].at, 0);
  assert.equal(normalizeTestProgress(base({ failures: 'nope' })).failures.length, 0);
});

test('grid states are filtered to -rpsf, padded with - and clipped to count', () => {
  assert.equal(normalizeTestProgress(base({
    grid: { count: 6, group: 2, px: 4, states: 'p<x>fRq' },
  })).grid.states, 'pf----');
  assert.equal(normalizeTestProgress(base({
    grid: { count: 3, group: 1, px: 6, states: 'ppppp' },
  })).grid.states, 'ppp');
  assert.equal(normalizeTestProgress(base({ grid: { count: 3, group: 1, px: 6 } })).grid.states, '---');
});

test('grid bounds: count <= 2500, group >= 1, px 4 or 6, null stays null', () => {
  const big = normalizeTestProgress(base({
    grid: { count: 99999, group: 0, px: 5, states: 'p' }, labels: [],
  })).grid;
  assert.equal(big.count, MAX_GRID_CELLS);
  assert.equal(big.states.length, MAX_GRID_CELLS);
  assert.equal(big.group, 1);
  assert.equal(big.px, 4);
  assert.equal(normalizeTestProgress(base({ grid: { count: 10, group: 3, px: 6, states: '' } })).grid.px, 6);
  assert.equal(normalizeTestProgress(base({ grid: null, labels: [] })).grid, null);
  assert.equal(normalizeTestProgress(base({ grid: { count: 0, group: 1, px: 6, states: '' } })).grid, null);
  assert.equal(normalizeTestProgress(base({ grid: 'x' })).grid, null);
});

test('labels clip to 160 chars and obey labels_from + length <= count', () => {
  const long = 'L'.repeat(400);
  const ok = normalizeTestProgress(base({ labels_from: 2, labels: [long, 7] }));
  assert.equal(ok.labelsFrom, 2);
  assert.equal(ok.labels[0].length, MAX_LABEL_CHARS);
  assert.equal(ok.labels[1], '');
  // 3 + 2 > 4: the range overruns the grid, so the labels are dropped.
  const over = normalizeTestProgress(base({ labels_from: 3, labels: ['x', 'y'] }));
  assert.deepEqual(over.labels, []);
  assert.equal(over.labelsFrom, 0);
  // Labels need a grid to describe.
  assert.deepEqual(normalizeTestProgress(base({ grid: null, labels: ['x'] })).labels, []);
  // Absent labels stay empty.
  assert.deepEqual(normalizeTestProgress(base({ labels: undefined, labels_from: undefined })).labels, []);
});

test('labels are capped at 2500 entries before the range rule', () => {
  const labels = Array.from({ length: 3000 }, (_, i) => `f${i}`);
  const out = normalizeTestProgress(base({ grid: { count: 2500, group: 1, px: 4, states: '' }, labels }));
  assert.equal(out.labels.length, MAX_GRID_CELLS);
  assert.equal(out.labels[2499], 'f2499');
});

test('final is true only for a boolean true', () => {
  assert.equal(normalizeTestProgress(base({ final: true })).final, true);
  assert.equal(normalizeTestProgress(base({ final: 'yes' })).final, false);
  assert.equal(normalizeTestProgress(base({ final: undefined })).final, false);
});
