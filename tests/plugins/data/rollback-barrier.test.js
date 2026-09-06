'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BLOCK_REASONS, GUIDANCE_CODES, evaluateRollback } = require('../../../services/plugins/data/rollback-barrier.js');

const fixture = require('../../fixtures/plugins/compat-corpus/rollbacks.json');

test('module exposes the closed block-reason and guidance vocabularies', () => {
  assert.deepEqual(BLOCK_REASONS, ['watermark_regression', 'rollback_barrier_active', 'unvalidated_writes_since_snapshot']);
  assert.deepEqual(GUIDANCE_CODES, ['export_current_data', 'contact_publisher_for_downgrade_path', 'manual_merge_required']);
});

for (const scenario of fixture.scenarios) {
  test(`rollback scenario: ${scenario.id}`, () => {
    const result = evaluateRollback({
      barrier: scenario.barrier,
      mutationWatermark: scenario.mutationWatermark,
      targetWatermark: scenario.targetWatermark,
      downgrade: scenario.downgrade,
    });

    assert.equal(result.permitted, scenario.expected.permitted, `permitted mismatch for ${scenario.id}`);
    assert.equal(result.reason, scenario.expected.reason, `reason mismatch for ${scenario.id}`);
    for (const [key, value] of Object.entries(scenario.expected.detail)) {
      assert.deepEqual(result.detail[key], value, `detail.${key} mismatch for ${scenario.id}`);
    }
  });
}

test('a blocked rollback always carries the full fixed guidance list', () => {
  const result = evaluateRollback({
    barrier: { kind: 'none' },
    mutationWatermark: { sequence: 9, recordedAt: '2026-07-30T10:00:00Z' },
    targetWatermark: { sequence: 1, recordedAt: '2026-07-29T09:00:00Z' },
    downgrade: null,
  });
  assert.equal(result.permitted, false);
  assert.deepEqual(result.detail.guidance, GUIDANCE_CODES);
});

test('a permitted rollback carries no guidance field requirement and reports zero risk', () => {
  const result = evaluateRollback({
    barrier: { kind: 'none' },
    mutationWatermark: { sequence: 4, recordedAt: '2026-07-30T10:00:00Z' },
    targetWatermark: { sequence: 4, recordedAt: '2026-07-30T10:00:00Z' },
    downgrade: null,
  });
  assert.equal(result.permitted, true);
  assert.equal(result.reason, null);
  assert.equal(result.detail.writesPreserved, 0);
});

test('malformed watermarks fail closed instead of throwing', () => {
  const result = evaluateRollback({
    barrier: { kind: 'none' },
    mutationWatermark: { sequence: 'not-a-number', recordedAt: '2026-07-30T10:00:00Z' },
    targetWatermark: { sequence: 1, recordedAt: '2026-07-29T09:00:00Z' },
    downgrade: null,
  });
  assert.equal(result.permitted, false);
  assert.equal(result.reason, 'watermark_regression');
});
