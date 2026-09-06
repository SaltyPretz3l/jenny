'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m3Gate = require('../scripts/checks/check_canonical_turn_m3_gate');
const {
  runParityGate,
} = require('../scripts/checks/check_canonical_legacy_parity');

function findMatchingKeys(value, matcher, matches = []) {
  if (!value || typeof value !== 'object') {
    return matches;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (matcher.test(key)) {
      matches.push(key);
    }
    findMatchingKeys(nestedValue, matcher, matches);
  }
  return matches;
}

test('canonical M3 gate exports its report seam', () => {
  assert.equal(typeof m3Gate.runGate, 'function');
});

test('canonical M3 gate report uses real parity divergence evidence', async () => {
  const parityReport = await runParityGate();
  const report = await m3Gate.runGate();
  const divergentNames = parityReport.scenarios
    .filter((scenario) => scenario.divergent)
    .map((scenario) => scenario.name);

  assert.equal(
    report.metrics.counters.live_replay_divergence_count,
    parityReport.summary.divergent_count
  );
  if (parityReport.summary.divergent_count > 0) {
    assert.equal(report.gate.passed, true);
    assert.equal(report.gate.decision, 'proceed_to_m3');
  }
  const deletedReductionKey = new RegExp(['prototype', 'reduction'].join('_'));
  assert.deepEqual(findMatchingKeys(report, deletedReductionKey), []);
  assert.equal(report.schema_version, 2);
  assert.deepEqual(report.parity, {
    scenarios: parityReport.summary.scenarios,
    divergent_count: parityReport.summary.divergent_count,
    divergent_scenarios: divergentNames,
  });
});
