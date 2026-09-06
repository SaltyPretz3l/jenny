'use strict';

// llamaServer.listLocalGgufs discovery sources (services/main/llama-server-ipc-handlers.js):
// persisted per-model paths, GGUF library roots with the size index, the
// Ollama blob source with its cache + per-refresh budget, and the library
// folder picker. The manager passthrough and .gguf picker are covered in
// tests/llama-server-ipc-handlers.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');

function createFakeIpcMain() {
  const invoke = new Map();
  const send = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    on(channel, handler) {
      send.set(channel, handler);
    },
    invoke,
    send,
  };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');

test('listLocalGgufs also scans the directory of every persisted per-model path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const repoRoot = path.join(root, 'repo');
  const outside = path.join(root, 'llmmodels', 'gemma4-12b-qat-unsloth');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf'), 'main!');
  fs.writeFileSync(path.join(outside, 'mtp-gemma-4-12B-it-Q8_0.gguf'), 'draft');
  const modelPath = path.join(outside, 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot,
    getPersistedModels: () => [
      { tag: 'gemma4:12b-qat-ud-k-xl', modelPath },
      { tag: 'relative:1b', modelPath: 'relative.gguf' },
      { tag: '', modelPath },
      { tag: 'missing:2b', modelPath: path.join(root, 'nowhere', 'gone.gguf') },
    ],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => entry.tag), ['gemma4:12b-qat-ud-k-xl', 'missing:2b']);
  assert.deepEqual(result.entries[0], {
    tag: 'gemma4:12b-qat-ud-k-xl',
    dir: outside,
    mainGguf: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
    drafterGguf: 'mtp-gemma-4-12B-it-Q8_0.gguf',
    mmproj: false,
    sizeBytes: 5,
    source: 'persisted',
  });
  assert.equal('ollamaBlob' in result.entries[0], false);
  assert.equal(result.entries[1].sizeBytes, 0);
});

test('listLocalGgufs survives a throwing persisted-models getter', async () => {
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(os.tmpdir(), 'jenny-llama-ipc-none'),
    repoRoot: path.join(os.tmpdir(), 'jenny-llama-ipc-none'),
    getPersistedModels: () => { throw new Error('settings down'); },
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, []);
});

test('listLocalGgufs scans absolute library-root subdirectories by tag name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const modelDir = path.join(libraryRoot, 'qwen3-8b');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'qwen.gguf'), 'model');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => ['relative-library', libraryRoot],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries, [{
    tag: 'qwen3-8b',
    dir: modelDir,
    mainGguf: 'qwen.gguf',
    drafterGguf: '',
    mmproj: false,
    sizeBytes: 5,
    source: 'root',
  }]);
});

test('listLocalGgufs maps an Ollama blob to a same-size library GGUF and drafter', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-library-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const blobPath = path.join(root, 'ollama', 'sha256-model');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, 'gemma-main.gguf'), 'model');
  fs.writeFileSync(path.join(libraryRoot, 'mtp-gemma.gguf'), 'draft');
  fs.writeFileSync(blobPath, 'bytes');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async () => ({ blobPath, mmprojPath: '' }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries, [{
    tag: 'gemma4:12b',
    dir: libraryRoot,
    mainGguf: 'gemma-main.gguf',
    drafterGguf: 'mtp-gemma.gguf',
    mmproj: false,
    sizeBytes: 5,
    source: 'library',
  }]);
});

test('listLocalGgufs maps an Ollama blob to a same-size GGUF in a built-in root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-built-in-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const modelDir = path.join(userDataPath, 'models', 'gemma4-local');
  const blobPath = path.join(root, 'ollama', 'blobs', 'sha256-model');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'gemma-main.gguf'), 'model');
  fs.writeFileSync(path.join(modelDir, 'mtp-gemma.gguf'), 'draft');
  fs.writeFileSync(blobPath, 'bytes');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async () => ({ blobPath, mmprojPath: '' }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  const entry = result.entries.find(({ tag }) => tag === 'gemma4:12b');
  assert.equal(entry.dir, modelDir);
  assert.equal(entry.mainGguf, 'gemma-main.gguf');
  assert.equal(entry.drafterGguf, 'mtp-gemma.gguf');
});

// The persisted folder is the only place an owner with no library root
// configured keeps a real GGUF pair, so it has to reach the size index too.
test('listLocalGgufs maps an Ollama blob to a same-size GGUF in a persisted folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-persisted-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelDir = path.join(root, 'gguf', 'gemma4-local');
  const blobPath = path.join(root, 'ollama', 'blobs', 'sha256-model');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'gemma-main.gguf'), 'model');
  fs.writeFileSync(path.join(modelDir, 'mtp-gemma.gguf'), 'draft');
  fs.writeFileSync(blobPath, 'bytes');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getPersistedModels: () => [{ tag: 'gemma4-local', modelPath: path.join(modelDir, 'gemma-main.gguf') }],
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async () => ({ blobPath, mmprojPath: '' }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  const entry = result.entries.find(({ tag }) => tag === 'gemma4:12b');
  assert.equal(entry.dir, modelDir);
  assert.equal(entry.drafterGguf, 'mtp-gemma.gguf');
});

test('listLocalGgufs exposes an unmatched Ollama blob and its projector status', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-blob-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const blobPath = path.join(root, 'ollama', 'sha256-model');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, 'other.gguf'), 'different');
  fs.writeFileSync(blobPath, 'blob');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async () => ({ blobPath, mmprojPath: path.join(root, 'mmproj') }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries, [{
    tag: 'gemma4:12b',
    dir: path.dirname(blobPath),
    mainGguf: path.basename(blobPath),
    drafterGguf: '',
    mmproj: true,
    sizeBytes: 4,
    source: 'ollama',
  }]);
});

test('listLocalGgufs root and persisted keys suppress Ollama blob lookups', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-precedence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const rootDir = path.join(userDataPath, 'models', 'gemma4-12b');
  const persistedDir = path.join(root, 'outside');
  const persistedPath = path.join(persistedDir, 'qwen.gguf');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(persistedDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'gemma.gguf'), 'root');
  fs.writeFileSync(persistedPath, 'persisted');
  const lookups = [];

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getPersistedModels: () => [{ tag: 'qwen:7b', modelPath: persistedPath }],
    getOllamaTags: async () => ['gemma4:12b', 'qwen-7b'],
    getOllamaBlob: async (tag) => { lookups.push(tag); return null; },
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, source }) => ({ tag, source })), [
    { tag: 'gemma4-12b', source: 'root' },
    { tag: 'qwen:7b', source: 'persisted' },
  ]);
  assert.deepEqual(lookups, []);
});

test('listLocalGgufs keeps a persisted entry beside a root entry with the same key', async (t) => {
  // The drawer matches a persisted path by PATH, so the persisted directory
  // (not the root that happens to share the tag key) decides the drafter verdict.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-persisted-beside-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const rootDir = path.join(userDataPath, 'models', 'qwen-7b');
  const persistedDir = path.join(root, 'outside');
  const persistedPath = path.join(persistedDir, 'qwen.gguf');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(persistedDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'qwen.gguf'), 'root');
  fs.writeFileSync(persistedPath, 'persisted');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getPersistedModels: () => [{ tag: 'qwen:7b', modelPath: persistedPath }],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  const byDir = result.entries.map(({ tag, dir, source }) => ({ tag, dir, source }))
    .sort((left, right) => left.dir.localeCompare(right.dir));
  assert.deepEqual(byDir, [
    { tag: 'qwen:7b', dir: persistedDir, source: 'persisted' },
    { tag: 'qwen-7b', dir: rootDir, source: 'root' },
  ].sort((left, right) => left.dir.localeCompare(right.dir)));
});

test('listLocalGgufs re-homes an Ollama blob onto a same-size GGUF in a library subfolder', async (t) => {
  // The owner's layout: <library>/<model folder>/{main.gguf, mtp-*.gguf}. The
  // folder is already listed under its own name; the Ollama tag must STILL get
  // its own entry pointing at that folder (the tag is what the drawer matches).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-library-subdir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const modelDir = path.join(libraryRoot, 'gemma4-12b-qat-unsloth');
  const blobPath = path.join(root, 'ollama', 'sha256-model');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'gemma-main.gguf'), 'model');
  fs.writeFileSync(path.join(modelDir, 'mtp-gemma.gguf'), 'draft');
  fs.writeFileSync(blobPath, 'bytes');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
    getOllamaTags: async () => ['gemma4:12b-qat-ud-q4-k-xl'],
    getOllamaBlob: async () => ({ blobPath, mmprojPath: '' }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, dir, drafterGguf, source }) => ({ tag, dir, drafterGguf, source })), [
    { tag: 'gemma4-12b-qat-unsloth', dir: modelDir, drafterGguf: 'mtp-gemma.gguf', source: 'root' },
    { tag: 'gemma4:12b-qat-ud-q4-k-xl', dir: modelDir, drafterGguf: 'mtp-gemma.gguf', source: 'library' },
  ]);
});

test('listLocalGgufs lists every Ollama blob even though all blobs share one directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-blob-siblings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blobsDir = path.join(root, 'blobs');
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.writeFileSync(path.join(blobsDir, 'sha256-one'), 'one');
  fs.writeFileSync(path.join(blobsDir, 'sha256-two'), 'two-two');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getOllamaTags: async () => ['gemma4:12b', 'qwen3:8b'],
    getOllamaBlob: async (tag) => ({
      blobPath: path.join(blobsDir, tag.startsWith('gemma4') ? 'sha256-one' : 'sha256-two'),
      mmprojPath: '',
    }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, mainGguf, source }) => ({ tag, mainGguf, source })), [
    { tag: 'gemma4:12b', mainGguf: 'sha256-one', source: 'ollama' },
    { tag: 'qwen3:8b', mainGguf: 'sha256-two', source: 'ollama' },
  ]);
});

test('listLocalGgufs rescans a persisted Ollama blob path (extensionless sha256 name)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-persisted-blob-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blobsDir = path.join(root, 'blobs');
  const blobPath = path.join(blobsDir, 'sha256-' + 'a'.repeat(64));
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.writeFileSync(blobPath, 'blob');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getPersistedModels: () => [
      { tag: 'gemma4:12b', modelPath: blobPath },
      { tag: 'junk:1b', modelPath: path.join(blobsDir, 'sha256-nothex') },
    ],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, dir, mainGguf, source, ollamaBlob }) => ({
    tag, dir, mainGguf, source, ollamaBlob,
  })), [
    {
      tag: 'gemma4:12b', dir: blobsDir, mainGguf: path.basename(blobPath),
      source: 'persisted', ollamaBlob: true,
    },
  ]);
});

test('listLocalGgufs does not list a built-in root twice when it is also a library root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-root-dup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const modelsRoot = path.join(userDataPath, 'models');
  fs.mkdirSync(path.join(modelsRoot, 'gemma4-12b'), { recursive: true });
  fs.writeFileSync(path.join(modelsRoot, 'gemma4-12b', 'gemma.gguf'), 'root');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [modelsRoot.toUpperCase(), modelsRoot + path.sep, modelsRoot],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, source }) => ({ tag, source })), [
    { tag: 'gemma4-12b', source: 'root' },
  ]);
});

test('listLocalGgufs never size-matches a zero-byte library GGUF or an unreadable blob', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-zero-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, 'partial-download.gguf'), '');
  const missingBlob = path.join(root, 'blobs', 'sha256-gone');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
    getOllamaTags: async () => ['qwen3:8b'],
    getOllamaBlob: async () => ({ blobPath: missingBlob, mmprojPath: '' }),
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(result.entries.map(({ tag, dir, sizeBytes, source }) => ({ tag, dir, sizeBytes, source })), [
    { tag: 'qwen3:8b', dir: path.dirname(missingBlob), sizeBytes: 0, source: 'ollama' },
  ]);
});

test('listLocalGgufs caps Ollama lookups AFTER dropping tags that already have entries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-cap-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const tags = [];
  for (let index = 0; index < 64; index += 1) {
    const tag = `local-${index}`;
    tags.push(tag);
    fs.mkdirSync(path.join(userDataPath, 'models', tag), { recursive: true });
  }
  const lookups = [];

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getOllamaTags: async () => [...tags, 'extra:1b'],
    getOllamaBlob: async (tag) => { lookups.push(tag); return null; },
  });
  await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.deepEqual(lookups, ['extra:1b']);
});

test('listLocalGgufs stops querying Ollama blobs once the per-refresh budget is spent', async () => {
  // Each lookup blocks the sidecar's dispatch loop; a hung daemon must cost
  // one bounded batch per refresh, not one timeout per installed model.
  let clock = 0;
  const lookups = [];
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: '',
    repoRoot: path.join(os.tmpdir(), 'jenny-llama-no-repo'),
    getOllamaTags: async () => Array.from({ length: 8 }, (_unused, index) => `model-${index}:1b`),
    getOllamaBlob: async (tag) => { lookups.push(tag); return null; },
    nowMs: () => { clock += 3_000; return clock; },
  });
  await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  assert.equal(lookups.length, 4);
});

test('listLocalGgufs caches Ollama blob lookups for 30 seconds by tag list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blobPath = path.join(root, 'ollama', 'sha256-model');
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, 'blob');
  let currentMs = 0;
  let calls = 0;

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async () => { calls += 1; return { blobPath, mmprojPath: '' }; },
    nowMs: () => currentMs,
  });
  const list = ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'));

  await list();
  await list();
  assert.equal(calls, 1);
  currentMs = 31_000;
  await list();
  assert.equal(calls, 2);
});

test('listLocalGgufs survives throwing Ollama tag and blob getters', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-getters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const modelDir = path.join(userDataPath, 'models', 'root-model');
  const persistedPath = path.join(root, 'outside', 'persisted.gguf');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'root.gguf'), 'root');
  fs.writeFileSync(persistedPath, 'persisted');
  const baseOptions = {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    getPersistedModels: () => [{ tag: 'persisted-model', modelPath: persistedPath }],
  };
  const expected = [
    { tag: 'persisted-model', source: 'persisted' },
    { tag: 'root-model', source: 'root' },
  ];

  const tagIpc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(tagIpc, {
    ...baseOptions,
    getOllamaTags: async () => { throw new Error('tags failed'); },
  });
  const tagResult = await tagIpc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();
  assert.deepEqual(tagResult.entries.map(({ tag, source }) => ({ tag, source })), expected);

  const blobIpc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(blobIpc, {
    ...baseOptions,
    getOllamaTags: async () => ['ollama-model'],
    getOllamaBlob: async () => { throw new Error('blob failed'); },
  });
  const blobResult = await blobIpc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();
  assert.deepEqual(blobResult.entries.map(({ tag, source }) => ({ tag, source })), expected);
});

test('chooseLibraryFolder returns cancel and pick results without logging the path', async () => {
  let pickerResult = { canceled: true, filePaths: [] };
  const calls = [];
  const logs = [];
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    getMainWindow: () => 'main-window',
    dialogImpl: {
      showOpenDialog: async (...args) => { calls.push(args); return pickerResult; },
    },
    log: (...args) => logs.push(args),
  });
  const choose = ipc.invoke.get(invokeChannel('llamaServer.chooseLibraryFolder'));

  assert.deepEqual(await choose(), { ok: true, picked: false, path: '' });
  pickerResult = { canceled: false, filePaths: ['C:\\models'] };
  assert.deepEqual(await choose(), { ok: true, picked: true, path: 'C:\\models' });
  assert.deepEqual(calls, [
    ['main-window', { title: 'Select a GGUF folder', properties: ['openDirectory'] }],
    ['main-window', { title: 'Select a GGUF folder', properties: ['openDirectory'] }],
  ]);
  assert.deepEqual(logs, [
    ['INFO', 'llama.server.ipc_choose_library_folder', { ok: true, picked: false }],
    ['INFO', 'llama.server.ipc_choose_library_folder', { ok: true, picked: true }],
  ]);
});
