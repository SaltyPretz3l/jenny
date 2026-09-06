'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { retryInfrastructureFailures } = require('../scripts/run-node-tests-safe-reporting');

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
