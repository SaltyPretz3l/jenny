'use strict';

// Row 38 item 1 (variant B): one reading of a classified model-load failure
// for the library row, the composer and Diagnostics.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  causePhrase, causeSentence, failureDetails, readModelLoadFailure, recoveryActions, retryContext,
} = require('../renderer/shared/model-load-failure');

function backend(failure, phase = 'model_unavailable') {
  return { phase, model_lifecycle: { state: 'unavailable', requested_model: 'qwen3:8b', engine: 'ollama', failure } };
}

const OOM = { cause: 'out_of_memory', message: 'model requires more system memory', context: 40960, at: '2026-10-07T12:00:00.000Z', engine: 'ollama', model: 'qwen3:8b' };

test('readModelLoadFailure reads the failure only in the unavailable phase and only when classified', () => {
  const read = readModelLoadFailure(backend(OOM));
  assert.deepEqual(read, OOM);
  assert.equal(readModelLoadFailure(backend(OOM, 'ready')), null, 'a ready backend has no failure to tell');
  assert.equal(readModelLoadFailure(backend({ ...OOM, cause: 'bogus' })), null);
  assert.equal(readModelLoadFailure(backend(null)), null);
  assert.equal(readModelLoadFailure(null), null);
  const unnamed = readModelLoadFailure(backend({ ...OOM, model: '', context: -1 }));
  assert.equal(unnamed.model, 'qwen3:8b', 'the requested model names an unnamed failure');
  assert.equal(unnamed.context, null);
});

test('plain words and the matching recovery follow the cause', () => {
  assert.equal(causeSentence(OOM), 'Not enough memory to load it. A smaller context needs less.');
  assert.equal(causePhrase(OOM), 'not enough memory');
  assert.deepEqual(recoveryActions(OOM), ['loadSmaller', 'showFits']);
  assert.deepEqual(recoveryActions({ ...OOM, context: 4096 }), ['showFits'], 'nothing smaller than the lowest step');
  assert.deepEqual(recoveryActions({ ...OOM, context: null }), ['loadSmaller', 'showFits'], 'unknown attempt: offer 8K');
  const unreachable = { ...OOM, cause: 'engine_unreachable' };
  assert.equal(causeSentence(unreachable), "Ollama isn't responding.");
  assert.deepEqual(recoveryActions(unreachable), ['diagnostics', 'retry']);
  const timeout = { ...OOM, cause: 'timeout', engine: 'openai-compatible' };
  assert.equal(causeSentence(timeout), 'Loading took too long and was stopped.');
  assert.deepEqual(recoveryActions(timeout), ['retry']);
  const other = { ...OOM, cause: 'other', message: 'unexpected EOF' };
  assert.equal(causeSentence(other), 'Ollama: unexpected EOF');
  assert.equal(causePhrase(other), 'unexpected EOF');
  assert.deepEqual(recoveryActions(other), ['retry', 'copyDetails']);
  assert.equal(causeSentence({ ...other, message: '', engine: 'openai-compatible' }), 'llama-server could not load it.');
});

test('the memory retry picks the Tune step under the attempted context, 8K when unknown or small', () => {
  assert.equal(retryContext(OOM), 32768);
  assert.equal(retryContext({ ...OOM, context: 8192 }), 4096);
  assert.equal(retryContext({ ...OOM, context: 4096 }), 8192);
  assert.equal(retryContext({ ...OOM, context: null }), 8192);
  assert.equal(retryContext({ ...OOM, context: 5000 }), 4096);
});

test('copy details lists the facts one per line and skips empty ones', () => {
  assert.equal(failureDetails(OOM), [
    'model: qwen3:8b', 'engine: ollama', 'cause: out_of_memory', 'context: 40960',
    'at: 2026-10-07T12:00:00.000Z', 'message: model requires more system memory',
  ].join('\n'));
  assert.equal(failureDetails({ ...OOM, context: null, at: '', message: '' }), 'model: qwen3:8b\nengine: ollama\ncause: out_of_memory');
});
