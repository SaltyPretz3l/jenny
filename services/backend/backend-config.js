const fs = require('fs');
const path = require('path');

const DEFAULT_MANAGED_SHELL_MODEL = 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M';
const DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL = DEFAULT_MANAGED_SHELL_MODEL;
const DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH = 32768;

const DEFAULT_LLAMA_SERVER_HOST = '127.0.0.1';
const DEFAULT_LLAMA_SERVER_PORT = 8033;
const DEFAULT_LLAMA_SERVER_READINESS_TIMEOUT_MS = 90_000;
const LLAMA_SERVER_PROFILE_SCHEMA_VERSION = 1;
const LLAMA_SERVER_PROFILE_SCHEMA_VERSIONS = new Set([1, 2]);
const LLAMA_SERVER_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const LLAMA_SERVER_PROFILE_MANAGED_ARGS = new Set([
  '-m', '--model', '--host', '--port', '-c', '--ctx-size', '-a', '--alias',
  '--api-key', '--api-key-file', '--slots', '--no-slots',
]);

function isTrueish(value) {
  return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function isFalseish(value) {
  return /^(0|false|no|off)$/i.test(String(value == null ? '' : value).trim());
}

function validateExtraArgs(rawExtraArgs) {
  if (!Array.isArray(rawExtraArgs) || rawExtraArgs.length > 64) {
    return { args: [], error: 'profile_extra_args_invalid' };
  }

  const args = [];
  for (const rawArg of rawExtraArgs) {
    if (typeof rawArg !== 'string') {
      return { args: [], error: 'profile_extra_args_invalid' };
    }
    const arg = rawArg.trim();
    const flagName = arg.split('=', 1)[0];
    if (!arg || /[\r\n\0]/.test(arg) || LLAMA_SERVER_PROFILE_MANAGED_ARGS.has(flagName)) {
      return { args: [], error: 'profile_extra_args_invalid' };
    }
    args.push(arg);
  }

  return { args, error: '' };
}

function normalizeProfileAcceleration(schemaVersion, source) {
  const hasAcceleration = Object.prototype.hasOwnProperty.call(source, 'acceleration');
  if (schemaVersion === 1 && hasAcceleration) {
    return { acceleration: null, error: 'profile_acceleration_invalid' };
  }
  if (!hasAcceleration || source.acceleration === null) {
    return { acceleration: null, error: '' };
  }

  const rawAcceleration = source.acceleration;
  if (
    typeof rawAcceleration !== 'object'
    || Array.isArray(rawAcceleration)
    || Object.getPrototypeOf(rawAcceleration) !== Object.prototype
  ) {
    return { acceleration: null, error: 'profile_acceleration_invalid' };
  }

  const mode = rawAcceleration.mode;
  const hasDraftNMax = Object.prototype.hasOwnProperty.call(rawAcceleration, 'draft_n_max');
  const draftNMax = hasDraftNMax
    ? rawAcceleration.draft_n_max
    : 0;
  const allowUnverified = Object.prototype.hasOwnProperty.call(rawAcceleration, 'allow_unverified')
    ? rawAcceleration.allow_unverified
    : false;
  if (
    !['off', 'mtp', 'ngram'].includes(mode)
    || (hasDraftNMax && (
      !Number.isInteger(draftNMax)
      || draftNMax < 1
      || draftNMax > 6
    ))
    || typeof allowUnverified !== 'boolean'
  ) {
    return { acceleration: null, error: 'profile_acceleration_invalid' };
  }

  return {
    acceleration: Object.freeze({ mode, draftNMax, allowUnverified }),
    error: '',
  };
}

function loadLlamaServerProfile({ profileId, repoRoot = process.cwd(), fsImpl = fs } = {}) {
  const normalizedId = String(profileId || '').trim().toLowerCase();
  if (!normalizedId) {
    return { profile: null, error: '' };
  }
  if (!LLAMA_SERVER_PROFILE_ID_PATTERN.test(normalizedId)) {
    return { profile: null, error: 'invalid_profile_id' };
  }

  const profilePath = path.join(repoRoot, 'config', 'llama-server-profiles', `${normalizedId}.json`);
  let source;
  try {
    source = JSON.parse(fsImpl.readFileSync(profilePath, 'utf8'));
  } catch (error) {
    return {
      profile: null,
      error: error instanceof SyntaxError ? 'profile_json_invalid' : 'profile_not_found',
    };
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { profile: null, error: 'profile_invalid' };
  }
  if (!LLAMA_SERVER_PROFILE_SCHEMA_VERSIONS.has(source.schema_version)) {
    return { profile: null, error: 'profile_schema_unsupported' };
  }
  if (String(source.profile_id || '').trim().toLowerCase() !== normalizedId) {
    return { profile: null, error: 'profile_id_mismatch' };
  }

  const modelTag = String(source.model_tag || '').trim();
  const contextSize = Number(source.context_size);
  if (!modelTag || modelTag.length > 160) {
    return { profile: null, error: 'profile_model_tag_invalid' };
  }
  if (!Number.isInteger(contextSize) || contextSize < 1024 || contextSize > 1_048_576) {
    return { profile: null, error: 'profile_context_size_invalid' };
  }
  const { args: extraArgs, error: extraArgsError } = validateExtraArgs(source.extra_args);
  if (extraArgsError) {
    return { profile: null, error: extraArgsError };
  }
  const { acceleration, error: accelerationError } = normalizeProfileAcceleration(
    source.schema_version,
    source
  );
  if (accelerationError) {
    return { profile: null, error: accelerationError };
  }

  return {
    profile: Object.freeze({
      id: normalizedId,
      modelTag,
      contextSize,
      extraArgs: Object.freeze(extraArgs),
      acceleration,
    }),
    error: '',
  };
}

function resolveLlamaServerSettings({
  env = process.env,
  repoRoot = process.cwd(),
  fsImpl = fs,
  managed = null,
} = {}) {
  const managedSettings = managed && typeof managed === 'object' && !Array.isArray(managed)
    ? managed
    : null;
  const managedLastUsedTag = String(managedSettings?.lastUsedTag || '').trim();
  const autostartRaw = String(env.JENNY_LLAMA_SERVER_AUTOSTART || '').trim();
  let autostart = managedSettings?.enabled === true && managedLastUsedTag !== '';
  if (autostartRaw) {
    if (isFalseish(autostartRaw)) {
      autostart = false;
    } else if (isTrueish(autostartRaw)) {
      autostart = true;
    }
  }
  const portRaw = Number(env.JENNY_LLAMA_SERVER_PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536
    ? portRaw
    : DEFAULT_LLAMA_SERVER_PORT;
  const host = String(env.JENNY_LLAMA_SERVER_HOST || DEFAULT_LLAMA_SERVER_HOST).trim()
    || DEFAULT_LLAMA_SERVER_HOST;
  const readinessRaw = Number(env.JENNY_LLAMA_SERVER_READINESS_TIMEOUT_MS);
  const readinessTimeoutMs = Number.isFinite(readinessRaw) && readinessRaw > 0
    ? Math.min(Math.trunc(readinessRaw), 600_000)
    : DEFAULT_LLAMA_SERVER_READINESS_TIMEOUT_MS;
  const binaryOverride = String(env.JENNY_LLAMA_SERVER_BINARY || '').trim();
  const envModelPath = String(env.JENNY_LLAMA_SERVER_MODEL_PATH || '').trim();
  const managedEntry = managedSettings?.perModel?.[managedLastUsedTag] || null;
  const configModelPath = String(managedEntry?.modelPath || '').trim();
  // Alias with the display tag the key came from so a boot launch serves the
  // same model id as a Model-library activation ('gemma4:12b', not 'gemma4-12b').
  const configModelTag = String(managedEntry?.tag || '').trim() || managedLastUsedTag;
  const envProfileId = String(env.JENNY_LLAMA_SERVER_PROFILE || '').trim().toLowerCase();
  // An env-selected profile is a different model: never pair it with the
  // persisted path of whatever the library last used.
  const modelPathOverride = envModelPath || (envProfileId ? '' : configModelPath);
  const profileId = envProfileId || String(managedSettings?.profileId || '').trim().toLowerCase();
  // The persisted tag aliases the server whenever config (not env) drives
  // the launch — with or without an explicit model path, since the tag alone
  // resolves `{userData}/models/<tag>/`.
  const modelTagOverride = !envProfileId && !envModelPath ? configModelTag : '';
  const source = autostartRaw || envProfileId || envModelPath
    ? 'env'
    : (managedSettings ? 'config' : 'none');
  const { profile, error: profileError } = loadLlamaServerProfile({
    profileId,
    repoRoot,
    fsImpl,
  });
  return {
    autostart,
    host,
    port,
    readinessTimeoutMs,
    binaryOverride,
    modelPathOverride,
    modelTagOverride,
    source,
    profileId,
    profile,
    profileError,
  };
}

module.exports = {
  DEFAULT_LLAMA_SERVER_HOST,
  DEFAULT_LLAMA_SERVER_PORT,
  DEFAULT_LLAMA_SERVER_READINESS_TIMEOUT_MS,
  LLAMA_SERVER_PROFILE_SCHEMA_VERSION,
  LLAMA_SERVER_PROFILE_SCHEMA_VERSIONS,
  LLAMA_SERVER_PROFILE_MANAGED_ARGS,
  DEFAULT_MANAGED_SHELL_MODEL,
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
  loadLlamaServerProfile,
  resolveLlamaServerSettings,
  validateExtraArgs,
};
