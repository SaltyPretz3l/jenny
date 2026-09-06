'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const safeRunner = require('../scripts/run-node-tests-safe');
const support = require('../scripts/run-node-tests-safe-support');

function makeTempSuite(t, files) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-runner-it-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const paths = [];
  for (const [name, body] of Object.entries(files)) {
    const filePath = path.join(tempRoot, name);
    fs.writeFileSync(filePath, body);
    paths.push(filePath);
  }
  return { tempRoot, paths };
}

function runRunner(args, options = {}) {
  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs || 60_000,
    env: { ...process.env, ...(options.env || {}) },
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

test('safe runner uses a 60 second default watchdog', () => {
  assert.equal(safeRunner.DEFAULT_TIMEOUT_MS, 60_000);
});

test('safe runner uses a 120 second default per-file watchdog', () => {
  assert.equal(safeRunner.DEFAULT_PER_FILE_TIMEOUT_MS, 120_000);
});

test('per-file timeout honors overrides and explicit flag', () => {
  const overrides = safeRunner.loadTimeoutOverrides(ROOT);

  assert.equal(
    safeRunner.resolvePerFileTimeoutMs(
      'tests/managed-sidecar/managed-sidecar-startup.test.js',
      { overrides, cwd: ROOT }
    ),
    180_000
  );
  assert.equal(
    safeRunner.resolvePerFileTimeoutMs('tests/repo-hygiene.test.js', { overrides, cwd: ROOT }),
    120_000
  );
  assert.equal(
    safeRunner.resolvePerFileTimeoutMs(
      'tests/managed-sidecar/managed-sidecar-startup.test.js',
      { overrides, cwd: ROOT, explicitMs: 5_000 }
    ),
    5_000
  );
});

test('safe runner parses reporting and lock control flags', () => {
  const defaults = safeRunner.parseArgs(['tests/repo-hygiene.test.js'], { cwd: ROOT });
  assert.equal(defaults.verbose, false);
  assert.equal(defaults.noLock, false);
  assert.equal(defaults.lockWaitMs, safeRunner.DEFAULT_LOCK_WAIT_MS);
  assert.equal(defaults.perFileTimeoutMs, null);

  const parsed = safeRunner.parseArgs(
    ['--verbose', '--no-lock', '--lock-wait-ms=1000', '--per-file-timeout-ms=2500', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );
  assert.equal(parsed.verbose, true);
  assert.equal(parsed.noLock, true);
  assert.equal(parsed.lockWaitMs, 1_000);
  assert.equal(parsed.perFileTimeoutMs, 2_500);
});

test('run summary names failed, timed out, and not-run files', () => {
  const summary = safeRunner.formatRunSummary({
    results: [
      { file: 'tests/a.test.js', code: 0, timedOut: false, durationMs: 1000, perFileTimeoutMs: 120_000 },
      { file: 'tests/b.test.js', code: 1, timedOut: false, durationMs: 1000, perFileTimeoutMs: 120_000 },
      { file: 'tests/c.test.js', code: 124, timedOut: true, durationMs: 120_000, perFileTimeoutMs: 120_000 },
    ],
    notRun: ['tests/d.test.js'],
    inFlight: ['tests/e.test.js'],
    elapsedMs: 5000,
  });

  assert.match(summary, /summary: 1 passed, 1 failed, 0 infrastructure failed, 1 timed out, 0 aborted, 1 not run \(3 of 5 file\(s\) completed/);
  assert.match(summary, /FAILED: tests\/b\.test\.js \(exit 1\)/);
  assert.match(summary, /TIMED OUT: tests\/c\.test\.js \(after 120000ms\)/);
  assert.match(summary, /IN-FLIGHT AT SHUTDOWN: tests\/e\.test\.js/);
  assert.match(summary, /NOT RUN: 1 file\(s\): tests\/d\.test\.js/);
});

test('run summary ranks the slowest files and omits the line when none reach the floor', () => {
  const record = (file, durationMs, extra = {}) => ({
    file, code: 0, timedOut: false, durationMs, perFileTimeoutMs: 120_000, ...extra,
  });
  const summary = safeRunner.formatRunSummary({
    results: [
      record('tests/fast.test.js', 2_000),
      record('tests/mid.test.js', 15_000),
      record('tests/whale.test.js', 39_000),
      // Timed-out duration is the kill threshold, not a measurement — excluded.
      record('tests/hung.test.js', 120_000, { code: 124, timedOut: true }),
    ],
    notRun: [],
    inFlight: [],
    elapsedMs: 60_000,
  });
  // Ranked descending, floor-filtered, timed-out excluded.
  assert.match(summary, /slowest files \(>=10s\): tests\/whale\.test\.js \(39\.0s\), tests\/mid\.test\.js \(15\.0s\)/);
  assert.doesNotMatch(summary, /slowest files.*fast\.test\.js/);
  assert.doesNotMatch(summary, /slowest files.*hung\.test\.js/);

  const quietSummary = safeRunner.formatRunSummary({
    results: [record('tests/fast.test.js', 2_000)],
    notRun: [],
    inFlight: [],
    elapsedMs: 3_000,
  });
  assert.doesNotMatch(quietSummary, /slowest files/,
    'small targeted runs must not carry a slowest-files line');
});

test('run summary buckets fail-fast/shutdown collateral kills as aborted, not failed', () => {
  const summary = safeRunner.formatRunSummary({
    results: [
      { file: 'tests/a.test.js', code: 1, timedOut: false, durationMs: 1000, perFileTimeoutMs: 120_000 },
      {
        file: 'tests/b.test.js',
        code: 1,
        timedOut: false,
        collateralKilled: true,
        durationMs: 800,
        perFileTimeoutMs: 120_000,
      },
    ],
    notRun: [],
    inFlight: [],
    elapsedMs: 3000,
  });

  // The genuine failure counts as failed; the collateral kill counts as aborted.
  assert.match(summary, /summary: 0 passed, 1 failed, 0 infrastructure failed, 0 timed out, 1 aborted, 0 not run/);
  assert.match(summary, /FAILED: tests\/a\.test\.js \(exit 1\)/);
  assert.doesNotMatch(summary, /FAILED: tests\/b\.test\.js/);
  assert.match(summary, /ABORTED \(fail-fast\/shutdown collateral\): 1 file\(s\): tests\/b\.test\.js/);
});

test('run lock serializes, reports the holder, and steals stale locks', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-runner-lock-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const logged = [];
  const log = (message) => logged.push(message);

  const lock = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log });
  assert.ok(lock, 'first acquire must succeed');
  assert.equal(fs.existsSync(lock.lockPath), true);

  const blocked = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log });
  assert.equal(blocked, null, 'second acquire must give up when the holder is alive');

  lock.release();
  assert.equal(fs.existsSync(lock.lockPath), false, 'release must remove the lock file');

  fs.writeFileSync(
    path.join(tempRoot, safeRunner.LOCK_BASENAME),
    JSON.stringify({ pid: 99_999_999, startedAt: new Date().toISOString() })
  );
  const stolen = await safeRunner.acquireRunLock({ cwd: tempRoot, waitMs: 0, log });
  assert.ok(stolen, 'dead-pid lock must be stolen');
  assert.ok(
    logged.some((line) => line.includes('removing stale test-run lock')),
    'stale steal must be logged'
  );
  stolen.release();
});

test('safe runner keeps scheduling files after a failure and summarizes both', (t) => {
  const { paths } = makeTempSuite(t, {
    'failing-a.test.js': "const test = require('node:test');\ntest('boom', () => { throw new Error('boom'); });\n",
    'passing-b.test.js': "const test = require('node:test');\ntest('ok', () => {});\n",
  });

  const { status, stdout, stderr } = runRunner([...paths, '--timeout-ms=50000']);

  assert.equal(status, 1);
  assert.match(stderr, /FAIL .*failing-a\.test\.js \(exit 1/);
  assert.match(stdout, /----- output: .*failing-a\.test\.js/);
  assert.match(stdout, /ok .*passing-b\.test\.js/, 'later file must still run after the failure');
  assert.match(stdout, /summary: 1 passed, 1 failed, 0 infrastructure failed, 0 timed out, 0 aborted, 0 not run \(2 of 2 file\(s\) completed/);
  assert.match(stdout, /FAILED: .*failing-a\.test\.js \(exit 1\)/);
});

test('safe runner kills and names a hung test file via the per-file watchdog', (t) => {
  const { paths } = makeTempSuite(t, {
    'hanging.test.js': "const test = require('node:test');\ntest('hang', () => new Promise(() => {}));\n",
  });

  const { status, stdout, stderr } = runRunner(
    [...paths, '--per-file-timeout-ms=2000', '--timeout-ms=30000'],
    { timeoutMs: 45_000 }
  );

  assert.equal(status, 1);
  assert.match(
    stderr,
    /TIMEOUT .*hanging\.test\.js after 2000ms \(likely hung\); (?:process tree killed|process tree termination NOT confirmed; remaining files aborted)/
  );
  assert.match(stdout, /summary: 0 passed, 0 failed, 0 infrastructure failed, 1 timed out, 0 aborted, 0 not run/);
  assert.match(stdout, /TIMED OUT: .*hanging\.test\.js \(after 2000ms\)/);
});

test('safe runner directory expansion skips generated and cache directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jenny-safe-runner-'));
  try {
    const keepDir = path.join(tempRoot, 'unit');
    const distDir = path.join(tempRoot, 'dist');
    const cacheDir = path.join(tempRoot, '.pytest_cache');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'kept.test.js'), "test('ok', () => {});\n");
    fs.writeFileSync(path.join(distDir, 'generated.test.js'), "test('skip', () => {});\n");
    fs.writeFileSync(path.join(cacheDir, 'cached.test.js'), "test('skip', () => {});\n");

    const matches = safeRunner.expandDirectoryArg(tempRoot)
      .map((filePath) => path.relative(tempRoot, filePath).replace(/\\/g, '/'))
      .sort();

    assert.deepEqual(matches, ['unit/kept.test.js']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('expandDirectoryArg drops *.load.test.js by default and reports them; includeLoad opts in', (t) => {
  const { tempRoot } = makeTempSuite(t, {
    'unit.test.js': "test('ok', () => {});\n",
    'perf.load.test.js': "test('perf', () => {});\n",
  });

  const excluded = [];
  const defaultMatches = safeRunner.expandDirectoryArg(tempRoot, { excluded })
    .map((filePath) => path.basename(filePath))
    .sort();
  assert.deepEqual(defaultMatches, ['unit.test.js']);
  assert.deepEqual(excluded.map((filePath) => path.basename(filePath)), ['perf.load.test.js']);

  const withLoad = safeRunner.expandDirectoryArg(tempRoot, { includeLoad: true })
    .map((filePath) => path.basename(filePath))
    .sort();
  assert.deepEqual(withLoad, ['perf.load.test.js', 'unit.test.js']);
});

test('an explicit *.load.test.js file argument is never filtered out', (t) => {
  const { paths } = makeTempSuite(t, {
    'perf.load.test.js': "test('perf', () => {});\n",
  });
  assert.deepEqual(safeRunner.expandDirectoryArg(paths[0]), [paths[0]]);
});

test('parseArgs excludes load tests from directory discovery; --include-load opts in', (t) => {
  const { tempRoot } = makeTempSuite(t, {
    'unit.test.js': "test('ok', () => {});\n",
    'perf.load.test.js': "test('perf', () => {});\n",
  });

  const excludedRun = safeRunner.parseArgs([tempRoot], { cwd: ROOT });
  assert.deepEqual(excludedRun.childArgs.map((p) => path.basename(p)).sort(), ['unit.test.js']);
  assert.equal(excludedRun.includeLoad, false);
  assert.deepEqual(excludedRun.excludedLoadFiles.map((p) => path.basename(p)), ['perf.load.test.js']);

  const includedRun = safeRunner.parseArgs(['--include-load', tempRoot], { cwd: ROOT });
  assert.deepEqual(includedRun.childArgs.map((p) => path.basename(p)).sort(), ['perf.load.test.js', 'unit.test.js']);
  assert.equal(includedRun.includeLoad, true);
  assert.deepEqual(includedRun.excludedLoadFiles, []);
});

test('selectRunGroups routes an included *.load.test.js through the isolated sequential lane', () => {
  assert.equal(safeRunner.isSequentialTestPath('tests/renderer-stream-handler.load.test.js'), true);
  const groups = safeRunner.selectRunGroups({
    childArgs: ['tests/repo-hygiene.test.js', 'tests/renderer-stream-handler.load.test.js'],
  });
  assert.deepEqual(groups.parallelArgs, ['tests/repo-hygiene.test.js']);
  assert.deepEqual(groups.sequentialArgs, ['tests/renderer-stream-handler.load.test.js']);
});

test('safe runner applies the largest configured per-file timeout', () => {
  const parsed = safeRunner.parseArgs(
    ['tests/managed-sidecar/managed-sidecar-startup.test.js', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );

  assert.equal(parsed.timeoutMs, 180_000);
});

test('safe runner explicit timeout overrides timeout file', () => {
  const parsed = safeRunner.parseArgs(
    ['--timeout-ms=10000', 'tests/managed-sidecar/managed-sidecar-startup.test.js'],
    { cwd: ROOT }
  );

  assert.equal(parsed.timeoutMs, 10_000);
});

test('safe runner parses parallel controls with conservative defaults', () => {
  const parsed = safeRunner.parseArgs(['tests/repo-hygiene.test.js'], { cwd: ROOT });

  assert.equal(parsed.sequentialOnly, false);
  // Default raised 4 -> 12 on 2026-07-05; JENNY_TEST_WORKERS (read at module
  // load) overrides it, so this assertion holds only without that env var.
  assert.equal(parsed.parallelWorkers, safeRunner.DEFAULT_PARALLEL_WORKERS);
  if (!process.env.JENNY_TEST_WORKERS) {
    assert.equal(parsed.parallelWorkers, 12);
  }
  assert.equal(parsed.failFast, false);

  const forcedSequential = safeRunner.parseArgs(
    ['--sequential-only', '--parallel-workers=8', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );

  assert.equal(forcedSequential.sequentialOnly, true);
  assert.equal(forcedSequential.parallelOnly, false);
  assert.equal(forcedSequential.parallelWorkers, 8);

  const clamped = safeRunner.parseArgs(
    ['--parallel-workers=64', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );
  assert.equal(clamped.parallelWorkers, 16);

  const forcedParallel = safeRunner.parseArgs(
    ['--parallel-only', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );

  assert.equal(forcedParallel.parallelOnly, true);
  assert.equal(forcedParallel.sequentialOnly, false);
});

test('safe runner --fail-fast flag toggles opt-in abort behavior', () => {
  const defaultParsed = safeRunner.parseArgs(['tests/repo-hygiene.test.js'], { cwd: ROOT });
  assert.equal(defaultParsed.failFast, false);

  const optedIn = safeRunner.parseArgs(
    ['--fail-fast', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );
  assert.equal(optedIn.failFast, true);
});

test('safe runner partitions sequential-risk suites from parallel-safe suites', () => {
  const groups = safeRunner.partitionChildArgs([
    'tests/managed-sidecar/managed-sidecar-chat-lifecycle.test.js',
    'tests/backend-service-lifecycle.test.js',
    'tests/packaging-launch-probe.test.js',
    'tests/main-lifecycle.test.js',
    'tests/electron-shell-smoke.test.js',
    'tests/plugins/lifecycle/real-store-e2e.test.js',
    // 2026-07-20 lane narrowing: light renderer-*shell* VM-harness suites are
    // parallel-safe locally (self-contained, own child process) and no longer
    // ride the sequential lane. The heavy/contention-sensitive tail (e.g.
    // renderer-shell-settings) plus renderer-workspace-shell stay pinned.
    'tests/renderer-shell-service-registry.test.js',
    'tests/renderer-shell-settings.test.js',
    'tests/renderer-workspace-shell.test.js',
    'tests/renderer-incremental-dom.test.js',
    'tests/workspace-ipc.test.js',
    'tests/repo-hygiene.test.js',
    'tests/renderer-pretext-utils.test.js',
  ]);

  assert.deepEqual(groups.parallelArgs, [
    'tests/renderer-shell-service-registry.test.js',
    'tests/repo-hygiene.test.js',
    'tests/renderer-pretext-utils.test.js',
  ]);
  assert.deepEqual(groups.sequentialArgs, [
    'tests/managed-sidecar/managed-sidecar-chat-lifecycle.test.js',
    'tests/backend-service-lifecycle.test.js',
    'tests/packaging-launch-probe.test.js',
    'tests/main-lifecycle.test.js',
    'tests/electron-shell-smoke.test.js',
    'tests/plugins/lifecycle/real-store-e2e.test.js',
    'tests/renderer-shell-settings.test.js',
    'tests/renderer-workspace-shell.test.js',
    'tests/renderer-incremental-dom.test.js',
    'tests/workspace-ipc.test.js',
  ]);
});

// The hosted stable-lane exclusion and lane-overlap coverage live in
// tests/run-node-tests-safe-lanes.test.js (sibling file, test_files_over_600).

// ---------------------------------------------------------------------------
// P1-2: quarantine/retry + JUnit + --last-failed/--changed + --shard
// ---------------------------------------------------------------------------

test('loadQuarantineOverrides reads valid entries and ignores malformed ones', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-quarantine-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, 'tests', '.quarantine.json'),
    JSON.stringify({
      'tests/ok.test.js': { retries: 2, reason: 'r', ticket: 'T', expires_on: '2099-01-01' },
      'tests/bad.test.js': { retries: 0 }, // retries < 1 -> dropped
      'tests/nope.test.js': 'not-an-object', // dropped
    })
  );

  const map = support.loadQuarantineOverrides(tempRoot);
  assert.deepEqual(Object.keys(map).sort(), ['tests/ok.test.js']);
  assert.equal(map['tests/ok.test.js'].retries, 2);
  // retries are clamped to the defensive ceiling.
  fs.writeFileSync(
    path.join(tempRoot, 'tests', '.quarantine.json'),
    JSON.stringify({ 'tests/ok.test.js': { retries: 99, reason: 'r' } })
  );
  assert.equal(support.loadQuarantineOverrides(tempRoot)['tests/ok.test.js'].retries, support.MAX_QUARANTINE_RETRIES);
  // a missing file is an empty map (no quarantine).
  assert.deepEqual(support.loadQuarantineOverrides(path.join(tempRoot, 'absent')), {});
});

test('applyChildArgFilters narrows to the last-failed / changed intersection', () => {
  const args = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'];

  const none = support.applyChildArgFilters(args, {});
  assert.equal(none.filtered, false);
  assert.deepEqual(none.childArgs, args);

  const lastFailed = support.applyChildArgFilters(args, {
    lastFailed: true,
    lastFailedSet: new Set(['tests/b.test.js']),
  });
  assert.equal(lastFailed.filtered, true);
  assert.deepEqual(lastFailed.childArgs, ['tests/b.test.js']);

  const changed = support.applyChildArgFilters(args, {
    changed: true,
    changedSet: new Set(['tests/a.test.js', 'tests/c.test.js']),
  });
  assert.deepEqual(changed.childArgs, ['tests/a.test.js', 'tests/c.test.js']);

  const both = support.applyChildArgFilters(args, {
    lastFailed: true,
    lastFailedSet: new Set(['tests/a.test.js', 'tests/b.test.js']),
    changed: true,
    changedSet: new Set(['tests/b.test.js', 'tests/c.test.js']),
  });
  assert.deepEqual(both.childArgs, ['tests/b.test.js'], 'both flags = intersection');

  const emptyRecord = support.applyChildArgFilters(args, { lastFailed: true, lastFailedSet: new Set() });
  assert.equal(emptyRecord.filtered, false, 'no recorded failures -> run everything, do not error');
  assert.match(emptyRecord.note, /no recorded failures/);
});

test('collectRerunTargets records failures, timeouts, and not-run files (deduped)', () => {
  const targets = support.collectRerunTargets({
    results: [
      { file: 'tests/pass.test.js', code: 0, timedOut: false },
      { file: 'tests/fail.test.js', code: 1, timedOut: false },
      { file: 'tests/timeout.test.js', code: 124, timedOut: true },
    ],
    notRun: ['tests/skipped.test.js', 'tests/fail.test.js'],
  });
  assert.deepEqual(targets.sort(), ['tests/fail.test.js', 'tests/skipped.test.js', 'tests/timeout.test.js']);
});

test('parseShardSpec validates K/N and selectRunGroups shards the parallel lane', () => {
  assert.deepEqual(support.parseShardSpec('2/3'), { index: 2, count: 3 });
  assert.equal(support.parseShardSpec('0/3'), null);
  assert.equal(support.parseShardSpec('4/3'), null);
  assert.equal(support.parseShardSpec('x'), null);

  const childArgs = [
    'tests/p1.test.js',
    'tests/p2.test.js',
    'tests/p3.test.js',
    'tests/p4.test.js',
    'tests/managed-sidecar-x.test.js',
  ];
  const shard1 = safeRunner.selectRunGroups({ childArgs, shard: { index: 1, count: 2 } });
  const shard2 = safeRunner.selectRunGroups({ childArgs, shard: { index: 2, count: 2 } });
  assert.deepEqual(shard1.parallelArgs, ['tests/p1.test.js', 'tests/p3.test.js']);
  assert.deepEqual(shard2.parallelArgs, ['tests/p2.test.js', 'tests/p4.test.js']);
  // Heavy sequential suites run only on shard 1, never N times.
  assert.deepEqual(shard1.sequentialArgs, ['tests/managed-sidecar-x.test.js']);
  assert.deepEqual(shard2.sequentialArgs, []);
  // Union of shards == all parallel files (no overlap, no drop).
  assert.deepEqual(
    [...shard1.parallelArgs, ...shard2.parallelArgs].sort(),
    ['tests/p1.test.js', 'tests/p2.test.js', 'tests/p3.test.js', 'tests/p4.test.js']
  );
});

test('parseArgs surfaces --junit, --shard, --last-failed, and --changed', () => {
  const parsed = safeRunner.parseArgs(
    ['--junit=/tmp/j.xml', '--shard=2/4', 'tests/repo-hygiene.test.js'],
    { cwd: ROOT }
  );
  assert.equal(parsed.junitPath, '/tmp/j.xml');
  assert.deepEqual(parsed.shard, { index: 2, count: 4 });
  assert.equal(parsed.lastFailed, false);
  assert.equal(parsed.changed, false);
  assert.ok(parsed.quarantineOverrides && typeof parsed.quarantineOverrides === 'object');

  const filtered = safeRunner.parseArgs(['--last-failed', '--changed', 'tests/repo-hygiene.test.js'], {
    cwd: ROOT,
    lastFailedSet: new Set(['tests/repo-hygiene.test.js']),
    changedSet: new Set(['tests/repo-hygiene.test.js']),
  });
  assert.equal(filtered.lastFailed, true);
  assert.equal(filtered.changed, true);
  assert.equal(filtered.filterApplied, true);
  assert.deepEqual(filtered.childArgs, ['tests/repo-hygiene.test.js']);
});

test('buildJunitXml emits pass / failure / error / skipped cases with escaped output', () => {
  const xml = support.buildJunitXml({
    results: [
      { file: 'tests/p.test.js', code: 0, timedOut: false, durationMs: 1200, perFileTimeoutMs: 120_000, output: null },
      { file: 'tests/f.test.js', code: 1, timedOut: false, durationMs: 800, perFileTimeoutMs: 120_000, output: 'boom & <fail>' },
      { file: 'tests/t.test.js', code: 124, timedOut: true, durationMs: 120_000, perFileTimeoutMs: 120_000, output: 'hang' },
      { file: 'tests/a.test.js', code: 1, timedOut: false, collateralKilled: true, durationMs: 50, perFileTimeoutMs: 120_000, output: 'x' },
    ],
    notRun: ['tests/n.test.js'],
    elapsedMs: 5000,
  });

  assert.match(xml, /<testsuites name="run-node-tests-safe" tests="5" failures="1" errors="1" skipped="2"/);
  assert.match(xml, /<testcase name="tests\/p\.test\.js"[^>]*><\/testcase>/);
  assert.match(xml, /<failure message="exit 1">boom &amp; &lt;fail&gt;<\/failure>/);
  assert.match(xml, /<error message="timed out after 120000ms">hang<\/error>/);
  assert.match(xml, /tests\/a\.test\.js"[^>]*><skipped message="aborted/);
  assert.match(xml, /tests\/n\.test\.js"[^>]*><skipped message="not run"/);
});

test('a quarantined flaky file recovers on retry and the run stays green', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-retry-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });
  const marker = path.join(tempRoot, 'flake.marker');
  const testRel = 'tests/flaky.test.js';
  // Fails on the first attempt (no marker yet), passes on the retry.
  fs.writeFileSync(
    path.join(tempRoot, testRel),
    "const fs = require('fs');\n" +
      "const test = require('node:test');\n" +
      `test('flaky', () => {\n` +
      `  const m = ${JSON.stringify(marker)};\n` +
      '  if (!fs.existsSync(m)) { fs.writeFileSync(m, "1"); throw new Error("first-run flake"); }\n' +
      '});\n'
  );
  fs.writeFileSync(
    path.join(tempRoot, 'tests', '.quarantine.json'),
    JSON.stringify({ [testRel]: { retries: 1, reason: 'known flake', ticket: 'JENNY-1', expires_on: '2099-01-01' } })
  );

  const { status, stdout, stderr } = runRunner([testRel, '--timeout-ms=50000'], { cwd: tempRoot });
  assert.equal(status, 0, `expected green run; stderr=${stderr}`);
  assert.match(stderr, /RETRY .*flaky\.test\.js \(quarantined flake, attempt 1\/2/);
  assert.match(stdout, /RECOVERED .*flaky\.test\.js after 2 attempt\(s\)/);
  assert.match(stdout, /summary: 1 passed, 0 failed/);
  assert.match(stdout, /RECOVERED \(quarantined flakes passed on retry\): 1 file\(s\)/);
});

test('--junit writes a JUnit report alongside a real failing run', (t) => {
  const { paths } = makeTempSuite(t, {
    'pass.test.js': "const test = require('node:test');\ntest('ok', () => {});\n",
    'fail.test.js': "const test = require('node:test');\ntest('boom', () => { throw new Error('x'); });\n",
  });
  const junitPath = path.join(path.dirname(paths[0]), 'junit.xml');

  const { status } = runRunner([...paths, `--junit=${junitPath}`, '--timeout-ms=50000']);
  assert.equal(status, 1);
  const xml = fs.readFileSync(junitPath, 'utf8');
  assert.match(xml, /<testsuites name="run-node-tests-safe" tests="2" failures="1" errors="0"/);
  assert.match(xml, /<testcase name="[^"]*fail\.test\.js"[^>]*><failure message="exit 1">/);
  assert.match(xml, /<testcase name="[^"]*pass\.test\.js"[^>]*><\/testcase>/);
});
