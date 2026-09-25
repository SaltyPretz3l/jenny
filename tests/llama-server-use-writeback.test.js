'use strict';

// A Use records the model it launched as the boot autostart target by writing
// its per-model entry back. The launch takes seconds, and Tune can change or
// remove that entry meanwhile (a build picked or cleared, the model removed from
// the library); the write-back must never undo those changes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { createRuntimePickRegistry } = require('../services/main/llama-server-runtime');
const { loadModel } = require('../services/backend/backend-runtime');
const { resolveLlamaServerSettings } = require('../services/backend/backend-config');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const WIN32 = process.platform === 'win32';
const FORK = WIN32
  ? 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe'
  : '/opt/llama-prism-b10683/llama-server';
const NEWER = WIN32 ? 'G:\\llmmodels\\runtimes\\llama-b10800\\llama-server.exe' : '/opt/llama-b10800/llama-server';
const MODEL_PATH = WIN32
  ? 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b\\Ternary-Bonsai-2-27B-PQ2_0.gguf'
  : '/models/ternary-bonsai-2-27b/Ternary-Bonsai-2-27B-PQ2_0.gguf';
const GEMMA_PATH = WIN32
  ? 'G:\\llmmodels\\gguf\\gemma4-12b-qat-unsloth\\gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'
  : '/models/gemma4-12b/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const KEY = 'ternary-bonsai-2-27b-pq2-0';
const GEMMA_TAG = 'gemma4:12b';
const GEMMA_KEY = 'gemma4-12b';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-use-writeback-'));
  trackDirectory(userDataPath);
  const shell = new ShellConfigService({ userDataPath, env: {} });
  const runtimePicks = createRuntimePickRegistry();
  let gate = null;
  let initGate = null;
  const manager = {
    runtimePicks,
    getStatus: () => ({ state: 'stopped', lastError: '' }),
    async ensureRunning() {
      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }
      return { state: 'ready' };
    },
    async stop() { return { state: 'stopped' }; },
  };
  const handlers = new Map();
  const backendService = {
    options: { getLlamaServerManager: () => manager },
    currentEngineType: 'openai-compatible',
    currentModel: '',
    _lastEngineFallback: null,
    providerIntegrationRegistry: null,
    configService: shell,
    _emitServiceLog() {},
    async _initializeManagedSidecar() {
      const hold = initGate;
      initGate = null;
      if (hold) {
        hold.started.resolve();
        await hold.release.promise;
      }
    },
    async refreshStatusSnapshot() { return null; },
  };
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    backendService,
    shellConfigService: shell,
    processRef: { env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1' } },
    log: () => {},
  });
  const updateSettings = (payload) => handlers.get('engines:update-settings')({}, payload);
  const saved = () => shell.getLocalEngines().openaiCompatible.managed;
  // Use `tag`, with `duringLaunch` running while the server is still coming up.
  const use = async (tag, duringLaunch = null) => {
    gate = duringLaunch ? { started: deferred(), release: deferred() } : null;
    const load = loadModel(backendService, { model: tag, engine_type: 'openai-compatible' });
    if (gate) {
      await gate.started.promise;
      duringLaunch();
      gate.release.resolve();
    }
    await load;
  };
  // What the next boot decides from the saved settings (the real resolver).
  const bootAutostarts = () => resolveLlamaServerSettings({
    env: {},
    repoRoot: path.resolve(__dirname, '..'),
    managed: saved(),
  }).autostart;
  const preferredEngine = () => shell.getState().preferredEngineType;
  // Holds the next Use in its sidecar initialization (after its launch) until released.
  const holdNextInit = () => {
    initGate = { started: deferred(), release: deferred() };
    return initGate;
  };
  const load = (tag) => loadModel(backendService, { model: tag, engine_type: 'openai-compatible' });
  return { runtimePicks, updateSettings, saved, use, bootAutostarts, preferredEngine, shell, holdNextInit, load };
}

function entry(extra = {}) {
  return { engine: 'llama-server', modelPath: MODEL_PATH, tag: TAG, mtp: { mode: 'off', draftNMax: 4 }, ...extra };
}

function gemmaEntry(extra = {}) {
  return { engine: 'llama-server', modelPath: GEMMA_PATH, tag: GEMMA_TAG, mtp: { mode: 'off', draftNMax: 4 }, ...extra };
}

test('a build cleared while the model starts stays cleared', async () => {
  const { runtimePicks, updateSettings, saved, use } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: FORK }) } } });
  await use(TAG, () => updateSettings({ managed: { perModel: { [KEY]: entry({ runtimePath: '' }) } } }));
  assert.equal('runtimePath' in saved().perModel[KEY], false);
  assert.equal(saved().lastUsedTag, KEY, 'the Use is still recorded');
});

test('a build picked while the model starts is kept', async () => {
  const { runtimePicks, updateSettings, saved, use } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: FORK }) } } });
  await use(TAG, () => {
    runtimePicks.record(NEWER, { build: 10800, supportsMtp: false });
    updateSettings({ managed: { perModel: { [KEY]: entry({ runtimePath: NEWER }) } } });
  });
  assert.equal(saved().perModel[KEY].runtimePath, NEWER);
  assert.equal(saved().perModel[KEY].runtimeBuild, 10800);
});

test('a model removed from the library while it starts is not brought back', async () => {
  const { runtimePicks, updateSettings, saved, use } = setup();
  runtimePicks.record(FORK, { build: 10683, supportsMtp: false });
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry({ runtimePath: FORK }) } } });
  await use(TAG, () => updateSettings({ managed: { perModel: { [KEY]: null } } }));
  assert.equal(saved().perModel[KEY], undefined);
  assert.notEqual(saved().lastUsedTag, KEY, 'a removed model never becomes the boot autostart target');
});

test('a Use with nothing changed meanwhile records the model as before', async () => {
  const { updateSettings, saved, use, bootAutostarts, preferredEngine } = setup();
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry() } } });
  await use(TAG);
  assert.equal(saved().lastUsedTag, KEY);
  assert.equal(saved().perModel[KEY].tag, TAG);
  assert.equal(saved().perModel[KEY].modelPath, MODEL_PATH);
  assert.equal(bootAutostarts(), true);
  assert.equal(preferredEngine(), 'openai-compatible');
});

// W3 trust review round 2 (2026-09-18): each test below failed before its fix.

test('a model moved to Ollama in Tune is no longer the boot autostart target (T5)', async () => {
  const { updateSettings, saved, use, bootAutostarts } = setup();
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry() } } });
  await use(TAG);
  assert.equal(bootAutostarts(), true);
  updateSettings({ managed: { perModel: { [KEY]: entry({ engine: 'ollama' }) } } });
  assert.equal(saved().lastUsedTag, '');
  assert.equal(bootAutostarts(), false, 'boot never starts llama-server for an Ollama model');
});

test('a Use whose model moved to Ollama while it started leaves no boot target and no engine pin (T6)', async () => {
  const { updateSettings, saved, use, bootAutostarts, preferredEngine, shell } = setup();
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry(), [GEMMA_KEY]: gemmaEntry() } } });
  await use(GEMMA_TAG);
  assert.equal(saved().lastUsedTag, GEMMA_KEY, 'an earlier Use made gemma the boot target');
  shell.updatePreferredEngineType('ollama');
  await use(TAG, () => updateSettings({ managed: { perModel: { [KEY]: entry({ engine: 'ollama' }) } } }));
  assert.equal(saved().lastUsedTag, '', 'the earlier model is not started at boot in place of this Use');
  assert.equal(bootAutostarts(), false);
  assert.equal(preferredEngine(), 'ollama', 'no openai-compatible pin for a model now set to Ollama');
});

// W3 trust review round 3: a chat send can load a model while an earlier Use is still initializing.
test('a slow Use whose model moved to Ollama keeps the boot target a later Use recorded', async () => {
  const { updateSettings, saved, use, bootAutostarts, holdNextInit, load } = setup();
  updateSettings({ managed: { enabled: true, perModel: { [KEY]: entry(), [GEMMA_KEY]: gemmaEntry() } } });
  const hold = holdNextInit();
  const bonsaiUse = load(TAG);
  await hold.started.promise;
  await use(GEMMA_TAG);
  assert.equal(saved().lastUsedTag, GEMMA_KEY, 'gemma is serving and is the boot target');
  updateSettings({ managed: { perModel: { [KEY]: entry({ engine: 'ollama' }) } } });
  hold.release.resolve();
  await bonsaiUse;
  assert.equal(saved().lastUsedTag, GEMMA_KEY, 'the late Use does not clear the serving model\'s target');
  assert.equal(bootAutostarts(), true);
});
