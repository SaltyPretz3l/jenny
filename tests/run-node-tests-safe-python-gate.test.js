'use strict';

// Python gate of scripts/run-node-tests-safe.js (tests/.needs-python.json,
// scripts/run-node-tests-safe-python-gate.js). Without <repo>/.venv the listed
// sidecar-backed suites are left out and counted; a file named on the command
// line, or any listed file under JENNY_REQUIRE_PYTHON_TESTS=1, is a failure
// instead, so neither a targeted run nor the gate can go green without them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const safeRunner = require('../scripts/run-node-tests-safe');
const gate = require('../scripts/run-node-tests-safe-python-gate');

const PASSING_TEST = "require('node:test')('ok', () => {});\n";
// Stands in for a suite that starts the sidecar: it can only fail here, so a
// green run proves the runner never started it.
const NEEDS_VENV_TEST = "require('node:test')('starts the sidecar', () => { throw new Error('ran without a venv'); });\n";

function makeTree(t, { venv = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-python-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const testsDir = path.join(root, 'tests');
  fs.mkdirSync(testsDir);
  fs.writeFileSync(path.join(testsDir, 'quick.test.js'), PASSING_TEST);
  fs.writeFileSync(path.join(testsDir, 'sidecar-backed.test.js'), venv ? PASSING_TEST : NEEDS_VENV_TEST);
  fs.writeFileSync(path.join(testsDir, '.needs-python.json'), JSON.stringify({ version: 1, files: ['tests/sidecar-backed.test.js'] }));
  if (venv) {
    const python = gate.venvPythonPath(root);
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
  }
  return { root, testsDir, listed: path.join(testsDir, 'sidecar-backed.test.js') };
}

function runRunner(args, cwd, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('JENNY_REQUIRE_PYTHON_TESTS' in env)) delete childEnv.JENNY_REQUIRE_PYTHON_TESTS;
  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: childEnv,
    windowsHide: true,
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function basenames(files) {
  return files.map((file) => path.basename(file)).sort();
}

test('with a venv the gate changes nothing', (t) => {
  const { root, testsDir } = makeTree(t, { venv: true });
  const parsed = safeRunner.parseArgs([testsDir], { cwd: root, env: {} });
  assert.deepEqual(basenames(parsed.childArgs), ['quick.test.js', 'sidecar-backed.test.js']);
  assert.deepEqual(parsed.pythonGate.skipped, []);
  assert.deepEqual(parsed.pythonGate.failed, []);
});

test('without a venv a discovered listed file is left out and counted', (t) => {
  const { root, testsDir } = makeTree(t);
  const parsed = safeRunner.parseArgs([testsDir], { cwd: root, env: {} });
  assert.deepEqual(basenames(parsed.childArgs), ['quick.test.js']);
  assert.deepEqual(parsed.pythonGate.skipped, ['tests/sidecar-backed.test.js']);
  assert.deepEqual(parsed.pythonGate.failed, []);
  assert.match(gate.describePythonGate(parsed.pythonGate)[0], /SKIPPED: 1 file\(s\) that need the repo Python venv/);
});

test('without a venv a named listed file is a failure, not a skip', (t) => {
  const { root, testsDir, listed } = makeTree(t);
  const parsed = safeRunner.parseArgs([testsDir, listed], { cwd: root, env: {} });
  assert.deepEqual(basenames(parsed.childArgs), ['quick.test.js']);
  assert.deepEqual(parsed.pythonGate.skipped, []);
  assert.deepEqual(parsed.pythonGate.failed, ['tests/sidecar-backed.test.js'], 'named once and discovered once is one failure');
  assert.match(
    gate.describePythonGate(parsed.pythonGate)[0],
    /NO PYTHON VENV: 1 file\(s\) not run, which fails this run: needs the repo Python venv and this tree has no \.venv/
  );
});

test('a --changed or --last-failed selection is as targeted as a named file', (t) => {
  const { root, testsDir } = makeTree(t);
  const selection = new Set(['tests/sidecar-backed.test.js']);
  for (const [flag, option] of [['--changed', 'changedSet'], ['--last-failed', 'lastFailedSet']]) {
    const parsed = safeRunner.parseArgs([testsDir, flag], { cwd: root, env: {}, [option]: selection });
    assert.deepEqual(parsed.childArgs, [], flag);
    assert.deepEqual(parsed.pythonGate.failed, ['tests/sidecar-backed.test.js'], flag);
    assert.deepEqual(parsed.pythonGate.skipped, [], flag);
  }
});

test('the gate stands down for JENNY_TEST_PYTHON and for --no-default-test-flags', (t) => {
  const { root, testsDir } = makeTree(t);
  const both = ['quick.test.js', 'sidecar-backed.test.js'];
  const otherPython = safeRunner.parseArgs([testsDir], { cwd: root, env: { JENNY_TEST_PYTHON: '/opt/venv/bin/python' } });
  assert.deepEqual(basenames(otherPython.childArgs), both);
  assert.deepEqual(otherPython.pythonGate.skipped, []);
  const unmanaged = safeRunner.parseArgs([testsDir, '--no-default-test-flags'], {
    cwd: root, env: { JENNY_REQUIRE_PYTHON_TESTS: '1' },
  });
  assert.deepEqual(basenames(unmanaged.childArgs), both, 'the legacy path has no summary to carry a refusal');
  assert.deepEqual(unmanaged.pythonGate.failed, []);
});

test('the require flag turns every left-out file into a failure', (t) => {
  const { root, testsDir } = makeTree(t);
  const parsed = safeRunner.parseArgs([testsDir], { cwd: root, env: { JENNY_REQUIRE_PYTHON_TESTS: '1' } });
  assert.deepEqual(parsed.pythonGate.skipped, []);
  assert.deepEqual(parsed.pythonGate.failed, ['tests/sidecar-backed.test.js']);
  const lenient = safeRunner.parseArgs([testsDir], { cwd: root, env: { JENNY_REQUIRE_PYTHON_TESTS: 'true' } });
  assert.deepEqual(lenient.pythonGate.failed, [], 'only the exact value 1 arms the flag');
});

test('the runner skips green, fails a named file fast, and fails under the require flag', (t) => {
  const { root } = makeTree(t);
  const skipped = runRunner(['tests', '--timeout-ms=30000'], root);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /summary: 1 passed, 0 failed/);
  assert.match(skipped.stdout, /SKIPPED: 1 file\(s\) that need the repo Python venv/);
  assert.doesNotMatch(skipped.stdout + skipped.stderr, /ran without a venv/);

  // Nothing is left to start, and the refusal still reaches the summary, the
  // JUnit report and the --last-failed list.
  const named = runRunner([path.join('tests', 'sidecar-backed.test.js'), '--junit=report.xml', '--timeout-ms=30000'], root);
  assert.equal(named.status, 1, named.stdout + named.stderr);
  assert.match(named.stdout, /summary: 0 passed, 0 failed, .* 1 not run/);
  assert.match(named.stdout, /NOT RUN: 1 file\(s\): tests\/sidecar-backed\.test\.js/);
  assert.match(named.stdout, /NO PYTHON VENV: 1 file\(s\) not run, which fails this run/);
  assert.doesNotMatch(named.stdout + named.stderr, /ran without a venv/);
  assert.match(fs.readFileSync(path.join(root, 'report.xml'), 'utf8'), /sidecar-backed\.test\.js/);
  assert.match(fs.readFileSync(path.join(root, 'tests', '.last-test-run.json'), 'utf8'), /sidecar-backed\.test\.js/);

  const required = runRunner(['tests', '--timeout-ms=30000'], root, { JENNY_REQUIRE_PYTHON_TESTS: '1' });
  assert.equal(required.status, 1, required.stdout + required.stderr);
  assert.match(required.stdout, /progress 1\/1 pass/);
  assert.match(required.stdout, /summary: 1 passed, 0 failed, .* 1 not run/);
  assert.match(required.stdout, /NOT RUN: 1 file\(s\): tests\/sidecar-backed\.test\.js/);
});

// A listed file must name the venv interpreter itself or through a helper it
// requires; otherwise the list would skip a suite that has no such need.
function namesVenv(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (/\.venv|JENNY_TEST_PYTHON/.test(source)) return true;
  for (const match of source.matchAll(/require\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)) {
    const base = path.join(ROOT, path.dirname(file), match[1]);
    for (const candidate of [base, `${base}.js`]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        && /\.venv|JENNY_TEST_PYTHON/.test(fs.readFileSync(candidate, 'utf8'))) return true;
    }
  }
  return false;
}

test('the checked-in list names only real suites that depend on the venv, sorted', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, gate.NEEDS_PYTHON_PATH), 'utf8'));
  assert.ok(raw.files.length > 0);
  assert.deepEqual(raw.files, [...new Set(raw.files)].sort(), 'sorted and unique');
  const problems = [];
  for (const file of raw.files) {
    if (!fs.existsSync(path.join(ROOT, file))) problems.push(`${file}: no such file`);
    else if (!namesVenv(file)) problems.push(`${file}: neither it nor a helper it requires names .venv`);
  }
  assert.deepEqual(problems, []);
});
