const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSanitizedOllamaEnv,
  resolveUsableOllamaModelsDir,
} = require('../services/backend/ollama-env');

test('resolveUsableOllamaModelsDir keeps a direct directory path', () => {
  const result = resolveUsableOllamaModelsDir({
    env: { OLLAMA_MODELS: 'D:/Models/Ollama' },
    fsImpl: {
      lstatSync() {
        return {
          isSymbolicLink() {
            return false;
          },
        };
      },
      statSync() {
        return {
          isDirectory() {
            return true;
          },
        };
      },
    },
    platform: 'win32',
  });

  assert.equal(result.modelsDir, 'D:/Models/Ollama');
  assert.equal(result.warning, null);
});

test('resolveUsableOllamaModelsDir rejects Windows reparse points', () => {
  const result = resolveUsableOllamaModelsDir({
    env: { OLLAMA_MODELS: 'G:/Ollama' },
    fsImpl: {
      lstatSync() {
        return {
          isSymbolicLink() {
            return true;
          },
        };
      },
      realpathSync() {
        return 'G:/llmmodels/ollama';
      },
      statSync() {
        throw new Error('should not stat a rejected path');
      },
    },
    platform: 'win32',
  });

  assert.equal(result.modelsDir, null);
  assert.equal(result.warning.reason, 'windows_reparse_point');
  assert.equal(result.warning.target, 'G:/llmmodels/ollama');
  assert.match(result.warning.message, /direct trusted directory/i);
  assert.match(result.warning.message, /Ollama itself may also reject/i);
});

test('buildSanitizedOllamaEnv removes invalid OLLAMA_MODELS entries', () => {
  const result = buildSanitizedOllamaEnv({
    env: {
      OLLAMA_MODELS: 'G:/Ollama',
      PATH: 'C:/Windows/System32',
    },
    fsImpl: {
      lstatSync() {
        throw new Error('missing');
      },
      statSync() {
        throw new Error('missing');
      },
    },
  });

  assert.equal(result.modelsDir, null);
  assert.equal(result.env.PATH, 'C:/Windows/System32');
  assert.equal(Object.prototype.hasOwnProperty.call(result.env, 'OLLAMA_MODELS'), false);
});

test('buildSanitizedOllamaEnv injects anti-thrash runtime defaults when absent', () => {
  const result = buildSanitizedOllamaEnv({
    env: { PATH: 'C:/Windows/System32' },
  });

  assert.equal(result.env.OLLAMA_MAX_LOADED_MODELS, '1');
  assert.equal(result.env.OLLAMA_NUM_PARALLEL, '1');
  assert.equal(result.env.OLLAMA_KEEP_ALIVE, '30m');
  // Long-context defaults for a single 16GB GPU: Flash Attention + quantized KV cache.
  assert.equal(result.env.OLLAMA_FLASH_ATTENTION, '1');
  assert.equal(result.env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
});

test('buildSanitizedOllamaEnv never overrides user-provided OLLAMA_* runtime values', () => {
  const result = buildSanitizedOllamaEnv({
    env: {
      PATH: 'C:/Windows/System32',
      OLLAMA_MAX_LOADED_MODELS: '3',
      OLLAMA_KEEP_ALIVE: '-1',
      OLLAMA_KV_CACHE_TYPE: 'q4_0',
    },
  });

  // User values win; only the unset default is filled in.
  assert.equal(result.env.OLLAMA_MAX_LOADED_MODELS, '3');
  assert.equal(result.env.OLLAMA_KEEP_ALIVE, '-1');
  assert.equal(result.env.OLLAMA_NUM_PARALLEL, '1');
  // A user-chosen KV cache type (e.g. q4_0 to push 256K) is preserved over the default.
  assert.equal(result.env.OLLAMA_KV_CACHE_TYPE, 'q4_0');
  assert.equal(result.env.OLLAMA_FLASH_ATTENTION, '1');
});

test('buildSanitizedOllamaEnv raises the loaded-models ceiling for inline-suggest coexistence', () => {
  // When the caller signals coexistence (maxLoadedModels=2) the default ceiling
  // rises so a FIM model can stay resident beside the chat model.
  const raised = buildSanitizedOllamaEnv({ env: { PATH: 'x' }, maxLoadedModels: 2 });
  assert.equal(raised.env.OLLAMA_MAX_LOADED_MODELS, '2');
  // Other anti-thrash defaults are untouched.
  assert.equal(raised.env.OLLAMA_NUM_PARALLEL, '1');
  assert.equal(raised.env.OLLAMA_KEEP_ALIVE, '30m');
});

test('buildSanitizedOllamaEnv only RAISES the ceiling and still defers to a user value', () => {
  // A lower/equal request never lowers the anti-thrash default of 1.
  const noChange = buildSanitizedOllamaEnv({ env: { PATH: 'x' }, maxLoadedModels: 1 });
  assert.equal(noChange.env.OLLAMA_MAX_LOADED_MODELS, '1');
  const garbage = buildSanitizedOllamaEnv({ env: { PATH: 'x' }, maxLoadedModels: 'nope' });
  assert.equal(garbage.env.OLLAMA_MAX_LOADED_MODELS, '1');
  // A user-set value wins even when coexistence is requested.
  const userWins = buildSanitizedOllamaEnv({
    env: { PATH: 'x', OLLAMA_MAX_LOADED_MODELS: '4' },
    maxLoadedModels: 2,
  });
  assert.equal(userWins.env.OLLAMA_MAX_LOADED_MODELS, '4');
});
