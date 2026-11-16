'use strict';

// new-test-file: the receiver's staging folder (<root>/.jenny-incoming/, row 123 slice 6-4) is a new discovery case; llama-server-ipc-handlers-discovery.test.js stays unedited.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');

function createFakeIpcMain() {
  const invoke = new Map();
  return { handle(channel, handler) { invoke.set(channel, handler); }, on() {}, invoke };
}

async function listEntries(root, extra = {}) {
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    ...extra,
  });
  const result = await ipc.invoke.get(getBridgeChannel('llamaServer.listLocalGgufs', 'invoke'))();
  assert.equal(result.ok, true);
  return result.entries;
}

function makeLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-discovery-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const modelDir = path.join(libraryRoot, 'qwen3-8b');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'qwen.gguf'), 'model');
  return { root, libraryRoot };
}

const STAGING_SHAPES = {
  empty: () => {},
  'holding only sub-folders': (incoming) => fs.mkdirSync(path.join(incoming, 'transfer-1'), { recursive: true }),
  'holding gguf parts': (incoming) => {
    fs.writeFileSync(path.join(incoming, 'partial.gguf'), 'parts');
    fs.mkdirSync(path.join(incoming, 'transfer-1'), { recursive: true });
    fs.writeFileSync(path.join(incoming, 'transfer-1', 'partial.gguf'), 'parts');
  },
};

for (const [shape, fill] of Object.entries(STAGING_SHAPES)) {
  test(`a library root's .jenny-incoming folder ${shape} is never listed`, async (t) => {
    const { root, libraryRoot } = makeLibrary(t);
    const incoming = path.join(libraryRoot, '.jenny-incoming');
    fs.mkdirSync(incoming, { recursive: true });
    fill(incoming);
    const entries = await listEntries(root, { getLibraryRoots: () => [libraryRoot] });
    assert.deepEqual(entries.map((entry) => entry.tag), ['qwen3-8b']);
  });

  test(`a built-in root's .jenny-incoming folder ${shape} is never listed`, async (t) => {
    const { root } = makeLibrary(t);
    const builtIn = path.join(root, 'user-data', 'models');
    fs.mkdirSync(path.join(builtIn, 'gemma'), { recursive: true });
    fs.writeFileSync(path.join(builtIn, 'gemma', 'gemma.gguf'), 'model');
    const incoming = path.join(builtIn, '.jenny-incoming');
    fs.mkdirSync(incoming, { recursive: true });
    fill(incoming);
    const entries = await listEntries(root);
    assert.deepEqual(entries.map((entry) => entry.tag), ['gemma']);
  });
}

test('a staged part never size-matches an Ollama blob', async (t) => {
  const { root, libraryRoot } = makeLibrary(t);
  const incoming = path.join(libraryRoot, '.jenny-incoming');
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(incoming, 'partial.gguf'), 'abcdefghij');
  const blobPath = path.join(root, 'ollama', 'sha256-model');
  fs.mkdirSync(path.dirname(blobPath), { recursive: true });
  fs.writeFileSync(blobPath, '0123456789');
  const entries = await listEntries(root, {
    getLibraryRoots: () => [libraryRoot],
    getOllamaTags: async () => ['other:7b'],
    getOllamaBlob: async () => ({ blobPath }),
  });
  const other = entries.find((entry) => entry.tag === 'other:7b');
  assert.equal(other.source, 'ollama');
  assert.equal(other.dir, path.dirname(blobPath));
});

test('an ordinary dot-folder that is not .jenny- keeps today\'s behaviour', async (t) => {
  const { root, libraryRoot } = makeLibrary(t);
  fs.mkdirSync(path.join(libraryRoot, '.hidden-model'), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, '.hidden-model', 'hidden.gguf'), 'model');
  const entries = await listEntries(root, { getLibraryRoots: () => [libraryRoot] });
  assert.deepEqual(entries.map((entry) => entry.tag).sort(), ['.hidden-model', 'qwen3-8b']);
});
