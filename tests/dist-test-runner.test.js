'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  DIST_NODE_TESTS,
  DIST_PYTHON_TESTS,
  buildDistTestCommands,
  ensurePytestAvailable,
  parseArgs,
  resolvePythonExecutable,
  runDistTests,
} = require('../scripts/tests/run-dist-tests');

test('dist verification resolves the repository virtualenv before PATH Python', () => {
  const root = path.resolve('fixture-root');
  const expected = path.join(root, '.venv', 'Scripts', 'python.exe');

  assert.equal(resolvePythonExecutable({
    root,
    platform: 'win32',
    existsSync: (candidate) => candidate === expected,
  }), expected);
  assert.equal(resolvePythonExecutable({
    root,
    platform: 'linux',
    existsSync: () => false,
  }), 'python3');
});

test('dist verification accepts only an explicit Python override', () => {
  assert.deepEqual(parseArgs(['--python', 'C:/Python/python.exe']), {
    python: 'C:/Python/python.exe',
  });
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
  assert.throws(() => parseArgs(['--python']), /requires an executable path/);
});

test('dist verification contains deterministic supported lanes only', () => {
  const allTargets = [...DIST_NODE_TESTS, ...DIST_PYTHON_TESTS];
  assert.ok(allTargets.some((target) => target.includes('release-compat')));
  assert.ok(allTargets.some((target) => target.includes('runtime/test_capabilities.py')));
  assert.equal(allTargets.some((target) => target.includes('gui-smoke')), false);
  assert.equal(allTargets.some((target) => target.includes('live-ollama')), false);
  assert.equal(allTargets.some((target) => target.includes('.load.test.js')), false);

  const commands = buildDistTestCommands({ node: 'node-bin', python: 'python-bin' });
  assert.equal(commands.length, 4);
  assert.equal(commands[0].executable, 'python-bin');
  assert.equal(commands[2].executable, 'node-bin');
  assert.equal(commands[3].requiresPytest, true);
});

test('dist verification stops after the first failed command', () => {
  const calls = [];
  const commands = [
    { label: 'first', executable: 'one', args: [] },
    { label: 'second', executable: 'two', args: [] },
    { label: 'third', executable: 'three', args: [] },
  ];
  const status = runDistTests({
    commands,
    spawn(executable) {
      calls.push(executable);
      return { status: executable === 'two' ? 7 : 0 };
    },
    log() {},
    error() {},
  });

  assert.equal(status, 7);
  assert.deepEqual(calls, ['one', 'two']);
});

test('ensurePytestAvailable is a no-op when pytest already probes clean', () => {
  const calls = [];
  const result = ensurePytestAvailable({
    python: 'python-bin',
    spawn(executable, args) {
      calls.push(args.join(' '));
      return { status: 0 };
    },
    log() {},
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ['-B -m pytest --version']);
});

test('ensurePytestAvailable installs the dev extra when pytest is missing, then re-probes', () => {
  const calls = [];
  const logs = [];
  const result = ensurePytestAvailable({
    python: 'python-bin',
    spawn(executable, args) {
      calls.push(args.join(' '));
      if (args.includes('install')) {
        return { status: 0 };
      }
      // First probe misses; the re-probe after install succeeds.
      return { status: calls.length > 1 ? 0 : 1 };
    },
    log(message) {
      logs.push(message);
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    '-B -m pytest --version',
    '-m pip install -e .[dev]',
    '-B -m pytest --version',
  ]);
  assert.ok(logs.some((line) => line.includes('pip install -e ".[dev]"')));
});

test('ensurePytestAvailable reports an actionable command when auto-install fails offline', () => {
  const result = ensurePytestAvailable({
    python: 'python-bin',
    spawn(executable, args) {
      if (args.includes('install')) {
        return { status: 1 };
      }
      return { status: 1 };
    },
    log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /python-bin -m pip install -e "\.\[dev\]"/);
});

test('ensurePytestAvailable fails clearly if install reports success but pytest is still missing', () => {
  const result = ensurePytestAvailable({
    python: 'python-bin',
    spawn(executable, args) {
      if (args.includes('install')) {
        return { status: 0 };
      }
      return { status: 1 };
    },
    log() {},
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /still unavailable/);
});

test('runDistTests self-heals a missing pytest before the pytest lane, never skipping it', () => {
  const calls = [];
  let versionProbes = 0;
  const commands = [
    { label: 'first', executable: 'py', args: ['first'] },
    {
      label: 'pytest lane',
      executable: 'py',
      args: ['-m', 'pytest'],
      requiresPytest: true,
    },
  ];
  const status = runDistTests({
    commands,
    spawn(executable, args) {
      calls.push(args.join(' '));
      if (args.includes('--version')) {
        versionProbes += 1;
        // First probe misses (pytest not installed yet); re-probe after
        // the install succeeds.
        return { status: versionProbes === 1 ? 1 : 0 };
      }
      return { status: 0 }; // install succeeds, then the actual commands succeed
    },
    log() {},
    error() {},
  });
  assert.equal(status, 0);
  // pytest availability must be checked (and healed) before the pytest lane runs.
  assert.deepEqual(calls, [
    'first',
    '-B -m pytest --version',
    '-m pip install -e .[dev]',
    '-B -m pytest --version',
    '-m pytest',
  ]);
});

test('runDistTests fails with an actionable message (not a silent skip) when pytest cannot be installed', () => {
  const errors = [];
  const commands = [
    {
      label: 'pytest lane',
      executable: 'py',
      args: ['-m', 'pytest'],
      requiresPytest: true,
    },
  ];
  const status = runDistTests({
    commands,
    spawn() {
      return { status: 1 };
    },
    log() {},
    error(message) {
      errors.push(message);
    },
  });
  assert.equal(status, 1);
  assert.ok(errors.some((line) => line.includes('py -m pip install -e ".[dev]"')));
});
