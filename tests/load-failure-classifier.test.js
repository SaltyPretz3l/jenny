'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLoadFailure, buildLoadFailure } = require('../services/backend/load-failure-classifier');

test('load failure classification mirrors runtime causes and precedence', () => {
  for (const [message, cause] of [
    ['model requires more system memory (7.2 GiB) than is available (5.9 GiB)', 'out_of_memory'],
    ['Could not connect to Ollama at 127.0.0.1:11434', 'engine_unreachable'],
    ['request timed out', 'timeout'], ['unexpected EOF', 'other'],
    ['CUDA error', 'out_of_memory'], ['cudaMalloc failed', 'out_of_memory'], ['VRAM exhausted', 'out_of_memory'],
  ]) assert.equal(classifyLoadFailure(message), cause);
  assert.equal(classifyLoadFailure('memory', { timedOut: true, unreachable: true }), 'timeout');
  assert.equal(classifyLoadFailure('memory', { unreachable: true }), 'engine_unreachable');
});

test('failure payload bounds and redacts its message and normalizes unknown shapes', () => {
  const failure = buildLoadFailure({ cause: 'other', message: 'failed /home/private/model.gguf C:\\private\\model.gguf ' + 'x'.repeat(300), context: 8192, engine: 'ollama', model: 'qwen3:8b' });
  assert.equal(failure.message.length, 240);
  assert.equal(failure.message.includes('private'), false);
  assert.equal(failure.context, 8192);
  assert.ok(Number.isFinite(Date.parse(failure.at)));
  assert.equal(buildLoadFailure({ unknown: true }), null);
  assert.equal(buildLoadFailure(null), null);
});
