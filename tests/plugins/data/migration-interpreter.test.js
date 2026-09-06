'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXECUTOR_TIERS,
  DEFAULT_ENABLED_EXECUTOR_TIERS,
  STEP_KINDS,
  DEFAULT_LIMITS,
  evaluateMigration,
} = require('../../../services/plugins/data/migration-interpreter.js');

const fixture = require('../../fixtures/plugins/compat-corpus/migrations.json');

test('module exposes the closed constants the architecture requires', () => {
  assert.deepEqual(EXECUTOR_TIERS, ['declarative', 'restricted', 'full_host']);
  assert.deepEqual(DEFAULT_ENABLED_EXECUTOR_TIERS, ['declarative']);
  assert.deepEqual(STEP_KINDS, [
    'rename_field',
    'set_default',
    'drop_field',
    'map_enum_value',
    'wrap_object',
    'unwrap_object',
  ]);
  assert.equal(DEFAULT_LIMITS.maxSteps, 64);
});

for (const scenario of fixture.scenarios) {
  test(`migration scenario: ${scenario.id}`, () => {
    const result = evaluateMigration({
      migration: scenario.migration,
      input: scenario.input,
      enabledExecutorTiers: scenario.enabledExecutorTiers,
      limits: scenario.limits,
    });

    assert.equal(result.ok, scenario.expected.ok, `ok mismatch for ${scenario.id}`);
    if (scenario.expected.ok) {
      assert.deepEqual(result.value, scenario.expected.value, `value mismatch for ${scenario.id}`);
    } else {
      assert.equal(result.outcome, scenario.expected.outcome, `outcome mismatch for ${scenario.id}`);
      assert.equal(result.reason, scenario.expected.reason, `reason mismatch for ${scenario.id}`);
      assert.equal(
        result.detail.recommendedAction,
        scenario.expected.recommendedAction,
        `recommendedAction mismatch for ${scenario.id}`,
      );
    }
  });
}

test('evaluateMigration never mutates the caller-supplied input object', () => {
  const input = { notes_text: 'buy milk', status: 'todo' };
  const frozenCopy = JSON.parse(JSON.stringify(input));
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'rename_field', path: [], from: 'notes_text', to: 'body' }],
    },
    input,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(input, frozenCopy, 'the original input must be untouched');
  assert.notDeepEqual(result.value, input);
});

test('rename_field into an existing target field is a collision, not a silent overwrite', () => {
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'rename_field', path: [], from: 'a', to: 'b' }],
    },
    input: { a: 1, b: 2 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'migration_failed');
  assert.equal(result.reason, 'rename_target_collision');
});

test('input node budget rejects a migration whose input is already too large', () => {
  const bigArray = new Array(10).fill(0).map((_, i) => i);
  const result = evaluateMigration({
    migration: { executorTier: 'declarative', steps: [{ kind: 'set_default', path: [], field: 'extra', value: 'x' }] },
    input: { list: bigArray },
    limits: { maxOutputNodes: 5 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'input_size_exceeded');
});

test('output node budget rejects a migration whose result grows past the limit', () => {
  // Input is under budget (2 nodes: the object + one leaf); four set_default
  // steps grow it to 6 nodes (object + five leaves), which exceeds the cap.
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [
        { kind: 'set_default', path: [], field: 'b', value: 1 },
        { kind: 'set_default', path: [], field: 'c', value: 2 },
        { kind: 'set_default', path: [], field: 'd', value: 3 },
        { kind: 'set_default', path: [], field: 'e', value: 4 },
      ],
    },
    input: { a: 0 },
    limits: { maxOutputNodes: 5 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'output_size_exceeded');
});

test('a non-object step is rejected as malformed rather than crashing', () => {
  const result = evaluateMigration({
    migration: { executorTier: 'declarative', steps: [null] },
    input: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'migration_failed');
  assert.equal(result.reason, 'unknown_step_kind');
});

// A declarative migration is meant to be the SAFE tier: data-only edits, no
// plugin code. Prototype reachability would make it strictly more powerful than
// that promise, so every route to Object.prototype is pinned here.
test('a migration path cannot traverse __proto__ into Object.prototype', () => {
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'set_default', path: ['__proto__'], field: 'polluted', value: 'yes' }],
    },
    input: { some: 'state' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'path_not_found');
  assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
});

test('a migration cannot reach an inherited field through the prototype chain', () => {
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'drop_field', path: ['constructor'], field: 'name' }],
    },
    input: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'path_not_found');
});

test('writing a field literally named __proto__ stores data, never a prototype', () => {
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'set_default', path: [], field: '__proto__', value: 'inert' }],
    },
    input: {},
  });
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(result.value, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});

test('unwrap_object cannot use __proto__ as its target field to swap a prototype', () => {
  const result = evaluateMigration({
    migration: {
      executorTier: 'declarative',
      steps: [{ kind: 'unwrap_object', path: [], field: '__proto__', from: 'x' }],
    },
    input: { keep: 1 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'field_not_found');
});
