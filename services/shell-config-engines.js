const path = require('path');
const { normalizeString } = require('./backend/path-utils');
const { canonicalizeModelToken } = require('./backend/llama-server-acceleration');

const DEFAULT_OFFLINE_INTELLIGENCE = Object.freeze({
  mode: 'disabled',
  preferredLocalModel: '',
});
const DEFAULT_LOCAL_ENGINES = Object.freeze({
  vllm: Object.freeze({
    port: 8000,
    maxModelLen: 131072,
    reasoningParser: 'qwen3',
    toolCallParser: 'qwen3_coder',
    enableAutoToolChoice: true,
    extraArgs: Object.freeze([]),
  }),
  // OpenAI-compatible entry applies to an unmanaged user-run server
  // (e.g. llama-server serving a GGUF quant).  Port defaults match the
  // llama-server convention; apiUrl overrides port when both present.
  openaiCompatible: Object.freeze({
    port: 8033,
    apiUrl: '',
    acceleration: Object.freeze({ mode: 'off', draftNMax: 0 }),
    managed: Object.freeze({
      enabled: false,
      profileId: '',
      lastUsedTag: '',
      lastPickDir: '',
      libraryRoots: Object.freeze([]),
      perModel: Object.freeze({}),
    }),
  }),
});
const DEFAULT_CODEX_CLI = Object.freeze({
  enabled: false,
  commandPath: '',
  models: Object.freeze([]),
  requestTimeoutSeconds: 300,
});

function normalizeOfflineMode(value) {
  return normalizeString(value).toLowerCase() === 'local_only'
    ? 'local_only'
    : 'disabled';
}

function normalizeOfflineIntelligence(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preferredLocalModel = source.preferredLocalModel ?? source.preferred_local_model;
  return {
    mode: normalizeOfflineMode(source.mode),
    preferredLocalModel: typeof preferredLocalModel === 'string'
      ? normalizeString(preferredLocalModel)
      : '',
  };
}

function normalizeVllmLaunchArgs(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = DEFAULT_LOCAL_ENGINES.vllm;
  const portRaw = Number(source.port ?? defaults.port);
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535
    ? Math.trunc(portRaw)
    : defaults.port;
  const maxModelLenRaw = Number(source.maxModelLen ?? source.max_model_len ?? defaults.maxModelLen);
  const maxModelLen = Number.isFinite(maxModelLenRaw) && maxModelLenRaw > 0
    ? Math.trunc(maxModelLenRaw)
    : defaults.maxModelLen;
  const reasoningParserRaw = normalizeString(
    source.reasoningParser ?? source.reasoning_parser ?? defaults.reasoningParser
  );
  const reasoningParser = /^[A-Za-z0-9_.-]*$/.test(reasoningParserRaw)
    ? reasoningParserRaw
    : defaults.reasoningParser;
  const toolCallParserRaw = normalizeString(
    source.toolCallParser ?? source.tool_call_parser ?? defaults.toolCallParser
  );
  const toolCallParser = /^[A-Za-z0-9_.-]*$/.test(toolCallParserRaw)
    ? toolCallParserRaw
    : defaults.toolCallParser;
  const enableAutoToolChoice = source.enableAutoToolChoice === undefined
    && source.enable_auto_tool_choice === undefined
    ? defaults.enableAutoToolChoice
    : (source.enableAutoToolChoice === true || source.enable_auto_tool_choice === true);
  const rawExtra = Array.isArray(source.extraArgs)
    ? source.extraArgs
    : (Array.isArray(source.extra_args) ? source.extra_args : []);
  const extraArgs = rawExtra
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry && !/[\r\n\0]/.test(entry));
  return {
    port,
    maxModelLen,
    reasoningParser,
    toolCallParser,
    enableAutoToolChoice,
    extraArgs,
  };
}

function normalizeAcceleration(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = ['off', 'mtp', 'ngram'].includes(source.mode) ? source.mode : 'off';
  const draftNMaxRaw = Number(source.draftNMax ?? source.draft_n_max);
  const draftNMax = Number.isInteger(draftNMaxRaw) && draftNMaxRaw >= 1 && draftNMaxRaw <= 6
    ? draftNMaxRaw
    : 0;
  return { mode, draftNMax };
}

// perModel key: the family token with the size/quant tag preserved
// ('gemma4:12b' -> 'gemma4-12b'). canonicalizeModelToken alone folds every
// size of a family into one entry, so every reader and writer of perModel /
// lastUsedTag goes through this helper.
function managedModelKey(tag) {
  return canonicalizeModelToken(String(tag || '').replace(/:/g, '-'));
}

function normalizeManagedLlamaServer(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const profileIdRaw = typeof source.profileId === 'string'
    ? normalizeString(source.profileId).toLowerCase()
    : '';
  const profileId = /^[a-z0-9._-]{0,64}$/.test(profileIdRaw) ? profileIdRaw : '';
  const lastUsedTagRaw = typeof source.lastUsedTag === 'string'
    ? managedModelKey(normalizeString(source.lastUsedTag))
    : '';
  const lastUsedTag = /^[a-z0-9-]{0,128}$/.test(lastUsedTagRaw) ? lastUsedTagRaw : '';
  const lastPickDirRaw = typeof source.lastPickDir === 'string'
    ? normalizeString(source.lastPickDir)
    : '';
  const lastPickDir = lastPickDirRaw
    && path.isAbsolute(lastPickDirRaw)
    && !/[\r\n\0]/.test(lastPickDirRaw)
    && lastPickDirRaw.length <= 512
    ? lastPickDirRaw
    : '';
  const libraryRoots = [];
  const seenLibraryRoots = new Set();
  for (const value of Array.isArray(source.libraryRoots) ? source.libraryRoots : []) {
    const root = typeof value === 'string' ? normalizeString(value) : '';
    const key = root.toLowerCase();
    if (!root
      || !path.isAbsolute(root)
      || /[\r\n\0]/.test(root)
      || root.length > 512
      || seenLibraryRoots.has(key)) {
      continue;
    }
    seenLibraryRoots.add(key);
    libraryRoots.push(root);
    if (libraryRoots.length >= 16) {
      break;
    }
  }
  const rawPerModel = source.perModel
    && typeof source.perModel === 'object'
    && !Array.isArray(source.perModel)
    ? source.perModel
    : {};
  const perModel = {};
  for (const rawKey of Object.keys(rawPerModel).sort()) {
    const token = managedModelKey(rawKey);
    if (!token || !/^[a-z0-9-]{1,128}$/.test(token)) {
      continue;
    }
    if (!(token in perModel) && Object.keys(perModel).length >= 64) {
      continue;
    }
    const entry = rawPerModel[rawKey]
      && typeof rawPerModel[rawKey] === 'object'
      && !Array.isArray(rawPerModel[rawKey])
      ? rawPerModel[rawKey]
      : {};
    const modelPathRaw = typeof entry.modelPath === 'string'
      ? normalizeString(entry.modelPath)
      : '';
    const modelPath = isManagedModelPath(modelPathRaw) ? modelPathRaw : '';
    const mtp = entry.mtp && typeof entry.mtp === 'object' && !Array.isArray(entry.mtp)
      ? entry.mtp
      : {};
    const draftNMaxRaw = Number(mtp.draftNMax);
    // The display tag the key was derived from ('gemma4:12b'): the boot
    // autostart and the chat preflight alias the server with it, so every
    // launch path serves the same model id.
    const tagRaw = typeof entry.tag === 'string' ? normalizeString(entry.tag) : '';
    const tag = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(tagRaw) && managedModelKey(tagRaw) === token
      ? tagRaw
      : '';
    perModel[token] = {
      engine: ['ollama', 'llama-server'].includes(entry.engine) ? entry.engine : 'ollama',
      modelPath,
      tag,
      mtp: {
        mode: ['off', 'mtp'].includes(mtp.mode) ? mtp.mode : 'off',
        draftNMax: Number.isInteger(draftNMaxRaw)
          && draftNMaxRaw >= 1
          && draftNMaxRaw <= 6
          ? draftNMaxRaw
          : 4,
      },
    };
  }
  return {
    enabled: source.enabled === true,
    profileId,
    lastUsedTag,
    lastPickDir,
    libraryRoots,
    perModel,
  };
}

function normalizeOpenAICompatibleSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = DEFAULT_LOCAL_ENGINES.openaiCompatible;
  const portRaw = Number(source.port ?? defaults.port);
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535
    ? Math.trunc(portRaw)
    : defaults.port;
  const apiUrlRaw = normalizeString(source.apiUrl ?? source.api_url ?? defaults.apiUrl);
  // Only accept http:// or https:// URLs.  Anything else (file paths,
  // protocol-less strings, javascript:) collapses to empty so the sidecar
  // picks up the default via port-based synthesis.
  let apiUrl = '';
  try {
    const parsed = new URL(apiUrlRaw);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
      apiUrl = apiUrlRaw;
    }
  } catch (_error) {
    // Invalid URLs collapse to the port-derived default.
  }
  return {
    port,
    apiUrl,
    acceleration: normalizeAcceleration(source.acceleration),
    managed: normalizeManagedLlamaServer(source.managed),
  };
}

function normalizeLocalEngines(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    vllm: normalizeVllmLaunchArgs(source.vllm),
    openaiCompatible: normalizeOpenAICompatibleSettings(
      source.openaiCompatible ?? source.openai_compatible,
    ),
  };
}

// Empty means infer from the model; an explicit override keeps the selected
// engine catalog discoverable.
const VALID_PREFERRED_ENGINE_TYPES = Object.freeze([
  '',
  'ollama',
  'vllm',
  'openai-compatible',
  'codex-cli',
  'chatgpt',
  'plugin_host',
  'mock',
  // Deterministic scripted engine for agentic GUI testing (dev/CI).
  'replay',
]);

function normalizePreferredEngineType(value) {
  const token = String(value || '').trim().toLowerCase();
  return VALID_PREFERRED_ENGINE_TYPES.includes(token) ? token : '';
}

function normalizeCodexCliModelId(value, { allowDefault = false } = {}) {
  if (typeof value !== 'string') {
    return '';
  }
  let token = normalizeString(value);
  if (!token) {
    return '';
  }
  if (token.toLowerCase() === 'codex-cli') {
    return '';
  }
  if (token.toLowerCase().startsWith('codex-cli/')) {
    token = token.slice('codex-cli/'.length).trim();
  }
  if (!token || (token.toLowerCase() === 'default' && !allowDefault)) {
    return '';
  }
  return token;
}

function normalizeCodexCliSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const models = [];
  const seen = new Set();
  for (const item of Array.isArray(source.models) ? source.models : []) {
    const model = normalizeCodexCliModelId(item);
    const key = model.toLowerCase();
    if (!model || seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push(model);
  }
  const timeout = Number(
    source.requestTimeoutSeconds ?? source.request_timeout_seconds
  );
  return {
    enabled: source.enabled === true,
    commandPath: (
      typeof (source.commandPath ?? source.command_path) === 'string'
        ? normalizeString(source.commandPath ?? source.command_path).slice(0, 1000)
        : ''
    ),
    models,
    requestTimeoutSeconds: Number.isFinite(timeout) && timeout >= 30 && timeout <= 3600
      ? Math.trunc(timeout)
      : DEFAULT_CODEX_CLI.requestTimeoutSeconds,
  };
}

// A launchable managed model path: an absolute `.gguf`, or Ollama's own blob
// copy of one (`sha256-<64 hex>`, extensionless; the sidecar sniffed its GGUF
// magic before the path ever reached the shell). The launch spec normalizer
// and the persisted-path rescan share this predicate so the three seams
// cannot drift.
const OLLAMA_BLOB_BASENAME = /^sha256-[0-9a-f]{64}$/i;
function isManagedModelPath(value) {
  const modelPath = String(value || '');
  if (!modelPath || !path.isAbsolute(modelPath) || /[\r\n\0]/.test(modelPath)) return false;
  return /\.gguf$/i.test(modelPath) || OLLAMA_BLOB_BASENAME.test(path.basename(modelPath));
}

module.exports = {
  isManagedModelPath,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_LOCAL_ENGINES,
  DEFAULT_CODEX_CLI,
  normalizeOfflineMode,
  normalizeOfflineIntelligence,
  normalizeVllmLaunchArgs,
  managedModelKey,
  normalizeAcceleration,
  normalizeManagedLlamaServer,
  normalizeOpenAICompatibleSettings,
  normalizeLocalEngines,
  normalizePreferredEngineType,
  normalizeCodexCliModelId,
  normalizeCodexCliSettings,
};
