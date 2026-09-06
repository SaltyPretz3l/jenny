'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'config', 'workspace-mutation-journal-v1.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const example = schema.examples[0];
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
const validate = ajv.compile(schema);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveSchema(candidate) {
  if (!candidate || typeof candidate !== 'object' || !candidate.$ref) return candidate;
  assert.match(candidate.$ref, /^#\//);
  return candidate.$ref.slice(2).split('/').reduce((current, part) => current[part], schema);
}

function schemaForValue(candidate, value) {
  const resolved = resolveSchema(candidate);
  if (!Array.isArray(resolved.anyOf)) return resolved;
  return resolveSchema(resolved.anyOf.find((option) => {
    const branch = resolveSchema(option);
    if (branch.type === 'null') return value === null;
    if (branch.type === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
    return true;
  }));
}

function deleteAtPath(root, parts) {
  const mutated = clone(root);
  const parent = parts.slice(0, -1).reduce((current, part) => current[part], mutated);
  delete parent[parts.at(-1)];
  return mutated;
}

function requiredFieldMutations(value, candidate, parts = [], cases = [], root = value) {
  const currentSchema = schemaForValue(candidate, value);
  if (!currentSchema || value === null) return cases;
  if (Array.isArray(value)) {
    value.forEach((item, index) => requiredFieldMutations(
      item, currentSchema.items, [...parts, index], cases, root
    ));
    return cases;
  }
  if (typeof value !== 'object') return cases;
  for (const key of currentSchema.required || []) {
    cases.push({ label: [...parts, key].join('.'), mutated: deleteAtPath(root, [...parts, key]) });
  }
  for (const [key, child] of Object.entries(value)) {
    if (currentSchema.properties?.[key]) {
      requiredFieldMutations(child, currentSchema.properties[key], [...parts, key], cases, root);
    }
  }
  return cases;
}

function assertClosedObjects(candidate, seen = new Set()) {
  const current = resolveSchema(candidate);
  if (!current || typeof current !== 'object' || seen.has(current)) return;
  seen.add(current);
  if (current.type === 'object' || current.properties) {
    assert.equal(current.additionalProperties, false, `${current.title || current.$id || 'object'} is open`);
  }
  for (const child of Object.values(current.properties || {})) assertClosedObjects(child, seen);
  if (current.items) assertClosedObjects(current.items, seen);
  for (const child of current.anyOf || []) assertClosedObjects(child, seen);
  for (const child of Object.values(current.$defs || {})) assertClosedObjects(child, seen);
}

test('workspace mutation journal design example validates against AJV', () => {
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  assert.equal(example.operations.length, 3);
  assert.deepEqual(example.operations.map((operation) => operation.kind), ['move', 'move', 'delete']);
});

test('workspace mutation journal admits Explorer move attribution without chat tool ids', () => {
  const explorer = clone(example);
  Object.assign(explorer, { actor: 'explorer', session_id: null, turn_id: null, tool_call_ids: [] });
  explorer.operations = [clone(example.operations[0])];
  explorer.operations[0].sequence = 1;
  explorer.operations[0].tool_name = 'explorer_rename';
  explorer.operation_count = 1;
  explorer.completed_sequences = [1];
  assert.equal(validate(explorer), true, JSON.stringify(validate.errors));
});

test('workspace mutation journal schema closes every object shape', () => {
  assertClosedObjects(schema);
});

test('workspace mutation journal rejects every required-field deletion', async (t) => {
  const expanded = clone(example);
  expanded.restore.decisions = [
    { inverse_step_id: '1.1', outcome: 'alternate_name', alternate_relative_path: 'restored/a.txt' },
  ];
  expanded.restore.staging_entries = [{
    inverse_step_id: '1.1',
    stage_relative_path: '.jenny-restore-01990f9a-1-nonce',
    expected_signature: clone(example.operations[0].destination.post_signature),
  }];
  expanded.restore.protected_occupants = [{
    ...clone(example.operations[2].recovery_objects[0]), role: 'protected_occupant',
  }];
  expanded.restore.partial_result = {
    restored: 1, skipped: 0, alternate_name: 0,
    protected_then_replaced: 0, conflicts: 0, warning: '',
  };
  assert.equal(validate(expanded), true, JSON.stringify(validate.errors));
  const cases = requiredFieldMutations(expanded, schema);
  assert.ok(cases.length > 50, `expected broad required-field coverage, got ${cases.length}`);
  for (const { label, mutated } of cases) {
    await t.test(label, () => {
      assert.equal(validate(mutated), false, `${label} was incorrectly accepted`);
      assert.ok(validate.errors.some((error) => error.keyword === 'required'));
    });
  }
});

test('workspace mutation journal rejects unknown fields and unsafe relative paths', () => {
  const unknown = clone(example);
  unknown.workspace.unexpected = true;
  assert.equal(validate(unknown), false);
  assert.ok(validate.errors.some((error) => error.keyword === 'additionalProperties'));

  const unsafe = clone(example);
  unsafe.operations[0].source.relative_path = '../outside.txt';
  assert.equal(validate(unsafe), false);
  assert.ok(validate.errors.some((error) => error.keyword === 'pattern'));
});
