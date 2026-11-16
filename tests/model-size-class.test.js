'use strict';

// Row 144: the size floor for unattended scheduled checks (owner decision D2).
const test = require('node:test');
const assert = require('node:assert/strict');
const { UNATTENDED_MIN_PARAMS_B, classifyModelSize, sizeFromLabel, sizeFromText } = require('../services/model-size-class');

test('the floor is 7B', () => {
  assert.equal(UNATTENDED_MIN_PARAMS_B, 7);
});

test('the engine parameter count decides first', () => {
  assert.deepEqual(classifyModelSize({ model: 'gemma3:2b', parameterSize: '2.6B' }), { fit: false, params_b: 2.6, source: 'engine' });
  assert.deepEqual(classifyModelSize({ model: 'qwen3.8:27b', parameterSize: '27.8B' }), { fit: true, params_b: 27.8, source: 'engine' });
  // The engine count wins over a misleading name.
  assert.equal(classifyModelSize({ model: 'my-70b-merge', parameterSize: '3.2B' }).fit, false);
  assert.deepEqual(classifyModelSize({ model: 'tiny', parameterSize: '670M' }), { fit: false, params_b: 0.7, source: 'engine' });
});

test('a MoE model counts by its total size', () => {
  assert.equal(classifyModelSize({ model: 'qwen3.6:35b-a3b' }).fit, true);
  assert.deepEqual(classifyModelSize({ model: 'x', ggufSizeLabel: '35B-A3B' }), { fit: true, params_b: 35, source: 'gguf' });
  assert.equal(classifyModelSize({ model: 'mixtral', ggufSizeLabel: '8x7B' }).params_b, 56);
});

test('the GGUF size label is used when the engine has no count', () => {
  assert.deepEqual(classifyModelSize({ model: 'LFM3-Omni-2B-Uncensored.f16', ggufSizeLabel: '2B' }), { fit: false, params_b: 2, source: 'gguf' });
});

test('the model id is the last resort', () => {
  assert.deepEqual(classifyModelSize({ model: 'lfm3-omni-2b' }), { fit: false, params_b: 2, source: 'name' });
  assert.equal(classifyModelSize({ model: 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M' }).params_b, 9);
  assert.equal(classifyModelSize({ model: 'Qwen3.8-27B-Q4_K_M' }).params_b, 27);
  assert.equal(classifyModelSize({ model: 'gemma4-e4b' }).fit, false);
  assert.equal(classifyModelSize({ model: 'gpt-oss-120b' }).fit, true);
});

test('a model whose size cannot be found is too small', () => {
  for (const model of ['phi-4', 'llama3.1', 'mystery-model:latest', '']) {
    assert.deepEqual(classifyModelSize({ model }), { fit: false, params_b: null, source: 'unknown' }, model);
  }
});

test('every cloud engine passes without a size', () => {
  for (const engineType of ['chatgpt', 'codex-cli', 'api-provider', 'ChatGPT']) {
    assert.deepEqual(classifyModelSize({ model: 'gpt-6', engineType }), { fit: true, params_b: null, source: 'cloud' }, engineType);
  }
  assert.equal(classifyModelSize({ model: 'lfm3-omni-2b', engineType: 'openai-compatible' }).fit, false);
  assert.equal(classifyModelSize({ model: 'lfm3-omni-2b', engineType: 'ollama' }).fit, false);
});

test('size helpers ignore quant and version noise', () => {
  assert.equal(sizeFromText('qwen3.8:q4_k_m'), null);
  assert.equal(sizeFromText('model-bf16'), null);
  assert.equal(sizeFromText('llama3.1-8b-instruct'), 8);
  assert.equal(sizeFromLabel(''), null);
  assert.equal(sizeFromLabel(null), null);
  assert.equal(sizeFromLabel('12B'), 12);
});
