'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DEFAULT_MAX_RUNS,
  HISTORY_PATH,
  buildRunRecord,
  createSafeRunnerHistory,
  finishRunHistory,
  formatRunTrendBlock,
  startRunHistory,
  trendForDuration,
} = require('../scripts/run-node-tests-safe-history');
const { recordsFromHistory } = require('../scripts/report-slow-tests');

const ROOT = path.resolve(__dirname, '..');
const SAFE_RUNNER_SCRIPT = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const REPORT_SCRIPT = path.join(__dirname, '..', 'scripts', 'report-slow-tests.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryStore(initial = { version: 1, runs: [] }) {
  let state = clone(initial);
  return {
    read(fallback) {
      return state == null ? clone(fallback) : clone(state);
    },
    write(next) {
      state = clone(next);
    },
    snapshot() {
      return clone(state);
    },
  };
}

function completedRun(runId, file, durationMs) {
  return {
    runId,
    status: 'passed',
    files: [{ file, status: 'passed', durationMs, timedOut: false }],
  };
}

test('history mirrors the IDE start/finish/reconcile API and keeps newest records first', () => {
  const store = createMemoryStore();
  const history = createSafeRunnerHistory({
    store,
    maxRuns: 2,
    now: () => new Date('2026-09-04T12:00:00.000Z'),
  });

  history.recordStart({ runId: 'one', timestamp: '2026-09-04T10:00:00.000Z', startedAt: '2026-09-04T10:00:00.000Z' });
  history.recordFinish('one', { status: 'passed', elapsedMs: 20, durationMs: 20 });
  history.recordStart({ runId: 'two', timestamp: '2026-09-04T01:00:00.000Z', startedAt: '2026-09-04T01:00:00.000Z' });
  history.recordStart({ runId: 'three', timestamp: '2026-09-04T02:00:00.000Z', startedAt: '2026-09-04T02:00:00.000Z' });

  assert.deepEqual(history.getHistory().map((run) => run.runId), ['three', 'two']);
  assert.equal(history.reconcileRunning(), 2);
  assert.deepEqual(
    store.snapshot().runs.map((run) => ({ runId: run.runId, status: run.status, finishedAt: run.finishedAt })),
    [
      { runId: 'three', status: 'interrupted', finishedAt: '2026-09-04T12:00:00.000Z' },
      { runId: 'two', status: 'interrupted', finishedAt: '2026-09-04T12:00:00.000Z' },
    ]
  );
  assert.equal(DEFAULT_MAX_RUNS, 100);
});

test('reconciliation preserves recent live siblings and interrupts dead pids', () => {
  const store = createMemoryStore({
    version: 1,
    runs: [
      { runId: 'live', status: 'running', startedAt: '2026-09-04T11:59:00.000Z', pid: 10 },
      { runId: 'dead', status: 'running', startedAt: '2026-09-04T11:59:00.000Z', pid: 11 },
    ],
  });
  const history = createSafeRunnerHistory({
    store,
    now: () => new Date('2026-09-04T12:00:00.000Z'),
    pidIsAlive: (pid) => pid === 10,
  });

  assert.equal(history.reconcileRunning(), 1);
  assert.deepEqual(
    history.getHistory().map((run) => ({ runId: run.runId, status: run.status })),
    [
      { runId: 'live', status: 'running' },
      { runId: 'dead', status: 'interrupted' },
    ]
  );
});

test('default history cap trims the oldest record after 100 runs', () => {
  const history = createSafeRunnerHistory({ store: createMemoryStore() });
  for (let index = 0; index <= DEFAULT_MAX_RUNS; index += 1) {
    history.recordStart({ runId: String(index), startedAt: '2026-09-04T10:00:00.000Z' });
  }
  const runs = history.getHistory();
  assert.equal(runs.length, 100);
  assert.equal(runs[0].runId, '100');
  assert.equal(runs[99].runId, '1');
});

test('run records include statuses, counts, durations, and watchdog identities', () => {
  const record = buildRunRecord({
    runId: 'shape',
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
    finishedAt: new Date('2026-09-04T10:00:02.000Z'),
    elapsedMs: 2_000,
    exitCode: 1,
    results: [
      { file: 'tests/pass.test.js', code: 0, durationMs: 100, timedOut: false },
      { file: 'tests/fail.test.js', code: 1, durationMs: 200, timedOut: false },
      { file: 'tests/infra.test.js', code: -1, durationMs: 300, infrastructureFailure: true },
      { file: 'tests/hang.test.js', code: 124, durationMs: 400, timedOut: true, perFileTimeoutMs: 400 },
      { file: 'tests/abort.test.js', code: 1, durationMs: 50, collateralKilled: true },
    ],
    notRun: ['tests/not-run.test.js'],
  });

  assert.deepEqual(record, {
    runId: 'shape',
    status: 'timeout',
    exitCode: 1,
    timestamp: '2026-09-04T10:00:00.000Z',
    startedAt: '2026-09-04T10:00:00.000Z',
    finishedAt: '2026-09-04T10:00:02.000Z',
    elapsedMs: 2_000,
    durationMs: 2_000,
    files: [
      { file: 'tests/pass.test.js', status: 'passed', durationMs: 100, timedOut: false },
      { file: 'tests/fail.test.js', status: 'failed', durationMs: 200, timedOut: false },
      { file: 'tests/infra.test.js', status: 'infra', durationMs: 300, timedOut: false },
      { file: 'tests/hang.test.js', status: 'timeout', durationMs: 400, timedOut: true },
      { file: 'tests/abort.test.js', status: 'aborted', durationMs: 50, timedOut: false },
      { file: 'tests/not-run.test.js', status: 'notRun', durationMs: 0, timedOut: false },
    ],
    counts: { passed: 1, failed: 1, infra: 1, timeout: 1, aborted: 1, notRun: 1 },
    watchdogHits: [{ file: 'tests/hang.test.js', timeoutMs: 400 }],
  });
});

test('termination snapshot preserves global watchdog hangs after child settlement', () => {
  const record = buildRunRecord({
    runId: 'global-timeout',
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
    finishedAt: new Date('2026-09-04T10:10:00.000Z'),
    elapsedMs: 600_000,
    results: [{
      file: 'tests/settled-during-kill.test.js',
      code: 1,
      durationMs: 599_900,
      timedOut: false,
      collateralKilled: true,
    }],
    termination: {
      inFlight: ['tests/settled-during-kill.test.js'],
      reason: 'timed out after 600000ms (global run budget)',
      exitCode: 124,
      timeoutMs: 600_000,
    },
  });

  assert.equal(record.status, 'timeout');
  assert.equal(record.exitCode, 124);
  assert.deepEqual(record.files, [{
    file: 'tests/settled-during-kill.test.js',
    status: 'timeout',
    durationMs: 599_900,
    timedOut: true,
  }]);
  assert.deepEqual(record.counts, {
    passed: 0, failed: 0, infra: 0, timeout: 1, aborted: 0, notRun: 0,
  });
  assert.deepEqual(record.watchdogHits, [{
    file: 'tests/settled-during-kill.test.js',
    timeoutMs: 600_000,
  }]);
  assert.deepEqual(record.termination, {
    inFlight: ['tests/settled-during-kill.test.js'],
    reason: 'timed out after 600000ms (global run budget)',
    exitCode: 124,
    timeoutMs: 600_000,
  });
  assert.match(formatRunTrendBlock(record), /\[run-node-tests-safe\] hangs: 1$/);
});

test('starting a new real run reconciles an earlier start without finish', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-history-orphan-'));
  const historyPath = path.join(tempRoot, 'history.json');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  startRunHistory({
    historyPath,
    runId: 'orphan',
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
    pid: 99_999_999,
  });
  startRunHistory({
    historyPath,
    runId: 'next',
    startedAt: new Date('2026-09-04T11:00:00.000Z'),
  });

  const afterStart = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(afterStart.runs[0].runId, 'next');
  assert.equal(afterStart.runs[0].status, 'running');
  assert.equal(afterStart.runs[0].pid, process.pid);
  assert.equal(afterStart.runs[1].runId, 'orphan');
  assert.equal(afterStart.runs[1].status, 'interrupted');
  assert.equal(afterStart.runs[1].pid, 99_999_999);
  assert.match(afterStart.runs[1].finishedAt, /^\d{4}-\d{2}-\d{2}T/);

  const originalLog = console.log;
  console.log = () => {};
  try {
    finishRunHistory({
      historyPath,
      runId: 'next',
      startedAt: new Date('2026-09-04T11:00:00.000Z'),
      finishedAt: new Date('2026-09-04T11:00:01.000Z'),
      elapsedMs: 1_000,
      results: [{ file: 'tests/a.test.js', code: 0, durationMs: 900, timedOut: false }],
    });
  } finally {
    console.log = originalLog;
  }
  const finished = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(finished.runs[0].status, 'passed');
  assert.equal(finished.runs[1].status, 'interrupted');
});

test('trend thresholds match the IDE strip ratios and use prior per-file medians', () => {
  assert.equal(trendForDuration(111, 100), 'slower');
  assert.equal(trendForDuration(110, 100), 'flat');
  assert.equal(trendForDuration(89, 100), 'faster');
  assert.equal(trendForDuration(90, 100), 'flat');
  assert.equal(trendForDuration(100, null), 'flat');

  const run = completedRun('current', 'tests/a.test.js', 240);
  run.watchdogHits = [];
  const previous = [
    completedRun('prior-1', 'tests/a.test.js', 100),
    completedRun('prior-2', 'tests/a.test.js', 300),
  ];
  const block = formatRunTrendBlock(run, previous);
  assert.equal(
    block,
    [
      '[run-node-tests-safe] trends: slowest 5 files this run (vs median of prior 10 runs)',
      '[run-node-tests-safe]   tests/a.test.js (0.2s): slower (median 0.2s)',
      '[run-node-tests-safe] hangs: 0',
    ].join('\n')
  );
});

test('split run lifecycle writes JSON history and reports without raw output', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-history-'));
  const historyPath = path.join(tempRoot, 'history.json');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const logged = [];
  const originalLog = console.log;
  console.log = (value) => logged.push(String(value));
  t.after(() => {
    console.log = originalLog;
  });

  const started = startRunHistory({
    historyPath,
    runId: 'real-write',
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
  });
  const result = finishRunHistory({
    historyPath,
    runId: started.runId,
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
    finishedAt: new Date('2026-09-04T10:00:01.000Z'),
    elapsedMs: 1_000,
    results: [{
      file: 'tests/a.test.js',
      code: 0,
      durationMs: 900,
      timedOut: false,
      output: 'must not persist',
    }],
  });

  const saved = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(result.historyPath, historyPath);
  assert.equal(saved.version, 1);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].runId, 'real-write');
  assert.equal(saved.runs[0].status, 'passed');
  assert.equal(JSON.stringify(saved).includes('must not persist'), false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /trends: slowest 5 files this run/);
});

test('slow-test history aggregation reads only the requested newest runs', () => {
  const history = {
    runs: [
      completedRun('new', 'tests/a.test.js', 300),
      completedRun('middle', 'tests/a.test.js', 100),
      completedRun('old', 'tests/a.test.js', 900),
    ],
  };
  assert.deepEqual(recordsFromHistory(history, 2), [{
    file: 'tests/a.test.js',
    durationSec: 0.2,
    sampleCount: 2,
  }]);
});

test('report-slow-tests defaults to history when the bounded file exists', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-slow-history-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const historyPath = path.join(tempRoot, HISTORY_PATH);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({
    version: 1,
    runs: [completedRun('new', 'tests/a.test.js', 300)],
  }));

  const result = spawnSync(process.execPath, [REPORT_SCRIPT, '--top=1'], {
    cwd: tempRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^0\.300s median \(1 run\) tests\/a\.test\.js\s{2}\[parallel\]\r?\n$/);
});

test('managed runner prints trends immediately before its final summary block', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-history-order-'));
  const testsDir = path.join(tempRoot, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'pass.test.js'),
    "const test = require('node:test');\ntest('pass', () => {});\n"
  );
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [SAFE_RUNNER_SCRIPT, '--no-lock', 'tests/pass.test.js', '--timeout-ms=50000'],
    { cwd: tempRoot, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const trendIndex = result.stdout.indexOf('[run-node-tests-safe] trends:');
  const summaryIndex = result.stdout.indexOf('[run-node-tests-safe] summary:');
  assert.notEqual(trendIndex, -1);
  assert.equal(trendIndex < summaryIndex, true);
  assert.match(
    result.stdout,
    /\[run-node-tests-safe\] hangs: 0\r?\n\[run-node-tests-safe\] summary: 1 passed,[^\n]*\r?\n$/
  );
});
