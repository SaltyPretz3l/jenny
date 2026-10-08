'use strict';

// Embedding model validation and prompt-profile resolution for the semantic
// catalog: tiny GGUF v3 headers written to a temp dir, profile files injected.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILTIN_NONE_PROFILE,
  loadEmbeddingProfiles,
  resolveEmbeddingDims,
  resolveEmbeddingProfile,
  validateEmbeddingModel,
} = require('../services/embedding-model-profiles');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

const STRING = 8;
const UINT32 = 4;
const INT32 = 5;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-embedding-profiles-'));
  trackDirectory(dir);
  return dir;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function ggufString(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

// entries: [key, type, value] with type STRING, UINT32 or INT32.
function buildGguf(entries) {
  const parts = [Buffer.from('GGUF'), u32(3), u64(0), u64(entries.length)];
  for (const [key, type, value] of entries) {
    parts.push(ggufString(key), u32(type));
    if (type === STRING) parts.push(ggufString(value));
    else if (type === UINT32) parts.push(u32(value));
    else {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32LE(value);
      parts.push(buffer);
    }
  }
  return Buffer.concat(parts);
}

function writeModel(dir, fileName, entries) {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buildGguf(entries));
  return filePath;
}

function writeProfiles(dir, content) {
  const filePath = path.join(dir, `profiles-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';

test('the shipped profile file loads every profile, frozen, with none last', () => {
  const profiles = loadEmbeddingProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id), [
    'embeddinggemma', 'nomic', 'e5', 'bge', 'qwen3-embedding', 'none',
  ]);
  assert.ok(Object.isFrozen(profiles));
  const gemma = profiles[0];
  assert.ok(Object.isFrozen(gemma));
  assert.equal(gemma.query, 'task: search result | query: {text}');
  assert.equal(gemma.document, 'title: {title} | text: {text}');
  assert.deepEqual(gemma.dims, [768, 512, 256, 128]);
  assert.equal(gemma.defaultDims, 256);
  const qwen = profiles.find((profile) => profile.id === 'qwen3-embedding');
  assert.equal(
    qwen.query,
    'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: {text}'
  );
  assert.equal(loadEmbeddingProfiles(), profiles, 'cached per file path');
});

test('invalid profiles are dropped and none is always present', () => {
  const dir = makeDir();
  const valid = {
    id: 'ok', label: 'Ok', match: { architectures: [], namePatterns: ['ok'] },
    query: 'q: {text}', document: '{title} {text}', dims: [64, 32], defaultDims: 32,
  };
  const filePath = writeProfiles(dir, {
    version: 1,
    profiles: [
      valid,
      { ...valid, id: 'ok' },
      { ...valid, id: 'Bad_Id' },
      { ...valid, id: 'no-text', query: 'query only' },
      { ...valid, id: 'unknown-placeholder', query: '{text} {lang}' },
      { ...valid, id: 'stray-brace', document: '{text} }' },
      { ...valid, id: 'too-long', query: `${'x'.repeat(510)}{text}` },
      { ...valid, id: 'big-dims', dims: [8192] },
      { ...valid, id: 'zero-dims', dims: [0] },
      { ...valid, id: 'default-not-in-dims', defaultDims: 100 },
      { ...valid, id: 'bad-regex', match: { architectures: [], namePatterns: ['('] } },
    ],
  });
  const profiles = loadEmbeddingProfiles({ filePath });
  assert.deepEqual(profiles.map((profile) => profile.id), ['ok', 'none']);
  assert.equal(profiles[1], BUILTIN_NONE_PROFILE);
});

test('a missing or corrupt profile file falls back to the built-in none profile', () => {
  const dir = makeDir();
  assert.deepEqual(loadEmbeddingProfiles({ filePath: path.join(dir, 'absent.json') }), [BUILTIN_NONE_PROFILE]);
  assert.deepEqual(loadEmbeddingProfiles({ filePath: writeProfiles(dir, '{not json') }), [BUILTIN_NONE_PROFILE]);
  assert.deepEqual(
    loadEmbeddingProfiles({ filePath: writeProfiles(dir, { version: 2, profiles: [] }) }),
    [BUILTIN_NONE_PROFILE]
  );
});

test('resolveEmbeddingProfile prefers a known override, then architecture or name, then none', () => {
  const resolve = (args) => resolveEmbeddingProfile(args).id;
  assert.equal(resolve({ architecture: 'gemma-embedding' }), 'embeddinggemma');
  assert.equal(resolve({ architecture: 'nomic-bert-moe' }), 'nomic');
  assert.equal(resolve({ architecture: 'bert', fileName: 'nomic-embed-text-v1.5.Q8_0.gguf' }), 'nomic');
  assert.equal(resolve({ architecture: 'bert', name: 'Multilingual-E5-Large' }), 'e5');
  assert.equal(resolve({ architecture: 'bert', fileName: 'e5-small-v2.gguf' }), 'e5');
  assert.equal(resolve({ architecture: 'bert', fileName: 'large5-model.gguf' }), 'none', 'e5 is a word, not a substring');
  assert.equal(resolve({ architecture: 'bert', fileName: 'BGE-M3-Q8_0.gguf' }), 'bge');
  assert.equal(resolve({ architecture: 'qwen3', name: 'Qwen3-Embedding-0.6B' }), 'qwen3-embedding');
  assert.equal(resolve({ architecture: 'bert', name: 'all-MiniLM-L6-v2' }), 'none');
  assert.equal(resolve({ architecture: 'gemma-embedding', overrideId: 'bge' }), 'bge');
  assert.equal(resolve({ architecture: 'gemma-embedding', overrideId: 'missing' }), 'embeddinggemma');
  assert.equal(resolveEmbeddingProfile({ architecture: 'bert', profiles: [] }), BUILTIN_NONE_PROFILE);
});

test('resolveEmbeddingDims keeps an allowed width, else the default, else native', () => {
  const gemma = resolveEmbeddingProfile({ architecture: 'gemma-embedding' });
  assert.equal(resolveEmbeddingDims(gemma, 512), 512);
  assert.equal(resolveEmbeddingDims(gemma, 300), 256);
  assert.equal(resolveEmbeddingDims(gemma, 0), 256);
  const nomic = resolveEmbeddingProfile({ architecture: 'nomic-bert' });
  assert.equal(resolveEmbeddingDims(nomic, 512), 0);
  assert.equal(resolveEmbeddingDims(null, 512), 0);
});

test('validateEmbeddingModel accepts a pooling model and reports header facts, never the path', () => {
  const dir = makeDir();
  const filePath = writeModel(dir, 'embeddinggemma-300m-Q8_0.gguf', [
    ['general.architecture', STRING, 'gemma-embedding'],
    ['general.name', STRING, 'EmbeddingGemma 300m'],
    ['gemma-embedding.pooling_type', UINT32, 1],
    ['gemma-embedding.embedding_length', UINT32, 768],
  ]);
  const result = validateEmbeddingModel(filePath, { platform: PLATFORM });
  assert.deepEqual(result, {
    ok: true,
    architecture: 'gemma-embedding',
    name: 'EmbeddingGemma 300m',
    poolingType: 1,
    embeddingLength: 768,
    profileId: 'embeddinggemma',
  });
  assert.equal(JSON.stringify(result).includes(dir), false);
});

test('a pooling_type key makes any architecture an embedding model; a known architecture needs none', () => {
  const dir = makeDir();
  const qwen = writeModel(dir, 'Qwen3-Embedding-0.6B-Q8_0.gguf', [
    ['general.architecture', STRING, 'qwen3'],
    ['qwen3.pooling_type', INT32, 3],
  ]);
  const qwenResult = validateEmbeddingModel(qwen, { platform: PLATFORM });
  assert.equal(qwenResult.ok, true);
  assert.equal(qwenResult.profileId, 'qwen3-embedding', 'the file name matches when general.name is absent');
  assert.equal(qwenResult.embeddingLength, 0);

  const bert = writeModel(dir, 'all-minilm.gguf', [['general.architecture', STRING, 'bert']]);
  const bertResult = validateEmbeddingModel(bert, { platform: PLATFORM });
  assert.equal(bertResult.ok, true);
  assert.equal(bertResult.poolingType, null);
  assert.equal(bertResult.profileId, 'none');
});

test('validateEmbeddingModel refuses a chat model, a non-GGUF, an unreadable file and a bad path', () => {
  const dir = makeDir();
  const chat = writeModel(dir, 'qwen3-8b.gguf', [
    ['general.architecture', STRING, 'qwen3'],
    ['qwen3.embedding_length', UINT32, 4096],
  ]);
  assert.deepEqual(validateEmbeddingModel(chat, { platform: PLATFORM }), { ok: false, reason: 'not_embedding_model' });

  const noArch = writeModel(dir, 'blank.gguf', []);
  assert.deepEqual(validateEmbeddingModel(noArch, { platform: PLATFORM }), { ok: false, reason: 'not_embedding_model' });

  const text = path.join(dir, 'notes.gguf');
  fs.writeFileSync(text, 'this is not a model');
  assert.deepEqual(validateEmbeddingModel(text, { platform: PLATFORM }), { ok: false, reason: 'not_gguf' });

  const truncated = path.join(dir, 'cut.gguf');
  fs.writeFileSync(truncated, buildGguf([['general.architecture', STRING, 'bert']]).subarray(0, 30));
  assert.deepEqual(validateEmbeddingModel(truncated, { platform: PLATFORM }), { ok: false, reason: 'not_gguf' });

  assert.deepEqual(
    validateEmbeddingModel(path.join(dir, 'absent.gguf'), { platform: PLATFORM }),
    { ok: false, reason: 'unreadable' }
  );

  for (const bad of [
    '', 'relative/model.gguf', '\\\\server\\share\\model.gguf', '\\\\?\\C:\\model.gguf',
    'C:\\models\\model.bin', `C:\\${'x'.repeat(1030)}.gguf`, 42,
  ]) {
    assert.deepEqual(validateEmbeddingModel(bad, { platform: 'win32' }), { ok: false, reason: 'path_invalid' });
  }
  assert.deepEqual(
    validateEmbeddingModel('/models/model.gguf', { platform: 'win32' }),
    { ok: false, reason: 'path_invalid' },
    'a root-relative path is refused on win32'
  );
});

test('validateEmbeddingModel reads through the injected fs with a bounded prefix', () => {
  const header = buildGguf([['general.architecture', STRING, 'nomic-bert']]);
  const reads = [];
  const fsImpl = {
    openSync: () => 3,
    fstatSync: () => ({ size: 500 * 1024 * 1024 }),
    readSync: (_fd, buffer, offset, length, position) => {
      reads.push(length);
      if (position >= header.length) return 0;
      return header.copy(buffer, offset, position, Math.min(header.length, position + length));
    },
    closeSync: () => {},
  };
  const result = validateEmbeddingModel('C:\\models\\nomic-embed-text.gguf', { fsImpl, platform: 'win32' });
  assert.equal(result.ok, true);
  assert.equal(result.profileId, 'nomic');
  assert.ok(reads[0] <= 16 * 1024 * 1024, 'never reads the whole model');
});
