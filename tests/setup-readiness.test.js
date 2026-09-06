'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSetupReadinessProbe,
  normalizeSetupEngineType,
  normalizeSetupCloudEngineType,
  countSetupLocalModels,
  countSetupCloudModels,
  SETUP_CLOUD_ENGINES,
} = require('../services/main/setup-readiness');
const {
  CLOUD_ENGINE_TYPES,
} = require('../services/backend/managed-sidecar-chat-helpers');

// ---------------------------------------------------------------------------
// normalizeSetupEngineType
// ---------------------------------------------------------------------------

test('normalizeSetupEngineType: OLLAMA uppercased -> ollama', (t) => {
  assert.equal(normalizeSetupEngineType('OLLAMA'), 'ollama');
});

test('normalizeSetupEngineType: openai_compatible with underscore -> openai-compatible', (t) => {
  assert.equal(normalizeSetupEngineType('openai_compatible'), 'openai-compatible');
});

test('normalizeSetupEngineType: garbage string -> empty string', (t) => {
  assert.equal(normalizeSetupEngineType('garbage'), '');
});

test('normalizeSetupEngineType: vllm -> vllm (known engine)', (t) => {
  assert.equal(normalizeSetupEngineType('vllm'), 'vllm');
});

test('normalizeSetupEngineType: empty string -> empty string', (t) => {
  assert.equal(normalizeSetupEngineType(''), '');
});

test('normalizeSetupEngineType: null -> empty string', (t) => {
  assert.equal(normalizeSetupEngineType(null), '');
});

// ---------------------------------------------------------------------------
// countSetupLocalModels
// ---------------------------------------------------------------------------

test('countSetupLocalModels: empty provider string counts as local (no provider)', (t) => {
  // An untagged entry counts only because the catalog engine itself is local;
  // local-tagged entries count, while cloud-tagged and unavailable entries do not.
  const payload = { data: [
    { id: 'a', provider: 'ollama' },
    { id: 'b', provider: 'cloud' },
    { id: 'c', provider: '' },
    { id: 'plugin-model', engine_type: 'ollama', available: false },
  ] };
  assert.equal(countSetupLocalModels(payload, 'ollama'), 2);
});

test('countSetupLocalModels: no data array -> 0', (t) => {
  assert.equal(countSetupLocalModels({}, 'ollama'), 0);
});

test('countSetupLocalModels: null payload -> 0', (t) => {
  assert.equal(countSetupLocalModels(null, 'ollama'), 0);
});

test('countSetupLocalModels: all matching providers -> all counted', (t) => {
  const payload = { data: [{ id: 'a', provider: 'ollama' }, { id: 'b', provider: 'ollama' }] };
  assert.equal(countSetupLocalModels(payload, 'ollama'), 2);
});

test('countSetupLocalModels: vllm is a known SETUP_LOCAL_ENGINE so counted regardless of engineType', (t) => {
  const payload = { data: [{ id: 'a', provider: 'vllm' }, { id: 'b', provider: 'cloud' }] };
  // 'vllm' is in SETUP_LOCAL_ENGINES -> counted; 'cloud' is not -> excluded
  assert.equal(countSetupLocalModels(payload, 'ollama'), 1);
});

// ---------------------------------------------------------------------------
// createSetupReadinessProbe — no backend service
// ---------------------------------------------------------------------------

test('probeSetupReadiness: no backend -> all local fields false/0', async (t) => {
  const probe = createSetupReadinessProbe({ getBackendService: () => null });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.local_model_available, false);
  assert.equal(result.local_endpoint_available, false);
  assert.equal(result.local_model_count, 0);
  assert.equal(result.catalog_available, false);
  assert.equal(result.catalog_pending, false);
  assert.equal(result.catalog_source, '');
  assert.equal(result.catalog_cached, false);
  assert.equal(result.catalog_stale, false);
  assert.match(result.reason, /unavailable/i);
});

test('probeSetupReadiness: no backend -> concrete runtime fields (not just types)', async (t) => {
  const probe = createSetupReadinessProbe({ getBackendService: () => null });
  const result = await probe.probeSetupReadiness();
  // Assert the actual values the no-backend branch must return, not just their
  // types. Each flips red if that branch's derivation changes: runtime_ready is
  // false (no model_loaded / readiness / phase=ready), runtime_model_loaded is
  // false, and runtime_engine is '' (no engine resolvable without a backend).
  assert.equal(result.runtime_ready, false);
  assert.equal(result.runtime_model_loaded, false);
  assert.equal(result.runtime_engine, '');
});

// ---------------------------------------------------------------------------
// createSetupReadinessProbe — delegation + shape (stub with call recording)
// ---------------------------------------------------------------------------

test('probeSetupReadiness: delegates to listModels and returns correct shape', async (t) => {
  let listCalls = 0;

  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => {
      listCalls++;
      return {
        available: true,
        engine_type: 'ollama',
        data: [{ id: 'a', provider: 'ollama' }, { id: 'b', provider: 'ollama' }],
      };
    },
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  // Confirm listModels was actually called exactly once
  assert.equal(listCalls, 1, 'listModels must be called exactly once');

  // Shape assertions — each must fail if the logic changes
  assert.equal(result.local_model_available, true);
  assert.equal(result.local_model_count, 2);
  assert.equal(result.local_endpoint_available, true);
  assert.equal(result.runtime_ready, true);
  assert.equal(result.runtime_engine, 'ollama');
});

// ---------------------------------------------------------------------------
// runtime_ready derivation via model_loaded
// ---------------------------------------------------------------------------

test('probeSetupReadiness: model_loaded=true makes runtime_ready true even without phase=ready', async (t) => {
  const backendService = {
    currentStatus: { phase: 'starting', model_loaded: true },
    listModels: async () => ({ available: false }),
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.runtime_ready, true,
    'runtime_ready must be true when model_loaded===true');
});

test('probeSetupReadiness: phase=starting and model_loaded=false -> runtime_ready false', async (t) => {
  let listCalls = 0;
  const backendService = {
    currentStatus: { phase: 'starting', model_loaded: false },
    listModels: async () => {
      listCalls += 1;
      return { available: false };
    },
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.runtime_ready, false,
    'runtime_ready must be false when model_loaded is false and phase is not ready');
  assert.equal(result.catalog_pending, true);
  assert.equal(listCalls, 0, 'catalog discovery must wait for backend startup');
});

test('probeSetupReadiness exposes live catalog cache provenance', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => ({
      available: true,
      engine_type: 'ollama',
      source: 'disk-cache',
      cached: true,
      stale: true,
      data: [{ id: 'a', provider: 'ollama' }],
    }),
  };
  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();
  assert.equal(result.catalog_pending, false);
  assert.equal(result.catalog_source, 'disk-cache');
  assert.equal(result.catalog_cached, true);
  assert.equal(result.catalog_stale, true);
});

test('probeSetupReadiness degrades and logs when backend access throws', async () => {
  const events = [];
  const result = await createSetupReadinessProbe({
    getBackendService: () => { throw new Error('disposed'); },
    emitLog: (level, event, details) => events.push([level, event, details]),
  }).probeSetupReadiness();

  assert.equal(result.catalog_available, false);
  assert.equal(result.runtime_ready, false);
  assert.equal(events[0][1], 'setup.readiness_backend_access_failed');
  assert.match(events[0][2].message, /disposed/);
});

test('probeSetupReadiness degrades and logs when catalog discovery rejects', async () => {
  const events = [];
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => { throw new Error('timeout'); },
  };
  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
    emitLog: (level, event, details) => events.push([level, event, details]),
  }).probeSetupReadiness();

  assert.equal(result.catalog_available, false);
  assert.equal(result.catalog_pending, false);
  assert.equal(result.runtime_engine, 'ollama');
  assert.match(result.reason, /temporarily unavailable/i);
  assert.equal(events[0][1], 'setup.readiness_catalog_failed');
});

test('probeSetupReadiness rejects malformed catalog payloads', async () => {
  const events = [];
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => null,
  };
  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
    emitLog: (_level, event) => events.push(event),
  }).probeSetupReadiness();
  assert.equal(result.local_endpoint_available, false);
  assert.match(result.reason, /invalid response/i);
  assert.deepEqual(events, ['setup.readiness_catalog_malformed']);
});

test('probeSetupReadiness does not claim a usable route for an empty or malformed catalog', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama', model: 'configured-but-not-loaded' },
    listModels: async () => ({ available: true, engine_type: 'ollama', data: [{ provider: 'ollama' }] }),
  };
  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.local_model_available, false);
  assert.equal(result.local_endpoint_available, false);
  assert.equal(result.catalog_available, false);
  assert.equal(result.runtime_model_loaded, false);
});

// ---------------------------------------------------------------------------
// probe re-exports normalizeSetupEngineType and countSetupLocalModels
// ---------------------------------------------------------------------------

test('probe object re-exports normalizeSetupEngineType and countSetupLocalModels', (t) => {
  const probe = createSetupReadinessProbe();
  assert.equal(typeof probe.normalizeSetupEngineType, 'function',
    'probe must expose normalizeSetupEngineType');
  assert.equal(typeof probe.countSetupLocalModels, 'function',
    'probe must expose countSetupLocalModels');
  // And they must work
  assert.equal(probe.normalizeSetupEngineType('OLLAMA'), 'ollama');
  assert.equal(probe.countSetupLocalModels({ data: [{ id: 'a', provider: 'ollama' }] }, 'ollama'), 1);
});

// ---------------------------------------------------------------------------
// Cloud engines (chatgpt / codex-cli) as a setup model route
//
// Regression: setup completion is gated on a live readiness probe, and this
// probe only understood local engines. On `preferredEngineType: 'chatgpt'` the
// engine token normalized to '', both local signals stayed false, and setup
// could NEVER complete -- the Home setup card sat there with every step marked
// Done and a permanently disabled Finish button.
// ---------------------------------------------------------------------------

test('SETUP_CLOUD_ENGINES mirrors the canonical CLOUD_ENGINE_TYPES set', () => {
  assert.deepEqual(
    [...SETUP_CLOUD_ENGINES].sort(),
    [...CLOUD_ENGINE_TYPES].sort(),
    'the mirrored cloud-engine set has drifted from services/backend/managed-sidecar-chat-helpers.js'
  );
});

test('normalizeSetupCloudEngineType: chatgpt and codex-cli in, local engines out', () => {
  assert.equal(normalizeSetupCloudEngineType('ChatGPT'), 'chatgpt');
  assert.equal(normalizeSetupCloudEngineType('codex_cli'), 'codex-cli');
  assert.equal(normalizeSetupCloudEngineType('ollama'), '',
    'a local engine must never normalize as a cloud engine');
  assert.equal(normalizeSetupCloudEngineType(null), '');
  assert.equal(normalizeSetupEngineType('chatgpt'), '',
    'a cloud engine must never normalize as a local engine');
});

test('countSetupCloudModels: strict entry provenance match, unlike the local counter', () => {
  const payload = { data: [
    { id: 'gpt-5', provider: 'chatgpt' },
    { id: 'qwen', engine_type: 'ollama' },
    { id: 'untagged', provider: '' },
  ] };
  assert.equal(countSetupCloudModels(payload, 'chatgpt'), 1,
    'merged local entries and untagged entries must not count toward a cloud route');
  assert.equal(countSetupCloudModels(payload, ''), 0);
  assert.equal(countSetupCloudModels(null, 'chatgpt'), 0);
});

test('probeSetupReadiness: a cloud catalog counts merged local entries by provenance', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      available: true,
      engine_type: 'chatgpt',
      data: [
        { id: 'gpt-5.2', provider: 'chatgpt' },
        { id: 'ornith:9b', engine_type: 'ollama' },
        { id: 'gemma3:4b', engine_type: 'ollama' },
      ],
    }),
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.local_model_available, true);
  assert.equal(result.local_model_count, 2);
  assert.equal(result.local_endpoint_available, false);
  assert.equal(result.remote_endpoint_available, true);
  assert.equal(result.runtime_engine, 'chatgpt');
});

test('probeSetupReadiness: signed-out cloud primary does not block merged local models', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      engine_type: 'chatgpt',
      available: true,
      primary_available: false,
      data: [
        { id: 'gpt-5.2', engine_type: 'chatgpt' },
        { id: 'ornith:9b', engine_type: 'ollama' },
      ],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, false);
  assert.equal(result.local_model_available, true);
});

test('probeSetupReadiness: signed-in cloud primary is a reachable remote endpoint', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      engine_type: 'chatgpt',
      available: true,
      primary_available: true,
      data: [
        { id: 'gpt-5.2', engine_type: 'chatgpt' },
        { id: 'ornith:9b', engine_type: 'ollama' },
      ],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, true);
});

test('probeSetupReadiness: untagged entries in a cloud catalog do not count as local', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      engine_type: 'chatgpt',
      available: true,
      data: [{ id: 'mystery-model' }],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.local_model_available, false);
  assert.equal(result.local_model_count, 0);
});

test('probeSetupReadiness: engine_type-only cloud tagging makes the remote route reachable', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      engine_type: 'chatgpt',
      available: true,
      data: [{ id: 'gpt-5.2', engine_type: 'chatgpt' }],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, true);
});

test('probeSetupReadiness: local models never fake a cloud route', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    listModels: async () => ({
      engine_type: 'chatgpt',
      available: true,
      data: [{ id: 'ornith:9b', engine_type: 'ollama' }],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, false);
  assert.equal(result.local_model_available, true);
});

test('probeSetupReadiness: untagged entries under a local catalog still count', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => ({
      engine_type: 'ollama',
      available: true,
      data: [{ id: 'ornith:9b' }],
    }),
  };

  const result = await createSetupReadinessProbe({
    getBackendService: () => backendService,
  }).probeSetupReadiness();

  assert.equal(result.local_model_available, true);
  assert.equal(result.local_model_count, 1);
});

test('probeSetupReadiness: an unauthenticated chatgpt engine is NOT a usable remote endpoint', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'chatgpt' },
    // What the sidecar returns with no ChatGPT credentials.
    listModels: async () => ({ available: false, engine_type: 'chatgpt', data: [] }),
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, false,
    'backend phase alone must never make an unauthenticated cloud route look ready');
});

test('probeSetupReadiness: a local ollama engine reports no remote endpoint', async () => {
  const backendService = {
    currentStatus: { phase: 'ready', engine: 'ollama' },
    listModels: async () => ({
      available: true,
      engine_type: 'ollama',
      data: [{ id: 'qwen3', provider: 'ollama' }],
    }),
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, false);
  assert.equal(result.local_model_count, 1, 'the local path must be unchanged');
  assert.equal(result.local_endpoint_available, true);
});

test('probeSetupReadiness: a starting backend on a cloud engine stays pending, not ready', async () => {
  let listCalls = 0;
  const backendService = {
    currentStatus: { phase: 'starting', engine: 'chatgpt', model_loaded: false },
    listModels: async () => { listCalls += 1; return { available: true }; },
  };

  const probe = createSetupReadinessProbe({ getBackendService: () => backendService });
  const result = await probe.probeSetupReadiness();

  assert.equal(result.remote_endpoint_available, false);
  assert.equal(result.catalog_pending, true);
  assert.equal(result.runtime_engine, 'chatgpt',
    'the cloud token must survive the early return so diagnostics show the real engine');
  assert.equal(listCalls, 0, 'catalog discovery must still wait for backend startup');
});
