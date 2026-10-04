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

test('Crashpad assertion failure cannot be retried into a green run', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-crashpad-assertion-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const marker = path.join(tempRoot, 'attempted');
  const fixture = path.join(tempRoot, 'crashpad-assertion.test.js');
  fs.writeFileSync(fixture, [
    "const fs = require('fs');",
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    `const marker = ${JSON.stringify(marker)};`,
    "test('real assertion', () => {",
    '  if (fs.existsSync(marker)) return;',
    "  fs.writeFileSync(marker, 'first attempt');",
    "  console.error('Crashpad not connected');",
    "  assert.equal(1, 2, 'Crashpad assertion failed');",
    '});',
  ].join('\n'));
  const result = runRunner([fixture, '--timeout-ms=10000']);
  assert.equal(result.status, 1, 'assertion failure must not become green after an infrastructure retry');
  assert.doesNotMatch(result.stderr, /RETRY |INFRASTRUCTURE_FAILURE/);
  assert.match(result.stdout, /summary: 0 passed, 1 failed/);
});

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
  assert.equal(safeRunner.hasTestEvents('TAP version 13\n# Subtest: real assertion'), true);
});

// Node 24's default reporter is spec even when piped. Glyphs are built from
// code points so this file stays ASCII.
const SPEC_FAIL = String.fromCodePoint(0x2716);
const SPEC_INFO = String.fromCodePoint(0x2139);
const SPEC_FAILING_OUTPUT = [
  `${SPEC_FAIL} incremental Markdown update cost stays within the measured growth baseline (6012.3ms)`,
  `${SPEC_INFO} tests 1`,
  `${SPEC_INFO} pass 0`,
  `${SPEC_INFO} fail 1`,
  '',
  `${SPEC_FAIL} failing tests:`,
  '  AssertionError [ERR_ASSERTION]: Markdown update cost grew >2.25x.',
].join('\n');

test('spec-reporter assertion failures in sequential load tests are not infrastructure failures', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(
      safeRunner.isInfrastructureFailure(
        'tests/streaming-markdown-cost.load.test.js',
        { code: 1, output: SPEC_FAILING_OUTPUT, timedOut: false, collateralKilled: false },
        platform
      ),
      false,
      platform
    );
  }
  // Output capture drops from the head, so the tail summary alone must count.
  assert.equal(safeRunner.hasTestEvents(`${SPEC_INFO} tests 3\n${SPEC_INFO} fail 1`), true);
  assert.equal(safeRunner.hasTestEvents('Error: spawn electron ENOENT'), false);
  assert.equal(
    safeRunner.isInfrastructureFailure(
      'tests/electron-shell-smoke.test.js',
      { code: 1, output: '', timedOut: false, collateralKilled: false },
      'win32'
    ),
    false,
    'missing test events alone do not establish a startup crash signature'
  );
});

test('a failing load test is reported as FAIL without an infrastructure retry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-load-assertion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'ratio-assertion.load.test.js');
  fs.writeFileSync(
    fixture,
    [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('growth ratio stays within the ratchet', () => assert.ok(3.4 <= 2.25, 'grew >2.25x'));",
      '',
    ].join('\n')
  );

  const result = runRunner([fixture]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\bFAIL .*ratio-assertion\.load\.test\.js/);
  assert.doesNotMatch(result.stderr, /INFRASTRUCTURE_FAILURE|RETRY /);
  assert.match(result.stdout + result.stderr, /summary: 0 passed, 1 failed, 0 infrastructure failed/);
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

test('a load file runs as a strict tail while the rest of the sequential lane still overlaps', (t) => {
  // 2026-10-04: one load file used to force the whole sequential lane to wait
  // for the pool (~250 s of the heavy lane). Now only the load file waits.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lane-load-tail-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const seqMarker = path.join(tempRoot, 'seq-started.txt');
  const poolMarker = path.join(tempRoot, 'parallel-done.txt');
  const waiterPath = path.join(tempRoot, 'waiter.test.js');
  const seqPath = path.join(tempRoot, 'packaging-marker.test.js');
  const loadPath = path.join(tempRoot, 'perf.load.test.js');
  fs.writeFileSync(
    waiterPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      "test('sees the sequential lane start concurrently', async () => {\n" +
      `  const m = ${JSON.stringify(seqMarker)};\n` +
      '  const deadline = Date.now() + 20000;\n' +
      '  while (!fs.existsSync(m)) {\n' +
      "    if (Date.now() > deadline) throw new Error('marker never appeared: lanes did not overlap');\n" +
      '    await new Promise((r) => setTimeout(r, 50));\n' +
      '  }\n' +
      `  fs.writeFileSync(${JSON.stringify(poolMarker)}, '1');\n` +
      '});\n'
  );
  fs.writeFileSync(
    seqPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      `test('marks lane start', () => { fs.writeFileSync(${JSON.stringify(seqMarker)}, '1'); });\n`
  );
  fs.writeFileSync(
    loadPath,
    "const fs = require('fs');\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\n" +
      "test('load file gets the post-parallel quiet machine', () => {\n" +
      `  assert.ok(fs.existsSync(${JSON.stringify(poolMarker)}), 'load file started before the parallel lane finished');\n` +
      '});\n'
  );

  const { status, stdout, stderr } = runRunner(
    [waiterPath, seqPath, loadPath, '--timeout-ms=60000', '--per-file-timeout-ms=30000'],
    { timeoutMs: 90_000, env: { JENNY_TEST_LANE_OVERLAP: '1' } }
  );
  assert.equal(status, 0, `expected overlapped run with a load tail; stderr=${stderr}\nstdout=${stdout}`);
  assert.match(stdout, /summary: 3 passed, 0 failed/);
  assert.deepEqual(
    safeRunner.splitLoadTail(['tests/packaging-a.test.js', 'tests/perf.load.test.js']),
    { sequentialArgs: ['tests/packaging-a.test.js'], loadArgs: ['tests/perf.load.test.js'] }
  );
});

test('the pool starts the longest known files first and unknown files before them', () => {
  const { orderLongestFirst } = require('../scripts/run-node-tests-safe-plan');
  // Runs are stored newest first; the newest record for a file wins.
  const history = { runs: [
    { files: [
      { file: 'tests/slow.test.js', durationMs: 9000 },
      { file: 'tests/quick.test.js', durationMs: 100 },
      { file: 'tests/hung.test.js', durationMs: 120000, timedOut: true },
    ] },
    { files: [{ file: 'tests/quick.test.js', durationMs: 50000 }, { file: 'tests/hung.test.js', durationMs: 400 }] },
  ] };
  const files = ['tests/quick.test.js', 'tests/new.test.js', 'tests/hung.test.js', 'tests/slow.test.js'];
  assert.deepEqual(
    orderLongestFirst(files, { cwd: ROOT, history }),
    ['tests/new.test.js', 'tests/slow.test.js', 'tests/hung.test.js', 'tests/quick.test.js']
  );
  assert.deepEqual(orderLongestFirst(files, { cwd: ROOT, history: { runs: [] } }), files);
});

test('the heavy jsdom suites and the resource suites drain as two chains side by side', (t) => {
  // 2026-10-04: as one chain they were the heavy lane's critical path (~330 s).
  // Each chain is still one-at-a-time; the two only stop waiting on each other.
  const support = require('../scripts/run-node-tests-safe-support');
  assert.deepEqual(
    support.splitSequentialChains([
      'tests/packaging-a.test.js', 'tests/renderer-shell.test.js', 'tests/workspace-ipc.test.js',
    ]),
    {
      resourceArgs: ['tests/packaging-a.test.js', 'tests/workspace-ipc.test.js'],
      jsdomArgs: ['tests/renderer-shell.test.js'],
    }
  );
  assert.equal(safeRunner.isSequentialTestPath('tests/renderer-shell.test.js'), true);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lane-chains-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const marker = path.join(tempRoot, 'jsdom-chain-started.txt');
  // Sequential-lane basenames: packaging-* (resource chain), renderer-shell (jsdom chain).
  const resourcePath = path.join(tempRoot, 'packaging-waiter.test.js');
  const jsdomPath = path.join(tempRoot, 'renderer-shell.test.js');
  const poolPath = path.join(tempRoot, 'pool.test.js');
  fs.writeFileSync(
    resourcePath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      "test('sees the jsdom chain start while this chain is still running', async () => {\n" +
      `  const m = ${JSON.stringify(marker)};\n` +
      '  const deadline = Date.now() + 20000;\n' +
      '  while (!fs.existsSync(m)) {\n' +
      "    if (Date.now() > deadline) throw new Error('marker never appeared: chains did not overlap');\n" +
      '    await new Promise((r) => setTimeout(r, 50));\n' +
      '  }\n' +
      '});\n'
  );
  fs.writeFileSync(
    jsdomPath,
    "const fs = require('fs');\nconst test = require('node:test');\n" +
      `test('marks chain start', () => { fs.writeFileSync(${JSON.stringify(marker)}, '1'); });\n`
  );
  fs.writeFileSync(poolPath, "require('node:test')('pool file', () => {});\n");

  const { status, stdout, stderr } = runRunner(
    [resourcePath, jsdomPath, poolPath, '--timeout-ms=60000', '--per-file-timeout-ms=30000'],
    { timeoutMs: 90_000, env: { JENNY_TEST_LANE_OVERLAP: '1' } }
  );
  assert.equal(status, 0, `expected the two chains to overlap; stderr=${stderr}\nstdout=${stdout}`);
  assert.match(stdout, /summary: 3 passed, 0 failed/);
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
