const fs = require('fs');

const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');

const OLLAMA_ALLOWED_ENV = [/^OLLAMA_/i];

// Anti-thrash runtime defaults for the managed Ollama daemon. On a single
// consumer GPU, the chat model plus any concurrent inference (e.g. the
// background session-notes worker, or a fallback default model) can force
// Ollama to keep two runners resident, evicting and cold-reloading weights
// every turn (observed: ~48s reloads). Pinning a single loaded model with a
// single request slot makes a second same-model request queue onto the hot
// runner instead of spinning a new one, and a longer keep-alive avoids paying
// the cold-load between messages. Each is a DEFAULT only — a user-provided
// OLLAMA_* value (which passes through sanitizeSpawnEnv) always wins.
const OLLAMA_RUNTIME_DEFAULTS = {
  OLLAMA_MAX_LOADED_MODELS: '1',
  OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_KEEP_ALIVE: '30m',
  // Long-context headroom on a single 16GB consumer GPU: Flash Attention plus a
  // quantized (q8_0) KV cache roughly halve the per-token KV footprint, which is
  // what keeps 128K+ context from blowing past VRAM on its own. Same DEFAULT-only
  // contract as above — a user-set OLLAMA_* value (e.g. q4_0 for 256K) still wins.
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
};

function applyOllamaRuntimeDefaults(childEnv, defaults = OLLAMA_RUNTIME_DEFAULTS) {
  for (const [key, value] of Object.entries(defaults)) {
    const existing = childEnv[key];
    if (existing === undefined || String(existing).trim() === '') {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

// Resolve the runtime defaults for this spawn. The MAX_LOADED_MODELS ceiling is
// normally 1 (the anti-thrash pin above), but inline autocomplete needs a small
// FIM model to coexist with the chat model so switching between editing and chat
// doesn't evict either runner. When the caller signals coexistence is needed it
// passes maxLoadedModels=2; we only RAISE the default (never lower it below 1),
// and a user-set OLLAMA_MAX_LOADED_MODELS still wins via applyOllamaRuntimeDefaults.
function resolveOllamaRuntimeDefaults({ maxLoadedModels } = {}) {
  const ceiling = Number(maxLoadedModels);
  if (Number.isInteger(ceiling) && ceiling > Number(OLLAMA_RUNTIME_DEFAULTS.OLLAMA_MAX_LOADED_MODELS)) {
    return { ...OLLAMA_RUNTIME_DEFAULTS, OLLAMA_MAX_LOADED_MODELS: String(ceiling) };
  }
  return OLLAMA_RUNTIME_DEFAULTS;
}

function getConfiguredOllamaModelsDir(env = process.env) {
  return String(env?.OLLAMA_MODELS || '').trim();
}

function resolvePathTarget(fsImpl, configuredPath) {
  if (!configuredPath) {
    return null;
  }
  try {
    if (fsImpl?.realpathSync?.native) {
      const target = String(fsImpl.realpathSync.native(configuredPath) || '').trim();
      return target || null;
    }
  } catch (_error) {
    // Fall through to the standard realpathSync variant.
  }
  try {
    if (typeof fsImpl?.realpathSync === 'function') {
      const target = String(fsImpl.realpathSync(configuredPath) || '').trim();
      return target || null;
    }
  } catch (_error) {
    // Best effort only.
  }
  return null;
}

function resolveUsableOllamaModelsDir({
  env = process.env,
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const configuredPath = getConfiguredOllamaModelsDir(env);
  if (!configuredPath) {
    return {
      configuredPath: '',
      modelsDir: null,
      warning: null,
    };
  }

  let pathLstat;
  try {
    pathLstat = fsImpl.lstatSync(configuredPath);
  } catch (_error) {
    return {
      configuredPath,
      modelsDir: null,
      warning: {
        reason: 'missing',
        message: 'Configured OLLAMA_MODELS path is missing or unreadable; ignoring it.',
      },
    };
  }

  if (platform === 'win32' && typeof pathLstat.isSymbolicLink === 'function' && pathLstat.isSymbolicLink()) {
    const target = resolvePathTarget(fsImpl, configuredPath);
    return {
      configuredPath,
      modelsDir: null,
      warning: {
        reason: 'windows_reparse_point',
        target,
        remediation: 'Use a direct trusted directory path for OLLAMA_MODELS instead of a junction or symlink.',
        troubleshooting: 'Jenny intentionally ignores reparse points here, and Ollama itself may also reject them on Windows.',
        message: 'Configured OLLAMA_MODELS path is a Windows reparse point; ignoring it. Use a direct trusted directory path instead of a junction or symlink. Ollama itself may also reject this path on Windows.',
      },
    };
  }

  let pathStat;
  try {
    pathStat = fsImpl.statSync(configuredPath);
  } catch (_error) {
    return {
      configuredPath,
      modelsDir: null,
      warning: {
        reason: 'unreadable',
        message: 'Configured OLLAMA_MODELS path could not be traversed; ignoring it.',
      },
    };
  }

  if (!pathStat.isDirectory()) {
    return {
      configuredPath,
      modelsDir: null,
      warning: {
        reason: 'not_directory',
        message: 'Configured OLLAMA_MODELS path is not a directory; ignoring it.',
      },
    };
  }

  return {
    configuredPath,
    modelsDir: configuredPath,
    warning: null,
  };
}

function buildSanitizedOllamaEnv(options = {}) {
  const env = options.env || process.env;
  const resolved = resolveUsableOllamaModelsDir(options);
  const childEnv = sanitizeSpawnEnv(env, { allow: OLLAMA_ALLOWED_ENV });
  if (resolved.modelsDir) {
    childEnv.OLLAMA_MODELS = resolved.modelsDir;
  } else {
    delete childEnv.OLLAMA_MODELS;
  }
  applyOllamaRuntimeDefaults(childEnv, resolveOllamaRuntimeDefaults({
    maxLoadedModels: options.maxLoadedModels,
  }));
  return {
    ...resolved,
    env: childEnv,
  };
}

module.exports = {
  OLLAMA_RUNTIME_DEFAULTS,
  applyOllamaRuntimeDefaults,
  resolveOllamaRuntimeDefaults,
  buildSanitizedOllamaEnv,
  getConfiguredOllamaModelsDir,
  resolveUsableOllamaModelsDir,
};
