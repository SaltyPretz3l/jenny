'use strict';

// Row 144: which model a scheduled check would run on, and whether it may (services/primary-check-model.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckModelGate, createSizeLabelReader } = require('../services/primary-check-model');

function service({ primaryChat = {}, phase = 'ready', models = [], available = true, perModel = {}, hints = {}, currentEngineType = 'ollama', currentModel = '' } = {}) {
  const calls = { list: 0 };
  return {
    calls,
    currentEngineType,
    currentModel,
    _modelEngineHints: new Map(Object.entries(hints)),
    getBackendStatus: () => ({ phase }),
    listModels: async () => { calls.list += 1; return { available, data: models }; },
    configService: {
      getState: () => ({ primaryChat }),
      getLocalEngines: () => ({ openaiCompatible: { managed: { enabled: true, perModel } } }),
    },
  };
}

const MODELS = [
  { id: 'qwen3.8:27b', parameterSize: '27.8B', engine_type: 'ollama' },
  { id: 'gemma3:2b', parameterSize: '2.6B', engine_type: 'ollama' },
  { id: 'lfm3-omni-2b', managed: 'llama-server', engine_type: 'openai-compatible' },
];

test('the check model wins, then Jenny\'s pin, then the chat\'s own model', async () => {
  const both = service({ primaryChat: { checkModel: 'qwen3.8:27b', model: 'gemma3:2b' }, models: MODELS });
  assert.equal((await createCheckModelGate(both)({ preferred_model: 'gemma3:2b' })).model, 'qwen3.8:27b');
  const pin = service({ primaryChat: { checkModel: '', model: 'gemma3:2b' }, models: MODELS });
  assert.deepEqual(await createCheckModelGate(pin)({ preferred_model: 'qwen3.8:27b' }),
    { status: 'too_small', model: 'gemma3:2b', engine_type: 'ollama', params_b: 2.6, source: 'engine' });
  const chat = service({ models: MODELS });
  assert.equal((await createCheckModelGate(chat)({ preferred_model: 'qwen3.8:27b' })).status, 'fit');
});

test('a model that is not in the model list is unavailable', async () => {
  const svc = service({ primaryChat: { checkModel: 'deleted:70b' }, models: MODELS });
  assert.equal((await createCheckModelGate(svc)({})).status, 'unavailable');
});

test('a GGUF is sized by its general.size_label', async () => {
  const svc = service({
    models: MODELS,
    perModel: { 'lfm3-omni-2b': { engine: 'llama-server', modelPath: 'G:\\m\\lfm3.gguf' } },
  });
  const seen = [];
  const gate = createCheckModelGate(svc, { readSizeLabel: (file) => { seen.push(file); return '2.6B'; } });
  const answer = await gate({ preferred_model: 'lfm3-omni-2b' });
  assert.deepEqual(answer, { status: 'too_small', model: 'lfm3-omni-2b', engine_type: 'openai-compatible', params_b: 2.6, source: 'gguf' });
  assert.deepEqual(seen, ['G:\\m\\lfm3.gguf']);
});

test('a managed GGUF missing from the list (another engine is current) is still installed', async () => {
  const svc = service({
    models: [{ id: 'qwen3.8:27b', parameterSize: '27.8B' }],
    perModel: { 'qwen3-8-27b-gguf': { engine: 'llama-server', modelPath: 'G:\\m\\q.gguf' } },
  });
  const gate = createCheckModelGate(svc, { readSizeLabel: () => '27B' });
  assert.deepEqual(await gate({ preferred_model: 'qwen3-8-27b-gguf' }),
    { status: 'fit', model: 'qwen3-8-27b-gguf', engine_type: 'openai-compatible', params_b: 27, source: 'gguf' });
});

test('Run anyway skips only the size test', async () => {
  const svc = service({ models: MODELS });
  const gate = createCheckModelGate(svc);
  assert.equal((await gate({ preferred_model: 'gemma3:2b' }, { override: true })).status, 'fit');
  assert.equal((await gate({ preferred_model: 'nope:1b' }, { override: true })).status, 'unavailable');
});

test('a cloud model passes without a model-list read', async () => {
  const svc = service({ currentEngineType: 'chatgpt', currentModel: 'gpt-6', models: [] });
  assert.deepEqual(await createCheckModelGate(svc)({ preferred_model: '' }),
    { status: 'fit', model: 'gpt-6', engine_type: 'chatgpt', params_b: null, source: 'cloud' });
  const hinted = service({ hints: { 'gpt-6': 'chatgpt' }, models: [] });
  assert.equal((await createCheckModelGate(hinted)({ preferred_model: 'gpt-6' })).status, 'fit');
  assert.equal(svc.calls.list + hinted.calls.list, 0);
});

test('a backend or model list that is not ready answers pending', async () => {
  const starting = service({ phase: 'starting', models: MODELS });
  assert.equal((await createCheckModelGate(starting)({ preferred_model: 'qwen3.8:27b' })).status, 'pending');
  const empty = service({ available: false, models: [] });
  assert.equal((await createCheckModelGate(empty)({ preferred_model: 'qwen3.8:27b' })).status, 'pending');
  const throwing = service({ models: MODELS });
  throwing.listModels = async () => { throw new Error('sidecar gone'); };
  assert.equal((await createCheckModelGate(throwing)({ preferred_model: 'qwen3.8:27b' })).status, 'pending');
  const none = service({ phase: 'starting' });
  assert.equal((await createCheckModelGate(none)({})).status, 'pending');
  assert.equal((await createCheckModelGate(service())({})).status, 'unavailable');
});

test('the size-label reader caches by size and mtime and never throws', () => {
  let stat = { size: 10, mtimeMs: 1 };
  let reads = 0;
  const reader = createSizeLabelReader({
    fsImpl: { statSync: (file) => { if (file === 'missing') throw new Error('ENOENT'); return stat; } },
    readHeader: () => { reads += 1; return { kv: { 'general.size_label': ' 27B ' } }; },
  });
  assert.equal(reader('a.gguf'), '27B');
  assert.equal(reader('a.gguf'), '27B');
  assert.equal(reads, 1);
  stat = { size: 11, mtimeMs: 2 };
  assert.equal(reader('a.gguf'), '27B');
  assert.equal(reads, 2);
  assert.equal(reader('missing'), null);
  const noKey = createSizeLabelReader({ fsImpl: { statSync: () => stat }, readHeader: () => ({ kv: {} }) });
  assert.equal(noKey('b.gguf'), null);
  let failed = 0;
  const broken = createSizeLabelReader({ fsImpl: { statSync: () => stat }, readHeader: () => { failed += 1; throw new Error('truncated'); } });
  assert.equal(broken('c.gguf'), null);
  assert.equal(broken('c.gguf'), null);
  assert.equal(failed, 1, 'an unreadable header is cached, not re-read on every retry');
});

test('a model of an engine family the list does not carry is sized by its name, not held as missing', async () => {
  // The list carries one family at a time: with llama-server current it lists no Ollama models.
  const managedOnly = [{ id: 'lfm3-omni-2b', engine_type: 'openai-compatible' }];
  const other = service({ primaryChat: { checkModel: 'qwen3.8:27b' }, models: managedOnly, currentEngineType: 'openai-compatible' });
  assert.equal((await createCheckModelGate(other)({})).status, 'fit');
  const small = service({ primaryChat: { checkModel: 'gemma3:2b' }, models: managedOnly, currentEngineType: 'openai-compatible' });
  assert.equal((await createCheckModelGate(small)({})).status, 'too_small');
  const listedFamily = service({ primaryChat: { checkModel: 'deleted:70b' }, models: [{ id: 'qwen3.8:27b', engine_type: 'ollama' }] });
  assert.equal((await createCheckModelGate(listedFamily)({})).status, 'unavailable');
});

// Row 201 C1 / OD-1: a scheduled check never runs on a teammate's GPU.
test('a team model is never picked for a scheduled check: not the check model, the pin, the chat or the loaded model', async () => {
  const TEAM_ID = 'team/team_alpha1/qwen3.8:27b';
  const withTeam = (primaryChat, extra = {}) => {
    const svc = service({ primaryChat, models: MODELS, hints: { [TEAM_ID]: 'openai-compatible' }, ...extra });
    svc.featureFlags = { team: true };
    return svc;
  };
  const checkModel = withTeam({ checkModel: TEAM_ID, model: 'gemma3:2b' });
  assert.equal((await createCheckModelGate(checkModel)({})).model, 'gemma3:2b', 'the saved team check model is skipped for the next candidate');
  const chat = withTeam({}, {});
  assert.equal((await createCheckModelGate(chat)({ preferred_model: TEAM_ID })).model !== TEAM_ID, true);
  const loaded = withTeam({}, { currentModel: TEAM_ID });
  const answer = await createCheckModelGate(loaded)({});
  assert.notEqual(answer.model, TEAM_ID, 'a loaded team model is not a check model');
  assert.equal(answer.status, 'unavailable');
});
