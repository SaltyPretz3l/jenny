'use strict';

// Lane-selection and lane-overlap coverage for scripts/run-node-tests-safe.js
// (2026-07-20): the hosted stable-lane exclusion, and the sequential lane
// running concurrently with the parallel pool on one reserved worker slot.
// Core runner coverage lives in tests/run-node-tests-safe.test.js; this is a
// sibling file so neither crosses the test_files_over_600 ratchet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const safeRunner = require('../scripts/run-node-tests-safe');

test('Electron startup exits are classified separately from assertion failures', () => {
  assert.equal(
    safeRunner.isInfrastructureFailure(
      'tests/electron-shell-smoke.test.js',
      { code: 0xFFFFFFFF, output: '', timedOut: false, collateralKilled: false },
      'win32'
    ),
    true
  );
  assert.equal(
    safeRunner.isInfrastructureFailure(
      'tests/electron-shell-smoke.test.js',
      { code: 1, output: 'Crashpad not connected', timedOut: false, collateralKilled: false },
      'win32'
    ),
    true
  );
  assert.equal(safeRunner.hasTapTestEvents('TAP version 13\n# Subtest: real assertion'), true);
});

test('summary reports infrastructure failures outside assertion failure count', () => {
  const summary = safeRunner.formatRunSummary({
    results: [{
      file: 'tests/electron.test.js',
      code: -1,
      timedOut: false,
      collateralKilled: false,
      infrastructureFailure: true,
      durationMs: 5,
    }],
    elapsedMs: 5,
  });
  assert.match(summary, /0 failed, 1 infrastructure failed/);
  assert.match(summary, /INFRASTRUCTURE_FAILURE:/);
});

test('parallel infrastructure failure retries once serially and retains first stderr', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-infra-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'attempted');
  const fixture = path.join(dir, 'electron-infra.test.js');
  fs.writeFileSync(
    fixture,
    [
      "const fs = require('fs');",
      "const test = require('node:test');",
      `const sentinel = ${JSON.stringify(sentinel)};`,
      "if (!fs.existsSync(sentinel)) {",
      "  fs.writeFileSync(sentinel, '1');",
      "  console.error('Crashpad not connected: first attempt');",
      "  process.exit(-1);",
      "}",
      "test('serial retry passes', () => {});",
      '',
    ].join('\n')
  );

  const result = runRunner(['--parallel-workers=2', fixture]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /INFRASTRUCTURE_FAILURE/);
  assert.match(result.stderr, /RETRY .*one worker/);
  assert.match(result.stdout, /Crashpad not connected: first attempt/);
  assert.match(result.stdout, /summary: 1 passed, 0 failed, 0 infrastructure failed/);
});

test('sequential Electron infrastructure failure receives the same one-time retry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-infra-sequential-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'attempted');
  const fixture = path.join(dir, 'direct-electron.test.js');
  fs.writeFileSync(
    fixture,
    [
      "if (false) require('electron');",
      "const fs = require('fs');",
      "const test = require('node:test');",
      `const sentinel = ${JSON.stringify(sentinel)};`,
      "if (!fs.existsSync(sentinel)) {",
      "  fs.writeFileSync(sentinel, '1');",
      "  console.error('Crashpad not connected: sequential first attempt');",
      "  process.exit(-1);",
      "}",
      "test('sequential retry passes', () => {});",
      '',
    ].join('\n')
  );

  const result = runRunner(['--parallel-workers=2', fixture]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /INFRASTRUCTURE_FAILURE/);
  assert.match(result.stderr, /RETRY .*one worker/);
  assert.match(result.stdout, /sequential first attempt/);
});

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

test('--parallel-only still drops renderer-*shell* suites (hosted stable-lane exclusion)', () => {
  // The CI stable lane (js-stable-gate / coverage-gate on hosted runners) must
  // stay byte-identical to before the lane narrowing: shell harnesses run in
  // the LOCAL parallel lane but are excluded from --parallel-only.
  assert.equal(safeRunner.isStableLaneExcludedPath('tests/renderer-shell-service-registry.test.js'), true);
  assert.equal(safeRunner.isStableLaneExcludedPath('tests/repo-hygiene.test.js'), false);

  const childArgs = [
    'tests/renderer-shell-service-registry.test.js',
    'tests/renderer-artifacts-shell.test.js',
    'tests/repo-hygiene.test.js',
  ];
  const parallelOnly = safeRunner.selectRunGroups({ parallelOnly: true, childArgs });
  assert.deepEqual(parallelOnly.parallelArgs, ['tests/repo-hygiene.test.js']);
  assert.deepEqual(parallelOnly.sequentialArgs, []);

  // Plain (local) mode keeps the light shell suites, in the parallel lane.
  const both = safeRunner.selectRunGroups({ childArgs });
  assert.deepEqual(both.parallelArgs, childArgs);
  assert.deepEqual(both.sequentialArgs, []);
});

test('selectRunGroups honors --parallel-only and --sequential-only', () => {
  const childArgs = [
    'tests/managed-sidecar/managed-sidecar-chat-lifecycle.test.js',
    'tests/main-lifecycle.test.js',
    'tests/repo-hygiene.test.js',
    'tests/renderer-pretext-utils.test.js',
  ];

  // --parallel-only: only the parallel-safe partition runs; the Electron/managed
  // sequential-risk suites are dropped entirely (they live in the heavy gate).
  const parallelOnly = safeRunner.selectRunGroups({ parallelOnly: true, childArgs });
  assert.deepEqual(parallelOnly.parallelArgs, [
    'tests/repo-hygiene.test.js',
    'tests/renderer-pretext-utils.test.js',
  ]);
  assert.deepEqual(parallelOnly.sequentialArgs, []);

  // --sequential-only forces every file through the one-at-a-time lane.
  const sequentialOnly = safeRunner.selectRunGroups({ sequentialOnly: true, childArgs });
  assert.deepEqual(sequentialOnly.parallelArgs, []);
  assert.deepEqual(sequentialOnly.sequentialArgs, childArgs);

  // Plain mode partitions into both lanes.
  const both = safeRunner.selectRunGroups({ childArgs });
  assert.deepEqual(both.parallelArgs, [
    'tests/repo-hygiene.test.js',
    'tests/renderer-pretext-utils.test.js',
  ]);
  assert.deepEqual(both.sequentialArgs, [
    'tests/managed-sidecar/managed-sidecar-chat-lifecycle.test.js',
    'tests/main-lifecycle.test.js',
  ]);
});

test('parseArgs surfaces lane-overlap controls (--no-lane-overlap, JENNY_TEST_LANE_OVERLAP=0)', () => {
  const savedEnv = process.env.JENNY_TEST_LANE_OVERLAP;
  delete process.env.JENNY_TEST_LANE_OVERLAP;
  try {
    const on = safeRunner.parseArgs(['tests/repo-hygiene.test.js'], { cwd: ROOT });
    assert.equal(on.laneOverlap, true);

    const off = safeRunner.parseArgs(['--no-lane-overlap', 'tests/repo-hygiene.test.js'], { cwd: ROOT });
    assert.equal(off.laneOverlap, false);

    process.env.JENNY_TEST_LANE_OVERLAP = '0';
    const envOff = safeRunner.parseArgs(['tests/repo-hygiene.test.js'], { cwd: ROOT });
    assert.equal(envOff.laneOverlap, false);
  } finally {
    if (savedEnv === undefined) delete process.env.JENNY_TEST_LANE_OVERLAP;
    else process.env.JENNY_TEST_LANE_OVERLAP = savedEnv;
  }
});

test('laneOverlapEnabled requires 2+ workers, both lanes non-empty, and no load files', () => {
  const groups = { parallelArgs: ['tests/a.test.js'], sequentialArgs: ['tests/packaging-b.test.js'] };
  assert.equal(safeRunner.laneOverlapEnabled({ laneOverlap: true, parallelWorkers: 12 }, groups), true);
  assert.equal(safeRunner.laneOverlapEnabled({ laneOverlap: false, parallelWorkers: 12 }, groups), false);
  assert.equal(safeRunner.laneOverlapEnabled({ laneOverlap: true, parallelWorkers: 1 }, groups), false);
  assert.equal(
    safeRunner.laneOverlapEnabled(
      { laneOverlap: true, parallelWorkers: 12 },
      { parallelArgs: [], sequentialArgs: groups.sequentialArgs }
    ),
    false
  );
  assert.equal(
    safeRunner.laneOverlapEnabled(
      { laneOverlap: true, parallelWorkers: 12 },
      { parallelArgs: groups.parallelArgs, sequentialArgs: [] }
    ),
    false
  );
  // *.load.test.js wall-clock oracles keep the strict post-parallel quiet machine.
  assert.equal(
    safeRunner.laneOverlapEnabled(
      { laneOverlap: true, parallelWorkers: 12 },
      { parallelArgs: groups.parallelArgs, sequentialArgs: ['tests/perf.load.test.js'] }
    ),
    false
  );
});

test('lanes overlap: a parallel file can wait on a marker the sequential lane writes', (t) => {
  // Under the old strict order the sequential file would not start until the
  // parallel lane finished, so the waiter would exhaust its deadline and fail.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lane-overlap-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const marker = path.join(tempRoot, 'seq-started.txt');
  const waiterPath = path.join(tempRoot, 'waiter.test.js');
  const seqPath = path.join(tempRoot, 'packaging-marker.test.js'); // /^packaging-/ -> sequential lane
  fs.writeFileSync(
    waiterPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      "test('sees the sequential lane start concurrently', async () => {\n" +
      `  const m = ${JSON.stringify(marker)};\n` +
      '  const deadline = Date.now() + 20000;\n' +
      '  while (!fs.existsSync(m)) {\n' +
      "    if (Date.now() > deadline) throw new Error('marker never appeared: lanes did not overlap');\n" +
      '    await new Promise((r) => setTimeout(r, 50));\n' +
      '  }\n' +
      '});\n'
  );
  fs.writeFileSync(
    seqPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      `test('marks lane start', () => { fs.writeFileSync(${JSON.stringify(marker)}, '1'); });\n`
  );

  const { status, stdout, stderr } = runRunner(
    [waiterPath, seqPath, '--timeout-ms=60000', '--per-file-timeout-ms=30000'],
    { timeoutMs: 90_000, env: { JENNY_TEST_LANE_OVERLAP: '1' } }
  );
  assert.equal(status, 0, `expected overlapped green run; stderr=${stderr}\nstdout=${stdout}`);
  assert.match(stdout, /summary: 2 passed, 0 failed/);
});

test('--no-lane-overlap restores the strict parallel-then-sequential order', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lane-strict-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const marker = path.join(tempRoot, 'parallel-done.txt');
  const slowPath = path.join(tempRoot, 'slow.test.js');
  const seqPath = path.join(tempRoot, 'packaging-order.test.js');
  // The parallel file finishes ~1s in; the sequential file asserts it already
  // ran. If lanes wrongly overlapped, the sequential child (spawned in
  // parallel) would find no marker and fail.
  fs.writeFileSync(
    slowPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      "test('slow parallel file', async () => {\n" +
      '  await new Promise((r) => setTimeout(r, 1000));\n' +
      `  fs.writeFileSync(${JSON.stringify(marker)}, '1');\n` +
      '});\n'
  );
  fs.writeFileSync(
    seqPath,
    "const fs = require('fs');\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\n" +
      "test('runs strictly after the parallel lane', () => {\n" +
      `  assert.ok(fs.existsSync(${JSON.stringify(marker)}), 'sequential lane started before the parallel lane finished');\n` +
      '});\n'
  );

  const { status, stdout, stderr } = runRunner(
    [slowPath, seqPath, '--no-lane-overlap', '--timeout-ms=60000'],
    { timeoutMs: 90_000, env: { JENNY_TEST_LANE_OVERLAP: '1' } }
  );
  assert.equal(status, 0, `expected strict-order green run; stderr=${stderr}\nstdout=${stdout}`);
  assert.match(stdout, /summary: 2 passed, 0 failed/);
});

test('explicit *.load.test.js args force the strict order even with overlap enabled', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lane-load-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const marker = path.join(tempRoot, 'parallel-done.txt');
  const slowPath = path.join(tempRoot, 'slow.test.js');
  const loadPath = path.join(tempRoot, 'perf.load.test.js');
  fs.writeFileSync(
    slowPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      "test('slow parallel file', async () => {\n" +
      '  await new Promise((r) => setTimeout(r, 1000));\n' +
      `  fs.writeFileSync(${JSON.stringify(marker)}, '1');\n` +
      '});\n'
  );
  fs.writeFileSync(
    loadPath,
    "const fs = require('fs');\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\n" +
      "test('load file gets the post-parallel quiet machine', () => {\n" +
      `  assert.ok(fs.existsSync(${JSON.stringify(marker)}), 'load file started before the parallel lane finished');\n` +
      '});\n'
  );

  const { status, stdout, stderr } = runRunner(
    [slowPath, loadPath, '--timeout-ms=60000'],
    { timeoutMs: 90_000, env: { JENNY_TEST_LANE_OVERLAP: '1' } }
  );
  assert.equal(status, 0, `expected load-isolated green run; stderr=${stderr}\nstdout=${stdout}`);
  assert.match(stdout, /summary: 2 passed, 0 failed/);
});
