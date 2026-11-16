'use strict';

// new-test-file: covers the new services/main/gguf-embedded-mtp-cache.js and the scan entry's embeddedMtpLayers and family-aware drafterGguf (row 140 S1); llama-server-ipc-handlers-discovery.test.js is past 570 lines.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');
const { createEmbeddedMtpCache } = require('../services/main/gguf-embedded-mtp-cache');

const STRING = 8;
const UINT32 = 4;

const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
const u64 = (value) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
const text = (value) => { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]); };

// A minimal GGUF header: `layers` undefined leaves the key out.
function gguf(architecture, layers) {
  const pairs = [['general.architecture', STRING, architecture]];
  if (layers !== undefined) pairs.push([`${architecture}.nextn_predict_layers`, UINT32, layers]);
  return Buffer.concat([
    Buffer.from('GGUF'), u32(3), u64(0), u64(pairs.length),
    ...pairs.map(([key, type, value]) => Buffer.concat([
      text(key), u32(type), type === STRING ? text(value) : u32(value),
    ])),
  ]);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeIpcMain() {
  const invoke = new Map();
  return { handle(channel, handler) { invoke.set(channel, handler); }, on() {}, invoke };
}

async function listEntries(root, options) {
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.resolve(__dirname, '..'),
    ...options,
  });
  const result = await ipc.invoke.get(getBridgeChannel('llamaServer.listLocalGgufs', 'invoke'))();
  assert.equal(result.ok, true);
  // repoRoot stays the real checkout (the acceleration catalog), so the scan also lists
  // whatever sits in its .jenny/models: keep only this test's own folders.
  const own = path.resolve(root) + path.sep;
  return result.entries.filter((entry) => path.resolve(String(entry.dir || '')).startsWith(own));
}

test('the cache reads a header once per file version and rereads after the file changes', (t) => {
  const dir = tempDir(t, 'jenny-mtp-cache-');
  const file = path.join(dir, 'model.gguf');
  fs.writeFileSync(file, gguf('qwen35', 1));
  const reads = [];
  const cache = createEmbeddedMtpCache({
    readHeader: (filePath, options) => {
      reads.push({ filePath, maxBytes: options.maxBytes });
      return { architecture: 'qwen35', kv: { 'qwen35.nextn_predict_layers': reads.length } };
    },
  });
  assert.equal(cache.get(file), 1);
  assert.equal(cache.get(file), 1);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].maxBytes, 32 * 1024 * 1024);
  fs.writeFileSync(file, Buffer.concat([gguf('qwen35', 1), Buffer.alloc(16)]));
  assert.equal(cache.get(file), 2);
  assert.equal(reads.length, 2);
});

test('the cache reports 0 for a header with no head and null for anything unreadable', (t) => {
  const dir = tempDir(t, 'jenny-mtp-cache-');
  const plain = path.join(dir, 'plain.gguf');
  const headed = path.join(dir, 'headed.gguf');
  const junk = path.join(dir, 'junk.gguf');
  fs.writeFileSync(plain, gguf('gemma4'));
  fs.writeFileSync(headed, gguf('qwen35', 2));
  fs.writeFileSync(junk, 'not a gguf');
  fs.mkdirSync(path.join(dir, 'folder.gguf'));
  const cache = createEmbeddedMtpCache();
  assert.equal(cache.get(plain), 0);
  assert.equal(cache.get(headed), 2);
  assert.equal(cache.get(junk), null);
  assert.equal(cache.get(path.join(dir, 'folder.gguf')), null);
  assert.equal(cache.get(path.join(dir, 'missing.gguf')), null);
  assert.equal(cache.get(''), null);
  const throwing = createEmbeddedMtpCache({ readHeader: () => { throw new Error('boom'); } });
  assert.equal(throwing.get(plain), null);
});

test('the cache evicts the least recently used verdict beyond its bound', (t) => {
  const dir = tempDir(t, 'jenny-mtp-cache-');
  const files = ['a', 'b', 'c'].map((name) => {
    const file = path.join(dir, `${name}.gguf`);
    fs.writeFileSync(file, gguf('qwen35', 1));
    return file;
  });
  let reads = 0;
  const cache = createEmbeddedMtpCache({
    max: 2,
    readHeader: () => { reads += 1; return { architecture: 'qwen35', kv: {} }; },
  });
  files.forEach((file) => cache.get(file));
  assert.equal(reads, 3);
  assert.equal(cache.size, 2);
  cache.get(files[2]);
  assert.equal(reads, 3);
  cache.get(files[0]);
  assert.equal(reads, 4);
  // Least recently used: a hit on c keeps it over a when b comes in.
  cache.get(files[2]);
  cache.get(files[1]);
  assert.equal(reads, 5);
  cache.get(files[2]);
  assert.equal(reads, 5, 'c stayed');
});

test('scan entries carry the header verdict only for MTP families and never for an Ollama blob', async (t) => {
  const root = tempDir(t, 'jenny-mtp-scan-');
  const dirs = {};
  for (const [name, bytes] of [
    ['Qwen3.8-27B-UD-Q6_K', gguf('qwen35', 1)],
    ['Qwen3.8-27B-Plain-Q4_K_M', gguf('qwen35')],
    ['Qwen3.6-35B-Q4_K_M', gguf('qwen35', 1)],
    ['Qwen3.8-27B-Broken-Q4_K_M', Buffer.from('not a gguf')],
  ]) {
    dirs[name] = path.join(root, 'lib', name);
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(path.join(dirs[name], `${name}.gguf`), bytes);
  }
  const blobsDir = path.join(root, 'blobs');
  const blobPath = path.join(blobsDir, `sha256-${'b'.repeat(64)}`);
  fs.mkdirSync(blobsDir, { recursive: true });
  // A different size from every library file, so the blob is not re-homed onto one.
  fs.writeFileSync(blobPath, Buffer.concat([gguf('qwen35', 1), Buffer.alloc(7)]));

  const entries = await listEntries(root, {
    getPersistedModels: () => Object.entries(dirs).map(([name, dir]) => ({
      tag: name.toLowerCase(), modelPath: path.join(dir, `${name}.gguf`),
    })),
    getOllamaTags: async () => ['qwen3.8:27b-ollama'],
    getOllamaBlob: async () => ({ blobPath }),
  });
  const byTag = new Map(entries.map((entry) => [entry.tag, entry]));
  assert.equal(byTag.get('qwen3.8-27b-ud-q6_k').embeddedMtpLayers, 1);
  assert.equal(byTag.get('qwen3.8-27b-plain-q4_k_m').embeddedMtpLayers, 0);
  // Qwen3.6 is `mtp: "no"` in the acceleration catalog: no header is read.
  assert.equal('embeddedMtpLayers' in byTag.get('qwen3.6-35b-q4_k_m'), false);
  // An unreadable header is "unread", not "no head".
  assert.equal('embeddedMtpLayers' in byTag.get('qwen3.8-27b-broken-q4_k_m'), false);
  const ollama = byTag.get('qwen3.8:27b-ollama');
  assert.equal(ollama.source, 'ollama');
  assert.equal('embeddedMtpLayers' in ollama, false);
});

test('scan entries name the drafter of their own model in a shared folder', async (t) => {
  const root = tempDir(t, 'jenny-mtp-shared-');
  const shared = path.join(root, 'flat');
  fs.mkdirSync(shared, { recursive: true });
  for (const name of [
    'gemma-4-31B-it-Q5.gguf', 'Qwen3.8-27B-UD-Q6_K.gguf',
    'mtp-gemma-4-31B-it.gguf', 'mtp-Qwen3.8-27B-Q4_0.gguf',
  ]) fs.writeFileSync(path.join(shared, name), 'x');

  const entries = await listEntries(root, {
    getPersistedModels: () => [
      { tag: 'gemma4:31b', modelPath: path.join(shared, 'gemma-4-31B-it-Q5.gguf') },
      { tag: 'qwen3.8:27b', modelPath: path.join(shared, 'Qwen3.8-27B-UD-Q6_K.gguf') },
    ],
  });
  const drafters = Object.fromEntries(entries.map((entry) => [entry.tag, entry.drafterGguf]));
  assert.deepEqual(drafters, {
    'gemma4:31b': 'mtp-gemma-4-31B-it.gguf',
    'qwen3.8:27b': 'mtp-Qwen3.8-27B-Q4_0.gguf',
  });
});
