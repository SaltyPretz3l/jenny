'use strict';

// Fast lane (--fast-only) of scripts/run-node-tests-safe.js and the slow list
// behind it (tests/.slow-lane.json, scripts/run-node-tests-safe-slow-lane.js).
// The contract under test: the fast lane only ever leaves files out of ITS OWN
// run, a named file always runs, and the checked-in list cannot rot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const safeRunner = require('../scripts/run-node-tests-safe');
const slowLane = require('../scripts/run-node-tests-safe-slow-lane');
const reportSlow = require('../scripts/report-slow-tests');

const PASSING_TEST = "require('node:test')('ok', () => {});\n";
// One file per way of leaving the fast lane, plus one that stays.
const QUICK = 'quick.test.js';
const SLOW = 'slow-listed.test.js';
const SEQUENTIAL = 'managed-sidecar-example.test.js';
const STABLE_EXCLUDED = 'process-utils.test.js';

function makeTree(t, { slowList = [`tests/${SLOW}`], extraFiles = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fast-lane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const testsDir = path.join(root, 'tests');
  fs.mkdirSync(testsDir);
  for (const name of [QUICK, SLOW, SEQUENTIAL, STABLE_EXCLUDED, ...extraFiles]) {
    const target = path.join(testsDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, PASSING_TEST);
  }
  if (slowList) {
    fs.writeFileSync(
      path.join(testsDir, '.slow-lane.json'),
      JSON.stringify({ version: 1, cut_ms: 2000, files: slowList })
    );
  }
  return { root, testsDir };
}

function basenames(files) {
  return files.map((file) => path.basename(file)).sort();
}

function runRunner(args, cwd) {
  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function fullRun(files, { status = 'passed' } = {}) {
  return {
    status,
    files: Object.entries(files).map(([file, durationMs]) => ({ file, status: 'passed', durationMs, timedOut: false })),
  };
}

test('--fast-only keeps only quick stable files from directory discovery', (t) => {
  const { root, testsDir } = makeTree(t);
  const parsed = safeRunner.parseArgs([testsDir, '--fast-only'], { cwd: root });
  assert.deepEqual(basenames(parsed.childArgs), [QUICK]);
  assert.deepEqual(parsed.fastLane.leftOutSlow, [`tests/${SLOW}`]);
  assert.deepEqual(parsed.fastLane.leftOutLane.sort(), [`tests/${SEQUENTIAL}`, `tests/${STABLE_EXCLUDED}`]);
  assert.equal(parsed.fastLane.cutMs, 2000);
});

test('without --fast-only the slow list changes nothing', (t) => {
  const { root, testsDir } = makeTree(t);
  const parsed = safeRunner.parseArgs([testsDir], { cwd: root });
  assert.deepEqual(basenames(parsed.childArgs), [SEQUENTIAL, STABLE_EXCLUDED, QUICK, SLOW].sort());
  assert.equal(parsed.fastLane, null);
  const stable = safeRunner.selectRunGroups(safeRunner.parseArgs([testsDir, '--parallel-only'], { cwd: root }));
  assert.deepEqual(basenames(stable.parallelArgs), [QUICK, SLOW], 'the stable lane still runs slow-listed files');
});

test('a file named on the command line runs in the fast lane, once, whatever lists it', (t) => {
  const { root, testsDir } = makeTree(t);
  const named = [path.join(testsDir, SLOW), path.join(testsDir, SEQUENTIAL), path.join(testsDir, QUICK)];
  const parsed = safeRunner.parseArgs([testsDir, ...named, '--fast-only'], { cwd: root });
  assert.deepEqual(basenames(parsed.childArgs), [SEQUENTIAL, QUICK, SLOW].sort());
  assert.deepEqual(parsed.fastLane.leftOutSlow, []);
  assert.deepEqual(parsed.fastLane.leftOutLane, [`tests/${STABLE_EXCLUDED}`]);
  const groups = safeRunner.selectRunGroups(parsed);
  assert.deepEqual(basenames(groups.sequentialArgs), [SEQUENTIAL], 'a named one-at-a-time file keeps its own lane');
});

test('a missing or malformed slow list makes the fast lane run more, never less', (t) => {
  const { root, testsDir } = makeTree(t, { slowList: null });
  const parsed = safeRunner.parseArgs([testsDir, '--fast-only'], { cwd: root });
  assert.deepEqual(basenames(parsed.childArgs), [QUICK, SLOW].sort());
  assert.equal(parsed.fastLane.listPresent, false);
  assert.match(slowLane.formatFastLaneNote(parsed.fastLane), /no tests\/\.slow-lane\.json found/);

  fs.writeFileSync(path.join(testsDir, '.slow-lane.json'), '{ "files": "tests/quick.test.js" }');
  assert.equal(slowLane.loadSlowLane(root).present, false);
  fs.writeFileSync(path.join(testsDir, '.slow-lane.json'), JSON.stringify({ cut_ms: -1, files: [7, '', `tests\\${SLOW}`] }));
  const loaded = slowLane.loadSlowLane(root);
  assert.deepEqual([...loaded.files], [`tests/${SLOW}`]);
  assert.equal(loaded.cutMs, slowLane.DEFAULT_CUT_MS);
});

test('the runner runs the fast lane end to end and says what it left out', (t) => {
  const { root } = makeTree(t);
  const result = runRunner(['tests', '--fast-only', '--timeout-ms=30000'], root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /fast lane: left out 1 slow-listed file\(s\) and 2 one-at-a-time or heavy file\(s\); npm test runs them all/);
  assert.match(result.stdout, /summary: 1 passed, 0 failed/);
  assert.match(result.stdout, new RegExp(`ok tests[\\\\/]${QUICK.replace(/\./g, '\\.')}`));
});

test('--fast-only leaves a --changed or --last-failed selection whole', (t) => {
  const { root, testsDir } = makeTree(t);
  const selection = new Set([`tests/${SLOW}`, `tests/${SEQUENTIAL}`]);
  for (const [flag, option] of [['--changed', 'changedSet'], ['--last-failed', 'lastFailedSet']]) {
    const parsed = safeRunner.parseArgs([testsDir, '--fast-only', flag], { cwd: root, [option]: selection });
    assert.deepEqual(basenames(parsed.childArgs), [SEQUENTIAL, SLOW].sort(), `${flag}: a changed slow test must still run`);
  }
});

test('--write-slow-lane fails when there is no history to read', (t) => {
  const { root } = makeTree(t);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'report-slow-tests.js'), '--write-slow-lane'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 1, String(result.stdout) + String(result.stderr));
  assert.match(String(result.stderr), /--write-slow-lane reads the run history/);
});

test('directory discovery skips fixture trees, and a named fixture file still runs', (t) => {
  const { testsDir } = makeTree(t, { extraFiles: ['fixtures/scan/input/widget.test.js'] });
  const fixture = path.join(testsDir, 'fixtures', 'scan', 'input', 'widget.test.js');
  assert.equal(safeRunner.expandDirectoryArg(testsDir).includes(fixture), false);
  assert.deepEqual(safeRunner.expandDirectoryArg(fixture), [fixture]);
});

test('drift names passing fast-lane files over twice the cut and skips named files', () => {
  const fastLane = { cutMs: 2000, explicit: new Set(['tests/named.test.js']) };
  const results = [
    { file: 'tests/a.test.js', code: 0, durationMs: 4001 },
    { file: 'tests/b.test.js', code: 0, durationMs: 9000 },
    { file: 'tests/at-limit.test.js', code: 0, durationMs: 4000 },
    { file: 'tests/failed.test.js', code: 1, durationMs: 9000 },
    { file: 'tests/hung.test.js', code: 0, timedOut: true, durationMs: 9000 },
    { file: 'tests/named.test.js', code: 0, durationMs: 9000 },
  ];
  assert.deepEqual(slowLane.findFastLaneDrift(results, fastLane).map((record) => record.file), ['tests/b.test.js', 'tests/a.test.js']);
  const lines = slowLane.formatFastLaneDrift(results, fastLane);
  assert.match(lines[0], /fast lane: 2 file\(s\) took over 4\.0s: tests\/b\.test\.js \(9\.0s\), tests\/a\.test\.js \(4\.0s\)/);
  assert.match(lines[1], /node scripts\/report-slow-tests\.js --write-slow-lane/);
  assert.deepEqual(slowLane.formatFastLaneDrift([results[2]], fastLane), []);
});

test('the slow list is computed from the median of passing full runs only', (t) => {
  const { root } = makeTree(t, { extraFiles: ['steady.test.js', 'spiky.test.js'] });
  const quick = `tests/${QUICK}`;
  const base = { [quick]: 100, [`tests/${SEQUENTIAL}`]: 9000, [`tests/${STABLE_EXCLUDED}`]: 9000, 'tests/gone.test.js': 9000 };
  const history = { runs: [
    fullRun({ ...base, 'tests/steady.test.js': 2000, 'tests/spiky.test.js': 300 }),
    // A targeted run and a failed full run say nothing about the lane.
    fullRun({ 'tests/spiky.test.js': 60000 }),
    fullRun({ ...base, 'tests/steady.test.js': 100, 'tests/spiky.test.js': 60000 }, { status: 'failed' }),
    fullRun({ ...base, 'tests/steady.test.js': 2500, 'tests/spiky.test.js': 60000 }),
    fullRun({ ...base, 'tests/steady.test.js': 1900, 'tests/spiky.test.js': 400 }),
  ] };
  const result = slowLane.computeSlowLane(history, { cwd: root, fullRunFileCount: 6 });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.files, ['tests/steady.test.js'], 'median 2000 meets the cut; one spike, a lane file and a deleted file do not');
  assert.equal(result.runsUsed, 3);
  assert.equal(result.considered, 3);

  const tooFew = slowLane.computeSlowLane({ runs: history.runs.slice(0, 4) }, { cwd: root, fullRunFileCount: 6 });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.reason, /need 3 passing full runs in the history and found 2/);

  slowLane.writeSlowLane(root, result);
  const written = fs.readFileSync(path.join(root, 'tests', '.slow-lane.json'), 'utf8');
  assert.equal(written, '{\n  "version": 1,\n  "cut_ms": 2000,\n  "files": [\n    "tests/steady.test.js"\n  ]\n}\n');
});

test('report-slow-tests accepts --write-slow-lane and --cut-ms', () => {
  const parsed = reportSlow.parseArgs(['--write-slow-lane', '--cut-ms=3000']);
  assert.equal(parsed.writeSlowLane, true);
  assert.equal(parsed.cutMs, 3000);
  assert.equal(reportSlow.parseArgs([]).writeSlowLane, false);
  assert.equal(reportSlow.parseArgs(['--write-slow-lane', '--cut-ms=soon']).cutMs, null);
});

test('the checked-in slow list names only real stable-lane files, sorted', () => {
  const loaded = slowLane.loadSlowLane(ROOT);
  assert.equal(loaded.present, true, 'tests/.slow-lane.json is checked in');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, slowLane.SLOW_LANE_PATH), 'utf8'));
  assert.equal(raw.cut_ms, 2000, 'owner pick D1 (2026-11-11): a 2 s cut line');
  assert.deepEqual(raw.files, [...new Set(raw.files)].sort(), 'sorted and unique');
  assert.ok(raw.files.length > 0);
  const problems = [];
  for (const file of raw.files) {
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) problems.push(`${file}: no such file`);
    else if (safeRunner.isSequentialTestPath(absolute)) problems.push(`${file}: one-at-a-time, never in the fast lane`);
    else if (safeRunner.isStableLaneExcludedPath(file)) problems.push(`${file}: excluded from the stable lane already`);
  }
  assert.deepEqual(problems, [], `refresh with ${slowLane.REFRESH_COMMAND}`);
});
