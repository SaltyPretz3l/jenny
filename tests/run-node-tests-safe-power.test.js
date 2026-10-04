'use strict';

// The safe runner's Windows power-throttling keeper helper
// (scripts/run-node-tests-safe-power.js + scripts/checks/power_throttling_keeper.py).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const {
  ACTIVE_ENV_VAR,
  KEEPER_SCRIPT,
  startPowerKeeper,
} = require('../scripts/run-node-tests-safe-power');

function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    calls.handlers = {};
    return {
      on(event, fn) { calls.handlers[event] = fn; },
      unref() { calls.unrefs = (calls.unrefs || 0) + 1; },
    };
  };
}

test('starts the keeper for this runner on Windows and marks the tree as covered', () => {
  const calls = [];
  const env = {};
  const child = startPowerKeeper({ platform: 'win32', env, pid: 4242, spawnImpl: fakeSpawn(calls) });
  assert.ok(child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'python');
  assert.deepEqual(calls[0].args, [KEEPER_SCRIPT, '--root-pid', '4242']);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls.unrefs, 1, 'the helper never holds the runner open');
  assert.equal(env[ACTIVE_ENV_VAR], '1', 'nested runners inherit the marker');
});

test('a keeper that fails to launch or exits early stops claiming the tree', () => {
  for (const event of ['error', 'exit']) {
    const calls = [];
    const env = {};
    startPowerKeeper({ platform: 'win32', env, pid: 1, spawnImpl: fakeSpawn(calls) });
    assert.equal(env[ACTIVE_ENV_VAR], '1');
    calls.handlers[event](new Error('spawn python ENOENT'));
    assert.equal(env[ACTIVE_ENV_VAR], undefined, `${event} clears the marker`);
  }
});

test('does nothing off Windows or under an outer keeper', () => {
  const calls = [];
  assert.equal(startPowerKeeper({ platform: 'linux', env: {}, spawnImpl: fakeSpawn(calls) }), null);
  assert.equal(
    startPowerKeeper({ platform: 'win32', env: { [ACTIVE_ENV_VAR]: '1' }, spawnImpl: fakeSpawn(calls) }),
    null
  );
  assert.equal(calls.length, 0);
});

test('a keeper that cannot start leaves the run unmarked and does not throw', () => {
  const env = {};
  const result = startPowerKeeper({
    platform: 'win32',
    env,
    spawnImpl: () => { throw new Error('spawn python ENOENT'); },
  });
  assert.equal(result, null);
  assert.equal(env[ACTIVE_ENV_VAR], undefined);
});

test('the keeper helper process exits once its root process is gone', { skip: process.platform !== 'win32' }, async () => {
  const root = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  const keeper = spawn('python', [KEEPER_SCRIPT, '--root-pid', String(root.pid)], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve, reject) => {
    keeper.on('error', reject);
    keeper.on('exit', (code) => resolve(code));
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(keeper.exitCode, null, 'the keeper stays up while its root runs');
  } finally {
    root.kill();
  }
  const guard = setTimeout(() => keeper.kill(), 10000);
  const code = await exited;
  clearTimeout(guard);
  assert.equal(code, 0);
});
