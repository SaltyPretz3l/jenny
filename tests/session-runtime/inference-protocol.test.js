'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SidecarClient } = require('../../services/backend/sidecar-client');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
  assertRuntimeInferenceProtocol, assertRuntimeOperationsProtocol,
  assertRuntimeContinuationProtocol, assertRuntimeBudgetProtocol } = require('../../services/session-runtime/inference-protocol');

test('plugin-only initialization neither clears nor grants full-runtime protocols', async () => {
  const client = new SidecarClient();
  client.process = {};
  const capabilities = { runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
    runtime_continuation_version: 1, runtime_inference_budget_version: 1 };
  client.request = async () => capabilities;
  await client.initialize({ mode: 'plugin_runtime', plugin_runtime: {} });
  assert.throws(() => assertRuntimeInferenceProtocol(client), 'plugin response cannot grant protocols');
  await client.initialize();
  await client.initialize({ mode: 'plugin_runtime', plugin_runtime: {} });
  assert.equal(assertRuntimeBudgetProtocol(client), true);
  assert.equal(assertRuntimeContinuationProtocol(client), true);
  client.request = async () => { throw new Error('plugin rejected'); };
  await assert.rejects(client.initialize({ mode: 'plugin_runtime', plugin_runtime: {} }), /plugin rejected/);
  assert.equal(assertRuntimeBudgetProtocol(client), true, 'failed plugin-only apply preserves negotiated runtime');
  client.process = {};
  assert.throws(() => assertRuntimeInferenceProtocol(client), 'process replacement still invalidates authority');
});

test('mandatory inference requires the current full-runtime acknowledgement', async () => {
  const client = new SidecarClient();
  client.process = {};
  assert.throws(() => assertRuntimeInferenceProtocol(client), error => error.reason === 'runtime_inference_protocol_required');
  for (const version of [1, undefined, '1', 2, null]) {
    client.request = async () => ({ runtime_inference_admission_version: version });
    await client.initialize();
    if (version === 1) assert.equal(assertRuntimeInferenceProtocol(client), true);
    else assert.throws(() => assertRuntimeInferenceProtocol(client));
  }
  client.request = async () => ({ runtime_inference_admission_version: 1 });
  await client.initialize();
  client.detachProcess();
  assert.throws(() => assertRuntimeInferenceProtocol(client));
});

test('an earlier initializer cannot overwrite a newer negotiated state', () => {
  const client = { process: {} };
  const first = beginRuntimeInferenceInitialization(client);
  const second = beginRuntimeInferenceInitialization(client);
  assert.equal(completeRuntimeInferenceInitialization(client, first, { runtime_inference_admission_version: 1 }), false);
  assert.throws(() => assertRuntimeInferenceProtocol(client));
  assert.equal(completeRuntimeInferenceInitialization(client, second, { runtime_inference_admission_version: 1 }), true);
  assert.equal(assertRuntimeInferenceProtocol(client), true);
  client.process = {};
  assert.throws(() => assertRuntimeInferenceProtocol(client));
});

test('tool dispatch requires the exact current resource protocol acknowledgement', () => {
  const client = { process: {} };
  for (const version of [undefined, '1', 2, null, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: version,
    });
    assert.equal(assertRuntimeInferenceProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeOperationsProtocol(client), true);
    else assert.throws(() => assertRuntimeOperationsProtocol(client),
      error => error.reason === 'runtime_tool_resource_protocol_required');
  }
  client.process = {};
  assert.throws(() => assertRuntimeOperationsProtocol(client));
});

test('continuations require current process and initializer acknowledgement in addition to resource protocols', () => {
  const client = { process: {} };
  for (const version of [undefined, true, '1', 2, null, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
      runtime_continuation_version: version,
    });
    assert.equal(assertRuntimeOperationsProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeContinuationProtocol(client), true);
    else assert.throws(() => assertRuntimeContinuationProtocol(client),
      error => error.reason === 'runtime_continuation_protocol_required');
  }
  const old = beginRuntimeInferenceInitialization(client);
  beginRuntimeInferenceInitialization(client);
  assert.equal(completeRuntimeInferenceInitialization(client, old, {
    runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
    runtime_continuation_version: 1,
  }), false);
  assert.throws(() => assertRuntimeContinuationProtocol(client));
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1,
    runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1 });
  client.process = {};
  assert.throws(() => assertRuntimeContinuationProtocol(client));
});


test('budget-required dispatch needs its own current-process acknowledgement', () => {
  const client = { process: {} };
  for (const version of [undefined, null, true, '1', 2, 1]) {
    const token = beginRuntimeInferenceInitialization(client);
    completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1,
      runtime_tool_resource_admission_version: 1, runtime_inference_budget_version: version });
    assert.equal(assertRuntimeOperationsProtocol(client), true);
    if (version === 1) assert.equal(assertRuntimeBudgetProtocol(client), true);
    else assert.throws(() => assertRuntimeBudgetProtocol(client),
      error => error.reason === 'runtime_inference_budget_protocol_required');
  }
  client.process = {};
  assert.throws(() => assertRuntimeBudgetProtocol(client));
});
