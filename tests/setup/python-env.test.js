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
    // The prune after the move must never reach the real filesystem here.
    readdir: () => [],
    rm: () => { throw new Error('unexpected rm'); },
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

function dirent(name, directory = true) {
  return { name, isDirectory: () => directory };
}

test('ensureVenv prunes older .venv.invalid-* quarantines and keeps the one it just made', () => {
  const removed = [];
  const stamp = '2026-08-16T12-00-00-000Z';
  const result = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    platform: 'darwin',
    fileExists: (candidate) => candidate.includes('.venv'),
    nowProvider: () => new Date('2026-08-16T12:00:00.000Z'),
    rename: () => {},
    readdir: () => [
      dirent('.venv.invalid-2026-01-01T00-00-00-000Z'),
      dirent(`.venv.invalid-${stamp}`),
      dirent('.venv.invalid-2026-03-03T00-00-00-000Z'),
      dirent('.venv.invalid-notes.txt', false),
      dirent('.venv.invalid'),
      dirent('.venv.invalid2-2026'),
      dirent('.venv-old'),
      dirent('.venv'),
      dirent('node_modules'),
    ],
    rm: (target, options) => removed.push([target, options]),
    run: (cmd) => (String(cmd).includes('.venv') ? { status: 1, stderr: 'broken interpreter' } : { status: 0 }),
  });
  assert.equal(result.created, true);
  assert.deepEqual(removed.map(([target]) => target), [
    path.join('/repo', '.venv.invalid-2026-01-01T00-00-00-000Z'),
    path.join('/repo', '.venv.invalid-2026-03-03T00-00-00-000Z'),
  ]);
  assert.ok(removed.every(([, options]) => options.recursive === true && options.force === true));
});

test('ensureVenv prunes after moving aside a venv directory that has no interpreter', () => {
  const removed = [];
  const result = ensureVenv('/repo', { cmd: 'python3', args: [] }, {
    platform: 'darwin',
    fileExists: (candidate) => candidate === path.join('/repo', '.venv'),
    nowProvider: () => new Date('2026-08-16T12:00:00.000Z'),
    rename: () => {},
    readdir: () => [dirent('.venv.invalid-2026-01-01T00-00-00-000Z')],
    rm: (target) => removed.push(target),
    run: () => ({ status: 0 }),
  });
  assert.equal(result.created, true);
  assert.deepEqual(removed, [path.join('/repo', '.venv.invalid-2026-01-01T00-00-00-000Z')]);
});

test('ensureVenv does not prune when the quarantine rename fails', () => {
  let listed = 0;
  const result = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    platform: 'darwin',
    fileExists: (candidate) => candidate.includes('.venv'),
    rename: () => { throw new Error('EBUSY'); },
    readdir: () => { listed += 1; return []; },
    rm: () => { throw new Error('must not remove'); },
    run: () => ({ status: 1, stderr: 'broken interpreter' }),
  });
  assert.equal(result.error, 'venv_recovery_failed');
  assert.equal(listed, 0);
});

test('ensureVenv swallows prune failures and still rebuilds the environment', () => {
  const calls = [];
  const options = {
    platform: 'darwin',
    fileExists: (candidate) => candidate.includes('.venv'),
    rename: () => {},
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return String(cmd).includes('.venv') ? { status: 1, stderr: 'broken interpreter' } : { status: 0 };
    },
  };
  const rmFails = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    ...options,
    readdir: () => [dirent('.venv.invalid-2026-01-01T00-00-00-000Z')],
    rm: () => { throw new Error('EPERM'); },
  });
  assert.equal(rmFails.created, true);
  const readdirFails = ensureVenv('/repo', { cmd: 'python3.11', args: [] }, {
    ...options,
    readdir: () => { throw new Error('EACCES'); },
    rm: () => { throw new Error('must not remove'); },
  });
  assert.equal(readdirFails.created, true);
  assert.equal(calls.filter(([cmd, args]) => cmd === 'python3.11' && args.includes('venv')).length, 2);
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
