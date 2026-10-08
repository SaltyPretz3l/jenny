'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getJennyStatus } = require('../services/backend/jenny-status-composer');
const { normalizeResidentModelEntry } = require('../services/backend/backend-resident-models');
const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { ShellConfigService } = require('../services/shell-config-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function makeService(overrides = {}) {
  return {
    getBackendStatus: () => ({ phase: 'ready', detail: '', error: '', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'ollama', model: 'llama3:8b', model_loaded: false, tools_status: {} },
    shellLogStore: {
      list: () => [],
      getCurrentDiagnosticsMetadata: () => ({ sources: {}, integrity: { complete: true, partial_reasons: [] } }),
    },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    ...overrides,
  };
}

test('composer carries app and resident model memory into the budget facade', async () => {
  const payload = await getJennyStatus(makeService({
    appMemoryProvider: () => 412 * 1024 * 1024,
    getResidentModels: async () => [
      normalizeResidentModelEntry({ name: 'alpha', size: 100, size_vram: 20 }),
      normalizeResidentModelEntry({ name: 'unknown' }),
      normalizeResidentModelEntry({ name: 'ambiguous-zero', size: 0, size_vram: 0 }),
    ],
  }));
  assert.equal(payload.resources.app_memory_bytes, 412 * 1024 * 1024);
  assert.deepEqual(payload.resources.resident_models, [
    { name: 'alpha', size_bytes: 100, vram_bytes: 20 },
    { name: 'unknown', size_bytes: null, vram_bytes: null },
    { name: 'ambiguous-zero', size_bytes: null, vram_bytes: null },
  ]);
  assert.equal(payload.budgets.resources.model_memory.ram_bytes, 80, 'the RAM share is the resident size less the VRAM part');
  assert.equal(payload.budgets.resources.model_memory.vram_bytes, 20);
  assert.equal(payload.budgets.inputs.resources, true);
});

for (const [name, provider, expected] of [
  ['zero', () => 0, 0],
  ['absent', undefined, null],
  ['null', () => null, null],
  ['non-finite', () => Infinity, null],
  ['throwing', () => { throw new Error('app metric failure'); }, null],
]) {
  test(`composer handles ${name} app memory evidence`, async () => {
    const payload = await getJennyStatus(makeService({ appMemoryProvider: provider }));
    assert.equal(payload.resources.app_memory_bytes, expected);
    assert.equal(payload.budgets.resources.app_memory_bytes, expected);
    if (name === 'throwing') assert.match(payload.resources.error, /app metric failure/);
  });
}

for (const [name, getter, expected] of [
  ['absent', undefined, null],
  ['null', async () => null, null],
  ['non-array', async () => ({}), null],
  ['throwing', async () => { throw new Error('resident failure'); }, null],
  ['empty array', async () => [], []],
]) {
  test(`composer handles ${name} resident model evidence`, async () => {
    const payload = await getJennyStatus(makeService({ getResidentModels: getter }));
    assert.deepEqual(payload.resources.resident_models, expected);
    assert.equal(payload.budgets.resources.model_memory === null, expected === null);
  });
}

test('an empty Ollama resident list is a zero only while Ollama is the active engine', async () => {
  const llamaServer = makeService({
    currentStatus: { engine: 'llama_server', model: 'local-coder', model_loaded: true, tools_status: {} },
    getResidentModels: async () => [],
  });
  const payload = await getJennyStatus(llamaServer);
  assert.equal(payload.resources.resident_models, null, 'another engine is active: residency is not measured');
  assert.equal(payload.budgets.resources.model_memory, null);
  const withModels = makeService({
    currentStatus: { engine: 'llama_server', model: 'local-coder', model_loaded: true, tools_status: {} },
    getResidentModels: async () => [normalizeResidentModelEntry({ name: 'alpha', size: 100, size_vram: 20 })],
  });
  const loaded = await getJennyStatus(withModels);
  assert.equal(loaded.resources.resident_models.length, 1, 'models Ollama still holds are reported whatever the engine');
});

test('concurrent status calls share one in-flight resident-model read', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = makeService({ getResidentModels: async () => { calls += 1; await gate; return []; } });
  const both = Promise.all([getJennyStatus(service), getJennyStatus(service)]);
  release();
  const [first, second] = await both;
  assert.equal(calls, 1);
  assert.deepEqual(first.resources.resident_models, []);
  assert.deepEqual(second.resources.resident_models, []);
});

test('the Diagnostics status (no harness, include_system_pressure) reads the sidecar pressure from the runtime section alone, shared for ten seconds', async () => {
  const calls = [];
  const service = makeService({
    systemStatsProvider: () => ({ ramPercent: 40 }),
    inspectHarness: async (options) => { calls.push(options); return { runtime: { system_pressure: { status: 'pressured', memory: { percent: 91 } } } }; },
  });
  const plain = await getJennyStatus(service, { include_harness: false });
  assert.equal(plain.resources.sidecar.available, false, 'without the opt-in no sidecar read happens');
  assert.equal(calls.length, 0);
  const first = await getJennyStatus(service, { include_harness: false, include_system_pressure: true });
  assert.equal(first.harness.reason, 'disabled_by_request');
  assert.equal(first.resources.sidecar.available, true);
  assert.equal(first.resources.sidecar.system_pressure.status, 'pressured');
  assert.deepEqual(first.budgets.resources.system_memory, { percent: 40, pressure: 'high' });
  assert.deepEqual(calls, [{ sections: ['runtime'], include_recent_history: false, recent_history_limit: 0, include_disabled: false }]);
  const second = await getJennyStatus(service, { include_harness: false, include_system_pressure: true });
  assert.equal(second.resources.sidecar.system_pressure.status, 'pressured');
  assert.equal(calls.length, 1, 'the second status within the window reuses the read');
  const failing = makeService({ systemStatsProvider: () => ({ ramPercent: 40 }), inspectHarness: async () => { throw new Error('sidecar away'); } });
  const payload = await getJennyStatus(failing, { include_harness: false, include_system_pressure: true });
  assert.equal(payload.resources.sidecar.available, false);
  assert.deepEqual(payload.budgets.resources.system_memory, { percent: 40, pressure: null });
});

test('desktop wiring supplies app memory to the real service status entry point', async (t) => {
  const userDataPath = createTrackedTempDir('jenny-resource-wiring-');
  const app = {
    getVersion: () => '1.0.0-test', getPath: () => userDataPath, isReady: () => true,
    getAppMetrics: () => [
      { pid: process.pid, memory: { workingSetSize: 99999 } },
      { pid: process.pid + 1, memory: { workingSetSize: 20 } },
      { pid: process.pid + 2, memory: { workingSetSize: 30 } },
    ],
  };
  const { backendService } = createBackendServiceWithDeps({
    app, processRef: { env: {}, platform: process.platform, resourcesPath: '', cwd: () => userDataPath },
    safeStorage: createFakeSafeStorage(), dialog: {}, personalityWorkspace: {},
    shellConfigService: new ShellConfigService({ userDataPath, env: {} }),
    skillsService: { getBundledRoot: () => '', on: () => {} },
    mcpDiscoveryService: { setBackendService: () => {} },
  });
  t.after(() => backendService.dispose());
  const originalMemoryUsage = process.memoryUsage;
  process.memoryUsage = () => ({ ...originalMemoryUsage(), rss: 1000 });
  try {
    const payload = await backendService.getJennyStatus();
    assert.equal(payload.resources.app_memory_bytes, 1000 + 50 * 1024);
    assert.equal(payload.budgets.resources.app_memory_bytes, 1000 + 50 * 1024);
    for (const getter of [undefined, () => { throw new Error('metrics failed'); },
      () => [{ pid: process.pid + 1, memory: { workingSetSize: null } }]]) {
      app.getAppMetrics = getter;
      assert.equal(backendService.appMemoryProvider(), null);
    }
  } finally {
    process.memoryUsage = originalMemoryUsage;
  }
});
