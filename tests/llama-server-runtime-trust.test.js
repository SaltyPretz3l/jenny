'use strict';

// End-to-end trust boundary for per-model llama-server builds: the real
// engines.updateSettings handler, the real ShellConfigService, and payloads
// built by the renderer's own buildManagedPatch. A renderer can only name a
// runtime the main-process picker recorded; everything else keeps the saved one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { createRuntimePickRegistry } = require('../services/main/llama-server-runtime');
const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const WIN32 = process.platform === 'win32';
const FORK = WIN32
  ? 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe'
  : '/opt/llama-prism-b10683/llama-server';
const INJECTED = WIN32 ? 'C:\\Users\\Public\\evil\\llama-server.exe' : '/tmp/evil/llama-server';
const MODEL_PATH = WIN32
  ? 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b\\Ternary-Bonsai-2-27B-PQ2_0.gguf'
  : '/models/ternary-bonsai-2-27b/Ternary-Bonsai-2-27B-PQ2_0.gguf';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const KEY = 'ternary-bonsai-2-27b-pq2-0';

function setup({ withManager = true, flagOn = true, seedConfig = null } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-trust-'));
  trackDirectory(userDataPath);
  if (seedConfig) {
    fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify(seedConfig));
  }
  const service = new ShellConfigService({ userDataPath, env: {} });
  const runtimePicks = createRuntimePickRegistry();
  const logs = [];
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    backendService: withManager ? { options: { getLlamaServerManager: () => ({ runtimePicks }) } } : {},
    shellConfigService: service,
    processRef: { env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: flagOn ? '1' : '0' } },
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  const updateSettings = (payload) => handlers.get('engines:update-settings')({}, payload);
  const saved = () => service.getLocalEngines().openaiCompatible.managed.perModel[KEY];
  return { service, runtimePicks, logs, updateSettings, saved };
}

// The drawer's own Apply payload for the Bonsai card, as W4 will send it.
function drawerPayload(service, extra = {}) {
  const view = engineUtils.deriveEngineView({
    activeModelId: TAG,
    engineType: 'openai-compatible',
    engineSettings: { localEngines: service.getLocalEngines() },
    localGgufs: { entries: [] },
  });
  const request = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, engine: 'llama-server', modelPath: MODEL_PATH });
  Object.assign(request.payload.managed.perModel[KEY], extra);
  return request;
}

test('an injected, never-picked runtime path is not saved and the rejection logs no path', () => {
  const { service, logs, updateSettings, saved } = setup();
  updateSettings(drawerPayload(service, { runtimePath: INJECTED, runtimeBuild: 10683 }).payload);
  assert.equal(saved().modelPath, MODEL_PATH, 'the rest of the Apply still lands');
  assert.equal('runtimePath' in saved(), false);
  assert.equal('runtimeBuild' in saved(), false);
  const rejected = logs.find((entry) => entry.event === 'engines.managed_runtime_rejected');
  assert.deepEqual(rejected?.details, { keys: [KEY] });
  assert.equal(JSON.stringify(logs).includes('llama-server.exe') || JSON.stringify(logs).includes('/evil/'), false);
});

test('a picked runtime is saved once with the pick\'s build and the pick is consumed', () => {
  const { service, runtimePicks, updateSettings, saved } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: true });
  const request = drawerPayload(service, { runtimePath: FORK, runtimeBuild: 1 });
  const result = updateSettings(request.payload);
  assert.equal(saved().runtimePath, FORK);
  assert.equal(saved().runtimeBuild, 10683, 'the build comes from the probe, never the renderer');
  assert.equal(runtimePicks.has(FORK), false);
  assert.equal(engineUtils.returnedEntryMatches(result.localEngines, KEY, request.entry), true,
    'the drawer\'s reflect check still passes');
  const second = drawerPayload(service, { runtimePath: FORK });
  second.payload.managed.perModel = { 'gemma4-12b': second.payload.managed.perModel[KEY] };
  updateSettings(second.payload);
  assert.equal('runtimePath' in service.getLocalEngines().openaiCompatible.managed.perModel['gemma4-12b'], false,
    'a consumed pick cannot be replayed onto another model');
});

test('an Apply that omits the field keeps the saved runtime and an empty string clears it', () => {
  const { service, runtimePicks, updateSettings, saved } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  updateSettings(drawerPayload(service, { mtp: { mode: 'off', draftNMax: 3 } }).payload);
  assert.equal(saved().runtimePath, FORK, 'the drawer rebuilds the entry whole without the field');
  assert.equal(saved().runtimeBuild, 10683);
  assert.equal(saved().mtp.draftNMax, 3, 'the untouched Apply still wrote its own fields');
  updateSettings(drawerPayload(service, { runtimePath: FORK, runtimeBuild: 5 }).payload);
  assert.equal(saved().runtimeBuild, 10683, 'an echo of the saved path keeps the saved build');
  updateSettings(drawerPayload(service, { runtimePath: '' }).payload);
  assert.equal('runtimePath' in saved(), false);
  assert.equal('runtimeBuild' in saved(), false);
});

test('without a manager the write fails closed for new paths but can still clear', () => {
  const { service, updateSettings, saved } = setup({ withManager: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal('runtimePath' in saved(), false);
  updateSettings(drawerPayload(service, { runtimePath: '' }).payload);
  assert.equal(saved().engine, 'llama-server');
});

test('with the acceleration flag off nothing is written and the pick survives', () => {
  const { service, runtimePicks, updateSettings, saved } = setup({ flagOn: false });
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal(saved(), undefined);
  assert.equal(runtimePicks.has(FORK), true);
});

// Review round 1 (T3): a pick is spent only on a runtime that actually saved.
test('a write blocked by a newer config version keeps the pick and claims nothing', () => {
  const { service, runtimePicks, logs, updateSettings } = setup({ seedConfig: { version: 999 } });
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal(service.getLocalEngines().openaiCompatible.managed.perModel[KEY]?.runtimePath, undefined);
  assert.equal(runtimePicks.has(FORK), true);
  assert.equal(logs.some((entry) => entry.event === 'engines.managed_runtime_accepted'), false);
});

test('an entry dropped by the per-model cap keeps the pick and claims nothing', () => {
  const { service, runtimePicks, logs, updateSettings } = setup();
  const perModel = {};
  for (let index = 0; index < 64; index += 1) {
    perModel[`m${String(index).padStart(2, '0')}`] = { engine: 'llama-server', modelPath: MODEL_PATH, mtp: { mode: 'off', draftNMax: 4 } };
  }
  updateSettings({ managed: { enabled: true, perModel } });
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings({ managed: { perModel: { 'zz-new-model': { engine: 'llama-server', modelPath: MODEL_PATH, runtimePath: FORK } } } });
  assert.equal(service.getLocalEngines().openaiCompatible.managed.perModel['zz-new-model'], undefined);
  assert.equal(runtimePicks.has(FORK), true);
  assert.equal(logs.some((entry) => entry.event === 'engines.managed_runtime_accepted'), false);
});

// Review round 2 (T8): the saved build picked again after an in-place upgrade.
test('picking the saved build again refreshes its build number and spends the pick', () => {
  const { service, runtimePicks, updateSettings, saved } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal(saved().runtimeBuild, 10683);
  // New files copied over the same folder, then Choose… on the same file.
  runtimePicks.record(FORK, { build: 10800, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal(saved().runtimePath, FORK);
  assert.equal(saved().runtimeBuild, 10800);
  assert.equal(runtimePicks.has(FORK), false, 'spent like any pick, so no other model can claim it later');
});

test('echoing the saved build with no fresh pick keeps its saved number', () => {
  const { service, runtimePicks, updateSettings, saved } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  updateSettings(drawerPayload(service, { runtimePath: FORK, runtimeBuild: 99999 }).payload);
  assert.equal(saved().runtimeBuild, 10683);
});

// Review round 3 (T10): the path alone was already saved, so only the build shows a re-pick landed.
test('a same-path re-pick whose write is blocked keeps the pick and claims nothing', () => {
  const entry = {
    engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off', draftNMax: 4 },
    runtimePath: FORK, runtimeBuild: 10683,
  };
  const { service, runtimePicks, logs, updateSettings, saved } = setup({
    seedConfig: { version: 999, localEngines: { openaiCompatible: { managed: { enabled: true, perModel: { [KEY]: entry } } } } },
  });
  assert.equal(saved().runtimeBuild, 10683, 'precondition: the newer file still loads');
  runtimePicks.record(FORK, { build: 10800, supportsMtp: false });
  updateSettings(drawerPayload(service, { runtimePath: FORK }).payload);
  assert.equal(saved().runtimeBuild, 10683, 'the blocked write changed nothing');
  assert.equal(runtimePicks.has(FORK), true, 'so the pick survives for the next Apply');
  assert.equal(logs.some((item) => item.event === 'engines.managed_runtime_accepted'), false);
});
