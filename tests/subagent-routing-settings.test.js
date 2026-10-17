const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSubagentRouting, applySubagentRoutingPatch } = require('../services/subagent-routing-settings');
const { ShellConfigService } = require('../services/shell-config-service');
const { applyFeatureSettingsPatch, buildFeatureStatePayload } = require('../services/feature-settings-service');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');

const preference = { defaultModel: 'gpt-6-astra', defaultEffort: 'high', preferredModels: ['gpt-5.6-sol', 'gpt-6-astra'], allowedModels: [], maxEffort: '' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-subagent-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = new ShellConfigService({ userDataPath: root, env: {} });
  return { root, config, backend: { configService: config, options: { userDataPath: root }, currentEngineType: 'ollama',
    currentModel: 'test-model', defaultModel: 'test-model', async refreshManagedConfig() { throw new Error('refresh must not run'); } } };
}

test('routing defaults, read normalization and snapshots are bounded and independent', () => {
  const empty = normalizeSubagentRouting();
  assert.deepEqual(empty.chatgpt, { defaultModel: '', defaultEffort: '', preferredModels: [], allowedModels: [], maxEffort: '' });
  const result = normalizeSubagentRouting({ chatgpt: { ...preference, preferredModels: ['a', 'a', '../bad', ...Array.from({ length: 30 }, (_, i) => `model-${i}`)] } });
  assert.equal(result.chatgpt.preferredModels.length, 16);
  assert.equal(result.chatgpt.preferredModels[0], 'a');
  assert.equal(result.chatgpt.preferredModels.includes('../bad'), false);
  assert.deepEqual(normalizeSubagentRouting({ chatgpt: { defaultModel: 'x'.repeat(161), defaultEffort: 'ultra' } }).chatgpt, empty.chatgpt);
});

test('routing writes reject malformed models, efforts, providers, lengths and unknown fields atomically', () => {
  for (const patch of [null, [], { wrong: {} }, { chatgpt: { defaultModel: '../bad' } },
    { chatgpt: { defaultModel: 'x'.repeat(129) } }, { chatgpt: { defaultModel: 'codex-cli/model' } },
    { 'codex-cli': { defaultModel: 'chatgpt/model' } }, { chatgpt: { defaultEffort: 'ultra' } },
    { chatgpt: { preferredModels: [''] } }, { chatgpt: { preferredModels: Array(17).fill('model') } },
    { chatgpt: { command: 'run' } }, { chatgpt: { defaultEffort: {} } }]) {
    assert.throws(() => applySubagentRoutingPatch({}, patch), /invalid/);
  }
  const patch = applySubagentRoutingPatch({ chatgpt: preference }, { 'codex-cli': { defaultModel: 'codex-cli/default' } });
  assert.deepEqual(patch.chatgpt, preference);
  assert.equal(patch['codex-cli'].defaultModel, 'codex-cli/default');
});

test('real feature settings persist, reload, keep runtime config request-local and reset only one provider without refresh', async (t) => {
  const { root, config, backend } = fixture(t);
  const broadcasts = [];
  const payload = await applyFeatureSettingsPatch({ shellConfigService: config, backendService: backend,
    patch: { subagentRouting: { chatgpt: preference, 'codex-cli': { defaultModel: 'codex-cli/default' } } },
    sendToWindow: (_channel, value) => broadcasts.push(value), env: {} });
  assert.deepEqual(payload.subagentRouting.chatgpt, preference);
  assert.equal(broadcasts.length, 1);
  const reloaded = new ShellConfigService({ userDataPath: root, env: {} });
  assert.deepEqual(reloaded.getState().subagentRouting.chatgpt, preference);
  const raw = buildManagedSidecarConfig(backend);
  assert.equal(Object.hasOwn(raw, 'subagent_routing'), false);
  const snapshot = config.getState();
  snapshot.subagentRouting.chatgpt.preferredModels.push('mutated');
  assert.deepEqual(config.getState().subagentRouting.chatgpt, preference);
  await applyFeatureSettingsPatch({ shellConfigService: config, backendService: backend,
    patch: { subagentRouting: { chatgpt: normalizeSubagentRouting().chatgpt } }, env: {} });
  assert.equal(config.getState().subagentRouting['codex-cli'].defaultModel, 'codex-cli/default');
  assert.deepEqual(config.getState().subagentRouting.chatgpt, normalizeSubagentRouting().chatgpt);
});

test('failed persistence and invalid routing do not change settings', async (t) => {
  const { config, backend } = fixture(t);
  const before = config.getState();
  config._persistState = () => false;
  await assert.rejects(applyFeatureSettingsPatch({ shellConfigService: config, backendService: backend,
    patch: { subagentRouting: { chatgpt: preference } } }), /could not be saved/);
  assert.deepEqual(config.getState(), before);
  await assert.rejects(applyFeatureSettingsPatch({ shellConfigService: config, backendService: backend,
    patch: { tools: { web: true }, subagentRouting: { chatgpt: { defaultEffort: 'bogus' } } } }), /invalid/);
  assert.deepEqual(config.getState(), before);
});

test('mixed runtime-setting failure rolls back routing through the existing atomic transaction', async (t) => {
  const { config, backend } = fixture(t);
  backend.refreshManagedConfig = async () => { throw new Error('runtime failed'); };
  const before = config.getState();
  await assert.rejects(applyFeatureSettingsPatch({ shellConfigService: config, backendService: backend,
    patch: { tools: { web: true }, subagentRouting: { chatgpt: preference } }, env: {} }), /runtime failed/);
  assert.deepEqual(config.getState().subagentRouting, before.subagentRouting);
  assert.equal(config.getState().tools.web, before.tools.web);
});

test('catalog payload uses existing owners and exposes effort capabilities and truthful provider states', () => {
  const payload = buildFeatureStatePayload({ backendService: {
    chatgptAuthService: { hasCredential: () => true },
    chatgptModelCatalogService: { snapshot: () => ({ stale: true, models: [{ id: 'gpt-6-astra', label: 'Astra', reasoning_efforts: ['low', 'high'] }] }) },
    codexCliRuntimeService: { getModelCatalog: () => [{ id: 'codex-cli/default', available: false }] },
  }, env: {} });
  assert.equal(payload.subagentModelCatalogs.chatgpt.stale, true);
  assert.equal(payload.subagentModelCatalogs.chatgpt.available, true);
  assert.deepEqual(payload.subagentModelCatalogs.chatgpt.models[0].reasoning_efforts, ['low', 'high']);
  assert.equal(payload.subagentModelCatalogs['codex-cli'].available, false);
  assert.ok(payload.subagentModelCatalogs['codex-cli'].models[0].reasoning_efforts.includes('xhigh'));
});


test('limits validate atomically and prototype patches are refused', () => {
  const row = applySubagentRoutingPatch({}, { chatgpt: { allowedModels: ['luna', 'luna'], maxEffort: 'low' } }).chatgpt;
  assert.deepEqual(row.allowedModels, ['luna']);
  assert.equal(row.maxEffort, 'low');
  for (const patch of [JSON.parse('{"__proto__":{"polluted":true}}'), { chatgpt: { maxEffort: 'default' } },
    { chatgpt: { allowedModels: ['../bad'] } }, { chatgpt: { allowedModels: Array(17).fill('luna') } }]) {
    assert.throws(() => applySubagentRoutingPatch({}, patch), /invalid/);
  }
  assert.equal({}.polluted, undefined);
});
