'use strict';

// W4a: a GGUF file on disk becomes a Model library card. These pin the pure
// helpers in model-library-sources.js against the two main-process seams they
// mirror: the GGUF classification (services/llama-server-gguf-files.js) and the
// persisted-settings normalizer (services/shell-config-engines.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sources = require('../renderer/shell/model-library/model-library-sources');
const merge = require('../renderer/shell/model-library/model-library-merge');
const { splitGgufFiles } = require('../services/llama-server-gguf-files');
const {
  managedModelKey: serviceManagedModelKey,
  normalizeLocalEngines,
} = require('../services/shell-config-engines');

const OWNER_DIR = 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b';
const OWNER_FILE = OWNER_DIR + '\\Ternary-Bonsai-2-27B-PQ2_0.gguf';
const OWNER_TAG = 'ternary-bonsai-2-27b-pq2_0';
const OWNER_KEY = 'ternary-bonsai-2-27b-pq2-0';
const OWNER_BYTES = 7206168928;
const BLOB = 'sha256-' + 'a1'.repeat(32);

function libraryEntry(tag, modelPath, extra = {}) {
  return { engine: 'llama-server', tag, modelPath, mtp: { mode: 'off', draftNMax: 4 }, ...extra };
}

function managedWith(entries) {
  const perModel = {};
  for (const entry of entries) perModel[merge.managedModelKey(entry.tag)] = entry;
  return { enabled: true, perModel };
}

test('libraryTagFromPath names the owner file by its lowercased stem and keys it like main', () => {
  assert.equal(sources.libraryTagFromPath(OWNER_FILE), OWNER_TAG);
  assert.equal(sources.libraryTagFromPath('/srv/gguf/Ternary-Bonsai-2-27B-PQ2_0.GGUF'), OWNER_TAG);
  assert.equal(sources.libraryTagFromPath('G:/llmmodels\\gguf/Ternary-Bonsai-2-27B-PQ2_0.gguf'), OWNER_TAG);
  assert.equal(merge.managedModelKey(OWNER_TAG), OWNER_KEY);
  assert.equal(serviceManagedModelKey(OWNER_TAG), OWNER_KEY);
});

test('libraryTagFromPath drops a shard suffix, maps symbols and trims separators', () => {
  const cases = [
    ['D:\\m\\Qwen3-235B-A22B-Q4_K_M-00001-of-00003.gguf', 'qwen3-235b-a22b-q4_k_m'],
    ['D:\\m\\GLM-4.6-UD-Q2_K_XL-00002-OF-00005.GGUF', 'glm-4.6-ud-q2_k_xl'],
    // Only llama.cpp's five-digit split names are shards.
    ['D:\\m\\x-001-of-003.gguf', 'x-001-of-003'],
    ['D:\\m\\Llama-3.1-8B.Q4_K_M.gguf', 'llama-3.1-8b.q4_k_m'],
    ['D:\\m\\My Model (1) [Q4]+x.gguf', 'my-model--1---q4--x'],
    ['D:\\m\\Modèle Ü-7B.gguf', 'mod-le---7b'],
    ['D:\\m\\--._Model_.gguf', 'model'],
    ['D:\\m\\.hidden.gguf', 'hidden'],
    ['D:\\m\\model.gguf.bin', 'model.gguf.bin'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sources.libraryTagFromPath(input), expected, input);
  }
});

test('libraryTagFromPath falls back to the parent folder when the stem is empty', () => {
  assert.equal(sources.libraryTagFromPath('D:\\gguf\\Bonsai 2\\---.gguf'), 'bonsai-2');
  assert.equal(sources.libraryTagFromPath('D:/gguf/Bonsai 2/.gguf'), 'bonsai-2');
  assert.equal(sources.libraryTagFromPath('/srv/models/My.Model/(__).gguf'), 'my.model');
  assert.equal(sources.libraryTagFromPath('D:\\gguf\\Q4-00001-of-00002\\-00001-of-00002.gguf'), 'q4');
  // Nothing usable anywhere: no tag, and a drive root is not a folder name.
  assert.equal(sources.libraryTagFromPath('D:\\---\\___.gguf'), '');
  assert.equal(sources.libraryTagFromPath('G:\\---.gguf'), '');
  assert.equal(sources.libraryTagFromPath('---.gguf'), '');
  assert.equal(sources.libraryTagFromPath(''), '');
  assert.equal(sources.libraryTagFromPath(null), '');
  assert.equal(sources.libraryTagFromPath(undefined), '');
});

test('libraryTagFromPath refuses mock and replay tags and tags over 128 characters', () => {
  assert.equal(sources.libraryTagFromPath('D:\\m\\Mock-Model.gguf'), '');
  assert.equal(sources.libraryTagFromPath('D:\\m\\REPLAY_7b.gguf'), '');
  assert.equal(sources.libraryTagFromPath('D:\\m\\mockingbird-7b.gguf'), '');
  assert.equal(sources.libraryTagFromPath('D:\\mock-models\\---.gguf'), '');
  assert.equal(sources.libraryTagFromPath('D:\\m\\my-mock.gguf'), 'my-mock');
  assert.equal(sources.libraryTagFromPath('D:\\m\\' + 'a'.repeat(128) + '.gguf'), 'a'.repeat(128));
  assert.equal(sources.libraryTagFromPath('D:\\m\\' + 'a'.repeat(129) + '.gguf'), '');
  assert.equal(
    sources.libraryTagFromPath('D:\\m\\' + 'b'.repeat(128) + '-00001-of-00002.gguf'),
    'b'.repeat(128)
  );
});

test('library tags round-trip through the real persisted-settings normalizer', () => {
  const files = [
    OWNER_FILE,
    'D:\\m\\Qwen3-235B-A22B-Q4_K_M-00001-of-00003.gguf',
    'D:\\m\\Llama-3.1-8B.Q4_K_M.gguf',
    'D:\\m\\My Model (1) [Q4]+x.gguf',
    'D:\\gguf\\Bonsai 2\\---.gguf',
    'D:\\m\\' + 'c'.repeat(128) + '.gguf',
  ];
  for (const file of files) {
    const tag = sources.libraryTagFromPath(file);
    assert.ok(tag, file);
    const key = merge.managedModelKey(tag);
    assert.equal(key, serviceManagedModelKey(tag), file);
    const normalized = normalizeLocalEngines({
      openaiCompatible: { managed: { enabled: true, perModel: { [key]: libraryEntry(tag, file) } } },
    }).openaiCompatible.managed.perModel;
    assert.deepEqual(Object.keys(normalized), [key], file);
    assert.equal(normalized[key].tag, tag, file);
    assert.equal(normalized[key].modelPath, file, file);
    assert.equal(normalized[key].engine, 'llama-server', file);
  }
});

// One corpus, two classifiers: every name must land on the same side of the
// main/auxiliary line in the renderer and in the launcher's own splitGgufFiles.
const AUXILIARY_CORPUS = [
  // main models
  'Ternary-Bonsai-2-27B-PQ2_0.gguf',
  'gemma-4-E4B-it-UD-Q5_K_XL.gguf',
  'model.gguf',
  'x-mmprojector.gguf',
  'x mmprojector.gguf',
  'x-mmprojection-Q8_0.gguf',
  'mymmproj.gguf',
  'x\u200bmmproj.gguf',
  'mtp_x.gguf',
  'MTPx.gguf',
  'x-mtp-Q4.gguf',
  'qwen3 - Copy.gguf',
  'qwen3 (1).gguf',
  'x.gguf.gguf',
  '.gguf',
  '..gguf',
  // vision projectors
  'mmproj.gguf',
  'mmproj-Ternary-Bonsai-2-27B-F16.gguf',
  'MMPROJ-x.gguf',
  'mmprojector.gguf',
  'mmproj_x.gguf',
  'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
  'x.mmproj-f16.gguf',
  'x_mmproj.gguf',
  'x.mmproj.gguf',
  'x.mmproj..gguf',
  '-mmproj.gguf',
  'foo-MmPrOj-Q4.gguf',
  'x mmproj Q8_0.gguf',
  'x-mmproj (1).gguf',
  'x-mmproj - Copy.gguf',
  'x\tmmproj.gguf',
  'x\u00a0mmproj.gguf',
  'x\u2003mmproj.gguf',
  ' mmproj-x.gguf',
  // MTP drafters
  'mtp-gemma4.gguf',
  'MTP-x.gguf',
  'mtp-.gguf',
  'mtp-x-mmproj-f16.gguf',
];

test('isAuxiliaryGguf agrees with the launcher classification on a shared corpus', () => {
  let auxiliary = 0;
  for (const name of AUXILIARY_CORPUS) {
    const split = splitGgufFiles([name]);
    assert.equal(split.main.length + split.drafters.length + split.projectors.length, 1, name);
    const expected = !split.main.includes(name);
    assert.equal(sources.isAuxiliaryGguf(name), expected, JSON.stringify(name));
    if (expected) auxiliary += 1;
  }
  // Both sides of the line are exercised, whitespace separators included.
  assert.ok(auxiliary > 10 && auxiliary < AUXILIARY_CORPUS.length - 10);
  assert.equal(sources.isAuxiliaryGguf('x mmproj Q8_0.gguf'), true);
  assert.equal(sources.isAuxiliaryGguf('x-mmprojector.gguf'), false);
  const whole = splitGgufFiles(AUXILIARY_CORPUS);
  assert.deepEqual(
    [...whole.main].sort(),
    AUXILIARY_CORPUS.filter((name) => !sources.isAuxiliaryGguf(name)).sort()
  );
});

test('isAuxiliaryGguf reads the file name of a full path, never a folder name', () => {
  assert.equal(sources.isAuxiliaryGguf(OWNER_DIR + '\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'), true);
  assert.equal(sources.isAuxiliaryGguf('/srv/gguf/mtp-gemma4.gguf'), true);
  assert.equal(sources.isAuxiliaryGguf('G:\\mmproj\\model.gguf'), false);
  assert.equal(sources.isAuxiliaryGguf('G:\\mtp-models\\model.gguf'), false);
  assert.equal(sources.isAuxiliaryGguf(OWNER_FILE), false);
  assert.equal(sources.isAuxiliaryGguf(''), false);
});

test('sameModelPath normalizes separators and folds case only for drive paths', () => {
  assert.equal(sources.sameModelPath('G:\\M\\x.gguf', 'g:/m/X.GGUF'), true);
  assert.equal(sources.sameModelPath('G:\\M\\x.gguf', 'G:\\M\\y.gguf'), false);
  assert.equal(sources.sameModelPath('/srv/M/x.gguf', '/srv/m/x.gguf'), false);
  assert.equal(sources.sameModelPath('/srv/m/x.gguf', '/srv/m/x.gguf'), true);
  assert.equal(sources.sameModelPath('\\\\host\\share\\X.gguf', '//host/share/X.gguf'), true);
  assert.equal(sources.sameModelPath('\\\\host\\share\\X.gguf', '//host/share/x.gguf'), false);
  assert.equal(sources.sameModelPath('', ''), false);
  assert.equal(sources.sameModelPath(null, undefined), false);
});

test('projectLibraryGgufs emits a library entry sized by the scanned file at its path', () => {
  const managed = managedWith([libraryEntry(OWNER_TAG, OWNER_FILE)]);
  const scanned = {
    // Listed under its folder's tag by a library-root scan: the PATH decides.
    tag: 'ternary-bonsai-2-27b',
    dir: 'g:\\llmmodels\\GGUF\\ternary-bonsai-2-27b\\',
    mainGguf: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
    sizeBytes: OWNER_BYTES,
  };
  const sibling = { tag: OWNER_TAG, dir: OWNER_DIR, mainGguf: 'Other-Q8_0.gguf', sizeBytes: 5 };
  assert.deepEqual(sources.projectLibraryGgufs({
    managed, localGgufs: [sibling, scanned], ollamaTags: [], installed: [],
  }), [{
    id: OWNER_TAG, size: OWNER_BYTES, engine_type: 'openai-compatible', available: true, libraryGguf: true,
  }]);
  // No scanned file at that path: the entry still projects, size unknown.
  assert.deepEqual(sources.projectLibraryGgufs({ managed, localGgufs: [sibling] }), [{
    id: OWNER_TAG, size: 0, engine_type: 'openai-compatible', available: true, libraryGguf: true,
  }]);
  assert.deepEqual(sources.projectLibraryGgufs(null), []);
  assert.deepEqual(sources.projectLibraryGgufs({ managed: { perModel: null } }), []);
});

test('projectLibraryGgufs skips every entry that is not a library GGUF', () => {
  const qwen = libraryEntry('qwen3-8b', 'D:\\gguf\\Qwen3-8B.gguf');
  const project = (entries, extra = {}) => sources.projectLibraryGgufs({
    managed: managedWith(entries), localGgufs: [], ollamaTags: [], installed: [], ...extra,
  }).map((entry) => entry.id);

  assert.deepEqual(project([qwen]), ['qwen3-8b']);
  // Not a llama-server entry, or missing its tag or file.
  assert.deepEqual(project([{ ...qwen, engine: 'ollama' }]), []);
  assert.deepEqual(sources.projectLibraryGgufs({
    managed: { enabled: true, perModel: { 'qwen3-8b': { ...qwen, tag: '' } } },
  }), []);
  assert.deepEqual(project([{ ...qwen, modelPath: '' }]), []);
  // Ollama has a model under the same key (string or object entries).
  assert.deepEqual(project([qwen], { ollamaTags: ['qwen3:8b'] }), []);
  assert.deepEqual(project([qwen], { ollamaTags: [{ name: 'Qwen3:8B', size: 1 }] }), []);
  assert.deepEqual(project([qwen], { ollamaTags: [{ name: 'qwen3:14b' }] }), ['qwen3-8b']);
  // An installed model owns the key: Ollama's, or any other tag.
  assert.deepEqual(project([qwen], { installed: [{ id: 'qwen3-8b', engine_type: 'ollama' }] }), []);
  assert.deepEqual(project([qwen], { installed: [{ id: 'qwen3:8b', engine_type: 'openai-compatible' }] }), []);
  // The served alias of this very entry is the same card, not an owner.
  assert.deepEqual(project([qwen], { installed: [{ id: 'qwen3-8b', engine_type: 'openai-compatible' }] }), ['qwen3-8b']);
  assert.deepEqual(project([qwen], { installed: [{ id: 'other:1b', engine_type: 'ollama' }] }), ['qwen3-8b']);
  // Ollama's own blob copy is an Ollama model even when Ollama is not listing.
  const blobEntry = libraryEntry('gemma4-12b', 'C:\\Users\\me\\.ollama\\models\\blobs\\' + BLOB);
  assert.deepEqual(project([blobEntry]), []);
  assert.deepEqual(project([{ ...blobEntry, modelPath: '/home/me/.ollama/models/blobs/SHA256-' + 'A1'.repeat(32) }]), []);
  assert.deepEqual(project([{ ...blobEntry, modelPath: 'D:\\gguf\\' + BLOB + '.gguf' }]), ['gemma4-12b']);
});

// The merge keys CARDS by canonical tag, so "mistral" and Ollama's
// "mistral:latest" would be one card although their perModel keys differ. The
// Add refuses such a name up front; one that meets its clash later (Ollama
// pulls "mistral" afterwards) keeps a card of its own, keyed by its tag.
test('a clash on the card only gives the library entry a card of its own', () => {
  assert.equal(sources.sharesModelName('mistral', 'mistral:latest'), true);
  assert.equal(sources.sharesModelName('qwen3-8b', 'qwen3:8b'), true);
  assert.equal(sources.sharesModelName('qwen3-8b', 'qwen3:14b'), false);
  assert.equal(sources.sharesModelName('---', '...'), false);
  assert.equal(sources.sharesModelName('', null), false);
  const mistral = libraryEntry('mistral', 'D:\\gguf\\Mistral.gguf');
  const project = (extra) => sources.projectLibraryGgufs({ managed: managedWith([mistral]), ...extra })
    .map((row) => [row.id, row.ownCardKey || '']);
  const own = [['mistral', 'mistral']];
  assert.deepEqual(project({ ollamaTags: [{ name: 'mistral:latest' }] }), own);
  assert.deepEqual(project({ ollamaTags: ['Mistral:Latest'] }), own);
  assert.deepEqual(project({ installed: [{ id: 'mistral:latest', engine_type: 'ollama' }] }), own);
  assert.deepEqual(project({ installed: [{ id: 'mistral:latest', engine_type: 'openai-compatible' }] }), own);
  // A catalog card is a card too.
  assert.deepEqual(project({ recommendations: [{ pullTag: 'mistral:latest', vramRequiredMb: 1 }] }), own);
  // The served alias of this very entry (a twin under both keys) shares its card.
  assert.deepEqual(project({ installed: [{ id: 'Mistral', engine_type: 'openai-compatible' }] }), [['mistral', '']]);
  assert.deepEqual(project({ recommendations: [{ pullTag: 'mistral', vramRequiredMb: 1 }] }), [['mistral', '']]);
  assert.deepEqual(project({ ollamaTags: [{ name: 'mistral:7b' }] }), [['mistral', '']]);
  // A model under the same perModel KEY still owns the entry as its engine setting.
  assert.deepEqual(project({ ollamaTags: [{ name: 'mistral' }] }), []);
  assert.deepEqual(project({ installed: [{ id: 'mistral', engine_type: 'ollama' }] }), []);
  assert.deepEqual(project({ installed: [{ id: 'org/mistral', engine_type: 'vllm' }] }), []);
});

test('the merge keeps an own-card library row apart from the card it would share', () => {
  const row = { id: 'mistral', size: 5, engine_type: 'openai-compatible', available: true, libraryGguf: true, ownCardKey: 'mistral' };
  const cards = merge.mergeModelLibrary({
    installed: [{ id: 'mistral:latest', size: 4e9, engine_type: 'ollama' }, row],
    ollamaTags: [{ name: 'mistral:latest', size: 4e9 }],
    recommendations: [{ pullTag: 'mistral:latest', vramRequiredMb: 1 }],
    managed: managedWith([libraryEntry('mistral', 'D:\\gguf\\Mistral.gguf')]),
  }).cards;
  const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
  assert.deepEqual(Object.keys(byKey).sort(), ['mistral', 'mistral:latest']);
  assert.equal(byKey.mistral.libraryGguf, true);
  assert.equal(byKey.mistral.tag, 'mistral');
  assert.equal(byKey.mistral.selectedEngine, 'llama-server');
  assert.equal(byKey.mistral.engines.ollama.available, false);
  assert.equal(byKey['mistral:latest'].libraryGguf, false);
  assert.equal(byKey['mistral:latest'].engineType, 'ollama');
  assert.equal(byKey['mistral:latest'].selectedEngine, 'ollama');
  // Only a projected library row may pick its own card key.
  const plain = merge.mergeModelLibrary({ installed: [{ id: 'x', engine_type: 'ollama', ownCardKey: 'y' }] }).cards;
  assert.deepEqual(plain.map((card) => card.key), ['x:latest']);
});

// Fix: an Ollama model's engine setting (Tune writes its Ollama tag, with ":")
// is not a library GGUF, even while Ollama is not listing.
test('isLibraryTag accepts every tag libraryTagFromPath makes and nothing an engine names', () => {
  const files = [
    OWNER_FILE, 'D:\\m\\Qwen3-235B-A22B-Q4_K_M-00001-of-00003.gguf', 'D:\\m\\Llama-3.1-8B.Q4_K_M.gguf',
    'D:\\m\\My Model (1) [Q4]+x.gguf', 'D:\\m\\Modèle Ü-7B.gguf', 'D:\\m\\--._Model_.gguf', 'D:\\gguf\\Bonsai 2\\---.gguf',
    '/srv/models/My.Model/(__).gguf', 'D:\\m\\' + 'a'.repeat(128) + '.gguf', 'D:\\m\\gpt-50.gguf', 'D:\\m\\x-001-of-003.gguf',
  ];
  for (const file of files.concat(AUXILIARY_CORPUS.map((name) => 'D:\\m\\' + name))) {
    const tag = sources.libraryTagFromPath(file);
    if (tag) assert.equal(sources.isLibraryTag(tag), true, `${file} -> ${tag}`);
  }
  for (const tag of ['gemma4:12b', 'qwen3:8b-q4_K_M', 'Qwen/Qwen3-8B', 'hf.co/org/model:Q4', 'Mistral', '-x', '.x', '_x', 'a b', '', null, undefined, 7]) {
    assert.equal(sources.isLibraryTag(tag), false, String(tag));
  }
});

test('projectLibraryGgufs never projects an entry whose tag is not library-shaped', () => {
  const gemma = { engine: 'llama-server', tag: 'gemma4:12b', modelPath: 'G:\\gguf\\gemma-4-12b\\gemma-4-12b-it-Q4_K_M.gguf', mtp: { mode: 'mtp', draftNMax: 4 } };
  const project = (entries) => sources.projectLibraryGgufs({
    managed: { enabled: true, perModel: entries }, localGgufs: [], ollamaTags: [], installed: [],
  }).map((row) => row.id);
  // Ollama is not listing: no Ollama row may own the entry, and still it is no library GGUF.
  assert.deepEqual(project({ 'gemma4-12b': gemma }), []);
  assert.deepEqual(project({ qwen3: { ...gemma, tag: 'Qwen/Qwen3' } }), []);
  assert.deepEqual(project({ mistral: { ...gemma, tag: 'Mistral' } }), []);
  assert.deepEqual(project({ 'gemma4-12b': gemma, mistral: libraryEntry('mistral', 'D:\\gguf\\Mistral.gguf') }), ['mistral']);
});

// Fix: main's inferEngineTypeFromModel anchors some ids to another engine, and
// resolveRequestedEngineType lets that verdict override the llama-server pin,
// so a library GGUF must never be named like one. Main's anchors are read from
// its source, so a new one fails here until the renderer refuses it too.
test('libraryTagFromPath refuses exactly the ids main anchors to another engine', () => {
  const { inferEngineTypeFromModel, resolveRequestedEngineType } = require('../services/backend/backend-service-utils');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'backend', 'backend-service-utils.js'), 'utf8');
  const anchoredSet = /const ID_ANCHORED_ENGINE_TYPES = Object\.freeze\(\s*new Set\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(anchoredSet, 'main still declares ID_ANCHORED_ENGINE_TYPES');
  const anchored = anchoredSet[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual([...anchored].sort(), ['chatgpt', 'codex-cli', 'mock', 'replay']);
  const body = source.slice(source.indexOf('function inferEngineTypeFromModel'), source.indexOf('const ID_ANCHORED_ENGINE_TYPES'));
  const conditions = {};
  for (const match of body.matchAll(/if \(([^{]+)\) \{\s*return '([a-z_-]+)';/g)) {
    if (anchored.includes(match[2])) (conditions[match[2]] ||= []).push(match[1].trim());
  }
  // codex-cli's anchor needs a "/", which no library tag has.
  assert.deepEqual(conditions, {
    'codex-cli': ["token.startsWith('codex-cli/')"],
    chatgpt: ["token === 'gpt-6-astra' || /^gpt-5([.:-]|$)/.test(token)"],
    mock: ["token.startsWith('mock')"],
    replay: ["token.startsWith('replay')"],
  });
  const refused = ['GPT-5.gguf', 'gpt-5-Distill-Qwen3-8B-Q4_K_M.gguf', 'GPT-5.1-mini-abliterated.Q4_K_M.gguf',
    'gpt-6-astra.gguf', 'Mock-7B.gguf', 'replay_7b.gguf', 'mockingbird.gguf'];
  const accepted = ['gpt-50.gguf', 'gpt-5_x.gguf', 'gpt-6-astra-q4.gguf', 'gpt-6.gguf', 'gpt-oss-20b.gguf', 'my-gpt-5.gguf', 'my-mock.gguf'];
  for (const name of refused) assert.equal(sources.libraryTagFromPath('D:\\hf\\' + name), '', name);
  for (const name of accepted) {
    const tag = sources.libraryTagFromPath('D:\\hf\\' + name);
    assert.ok(tag, name);
    assert.equal(resolveRequestedEngineType('openai-compatible', tag), 'openai-compatible', `${name} -> ${inferEngineTypeFromModel(tag)}`);
  }
  // Every other tag the renderer makes keeps the llama-server pin.
  let seed = 918;
  const pieces = ['gpt', '-', '5', '6', '.', '_', 'astra', 'mock', 'replay', 'codex', 'cli', 'x', 'Q4', '8B', ' '];
  for (let index = 0; index < 4000; index += 1) {
    let name = '';
    for (let count = 1 + (index % 6); count > 0; count -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      name += pieces[seed % pieces.length];
    }
    const tag = sources.libraryTagFromPath('D:\\hf\\' + name + '.gguf');
    if (tag) assert.equal(resolveRequestedEngineType('openai-compatible', tag), 'openai-compatible', `${name} -> ${tag}`);
  }
});
