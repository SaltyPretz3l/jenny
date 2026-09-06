'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAcceleration,
  normalizeLocalEngines,
  normalizeOpenAICompatibleSettings,
} = require('../services/shell-config-engines');
const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const {
  FEATURE_OVERRIDE_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  buildFeatureFlags,
} = require('../services/feature-flags');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createShellConfigService(label) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-acceleration-${label}-`));
  trackDirectory(userDataPath);
  return new ShellConfigService({ userDataPath, env: {} });
}

function registerEngineHandlers(shellConfigService, processRef = { env: {} }) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    backendService: {},
    shellConfigService,
    processRef,
    log: () => null,
  });
  return handlers;
}

function registerEngineUpdateHandler(shellConfigService, env = {}) {
  return registerEngineHandlers(shellConfigService, { env }).get('engines:update-settings');
}

test('llama-server acceleration flag is internal and DEFAULT-ON with a =0 kill switch', () => {
  assert.equal(buildFeatureFlags({}).llama_server_acceleration, true);
  assert.equal(buildFeatureFlags({
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '0',
  }).llama_server_acceleration, false);
  assert.equal(buildFeatureFlags({
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  }).llama_server_acceleration, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('llama_server_acceleration'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('llama_server_acceleration'));
});

test('normalizeAcceleration accepts only the bounded acceleration contract', () => {
  const cases = [
    [undefined, { mode: 'off', draftNMax: 0 }],
    [null, { mode: 'off', draftNMax: 0 }],
    [[], { mode: 'off', draftNMax: 0 }],
    ['x', { mode: 'off', draftNMax: 0 }],
    [{ mode: 'MTP' }, { mode: 'off', draftNMax: 0 }],
    [{ mode: 'bogus' }, { mode: 'off', draftNMax: 0 }],
    [{ mode: 'mtp' }, { mode: 'mtp', draftNMax: 0 }],
    [{ mode: 'ngram', draftNMax: 3 }, { mode: 'ngram', draftNMax: 3 }],
    [{ draft_n_max: 4 }, { mode: 'off', draftNMax: 4 }],
    [{ draftNMax: '4' }, { mode: 'off', draftNMax: 4 }],
    [{ draftNMax: 0 }, { mode: 'off', draftNMax: 0 }],
    [{ draftNMax: 7 }, { mode: 'off', draftNMax: 0 }],
    [{ draftNMax: 2.5 }, { mode: 'off', draftNMax: 0 }],
    [{ draftNMax: -1 }, { mode: 'off', draftNMax: 0 }],
  ];

  for (const [value, expected] of cases) {
    assert.deepEqual(normalizeAcceleration(value), expected);
  }
});

test('OpenAI-compatible normalization backfills acceleration for legacy settings', () => {
  assert.deepEqual(normalizeOpenAICompatibleSettings({}), {
    port: 8033,
    apiUrl: '',
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: {
      enabled: false,
      profileId: '',
      lastUsedTag: '',
      lastPickDir: '',
      libraryRoots: [],
      perModel: {},
    },
  });
  assert.deepEqual(normalizeOpenAICompatibleSettings({ port: 9000 }), {
    port: 9000,
    apiUrl: '',
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: {
      enabled: false,
      profileId: '',
      lastUsedTag: '',
      lastPickDir: '',
      libraryRoots: [],
      perModel: {},
    },
  });
});

test('local-engine normalization preserves authored vLLM settings when acceleration is added', () => {
  const vllm = {
    port: 8123,
    maxModelLen: 65536,
    reasoningParser: 'qwen3',
    toolCallParser: 'qwen3_coder',
    enableAutoToolChoice: false,
    extraArgs: ['--gpu-memory-utilization', '0.85'],
  };
  const normalized = normalizeLocalEngines({
    vllm,
    openaiCompatible: {
      port: 8033,
      acceleration: { mode: 'mtp', draftNMax: 4 },
    },
  });

  assert.deepEqual(normalized.vllm, vllm);
  assert.deepEqual(normalized.openaiCompatible.acceleration, { mode: 'mtp', draftNMax: 4 });
});

test('shell config persists normalized acceleration and skips identical writes', () => {
  const service = createShellConfigService('service');
  const realWrite = service.store.write.bind(service.store);
  let writeCount = 0;
  service.store.write = (...args) => {
    writeCount += 1;
    return realWrite(...args);
  };

  service.updateLocalEngineAcceleration({ mode: 'mtp', draftNMax: 4 });
  assert.deepEqual(service.getLocalEngines().openaiCompatible.acceleration, {
    mode: 'mtp',
    draftNMax: 4,
  });
  assert.equal(writeCount, 1);
  const persisted = JSON.parse(fs.readFileSync(service.store.filePath, 'utf8'));
  assert.deepEqual(persisted.localEngines.openaiCompatible.acceleration, {
    mode: 'mtp',
    draftNMax: 4,
  });

  service.updateLocalEngineAcceleration({ mode: 'mtp', draftNMax: 4 });
  assert.equal(writeCount, 1);

  service.updateLocalEngineAcceleration('garbage');
  assert.deepEqual(service.getLocalEngines().openaiCompatible.acceleration, {
    mode: 'off',
    draftNMax: 0,
  });
  assert.equal(writeCount, 2);
});

test('engines.getSettings projects the acceleration catalog only while the flag is on', () => {
  const service = createShellConfigService('ipc-catalog');
  // cwd() deliberately points away from the repo: the catalog must resolve
  // relative to services/ (__dirname), never the process working directory —
  // a packaged app launches from an arbitrary cwd.
  const getSettings = registerEngineHandlers(service, {
    env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1' },
    cwd: () => os.tmpdir(),
  }).get('engines:get-settings');

  const settings = getSettings({});
  assert.equal(settings.accelerationCatalog.defaults.vramHeadroomMb, 2048);
  const gemma = settings.accelerationCatalog.families.find((entry) => entry.family === 'gemma4');
  assert.deepEqual(gemma, {
    family: 'gemma4',
    matchPrefixes: ['gemma4', 'gemma-4'],
    mtp: 'yes',
    vramHeadroomMb: 512,
  });

  const offSettings = registerEngineHandlers(service, {
    env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '0' },
  }).get('engines:get-settings')({});
  assert.equal('accelerationCatalog' in offSettings, false);
});

test('engines.updateSettings ignores acceleration while the flag is off', () => {
  const service = createShellConfigService('ipc-off');
  const reasons = [];
  service.on('changed', (_snapshot, meta) => reasons.push(meta?.reason));
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '0',
  });

  const result = updateSettings({}, { acceleration: { mode: 'mtp' } });

  assert.deepEqual(result, {
    localEngines: service.getLocalEngines(),
    preferredEngineType: '',
  });
  assert.equal(service.getLocalEngines().openaiCompatible.acceleration.mode, 'off');
  assert.deepEqual(reasons, []);
});

test('engines.updateSettings ignores managed llama-server settings while the flag is off', () => {
  const service = createShellConfigService('ipc-managed-off');
  const reasons = [];
  service.on('changed', (_snapshot, meta) => reasons.push(meta?.reason));
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '0',
  });

  const result = updateSettings({}, {
    managed: {
      enabled: true,
      perModel: { 'gemma4:12b': { engine: 'llama-server' } },
    },
  });

  assert.deepEqual(result.localEngines.openaiCompatible.managed, {
    enabled: false,
    profileId: '',
    lastUsedTag: '',
    lastPickDir: '',
    libraryRoots: [],
    perModel: {},
  });
  assert.deepEqual(reasons, []);
});

test('engines.updateSettings applies acceleration when the flag is on', () => {
  const service = createShellConfigService('ipc-on');
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  });

  const result = updateSettings({}, { acceleration: { mode: 'mtp' } });

  assert.equal(service.getLocalEngines().openaiCompatible.acceleration.mode, 'mtp');
  assert.equal(result.localEngines.openaiCompatible.acceleration.mode, 'mtp');
});

test('engines.updateSettings persists normalized managed llama-server settings when the flag is on', () => {
  const service = createShellConfigService('ipc-managed-on');
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  });

  const result = updateSettings({}, {
    managed: {
      enabled: true,
      perModel: { 'gemma4:12b': { engine: 'llama-server' } },
    },
  });
  const managed = service.getLocalEngines().openaiCompatible.managed;

  assert.equal(managed.enabled, true);
  assert.equal(managed.perModel['gemma4-12b'].engine, 'llama-server');
  assert.deepEqual(result.localEngines.openaiCompatible.managed, managed);
});

test('engines.updateSettings persists an Ollama blob modelPath but not a lookalike', () => {
  // Ollama's blob copy is extensionless (`sha256-<64 hex>`); it must survive
  // the normalizer or Apply on "Ollama's copy" can never succeed.
  const service = createShellConfigService('ipc-managed-blob');
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  });
  const blobPath = path.join(os.tmpdir(), 'blobs', 'sha256-' + 'b'.repeat(64));
  const lookalike = path.join(os.tmpdir(), 'blobs', 'sha256-nothex');

  updateSettings({}, {
    managed: {
      enabled: true,
      perModel: {
        'gemma4:12b': { engine: 'llama-server', modelPath: blobPath },
        'qwen3:8b': { engine: 'llama-server', modelPath: lookalike },
      },
    },
  });
  const perModel = service.getLocalEngines().openaiCompatible.managed.perModel;

  assert.equal(perModel['gemma4-12b'].modelPath, blobPath);
  assert.equal(perModel['qwen3-8b'].modelPath, '');
});

test('engines.updateSettings applies preferred engine, acceleration, and managed settings independently', () => {
  const service = createShellConfigService('ipc-combined');
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  });

  const result = updateSettings({}, {
    preferredEngineType: 'ollama',
    acceleration: { mode: 'mtp' },
    managed: { enabled: true },
  });

  assert.equal(service.getState().preferredEngineType, 'ollama');
  assert.equal(service.getLocalEngines().openaiCompatible.acceleration.mode, 'mtp');
  assert.equal(service.getLocalEngines().openaiCompatible.managed.enabled, true);
  assert.equal(result.preferredEngineType, 'ollama');
  assert.equal(result.localEngines.openaiCompatible.acceleration.mode, 'mtp');
  assert.equal(result.localEngines.openaiCompatible.managed.enabled, true);
});

test('invalid preferred engine does not block valid acceleration', () => {
  const service = createShellConfigService('ipc-invalid-preferred');
  const reasons = [];
  service.on('changed', (_snapshot, meta) => reasons.push(meta?.reason));
  const updateSettings = registerEngineUpdateHandler(service, {
    JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1',
  });

  const result = updateSettings({}, {
    preferredEngineType: 'invalid-engine',
    acceleration: { mode: 'mtp' },
  });

  assert.equal(service.getState().preferredEngineType, '');
  assert.equal(service.getLocalEngines().openaiCompatible.acceleration.mode, 'mtp');
  assert.equal(result.preferredEngineType, '');
  assert.deepEqual(reasons, ['local_engine_acceleration_updated']);
});
