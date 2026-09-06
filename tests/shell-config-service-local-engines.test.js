const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONFIG_VERSION,
  ShellConfigService,
  normalizeState,
} = require('../services/shell-config-service');
const { managedModelKey } = require('../services/shell-config-engines');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('normalizeState fills default localEngines.vllm on fresh state', () => {
  const normalized = normalizeState({});
  assert.equal(normalized.version, CONFIG_VERSION);
  assert.ok(normalized.localEngines);
  assert.ok(normalized.localEngines.vllm);
  assert.equal(normalized.localEngines.vllm.port, 8000);
  assert.equal(normalized.localEngines.vllm.maxModelLen, 131072);
  assert.equal(normalized.localEngines.vllm.reasoningParser, 'qwen3');
  assert.equal(normalized.localEngines.vllm.toolCallParser, 'qwen3_coder');
  assert.equal(normalized.localEngines.vllm.enableAutoToolChoice, true);
  assert.deepEqual(normalized.localEngines.vllm.extraArgs, []);
});

test('normalizeState migrates v12 config missing localEngines into defaults', () => {
  const v12 = { version: 12, toolsWorkspaceRoot: 'C:/ws' };
  const normalized = normalizeState(v12);
  assert.equal(normalized.version, CONFIG_VERSION);
  assert.equal(normalized.localEngines.vllm.port, 8000);
  assert.equal(normalized.toolsWorkspaceRoot, 'C:/ws');
});

test('normalizeState is idempotent across two passes on a migrated config', () => {
  const once = normalizeState({ version: 12 });
  const twice = normalizeState(once);
  assert.deepEqual(twice.localEngines, once.localEngines);
  assert.equal(twice.version, CONFIG_VERSION);
});

test('normalizeState rejects invalid vLLM port and falls back to default', () => {
  const normalized = normalizeState({ localEngines: { vllm: { port: -1 } } });
  assert.equal(normalized.localEngines.vllm.port, 8000);
});

test('normalizeState fills default localEngines.openaiCompatible on fresh state', () => {
  const normalized = normalizeState({});
  assert.ok(normalized.localEngines.openaiCompatible);
  assert.equal(normalized.localEngines.openaiCompatible.port, 8033);
  assert.equal(normalized.localEngines.openaiCompatible.apiUrl, '');
  assert.deepEqual(normalized.localEngines.openaiCompatible.managed, {
    enabled: false,
    profileId: '',
    lastUsedTag: '',
    lastPickDir: '',
    libraryRoots: [],
    perModel: {},
  });
});

test('normalizeState backfills managed llama-server settings and stays idempotent', () => {
  const once = normalizeState({
    localEngines: { openaiCompatible: { port: 9000 } },
  });
  const twice = normalizeState(once);

  assert.deepEqual(once.localEngines.openaiCompatible.managed, {
    enabled: false,
    profileId: '',
    lastUsedTag: '',
    lastPickDir: '',
    libraryRoots: [],
    perModel: {},
  });
  assert.deepEqual(twice.localEngines, once.localEngines);
});

test('normalizeState bounds and sanitizes managed llama-server settings', () => {
  const perModel = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
    `model-${String(64 - index).padStart(2, '0')}`,
    { engine: 'llama-server', modelPath: path.resolve(`model-${index}.gguf`) },
  ]));
  Object.assign(perModel, {
    'Gemma4:12B': {
      engine: 'invalid',
      modelPath: 'foo.txt',
      mtp: { mode: 'invalid', draftNMax: 0 },
      ignored: true,
    },
    'bad-path': { modelPath: 'a\nb.gguf', mtp: { mode: 'mtp', draftNMax: 7 } },
    'bad-draft': { mtp: { mode: 'mtp', draftNMax: 'x' } },
  });

  const managed = normalizeState({
    localEngines: { openaiCompatible: { managed: { perModel, ignored: true } } },
  }).localEngines.openaiCompatible.managed;

  assert.deepEqual(managed.perModel['gemma4-12b'], {
    engine: 'ollama',
    modelPath: '',
    tag: '',
    mtp: { mode: 'off', draftNMax: 4 },
  });
  assert.deepEqual(managed.perModel['bad-path'].mtp, { mode: 'mtp', draftNMax: 4 });
  assert.deepEqual(managed.perModel['bad-draft'].mtp, { mode: 'mtp', draftNMax: 4 });
  assert.equal(managed.perModel['bad-path'].modelPath, '');
  assert.equal(Object.keys(managed.perModel).length, 64);
  assert.equal('model-64' in managed.perModel, false);
  assert.deepEqual(Object.keys(managed), [
    'enabled',
    'profileId',
    'lastUsedTag',
    'lastPickDir',
    'libraryRoots',
    'perModel',
  ]);
});

test('managed llama-server directory settings are normalized and persist without changing perModel', () => {
  const validLastPickDir = path.resolve('pick-dir');
  const validLibraryRoots = Array.from(
    { length: 20 },
    (_, index) => path.resolve(`library-${index}`)
  );
  const managed = normalizeState({
    localEngines: { openaiCompatible: { managed: {
      lastPickDir: `  ${validLastPickDir}  `,
      libraryRoots: [
        validLibraryRoots[0],
        validLibraryRoots[0].toUpperCase(),
        'relative-library',
        ...validLibraryRoots.slice(1),
      ],
    } } },
  }).localEngines.openaiCompatible.managed;

  assert.equal(managed.lastPickDir, validLastPickDir);
  assert.deepEqual(managed.libraryRoots, validLibraryRoots.slice(0, 16));
  for (const lastPickDir of ['relative-pick-dir', `${validLastPickDir}\nother`]) {
    const normalized = normalizeState({
      localEngines: { openaiCompatible: { managed: { lastPickDir } } },
    });
    assert.equal(normalized.localEngines.openaiCompatible.managed.lastPickDir, '');
  }
  assert.deepEqual(normalizeState({
    localEngines: { openaiCompatible: { managed: { libraryRoots: 'not-an-array' } } },
  }).localEngines.openaiCompatible.managed.libraryRoots, []);

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-directories-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.updateManagedLlamaServer({
    perModel: { 'model-a': { engine: 'ollama' } },
  });
  const perModel = service.getLocalEngines().openaiCompatible.managed.perModel;
  service.updateManagedLlamaServer({ libraryRoots: validLibraryRoots.slice(0, 2) });

  assert.deepEqual(
    service.getLocalEngines().openaiCompatible.managed.libraryRoots,
    validLibraryRoots.slice(0, 2)
  );
  assert.deepEqual(service.getLocalEngines().openaiCompatible.managed.perModel, perModel);
  const persisted = JSON.parse(fs.readFileSync(service.store.filePath, 'utf8'));
  assert.deepEqual(
    persisted.localEngines.openaiCompatible.managed.libraryRoots,
    validLibraryRoots.slice(0, 2)
  );
});

test('managed perModel keys keep the size tag and remember the display tag they came from', () => {
  const managed = normalizeState({
    localEngines: { openaiCompatible: { managed: {
      lastUsedTag: 'Ornith:9B',
      perModel: {
        'ornith:9b': { engine: 'llama-server', tag: 'ornith:9b' },
        'ornith:27b': { engine: 'llama-server', tag: 'ornith:27b' },
        'gemma4:12b': { tag: 'gemma4:27b' },
        'bad-tag': { tag: 'bad\ntag' },
      },
    } } },
  }).localEngines.openaiCompatible.managed;
  assert.equal(managed.lastUsedTag, 'ornith-9b');
  assert.deepEqual(Object.keys(managed.perModel), ['bad-tag', 'gemma4-12b', 'ornith-27b', 'ornith-9b']);
  assert.equal(managed.perModel['ornith-9b'].tag, 'ornith:9b');
  assert.equal(managed.perModel['ornith-27b'].tag, 'ornith:27b');
  assert.equal(managed.perModel['gemma4-12b'].tag, '', 'a tag that does not derive the key is dropped');
  assert.equal(managed.perModel['bad-tag'].tag, '');
  assert.equal(managedModelKey('Ornith:9B'), 'ornith-9b');
});

test('updateManagedLlamaServer merges, deletes, skips identical writes, and reports reason', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-llama-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  const reasons = [];
  service.on('changed', (_snapshot, meta) => reasons.push(meta?.reason));

  service.updateManagedLlamaServer({
    enabled: true,
    lastUsedTag: 'model-a',
    perModel: {
      'model-a': { engine: 'llama-server', modelPath: path.resolve('model-a.gguf') },
      'model-b': { engine: 'ollama' },
    },
  });
  service.updateManagedLlamaServer({
    perModel: { 'model-b': { engine: 'llama-server' } },
  });
  assert.deepEqual(Object.keys(service.getLocalEngines().openaiCompatible.managed.perModel), [
    'model-a',
    'model-b',
  ]);

  service.updateManagedLlamaServer({ perModel: { 'model-a': null } });
  assert.equal(
    'model-a' in service.getLocalEngines().openaiCompatible.managed.perModel,
    false
  );
  const reasonCount = reasons.length;
  service.updateManagedLlamaServer({ enabled: true });
  assert.equal(reasons.length, reasonCount);
  assert.deepEqual(reasons, Array(3).fill('managed_llama_server_updated'));

  const persisted = JSON.parse(fs.readFileSync(service.store.filePath, 'utf8'));
  assert.deepEqual(
    persisted.localEngines.openaiCompatible.managed,
    service.getLocalEngines().openaiCompatible.managed
  );
});

test('normalizeState rejects non-http OpenAI-compatible apiUrl', () => {
  for (const apiUrl of ['javascript:alert(1)', 'file:///C:/models']) {
    const normalized = normalizeState({ localEngines: { openaiCompatible: { apiUrl } } });
    assert.equal(normalized.localEngines.openaiCompatible.apiUrl, '');
  }
});

test('normalizeState rejects credentials in OpenAI-compatible apiUrl', () => {
  const normalized = normalizeState({
    localEngines: {
      openaiCompatible: { apiUrl: 'http://user:secret@127.0.0.1:8033/v1' },
    },
  });
  assert.equal(normalized.localEngines.openaiCompatible.apiUrl, '');
});
