'use strict';

// Fast lane for scripts/run-node-tests-safe.js (--fast-only, `npm run
// test:js:fast`): the hosted-stable partition minus the files listed in
// tests/.slow-lane.json. The list is a measurement, not a judgement: it is
// written from the runner history by `node scripts/report-slow-tests.js
// --write-slow-lane` and reviewed like any other diff.
//
// The lane filters what directory discovery found. A file named on the command
// line always runs, in its normal lane, so `tests/ --fast-only <mapped files>`
// is "the fast lane plus these files" (the test:affected fallback).
//
// Nothing here removes a file from `npm test`, `test:js:stable` or the full
// gate; a missing or unreadable list only makes the fast lane run more.

const fs = require('fs');
const path = require('path');
const {
  normalizeRepoPath,
  normalizeChildArgPath,
  isSequentialTestPath,
  isStableLaneExcludedPath,
} = require('./run-node-tests-safe-support');

const SLOW_LANE_PATH = path.join('tests', '.slow-lane.json');
const SLOW_LANE_LABEL = 'tests/.slow-lane.json';
const SLOW_LANE_VERSION = 1;
const DEFAULT_CUT_MS = 2000;
// A list written from one or two runs would move files on noise.
const MIN_FULL_RUNS = 3;
const MAX_FULL_RUNS = 5;
// A history run counts as a full run when it covers this share of the test
// files on disk; a targeted run says nothing about files it did not run.
const FULL_RUN_SHARE = 0.9;
// Drift is reported, never gated: a wall-clock gate fails on a loaded machine.
const DRIFT_FACTOR = 2;
const DRIFT_FILES_REPORTED = 10;
const REFRESH_COMMAND = 'node scripts/report-slow-tests.js --write-slow-lane';

function loadSlowLane(cwd = process.cwd()) {
  const empty = { present: false, cutMs: DEFAULT_CUT_MS, files: new Set() };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(cwd, SLOW_LANE_PATH), 'utf8'));
  } catch {
    return empty;
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.files)) return empty;
  const cutMs = Number(payload.cut_ms);
  return {
    present: true,
    cutMs: Number.isFinite(cutMs) && cutMs > 0 ? Math.floor(cutMs) : DEFAULT_CUT_MS,
    files: new Set(payload.files.filter((entry) => typeof entry === 'string' && entry).map(normalizeRepoPath)),
  };
}

// Narrows childArgs to the fast lane. Discovered files leave when they are
// one-at-a-time, excluded from the hosted stable lane, or on the slow list.
// Files in `options.explicit` (named on the command line, as repo paths) stay.
// A file given twice (discovered and named) runs once. The checks go cheapest
// first: on Windows the one-at-a-time check reads the test's source.
function selectFastLane(childArgs, options = {}) {
  const cwd = options.cwd || process.cwd();
  const slowFiles = (options.slowLane && options.slowLane.files) || new Set();
  const explicit = options.explicit || new Set();
  const seen = new Set();
  const kept = [];
  const leftOutSlow = [];
  const leftOutLane = [];
  for (const childArg of childArgs) {
    const key = normalizeChildArgPath(childArg, cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    if (explicit.has(key)) {
      kept.push(childArg);
    } else if (slowFiles.has(key)) {
      leftOutSlow.push(key);
    } else if (isStableLaneExcludedPath(childArg) || isSequentialTestPath(childArg, { cwd })) {
      leftOutLane.push(key);
    } else {
      kept.push(childArg);
    }
  }
  return {
    childArgs: kept,
    cutMs: (options.slowLane && options.slowLane.cutMs) || DEFAULT_CUT_MS,
    listPresent: Boolean(options.slowLane && options.slowLane.present),
    leftOutSlow,
    leftOutLane,
    explicit,
  };
}

function formatFastLaneNote(fastLane) {
  const parts = [
    `fast lane: left out ${fastLane.leftOutSlow.length} slow-listed file(s) and ` +
      `${fastLane.leftOutLane.length} one-at-a-time or heavy file(s); npm test runs them all`,
  ];
  if (!fastLane.listPresent) {
    parts.push(`no ${SLOW_LANE_LABEL} found, so no file is treated as slow (write it with ${REFRESH_COMMAND})`);
  }
  return parts.join('; ');
}

// Passing fast-lane files that took more than DRIFT_FACTOR times the cut: they
// probably belong on the list now. Named files are not the lane's concern.
function findFastLaneDrift(results, fastLane) {
  const limitMs = fastLane.cutMs * DRIFT_FACTOR;
  return results
    .filter((record) => record && record.code === 0 && !record.timedOut && record.durationMs > limitMs)
    .filter((record) => !fastLane.explicit.has(normalizeRepoPath(record.file)))
    .sort((a, b) => b.durationMs - a.durationMs);
}

function formatFastLaneDrift(results, fastLane) {
  const drift = findFastLaneDrift(results, fastLane);
  if (drift.length === 0) return [];
  const listed = drift
    .slice(0, DRIFT_FILES_REPORTED)
    .map((record) => `${record.file} (${(record.durationMs / 1000).toFixed(1)}s)`)
    .join(', ');
  const more = drift.length > DRIFT_FILES_REPORTED ? `, ... (${drift.length - DRIFT_FILES_REPORTED} more)` : '';
  return [
    `[run-node-tests-safe] fast lane: ${drift.length} file(s) took over ` +
      `${((fastLane.cutMs * DRIFT_FACTOR) / 1000).toFixed(1)}s: ${listed}${more}`,
    `[run-node-tests-safe] fast lane: if that repeats on a quiet machine, refresh the slow list with ${REFRESH_COMMAND}`,
  ];
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// Decides the slow list from runner history (newest run first). Uses the
// newest passing full runs only, and only files that are in the stable lane
// today: a one-at-a-time or stable-excluded file never rides the fast lane, so
// listing it would be noise.
function computeSlowLane(history, options = {}) {
  const cwd = options.cwd || process.cwd();
  const cutMs = Number.isFinite(options.cutMs) && options.cutMs > 0 ? Math.floor(options.cutMs) : DEFAULT_CUT_MS;
  const expected = Number(options.fullRunFileCount) || 0;
  const runs = history && Array.isArray(history.runs) ? history.runs : [];
  const fullRuns = runs
    .filter((run) => run && run.status === 'passed' && Array.isArray(run.files))
    .filter((run) => expected > 0 && run.files.length >= expected * FULL_RUN_SHARE)
    .slice(0, MAX_FULL_RUNS);
  if (fullRuns.length < MIN_FULL_RUNS) {
    return {
      ok: false,
      reason:
        `need ${MIN_FULL_RUNS} passing full runs in the history and found ${fullRuns.length} ` +
        `(a full run covers at least ${Math.ceil(expected * FULL_RUN_SHARE)} of the ${expected} test files); ` +
        'run npm test on a quiet machine until there are enough',
    };
  }
  const durations = new Map();
  for (const run of fullRuns) {
    for (const record of run.files) {
      const durationMs = Number(record && record.durationMs);
      if (!record || record.timedOut || record.status !== 'passed' || !Number.isFinite(durationMs)) continue;
      const file = normalizeRepoPath(record.file);
      if (!durations.has(file)) durations.set(file, []);
      durations.get(file).push(durationMs);
    }
  }
  const files = [];
  let considered = 0;
  for (const record of fullRuns[0].files) {
    const file = normalizeRepoPath(record && record.file);
    const samples = durations.get(file);
    if (!samples || !file.startsWith('tests/')) continue;
    const absolute = path.join(cwd, file);
    if (isStableLaneExcludedPath(file) || !fs.existsSync(absolute) || isSequentialTestPath(absolute, { cwd })) continue;
    considered += 1;
    if (median(samples) >= cutMs) files.push(file);
  }
  files.sort();
  return { ok: true, cutMs, files, runsUsed: fullRuns.length, considered };
}

function writeSlowLane(cwd, result) {
  const body = { version: SLOW_LANE_VERSION, cut_ms: result.cutMs, files: result.files };
  fs.writeFileSync(path.join(cwd, SLOW_LANE_PATH), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

module.exports = {
  SLOW_LANE_PATH,
  SLOW_LANE_LABEL,
  DEFAULT_CUT_MS,
  REFRESH_COMMAND,
  loadSlowLane,
  selectFastLane,
  formatFastLaneNote,
  findFastLaneDrift,
  formatFastLaneDrift,
  computeSlowLane,
  writeSlowLane,
};
