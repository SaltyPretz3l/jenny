'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chatModelRefusal, filterDiffusionGgufs } = require('../services/llama-server-gguf-files');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');

function architectureHeader(architecture) {
  const string = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  const header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(1n, 16);
  const type = Buffer.alloc(4);
  type.writeUInt32LE(8);
  return Buffer.concat([header, string('general.architecture'), type, string(architecture)]);
}

test('chatModelRefusal excludes known diffusion and admits chat or unreadable headers', () => {
  for (const architecture of ['qwen_image21', 'flux']) {
    assert.equal(chatModelRefusal('model.gguf', { readArchitecture: () => architecture }), 'gguf_not_a_chat_model');
  }
  for (const architecture of ['llama', 'gemma4', 'qwen3vl', null, 'unknown']) {
    assert.equal(chatModelRefusal('model.gguf', { readArchitecture: () => architecture }), '');
  }
  assert.equal(chatModelRefusal('model.gguf', { readArchitecture: () => { throw new Error('unreadable'); } }), '');
});

test('filterDiffusionGgufs preserves bucket order and reads each file once, admitting errors', async () => {
  const dir = path.resolve('models');
  const names = ['z-chat.gguf', 'qwen-image.gguf', 'broken.gguf', 'flux.gguf', 'a-chat.gguf'];
  const reads = [];
  const buckets = await filterDiffusionGgufs(dir, names, {
    readArchitecture: (filePath) => {
      reads.push(filePath);
      const name = path.basename(filePath);
      if (name === 'broken.gguf') throw new Error('unreadable');
      return { 'qwen-image.gguf': 'qwen_image21', 'flux.gguf': 'flux' }[name] || 'llama';
    },
  });
  assert.deepEqual(buckets, {
    chat: ['z-chat.gguf', 'broken.gguf', 'a-chat.gguf'],
    diffusion: ['qwen-image.gguf', 'flux.gguf'],
  });
  assert.deepEqual(reads, names.map((name) => path.join(dir, name)));
});

test('local discovery hides diffusion folders, exposes diffusion rows, and retains pinned diffusion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gguf-diffusion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, 'library');
  const chatDir = path.join(library, 'chat');
  const diffusionDir = path.join(library, 'image');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.mkdirSync(diffusionDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'chat.gguf'), architectureHeader('llama'));
  const modelPath = path.join(diffusionDir, 'image.gguf');
  const imageHeader = architectureHeader('qwen_image21');
  fs.writeFileSync(modelPath, imageHeader);
  let persisted = [];
  const handlers = new Map();
  const registered = registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => null,
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [library],
    getPersistedModels: () => persisted,
  });
  const listChat = handlers.get(getBridgeChannel('llamaServer.listLocalGgufs', 'invoke'));
  assert.equal(typeof registered.listLocalDiffusionGgufs, 'function');
  assert.equal(Array.isArray(registered), true);
  const chat = await listChat();
  assert.equal(chat.ok, true);
  assert.deepEqual(chat.entries.map(({ tag, mainGguf }) => ({ tag, mainGguf })), [{ tag: 'chat', mainGguf: 'chat.gguf' }]);
  assert.deepEqual(await registered.listLocalDiffusionGgufs(), [{
    dir: diffusionDir, file: 'image.gguf', sizeBytes: imageHeader.length, architecture: 'qwen_image21',
  }]);
  persisted = [{ tag: 'pinned-image', modelPath }];
  const pinned = (await listChat()).entries.find(({ tag }) => tag === 'pinned-image');
  assert.equal(pinned.source, 'persisted');
  assert.equal(pinned.mainGguf, 'image.gguf');
});

test('mixed discovery picks the first chat main and diffusion rows are unique, sorted and capped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gguf-diffusion-mixed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'profile');
  const models = path.join(userDataPath, 'models');
  const dir = path.join(models, 'mixed');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 69; index >= 0; index -= 1) {
    fs.writeFileSync(path.join(dir, `image-${String(index).padStart(2, '0')}.gguf`), architectureHeader('flux'));
  }
  fs.writeFileSync(path.join(dir, 'z-chat.gguf'), architectureHeader('llama'));
  fs.writeFileSync(path.join(models, 'flat-image.gguf'), architectureHeader('sdxl'));
  const reads = new Map();
  const fsImpl = Object.create(fs);
  fsImpl.statSync = (filePath) => {
    reads.set(filePath, (reads.get(filePath) || 0) + 1);
    return fs.statSync(filePath);
  };
  const handlers = new Map();
  const registered = registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => null,
    userDataPath,
    repoRoot: path.join(root, 'repo'),
    fsImpl,
    getLibraryRoots: () => [models, models],
    getPersistedModels: () => [{ tag: 'mixed', modelPath: path.join(dir, 'image-00.gguf') }],
  });
  const chat = await handlers.get(getBridgeChannel('llamaServer.listLocalGgufs', 'invoke'))();
  assert.equal(chat.ok, true);
  assert.equal(chat.entries.find(({ tag }) => tag === 'mixed').mainGguf, 'z-chat.gguf');
  assert.equal(chat.entries.find(({ source }) => source === 'persisted').mainGguf, 'image-00.gguf');
  assert.equal(reads.size, 72);
  assert.equal([...reads.values()].every((count) => count === 1), true);
  reads.clear();
  const diffusion = await registered.listLocalDiffusionGgufs();
  assert.equal(diffusion.length, 64);
  assert.equal(diffusion[0].dir, models);
  assert.equal(diffusion[0].file, 'flat-image.gguf');
  assert.deepEqual(diffusion.slice(1).map(({ file }) => file),
    Array.from({ length: 63 }, (_, index) => `image-${String(index).padStart(2, '0')}.gguf`));
  assert.equal(reads.size, 72);
  assert.equal([...reads.values()].every((count) => count === 1), true);
});
