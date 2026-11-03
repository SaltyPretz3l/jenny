'use strict';

// Row 96: a `tool.output_chunk` batch may carry an optional `test_progress`
// object (snake_case, sidecar-produced). This is the trust boundary: re-bound
// every field and return the camelCase fields of a `tool_test_progress`
// chat-stream event, or null to drop it. Like tool_output_chunk it is
// forward-only and never persisted or journaled.

const RUNNERS = new Set(['pytest', 'tap', 'node_safe']);
const UNITS = new Set(['file', 'order', 'none']);
const TOTAL_UNITS = new Set(['tests', 'files']);
const MAX_FAILURES = 50;
const MAX_GRID_CELLS = 2500;
const MAX_LABEL_CHARS = 160;
const GRID_STATE_CHARS = /[^-rpsf]/g;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function toNullableInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? toInt(value) : null;
}

function toUnit(value, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;
}

function clip(value) {
  return typeof value === 'string' ? value.slice(0, MAX_LABEL_CHARS) : '';
}

function normalizeFailures(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .slice(0, MAX_FAILURES)
    .map((entry) => ({ file: clip(entry.file), name: clip(entry.name), at: toUnit(entry.at, 1) }));
}

function normalizeGrid(raw) {
  if (!isRecord(raw)) return null;
  const count = Math.min(MAX_GRID_CELLS, toInt(raw.count));
  if (count < 1) return null;
  const states = (typeof raw.states === 'string' ? raw.states : '').replace(GRID_STATE_CHARS, '');
  return {
    count,
    group: Math.max(1, toInt(raw.group)),
    px: raw.px === 6 || raw.px === 4 ? raw.px : (count <= 1000 ? 6 : 4),
    states: states.slice(0, count).padEnd(count, '-'),
  };
}

/**
 * @param {unknown} raw the `test_progress` object from a tool.output_chunk
 * @returns {object|null} camelCase event fields, or null when it must be dropped
 */
function normalizeTestProgress(raw) {
  if (!isRecord(raw) || !RUNNERS.has(raw.runner) || !UNITS.has(raw.unit)) return null;
  const grid = normalizeGrid(raw.grid);
  const rawLabels = Array.isArray(raw.labels) ? raw.labels.slice(0, MAX_GRID_CELLS).map(clip) : [];
  const labelsFrom = toInt(raw.labels_from);
  const labelsFit = grid !== null && labelsFrom + rawLabels.length <= grid.count;
  return {
    runner: raw.runner,
    unit: raw.unit,
    total: toNullableInt(raw.total),
    totalUnit: TOTAL_UNITS.has(raw.total_unit) ? raw.total_unit : 'tests',
    done: toInt(raw.done),
    tests: toInt(raw.tests),
    passed: toInt(raw.passed),
    failed: toInt(raw.failed),
    skipped: toInt(raw.skipped),
    percent: typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? toUnit(raw.percent, 100) : null,
    elapsedMs: toInt(raw.elapsed_ms),
    etaMs: toNullableInt(raw.eta_ms),
    failures: normalizeFailures(raw.failures),
    grid,
    labelsFrom: labelsFit ? labelsFrom : 0,
    labels: labelsFit ? rawLabels : [],
    stage: toInt(raw.stage),
    final: raw.final === true,
  };
}

module.exports = {
  MAX_FAILURES,
  MAX_GRID_CELLS,
  MAX_LABEL_CHARS,
  normalizeTestProgress,
};
