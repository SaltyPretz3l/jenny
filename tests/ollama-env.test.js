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

test('buildSanitizedOllamaEnv keeps the anti-thrash ceiling of 1 (no coexistence raise)', () => {
  // The two-model raise existed only for the removed inline suggestions; a
  // stray maxLoadedModels option is ignored and only a user value moves it.
  const pinned = buildSanitizedOllamaEnv({ env: { PATH: 'x' }, maxLoadedModels: 2 });
  assert.equal(pinned.env.OLLAMA_MAX_LOADED_MODELS, '1');
  const userWins = buildSanitizedOllamaEnv({ env: { PATH: 'x', OLLAMA_MAX_LOADED_MODELS: '4' } });
  assert.equal(userWins.env.OLLAMA_MAX_LOADED_MODELS, '4');
});

test('the 30 m keep-alive default applies only when Ollama is (or may be) the chat engine', () => {
  const env = { PATH: 'x' };
  // Dogfood HB-033: chat on the managed llama-server, and an auxiliary Ollama
  // load stayed resident for 30 minutes beside the 12 GB chat model.
  for (const chatEngineType of ['openai-compatible', 'chatgpt', 'OpenAI-Compatible']) {
    const aux = buildSanitizedOllamaEnv({ env, chatEngineType });
    assert.equal(Object.prototype.hasOwnProperty.call(aux.env, 'OLLAMA_KEEP_ALIVE'), false, chatEngineType);
    // The other anti-thrash defaults are untouched.
    assert.equal(aux.env.OLLAMA_MAX_LOADED_MODELS, '1');
    assert.equal(aux.env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
  }
  for (const chatEngineType of ['ollama', '', undefined]) {
    assert.equal(buildSanitizedOllamaEnv({ env, chatEngineType }).env.OLLAMA_KEEP_ALIVE, '30m');
  }
  // A user-set value wins on every engine.
  assert.equal(buildSanitizedOllamaEnv({
    env: { PATH: 'x', OLLAMA_KEEP_ALIVE: '-1' }, chatEngineType: 'openai-compatible',
  }).env.OLLAMA_KEEP_ALIVE, '-1');
  // The shared defaults object is never mutated.
  assert.equal(buildSanitizedOllamaEnv({ env }).env.OLLAMA_KEEP_ALIVE, '30m');
});
