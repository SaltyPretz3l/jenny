'use strict';

// services/main/semantic-catalog-wiring.js: model resolution (validation is
// cached per file identity) and the composition seams (knowledge-folder and
// embedding-settings changes reach the scheduler; nothing else does).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  createModelResolver,
  createRuntimeResolver,
  wireSemanticCatalog,
} = require('../services/main/semantic-catalog-wiring');
const { managedModelKey } = require('../services/shell-config-engines');

const PROFILES_PATH = path.join(__dirname, '..', 'config', 'embedding-prompt-profiles.json');
const GEMMA = { ok: true, architecture: 'gemma-embedding', name: 'EmbeddingGemma 2', poolingType: 1, embeddingLength: 768 };

function settings(overrides = {}) {
  return { enabled: true, modelPath: 'C:\\models\\embeddinggemma-2-Q4.gguf', profileId: '', device: 'cpu', dims: 0, ...overrides };
}

test('createModelResolver resolves the shipped EmbeddingGemma profile and its default dims', () => {
  const resolve = createModelResolver({
    profilesPath: PROFILES_PATH,
    validateModel: () => GEMMA,
    statImpl: () => ({ size: 1, mtimeMs: 1 }),
  });
  const resolved = resolve(settings());
  assert.equal(resolved.ok, true);
  assert.equal(resolved.profileId, 'embeddinggemma');
  assert.equal(resolved.dims, 256);
  assert.equal(resolved.queryTemplate, 'task: search result | query: {text}');
  assert.equal(resolved.documentTemplate, 'title: {title} | text: {text}');
  assert.equal(resolved.name, 'EmbeddingGemma 2');
  assert.equal(resolve(settings({ dims: 768 })).dims, 768);
  assert.equal(resolve(settings({ dims: 300 })).dims, 256, 'a dimension the profile does not allow falls back');
  assert.equal(resolve(settings({ profileId: 'none' })).profileId, 'none');
});

test('createModelResolver validates once per file identity and choice', () => {
  let calls = 0;
  let mtimeMs = 1;
  const resolve = createModelResolver({
    profilesPath: PROFILES_PATH,
    validateModel: () => { calls += 1; return GEMMA; },
    statImpl: () => ({ size: 10, mtimeMs }),
  });
  resolve(settings());
  resolve(settings());
  assert.equal(calls, 1);
  mtimeMs = 2;
  resolve(settings());
  assert.equal(calls, 2, 'a replaced file is validated again');
  resolve(settings({ dims: 512 }));
  assert.equal(calls, 3, 'a changed choice re-resolves');
});

test('createModelResolver returns a refusal reason without a path', () => {
  const resolve = createModelResolver({
    profilesPath: PROFILES_PATH,
    validateModel: () => ({ ok: false, reason: 'not_embedding_model' }),
    statImpl: () => { throw new Error('ENOENT C:\\models\\x.gguf'); },
  });
  assert.deepEqual(resolve(settings()), { ok: false, reason: 'not_embedding_model' });
});

test('createRuntimeResolver: env override, else bundled, else the saved build of the last chat model', async () => {
  const calls = [];
  const managed = {
    lastUsedTag: 'qwen3-8b-q4',
    perModel: { [managedModelKey('qwen3-8b-q4')]: { runtimePath: 'saved-build' } },
  };
  let bundled = 'bundled-build';
  const resolve = createRuntimeResolver({
    shellConfigService: { getLocalEngines: () => ({ openaiCompatible: { managed } }) },
    env: { JENNY_LLAMA_SERVER_BINARY: 'env-build' },
    resolveBundled: () => bundled,
    probeBuild: async () => { throw new Error('an env override never probes'); },
    resolveRuntime: (args) => {
      calls.push({ ...args, bundled: args.resolveBundledPath() });
      return { binaryPath: '', source: '', error: '' };
    },
  });
  await resolve();
  bundled = '';
  await resolve();
  assert.deepEqual(calls.map(({ binaryOverride, runtimePath, bundled: found }) => ({ binaryOverride, runtimePath, found })), [
    { binaryOverride: 'env-build', runtimePath: '', found: 'bundled-build' },
    { binaryOverride: 'env-build', runtimePath: 'saved-build', found: '' },
  ]);
});

test('createRuntimeResolver prefers the last chat model build only when it is newer than the bundled one', async () => {
  const calls = [];
  const managed = {
    lastUsedTag: 'qwen3-8b-q4',
    perModel: { [managedModelKey('qwen3-8b-q4')]: { runtimePath: 'saved-build' } },
  };
  const builds = { 'bundled-build': 10749, 'saved-build': 11457 };
  const resolve = createRuntimeResolver({
    shellConfigService: { getLocalEngines: () => ({ openaiCompatible: { managed } }) },
    env: {},
    resolveBundled: () => 'bundled-build',
    probeBuild: async (binaryPath) => builds[binaryPath] || 0,
    resolveRuntime: (args) => {
      calls.push(args.runtimePath);
      return { binaryPath: '', source: '', error: '' };
    },
  });
  await resolve();
  builds['saved-build'] = 10700;
  await resolve();
  builds['saved-build'] = 0;
  await resolve();
  assert.deepEqual(calls, ['saved-build', '', ''], 'EmbeddingGemma 2 needs a newer engine than the bundled b10749');
});

test('createRuntimeResolver takes the newest build saved for any chat model when no llama-server model is current', async () => {
  // The app clears lastUsedTag while the chat model runs on another engine (the row 41 gate profile).
  const managed = {
    lastUsedTag: '',
    perModel: {
      a: { runtimePath: 'old-build' },
      b: { runtimePath: 'new-build' },
      c: { runtimePath: 'new-build' },
    },
  };
  const builds = { 'bundled-build': 10749, 'old-build': 10683, 'new-build': 11457 };
  const probed = [];
  const calls = [];
  const resolve = createRuntimeResolver({
    shellConfigService: { getLocalEngines: () => ({ openaiCompatible: { managed } }) },
    env: {},
    resolveBundled: () => 'bundled-build',
    probeBuild: async (binaryPath) => { probed.push(binaryPath); return builds[binaryPath] || 0; },
    resolveRuntime: (args) => { calls.push(args.runtimePath); return { binaryPath: '', source: '', error: '' }; },
  });
  await resolve();
  assert.deepEqual(calls, ['new-build']);
  assert.equal(probed.filter((p) => p === 'new-build').length, 1, 'a build saved for two models is probed once');
});

test('createRuntimeResolver reads recorded builds without probing them, past any probe budget', async () => {
  // Five saved runtimes, the newest last: each entry carries the build recorded when it was picked.
  const perModel = {};
  [10500, 10600, 10683, 10700, 11457].forEach((build, index) => {
    perModel[`m${index}`] = { runtimePath: `build-${build}`, runtimeBuild: build };
  });
  const probed = [];
  const calls = [];
  const resolve = createRuntimeResolver({
    shellConfigService: { getLocalEngines: () => ({ openaiCompatible: { managed: { lastUsedTag: '', perModel } } }) },
    env: {},
    resolveBundled: () => 'bundled-build',
    probeBuild: async (binaryPath) => { probed.push(binaryPath); return binaryPath === 'bundled-build' ? 10749 : 0; },
    resolveRuntime: (args) => { calls.push(args.runtimePath); return { binaryPath: '', source: '', error: '' }; },
  });
  await resolve();
  assert.deepEqual(calls, ['build-11457']);
  assert.deepEqual(probed, ['bundled-build'], 'only the bundled build is probed');
});

test('createRuntimeResolver probes at most four unrecorded builds per resolve', async () => {
  const perModel = {};
  for (let index = 0; index < 6; index += 1) perModel[`m${index}`] = { runtimePath: `unrecorded-${index}` };
  const probed = [];
  const resolve = createRuntimeResolver({
    shellConfigService: { getLocalEngines: () => ({ openaiCompatible: { managed: { lastUsedTag: '', perModel } } }) },
    env: {},
    resolveBundled: () => '',
    probeBuild: async (binaryPath) => { probed.push(binaryPath); return 0; },
    resolveRuntime: () => ({ binaryPath: '', source: '', error: '' }),
  });
  await resolve();
  assert.equal(probed.length, 4);
});

test('wireSemanticCatalog attaches the service and forwards only relevant changes', () => {
  const backendService = {};
  const knowledgeService = new EventEmitter();
  knowledgeService.getAllRootPaths = () => ['C:\\notes'];
  const shellConfigService = new EventEmitter();
  let embedding = settings();
  shellConfigService.getLocalEngines = () => ({ embedding });
  const notified = [];
  class FakeService extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.started = false;
    }
    start() { this.started = true; }
    notifyChanged(reason) { notified.push(reason); }
  }
  let managerOptions = null;
  const service = wireSemanticCatalog({
    backendService,
    shellConfigService,
    knowledgeService,
    buildEffectiveFeatureFlags: () => ({ semantic_catalog: true }),
    userDataPath: 'C:\\userData',
    appRoot: path.join(__dirname, '..'),
    log: () => {},
    createManager: (options) => { managerOptions = options; return { stopSync() {} }; },
    ServiceClass: FakeService,
  });

  assert.equal(backendService.semanticCatalogService, service);
  assert.equal(service.started, true);
  assert.equal(service.options.isFeatureEnabled(), true);
  assert.deepEqual(service.options.listRootPaths(), ['C:\\notes']);
  assert.deepEqual(service.options.getSettings(), embedding);

  knowledgeService.emit('changed', {});
  shellConfigService.emit('changed', {});
  assert.deepEqual(notified, ['roots'], 'an unrelated config change is ignored');
  embedding = settings({ device: 'gpu' });
  shellConfigService.emit('changed', {});
  assert.deepEqual(notified, ['roots', 'settings']);
  managerOptions.onStateChange({ status: 'failed' });
  assert.deepEqual(notified, ['roots', 'settings', 'engine']);
});
