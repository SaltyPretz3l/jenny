'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OWNED_ENGINE_TUNING_KEYS,
  cloneEngineTuning,
  engineTuningMethods,
  harvestLegacyEngineTuning,
  normalizeEngineTuning,
  stripLegacyEngineTuningKeys,
} = require('../services/shell-config-engine-tuning');
const { getFieldDefinition } = require('../renderer/shared/engine-tuning-schema');

/* Minimal stand-in for ShellConfigService: the methods are installed onto a
 * prototype in production, so exercising them against a bare host with a
 * recording _writeState keeps this a unit test of the methods themselves. */
function createHost(engineTuning = {}) {
  const host = {
    state: { engineTuning: { ...engineTuning } },
    writes: [],
    ...engineTuningMethods,
  };
  host._writeState = (nextState, reason) => {
    host.state = nextState;
    host.writes.push(reason);
    return nextState;
  };
  return host;
}

test('normalizeEngineTuning keeps only in-bounds non-default overrides', () => {
  const normalized = normalizeEngineTuning({
    maxToolsPerTurn: 7,
    maxSubAgentConcurrency: 4,
  });
  assert.deepEqual(normalized, { maxToolsPerTurn: 7, maxSubAgentConcurrency: 4 });
});

test('normalizeEngineTuning drops out-of-bounds values instead of clamping', () => {
  // Clamping here would show the user a value the sidecar never received:
  // config.py's _as_bounded_int falls back to its default for out-of-range input.
  const normalized = normalizeEngineTuning({ maxToolsPerTurn: 5000, maxSubAgentConcurrency: 0 });
  assert.deepEqual(normalized, {});
});

test('normalizeEngineTuning drops values equal to the sidecar default', () => {
  // This is what makes "modified" equivalent to hasOwnProperty downstream.
  const field = getFieldDefinition('maxToolsPerTurn');
  const normalized = normalizeEngineTuning({ maxToolsPerTurn: field.default });
  assert.deepEqual(normalized, {});
});

test('normalizeEngineTuning ignores unknown keys and malformed input', () => {
  assert.deepEqual(normalizeEngineTuning({ notAField: 3 }), {});
  assert.deepEqual(normalizeEngineTuning({ maxToolsPerTurn: 'seven' }), {});
  assert.deepEqual(normalizeEngineTuning({ maxToolsPerTurn: null }), {});
  assert.deepEqual(normalizeEngineTuning(null), {});
  assert.deepEqual(normalizeEngineTuning([1, 2, 3]), {});
  assert.deepEqual(normalizeEngineTuning('nope'), {});
});

test('maxBudgetUsd is owned by this block like every other field', () => {
  // It previously lived as a bare top-level key that nothing could write. One
  // owned storage path means one write path; the managed-sidecar resolver's
  // legacy-key fallback is what keeps an old config readable.
  assert.ok(OWNED_ENGINE_TUNING_KEYS.includes('maxBudgetUsd'));
  assert.deepEqual(normalizeEngineTuning({ maxBudgetUsd: 5 }), { maxBudgetUsd: 5 });
});

test('a legacy top-level maxBudgetUsd is harvested into the block', () => {
  const harvested = harvestLegacyEngineTuning({ maxBudgetUsd: 12.5 });
  assert.equal(harvested.maxBudgetUsd, 12.5);
});

test('cloneEngineTuning returns a detached copy', () => {
  const source = { maxToolsPerTurn: 7 };
  const clone = cloneEngineTuning(source);
  clone.maxToolsPerTurn = 99;
  assert.equal(source.maxToolsPerTurn, 7);
});

test('harvestLegacyEngineTuning rescues both flat spellings', () => {
  const harvested = harvestLegacyEngineTuning({
    maxToolsPerTurn: 7,
    max_sub_agent_concurrency: 4,
    maxLoopIterations: 999,
  });
  assert.equal(harvested.maxToolsPerTurn, 7);
  assert.equal(harvested.maxSubAgentConcurrency, 4);
  // Out-of-bounds legacy junk is dropped rather than migrated forward.
  assert.ok(!('maxLoopIterations' in harvested));
});

test('harvestLegacyEngineTuning is idempotent over an already-nested block', () => {
  // Every `if (version < N)` block runs in sequence for an old file, so the
  // harvest must survive being handed its own output.
  const once = harvestLegacyEngineTuning({ maxToolsPerTurn: 7 });
  const twice = harvestLegacyEngineTuning({ engineTuning: once });
  assert.deepEqual(twice, once);
});

test('harvestLegacyEngineTuning prefers the nested block over a stale flat key', () => {
  const harvested = harvestLegacyEngineTuning({
    engineTuning: { maxToolsPerTurn: 7 },
    maxToolsPerTurn: 3,
  });
  assert.equal(harvested.maxToolsPerTurn, 7);
});

test('stripLegacyEngineTuningKeys removes both spellings', () => {
  const target = { maxToolsPerTurn: 7, max_tools_per_turn: 7, keepMe: 1 };
  stripLegacyEngineTuningKeys(target);
  assert.deepEqual(target, { keepMe: 1 });
});

test('updateEngineTuning stores an override and writes once', () => {
  const host = createHost();
  const next = host.updateEngineTuning({ maxToolsPerTurn: 7 });
  assert.equal(next.maxToolsPerTurn, 7);
  assert.deepEqual(host.writes, ['engine_tuning_updated']);
});

test('updateEngineTuning short-circuits an identical write', () => {
  // A redundant write would trigger a needless sidecar reinitialise.
  const host = createHost({ maxToolsPerTurn: 7 });
  host.updateEngineTuning({ maxToolsPerTurn: 7 });
  assert.deepEqual(host.writes, []);
});

test('updateEngineTuning treats null as a reset for that key', () => {
  const host = createHost({ maxToolsPerTurn: 7, maxSubAgentConcurrency: 4 });
  const next = host.updateEngineTuning({ maxToolsPerTurn: null });
  assert.ok(!('maxToolsPerTurn' in next));
  assert.equal(next.maxSubAgentConcurrency, 4);
});

test('updateEngineTuning clears rather than retains on an invalid value', () => {
  // Retaining the old override would leave the UI and the engine disagreeing
  // about a field the user just tried to change.
  const host = createHost({ maxToolsPerTurn: 7 });
  const next = host.updateEngineTuning({ maxToolsPerTurn: 5000 });
  assert.ok(!('maxToolsPerTurn' in next));
});

test('resetEngineTuning with no scope clears everything in one write', () => {
  const host = createHost({ maxToolsPerTurn: 7, maxSubAgentConcurrency: 4 });
  const next = host.resetEngineTuning();
  assert.deepEqual(next, {});
  assert.deepEqual(host.writes, ['engine_tuning_reset'], 'exactly one write, not one per key');
});

test('resetEngineTuning scoped to a pane spares the other pane', () => {
  const host = createHost({
    maxToolsPerTurn: 7,             // local
    cloudMaxToolsPerTurn: 150,      // cloud
    maxSubAgentLoopIterations: 12,  // shared
  });
  const next = host.resetEngineTuning('local');
  assert.ok(!('maxToolsPerTurn' in next), 'local field cleared');
  assert.ok(!('maxSubAgentLoopIterations' in next), 'shared field clears from either pane');
  assert.equal(next.cloudMaxToolsPerTurn, 150, 'cloud field untouched');
});

test('resetEngineTuning on an already-clean block does not write', () => {
  const host = createHost();
  host.resetEngineTuning();
  assert.deepEqual(host.writes, []);
});

test('resolveEngineTuningValue distinguishes an override from unset', () => {
  const host = createHost({ maxToolsPerTurn: 7 });
  assert.equal(host.resolveEngineTuningValue('maxToolsPerTurn'), 7);
  assert.equal(host.resolveEngineTuningValue('maxLoopIterations'), null);
  assert.equal(host.resolveEngineTuningValue('notAField'), null);
});
