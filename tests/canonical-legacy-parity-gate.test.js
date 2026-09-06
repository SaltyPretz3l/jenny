'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runParityGate,
} = require('../scripts/checks/check_canonical_legacy_parity');
const {
  PARITY_SCENARIOS,
} = require('../scripts/checks/lib/canonical-turn-parity-scenarios');

test('canonical/legacy parity gate runs the full corpus and returns evidence', async () => {
  const report = await runParityGate();

  assert.ok(report && typeof report === 'object');
  assert.ok(Array.isArray(report.scenarios));
  assert.equal(report.scenarios.length, PARITY_SCENARIOS.length);
  assert.deepEqual(report.summary, {
    scenarios: PARITY_SCENARIOS.length,
    divergent_count: report.scenarios.filter((entry) => entry.divergent).length,
  });
  for (const entry of report.scenarios) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.divergent, 'boolean');
    assert.ok(entry.first_diff === null || typeof entry.first_diff === 'object');
    assert.equal(Number.isInteger(entry.a_count), true);
    assert.equal(Number.isInteger(entry.b_count), true);
  }
});
