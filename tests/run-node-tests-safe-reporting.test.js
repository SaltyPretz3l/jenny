'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isInfrastructureFailure, retryInfrastructureFailures } = require('../scripts/run-node-tests-safe-reporting');

test('assertion events override Crashpad diagnostics and abnormal exit codes', () => {
  for (const file of ['tests/unit.test.js', 'tests/electron-shell-smoke.test.js']) {
    for (const code of [1, -1, 0xFFFFFFFF]) {
      for (const events of ['# Subtest: assertion\nnot ok 1 - assertion', '\u2716 assertion (1ms)\n\u2139 tests 1']) {
        assert.equal(isInfrastructureFailure(file, {
          code, output: `${events}\nCrashpad not connected\n0xffffffff`,
        }, 'win32'), false, 'executed assertions must remain failures');
      }
    }
  }
});

test('ordinary Crashpad mentions are not startup crash signatures', () => {
  assert.equal(isInfrastructureFailure('tests/unit.test.js', {
    code: 1, output: 'Error: expected crashpad configuration to be saved',
  }, 'win32'), false);
  assert.equal(isInfrastructureFailure('tests/unit.test.js', {
    code: 1, output: 'Crashpad not connected',
  }, 'win32'), true);
});

test('cleanup failures are never retried as startup infrastructure', () => {
  assert.equal(isInfrastructureFailure('tests/electron-shell-smoke.test.js', {
    code: 1, terminationFailed: true, output: 'orphaned descendants',
  }, 'win32'), false);
});

test('infrastructure retry returns an unconfirmed timeout termination', async () => {
  const file = 'tests/electron.test.js';
  const state = {
    results: [{
      file,
      code: -1,
      timedOut: false,
      terminationFailed: false,
      collateralKilled: false,
      infrastructureFailure: true,
      attempts: 1,
      durationMs: 1,
      output: 'crash',
      perFileTimeoutMs: 10,
    }],
    activeChildren: new Set(),
  };

  const outcome = await retryInfrastructureFailures(
    { verbose: false },
    state,
    async () => ({
      code: 124,
      timedOut: true,
      terminationFailed: true,
      collateralKilled: false,
      output: 'leaked',
    })
  );

  assert.deepEqual(outcome, { file, terminationFailed: true });
  assert.equal(state.results[0].terminationFailed, true);
});
