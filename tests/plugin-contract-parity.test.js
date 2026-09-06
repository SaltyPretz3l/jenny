'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { validate, SPEC } = require('../services/plugins/contracts/generated-plugin-contracts.js');
const { loadParityCorpus } = require('./helpers/plugins/contract-parity-corpus.js');

const { cases, expectations } = loadParityCorpus();
// Derived from the generated SPEC rather than hand-listed, so a lane adding a
// contract gets the adversarial sweep below for free and never has to edit this
// shared file.
const contractNames = Object.keys(SPEC.contracts).sort();

test('corpus and expectations fixtures stay aligned', () => {
  assert.ok(cases.length >= 60, 'corpus should carry a broad case set');
  const corpusIds = new Set(cases.map((item) => item.id));
  assert.equal(corpusIds.size, cases.length, 'corpus ids must be unique');
  assert.deepEqual(corpusIds, new Set(Object.keys(expectations)), 'every corpus case needs a frozen expectation');
});

test('every registered contract is exercised by the corpus', () => {
  const covered = new Set(cases.map((item) => item.contract));
  const uncovered = contractNames.filter((name) => !covered.has(name));
  assert.deepEqual(uncovered, [], `contracts with no parity cases: ${uncovered.join(', ')}`);
});

for (const item of cases) {
  test(`JS validator matches frozen expectation: ${item.id}`, () => {
    const expected = expectations[item.id];
    const result = validate(item.contract, item.value);
    assert.equal(result.ok, expected.ok, `ok mismatch for ${item.id}`);
    if (expected.ok) {
      assert.equal(result.error, null);
    } else {
      assert.equal(result.error.code, expected.error_code, `error code mismatch for ${item.id}`);
      assert.equal(result.error.path, expected.error_path, `error path mismatch for ${item.id}`);
    }
  });
}

test('plugin validator accepts plain records across realms without admitting class instances', () => {
  const fixture = cases.find((item) => item.id === 'w4_aud_valid_minimal');
  assert.ok(fixture, 'w4_aud_valid_minimal fixture must exist');

  const foreign = vm.runInNewContext('JSON.parse(payload)', {
    payload: JSON.stringify(fixture.value),
  });
  assert.equal(validate(fixture.contract, foreign).ok, true);

  const nullPrototype = Object.assign(Object.create(null), fixture.value);
  assert.equal(validate(fixture.contract, nullPrototype).ok, true);

  const classInstance = Object.assign(new (class Example {})(), fixture.value);
  const classResult = validate(fixture.contract, classInstance);
  assert.equal(classResult.ok, false);
  assert.equal(classResult.error.code, 'unsupported_value_type');

  const arrayResult = validate(fixture.contract, Object.assign([], fixture.value));
  assert.equal(arrayResult.ok, false);
  assert.equal(arrayResult.error.code, 'not_object');
});

// The parity corpus is JSON, and JSON.parse never produces shared references,
// so these two properties are unreachable from fixtures and must be asserted
// in process. Sharing one object across siblings is a DAG, not a cycle; an
// earlier revision tracked every visited node instead of the ancestor chain and
// rejected legitimate payloads as cyclic.
test('an object shared across sibling entries is not a cycle', () => {
  const shared = {
    kind: 'skill',
    contribution_id: 'a',
    name: 'A',
    content_path: 'content/a.json',
    content_sha256: 'a'.repeat(64),
  };
  const value = {
    manifest_schema_version: 1,
    publisher_id: 'acme-labs',
    plugin_id: 'widgets',
    name: 'Widgets Pack',
    version: '1.2.3',
    contract_versions: { manifest: 1, declarative_content: 1, operation_receipt: 1, cleanup_state: 1 },
    contributions: [shared, shared, shared],
    requested_permissions: [],
  };
  const result = validate('PluginManifestV1', value);
  assert.equal(result.ok, false);
  assert.notEqual(result.error.code, 'cycle_detected', 'a DAG must not be reported as a cycle');
  assert.equal(result.error.code, 'unique_by_violation', 'the real facet violation should surface instead');
});

test('a reference back into the current path is still a cycle', () => {
  const value = {
    manifest_schema_version: 1,
    publisher_id: 'acme-labs',
    plugin_id: 'widgets',
    name: 'Widgets Pack',
    version: '1.2.3',
    contract_versions: { manifest: 1, declarative_content: 1, operation_receipt: 1, cleanup_state: 1 },
    contributions: [{
      kind: 'skill',
      contribution_id: 'a',
      name: 'A',
      content_path: 'content/a.json',
      content_sha256: 'a'.repeat(64),
    }],
    requested_permissions: [],
  };
  value.contributions[0].self = value;
  const result = validate('PluginManifestV1', value);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cycle_detected');
});

test('unknown contract name fails closed regardless of payload shape', () => {
  const result = validate('NotARegisteredContractV1', { anything: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown_contract');
});

test('validate never throws on adversarial top-level shapes', () => {
  const adversarial = [null, undefined, 42, 'string', true, [], [1, 2, 3]];
  for (const value of adversarial) {
    for (const contractName of contractNames) {
      const result = validate(contractName, value);
      assert.equal(typeof result.ok, 'boolean');
      assert.equal(result.ok, false);
    }
  }
});

// --- properties JSON fixtures cannot express, so they live in-process --------
// JSON.parse/json.loads can never produce a shared object reference or an
// inherited property name, so the shard corpus and the cross-runtime differ are
// both blind to the cases below.

test('an inherited property name is an unknown contract, not a crash', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const result = validate(name, {});
    assert.equal(result.ok, false, `${name} should not validate`);
    assert.equal(result.error.code, 'unknown_contract');
  }
});

test('a preserved __proto__ field becomes an own key and never the result prototype', () => {
  const hostile = JSON.parse(`{
    "operation_id": "op-1",
    "request_fingerprint": "${'a'.repeat(64)}",
    "generation_id": "gen-0001",
    "lifecycle_epoch": 1,
    "commit_epoch": 1,
    "status": "committed",
    "created_at": "2026-07-30T12:00:00Z",
    "updated_at": "2026-07-30T12:00:01Z",
    "retain_until": "2026-09-01T00:00:00Z",
    "__proto__": {"isAdmin": true}
  }`);
  const result = validate('PluginOperationReceiptV1', hostile);
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.hasOwn(result.value, '__proto__'), true);
  assert.equal(result.value.isAdmin, undefined);
  // The validator must accept its own normalized output.
  assert.equal(validate('PluginOperationReceiptV1', result.value).ok, true);
});

test('composite unique_by keys are framed, so distinct id tuples do not collide', () => {
  const node = (publisherId, pluginId, digit) => ({
    publisher_id: publisherId,
    plugin_id: pluginId,
    resolved_version: '1.0.0',
    artifact_digest: String(digit).repeat(64),
    publisher_key_id: String(digit).repeat(64),
    source_identity: { kind: 'local_package', package_path_digest: String(digit).repeat(64) },
    dependencies: [],
  });
  const distinct = {
    lock_schema_version: 1,
    graph_hash: 'a'.repeat(64),
    // ("ab","cd") and ("a","bcd") both concatenate to "abcd".
    nodes: [node('ab', 'cd', 1), node('a', 'bcd', 2)],
  };
  assert.equal(validate('PluginLockV1', distinct).ok, true);

  const duplicated = { ...distinct, nodes: [node('ab', 'cd', 1), node('ab', 'cd', 2)] };
  const result = validate('PluginLockV1', duplicated);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unique_by_violation');
  assert.equal(result.error.path, 'nodes[1]');
});

test('the structural walk visits keys in sorted order, not JS integer-key order', () => {
  const chain = (depth) => {
    let out = 'leaf';
    for (let i = 0; i < depth; i += 1) out = { d: out };
    return out;
  };
  // JS hoists "0" ahead of "z" in Object.keys; Python preserves insertion
  // order. Sorting in both makes the reported path identical.
  const value = JSON.parse(JSON.stringify({ z: chain(20), 0: chain(20) }));
  const result = validate('PluginRegistryV1', value);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'depth_budget_exceeded');
  assert.ok(result.error.path.startsWith('0.'), `expected sorted-order path, got ${result.error.path}`);
});
