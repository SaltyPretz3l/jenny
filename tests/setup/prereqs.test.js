'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSemver,
  satisfiesMin,
  checkNode,
  checkNpm,
  checkPython,
  checkGit,
  MIN_PYTHON,
} = require('../../scripts/setup/prereqs');

// Build a fake `run` from a {("<cmd> <args>"): {status, stdout}} table.
function fakeRun(table) {
  return (cmd, args) => {
    const key = `${cmd} ${(args || []).join(' ')}`.trim();
    const entry = table[key];
    if (!entry) {
      return { status: 127, stdout: '', stderr: '', error: new Error('not found') };
    }
    return { status: 0, stdout: '', stderr: '', ...entry };
  };
}

test('parseSemver pulls the first dotted triple from noisy output', () => {
  assert.deepEqual(parseSemver('Python 3.11.9'), { major: 3, minor: 11, patch: 9 });
  assert.deepEqual(parseSemver('v22.17.1'), { major: 22, minor: 17, patch: 1 });
  assert.deepEqual(parseSemver('git version 2.45.0.windows.1'), { major: 2, minor: 45, patch: 0 });
  assert.equal(parseSemver('no version here'), null);
});

test('satisfiesMin compares major.minor.patch correctly', () => {
  const min = { major: 22, minor: 12, patch: 0 };
  assert.equal(satisfiesMin({ major: 22, minor: 12, patch: 0 }, min), true);
  assert.equal(satisfiesMin({ major: 22, minor: 17, patch: 1 }, min), true);
  assert.equal(satisfiesMin({ major: 23, minor: 0, patch: 0 }, min), true);
  assert.equal(satisfiesMin({ major: 22, minor: 11, patch: 9 }, min), false);
  assert.equal(satisfiesMin({ major: 20, minor: 99, patch: 9 }, min), false);
  assert.equal(satisfiesMin(null, min), false);
});

test('checkNode trusts an injected runtime version (the orchestrator runs under Node)', () => {
  const ok = checkNode(fakeRun({}), { nodeVersion: '22.23.2' });
  assert.equal(ok.found, true);
  assert.equal(ok.satisfiesMin, true);

  const tooOld = checkNode(fakeRun({}), { nodeVersion: '22.11.0' });
  assert.equal(tooOld.satisfiesMin, false);
});

test('checkNpm parses the npm --version output', () => {
  const npm = checkNpm(fakeRun({ 'npm --version': { stdout: '10.9.2\n' } }));
  assert.equal(npm.found, true);
  assert.equal(npm.satisfiesMin, true);
});

test('checkPython picks the first launcher that satisfies 3.11 (macOS)', () => {
  const run = fakeRun({
    'python3.11 --version': { stdout: 'Python 3.11.9\n' },
    'python3 --version': { stdout: 'Python 3.9.6\n' },
  });
  const py = checkPython(run, { platform: 'darwin' });
  assert.equal(py.satisfiesMin, true);
  assert.equal(py.launcher.cmd, 'python3.11');
});

test('checkPython reports the newest found interpreter even when all are too old', () => {
  const run = fakeRun({
    'python3 --version': { stdout: 'Python 3.10.0\n' },
    'python --version': { stdout: 'Python 3.9.0\n' },
  });
  const py = checkPython(run, { platform: 'darwin' });
  assert.equal(py.found, true);
  assert.equal(py.satisfiesMin, false);
  assert.equal(py.min, `${MIN_PYTHON.major}.${MIN_PYTHON.minor}.${MIN_PYTHON.patch}`);
});

test('checkPython reports not-found when no interpreter responds', () => {
  const py = checkPython(fakeRun({}), { platform: 'win32' });
  assert.equal(py.found, false);
  assert.equal(py.launcher, null);
});

test('version probes reject nonzero launcher diagnostics that mention a supported version', () => {
  const run = fakeRun({
    'py -3.11 --version': {
      status: 103,
      stderr: 'Requested Python version (3.11) is not installed.',
    },
  });
  const py = checkPython(run, { platform: 'win32' });

  assert.equal(py.found, false);
  assert.equal(py.satisfiesMin, false);
});

test('checkGit detects presence and absence', () => {
  const present = checkGit(fakeRun({ 'git --version': { stdout: 'git version 2.45.0\n' } }));
  assert.equal(present.found, true);
  const missing = checkGit(fakeRun({}));
  assert.equal(missing.found, false);
});
