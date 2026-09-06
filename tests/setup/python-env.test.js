'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  venvPythonRelativePath,
  venvPythonPath,
  venvExists,
  ensureVenv,
  installSidecarDeps,
} = require('../../scripts/setup/python-env');

test('venvPythonRelativePath is OS-correct', () => {
  assert.equal(venvPythonRelativePath('win32'), path.join('.venv', 'Scripts', 'python.exe'));
  assert.equal(venvPythonRelativePath('darwin'), path.join('.venv', 'bin', 'python'));
  assert.equal(venvPythonRelativePath('linux'), path.join('.venv', 'bin', 'python'));
});

test('venvPythonPath joins under the repo root', () => {
  const p = venvPythonPath('/repo', 'darwin');
  assert.equal(p, path.join('/repo', '.venv', 'bin', 'python'));
});

test('venvExists reflects the injected fileExists', () => {
  const expected = venvPythonPath('/repo', 'darwin');
  assert.equal(venvExists('/repo', { platform: 'darwin', fileExists: (c) => c === expected }), true);
  assert.equal(venvExists('/repo', { platform: 'darwin', fileExists: () => false }), false);
});

test('ensureVenv skips creation when the interpreter already exists', () => {
  const calls = [];
  const result = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    platform: 'darwin',
    fileExists: () => true,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return args.includes('-m')
        ? { status: 0, stdout: 'pip 24.3.1' }
        : { status: 0, stdout: 'Python 3.11.9' };
    },
  });
  assert.equal(result.created, false);
  assert.equal(calls.length, 2, 'the interpreter and pip must both be validated');
});

test('ensureVenv creates the venv via the resolved launcher', () => {
  const calls = [];
  const result = ensureVenv('/repo', { cmd: 'py', args: ['-3.11'] }, {
    platform: 'win32',
    fileExists: () => false,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0 };
    },
  });
  assert.equal(result.created, true);
  assert.deepEqual(calls[0][0], 'py');
  assert.deepEqual(calls[0][1], ['-3.11', '-m', 'venv', path.join('/repo', '.venv')]);
});

test('ensureVenv moves an invalid setup-owned environment aside before rebuilding', () => {
  const moves = [];
  const calls = [];
  const result = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    platform: 'darwin',
    fileExists: (candidate) => candidate.includes('.venv'),
    nowProvider: () => new Date('2026-08-16T12:00:00.000Z'),
    rename: (from, to) => moves.push([from, to]),
    run: (cmd, args) => {
      calls.push([cmd, args]);
      if (String(cmd).includes('.venv')) return { status: 1, stderr: 'broken interpreter' };
      return { status: 0 };
    },
  });
  assert.equal(result.created, true);
  assert.equal(moves.length, 1);
  assert.match(moves[0][1], /\.venv\.invalid-2026-08-16T12-00-00-000Z$/);
  assert.ok(calls.some(([cmd, args]) => cmd === 'python3.11' && args.includes('venv')));
});

test('ensureVenv reports an error when no launcher is available', () => {
  const result = ensureVenv('/repo', null, { platform: 'darwin', fileExists: () => false, run: () => ({ status: 0 }) });
  assert.equal(result.error, 'no_python_launcher');
});

test('ensureVenv surfaces a venv-create failure', () => {
  const result = ensureVenv('/repo', { cmd: 'python3', args: [] }, {
    platform: 'darwin',
    fileExists: () => false,
    run: () => ({ status: 1, stderr: 'No module named venv' }),
  });
  assert.equal(result.error, 'venv_create_failed');
  assert.match(result.detail, /No module named venv/);
});

test('installSidecarDeps (default) upgrades pip then installs the editable BASE package at the repo root', () => {
  const calls = [];
  const result = installSidecarDeps('/repo', {
    platform: 'darwin',
    run: (cmd, args, opts = {}) => {
      calls.push({ args: args.join(' '), cwd: opts.cwd });
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.venvPython, venvPythonPath('/repo', 'darwin'));
  assert.ok(calls.some((c) => c.args === '-m pip install --upgrade pip'));
  // Default is run-only: install the base package, NOT the .[dev] extra.
  const editable = calls.find((c) => c.args === '-m pip install -e .');
  assert.ok(editable, 'the editable base install must run');
  // The editable install MUST carry cwd=repoRoot so the package resolves at the
  // repo root, not wherever node happened to be launched from.
  assert.equal(editable.cwd, '/repo');
  assert.equal(result.target, '.');
});

test('installSidecarDeps({ dev: true }) installs the editable .[dev] extra for contributors', () => {
  const calls = [];
  const result = installSidecarDeps('/repo', {
    platform: 'darwin',
    dev: true,
    run: (cmd, args, opts = {}) => {
      calls.push({ args: args.join(' '), cwd: opts.cwd });
      return { status: 0 };
    },
  });
  assert.equal(result.ok, true);
  const editable = calls.find((c) => c.args === '-m pip install -e .[dev]');
  assert.ok(editable, 'the editable dev install must run under dev mode');
  assert.equal(editable.cwd, '/repo');
  assert.equal(result.target, '.[dev]');
});

test('installSidecarDeps reports the failing phase', () => {
  const result = installSidecarDeps('/repo', {
    platform: 'darwin',
    run: (cmd, args) => (args.includes('--upgrade') ? { status: 0 } : { status: 1, stderr: 'boom' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'pip_install');
});
