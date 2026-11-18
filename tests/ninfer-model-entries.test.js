'use strict';

// The composer catalog lists a downloaded NInfer model while its server is stopped (row 54): rows
// exist only when a launch could succeed, and a running server's own row wins the merge.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ninferModelEntries } = require('../services/backend/ninfer-model-entries');
const { listModels } = require('../services/backend/backend-model-list');

const PIN = { id: 'qwen3.8-27b-nvfp4', model_id: 'qwen3.8-27b-nvfp4' };

function makeService({
  enabled = true, manager = true, installed = true, eligible = true, downloaded = true, vision,
} = {}) {
  return {
    ninferRuntime: {
      enabled,
      install: { resolveExecutable: () => ({ ok: installed }) },
      eligibility: async () => ({ eligible }),
      artifacts: { artifacts: [PIN], resolveArtifactPath: async () => ({ ok: downloaded }) },
    },
    options: { getNinferManager: () => (manager ? {} : null) },
    configService: { getLocalEngines: () => ({ ninfer: vision === undefined ? {} : { vision } }) },
  };
}

test('a downloaded model with an installed, eligible runtime is listed as a managed NInfer row', async () => {
  assert.deepEqual(await ninferModelEntries(makeService()), [{
    id: PIN.model_id, engine_type: 'openai-compatible', available: true, managed: 'ninfer',
    capabilities: { vision: true },
  }]);
});

test('the row follows the saved vision setting', async () => {
  const rows = await ninferModelEntries(makeService({ vision: false }));
  assert.equal(rows[0].capabilities.vision, false);
});

for (const [name, options] of [
  ['the flag is off', { enabled: false }],
  ['no manager is wired', { manager: false }],
  ['the runtime is not installed', { installed: false }],
  ['the GPU is not eligible', { eligible: false }],
  ['the model is not downloaded', { downloaded: false }],
]) {
  test(`no row while ${name}`, async () => {
    assert.deepEqual(await ninferModelEntries(makeService(options)), []);
  });
}

test('a throwing probe yields no rows instead of failing the catalog', async () => {
  const service = makeService();
  service.ninferRuntime.eligibility = async () => { throw new Error('nvidia-smi missing'); };
  assert.deepEqual(await ninferModelEntries(service), []);
});

test('listModels carries the stopped NInfer model next to Ollama, grouped as managed NInfer', async () => {
  const service = {
    ...makeService(),
    currentEngineType: 'ollama',
    currentModel: 'llama3:8b',
    sidecarClient: {},
    providerIntegrationRegistry: null,
    configService: { getLocalEngines: () => ({ ninfer: {} }), getState: () => ({}) },
    async listModelsForEngine(engineType) {
      return engineType === 'ollama'
        ? { available: true, data: [{ id: 'llama3:8b', engine_type: 'ollama' }] }
        : { available: false, data: [] };
    },
  };
  const list = await listModels(service);
  const row = list.data.find((entry) => entry.id === PIN.model_id);
  assert.ok(row, 'NInfer model is in the catalog');
  assert.equal(row.engine_type, 'openai-compatible');
  assert.equal(row.managed, 'ninfer');
  assert.ok(list.data.some((entry) => entry.id === 'llama3:8b'));
});
