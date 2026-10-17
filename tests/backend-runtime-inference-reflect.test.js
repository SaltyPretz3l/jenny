'use strict';

// memory.reflect (agentic memory v2, row 58 W2) is a session-scoped auxiliary
// method like chat.compact, and its route is forced to a local engine.

const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeLaneAdmission } = require('../services/session-runtime/lanes');
const { requestRuntimeInference } = require('../services/backend/backend-runtime-inference');
const {
  beginRuntimeInferenceInitialization,
  completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');

function service() {
  const calls = [];
  const client = { process: {}, runtimeOperationHandlers: new Map(), async request(method, params) {
    calls.push({ method, params });
    return {};
  } };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1 });
  return { calls, currentEngineType: 'mock', configService: { getState: () => ({}) }, sidecarClient: client,
    featureFlags: { session_runtime: true }, _emitServiceLog() {},
    sessionRuntime: { lanes: new RuntimeLaneAdmission(), scheduler: { closing: false } } };
}

test('memory.reflect is session-scoped: it needs a matching session id', async () => {
  const target = service();
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' }),
    /runtime_auxiliary_scope_invalid/u);
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's2' }, { sessionId: 's1' }),
    /runtime_auxiliary_scope_invalid/u);
  assert.equal(target.calls.length, 0);
});

test('memory.reflect refuses a cloud route before taking any capacity', async () => {
  const target = service();
  for (const engineType of ['chatgpt', 'codex-cli']) {
    await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' },
      { sessionId: 's1', engineType }), error => error.reason === 'runtime_route_not_local');
  }
  target.currentEngineType = 'chatgpt';
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' }, { sessionId: 's1' }),
    error => error.reason === 'runtime_route_not_local');
  assert.equal(target.calls.length, 0);
  assert.equal(target.sessionRuntime.lanes.snapshot().active_leases, 0);
});

test('the engineType override is reserved for memory.reflect', async () => {
  const target = service();
  await assert.rejects(requestRuntimeInference(target, 'commit.generate_message', { diff: 'd' },
    { engineType: 'mock' }), /runtime_auxiliary_scope_invalid/u);
});

test('memory.reflect refuses an OpenAI-compatible endpoint that is not on this machine', async () => {
  const { localReflectionEngine } = require('../services/backend/memory-reflection-eligibility');
  const target = service();
  const withUrl = apiUrl => {
    target.configService = { getState: () => ({ localEngines: { openaiCompatible: { apiUrl } } }) };
    target.currentEngineType = 'openai-compatible';
  };
  for (const apiUrl of ['https://api.example.com/v1', 'http://192.168.1.20:8080/v1']) {
    withUrl(apiUrl);
    assert.equal(localReflectionEngine(target), null, apiUrl);
    await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' },
      { sessionId: 's1', engineType: 'openai-compatible' }), error => error.reason === 'runtime_route_not_local');
  }
  assert.equal(target.calls.length, 0);
  assert.equal(target.sessionRuntime.lanes.snapshot().active_leases, 0);
  withUrl('http://127.0.0.1:8080/v1');
  assert.equal(localReflectionEngine(target), 'openai-compatible');
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' },
    { sessionId: 's1', engineType: 'openai-compatible' }), error => error.reason !== 'runtime_route_not_local');
});
