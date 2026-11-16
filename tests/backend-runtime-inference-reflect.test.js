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

// Slice 4b member wiring, fix list items 3 and 19: while a team model is loaded only the chat that chose it
// reaches the team host. One case per caller of requestRuntimeInference, with the params that caller sends.
test('4b member wiring: a loaded team model refuses every caller but its own chat, through the runtime and the legacy path', async () => {
  const selection = { id: 'team/team_alpha1/alpha', teamId: 'team_alpha1', modelId: 'alpha' };
  const withTeam = (target) => Object.assign(target, { currentEngineType: 'openai-compatible', _teamEngineSelection: selection,
    configService: { getState: () => ({ localEngines: { openaiCompatible: { apiUrl: 'http://127.0.0.1:8080/v1' } } }) } });
  const target = withTeam(service());
  const legacyCalls = [];
  const legacy = withTeam({ featureFlags: {}, _emitServiceLog() {}, sidecarClient: {
    request: async (method) => { legacyCalls.push(method); return {}; } } });
  // backend-suggestions.js (titles, memory titles, the briefing) and backend-commit.js (the staged diff).
  for (const [method, params] of [['suggestions.generate', { recent_session_titles: ['t'] }],
    ['commit.generate_message', { diff: 'd' }]]) {
    for (const owner of [target, legacy]) {
      await assert.rejects(requestRuntimeInference(owner, method, params),
        (error) => error.reason === 'team_engine_other_chat' && error.error_code === 'CMP-TEAM-0010', method);
    }
  }
  // memory-reflection-run.js / memory-reflection-scheduler.js and session-auto-title.js: refused as not local.
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' }, { sessionId: 's1' }),
    (error) => error.reason === 'runtime_route_not_local');
  await assert.rejects(requestRuntimeInference(target, 'session.generate_title', { messages: [] }),
    (error) => error.reason === 'runtime_route_not_local');
  assert.deepEqual([target.calls.length, legacyCalls.length], [0, 0], 'no text left for the team host');
  assert.equal(target.sessionRuntime.lanes.snapshot().active_leases, 0);
  // chat.compact and handoff.generate_note (backend-chat-stream.js, backend-handoff.js) pass this gate: their
  // own team_engine_other_chat check runs in prepareSessionHistoryRequest (backend-service-compact-context).
  await requestRuntimeInference(legacy, 'handoff.generate_note', { session_id: 's1' }, { sessionId: 's1' });
  assert.deepEqual(legacyCalls, ['handoff.generate_note']);
});
