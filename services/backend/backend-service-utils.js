const {
  isPlainUserAssistantMessage,
} = require('./session-shadow-store');
const {
  normalizeManagedReasoningEffortForModel,
  normalizeReasoningEffort,
} = require('../../reasoning-effort-profiles');
const {
  ensureArray,
} = require('../value-utils');

const LOCAL_AUTH_ACCOUNTS_KEY = 'local_auth_accounts_json';
const MANAGED_REASONING_EFFORT_SUPPORTED_ENGINES = new Set(['vllm', 'openai-compatible', 'codex-cli', 'chatgpt']);
const KNOWN_OLLAMA_THINKING_MODEL_PREFIXES = [
  'qwen3.5',
  'qwen3.6',
  'qwen36',
  'qwen3.8',
  'qwen38',
  'qwen-3.8',
];
const KNOWN_VLLM_PREFIXES = [
  'qwen/',
  'meta-llama/',
  'mistralai/',
  'deepseek-ai/',
  'google/',
  'microsoft/',
  'tiiuae/',
  'internlm/',
  'internvl/',
  'openbmb/',
];
const KNOWN_VLLM_VISION_PREFIXES = [
  'qwen2-vl',
  'qwen2.5-vl',
  'llava',
  'pixtral',
  'internvl',
  'phi-3-vision',
  'minicpm-v',
];
const TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS = Object.freeze({
  web_search: ['web_search', 'fetch_url'],
  Bash: ['run_command', 'run_temp_script', 'check_background_job', 'stop_background_job'],
  python_execute: ['python_execute'],
  file_tools: [
    'read_file',
    'write_file',
    'edit_file',
    'delete_file',
    'move_file',
    'glob_files',
    'grep_search',
    'list_dir',
    'create_artifact',
    'mermaid_generate',
  ],
});

// Every canonical tool id that belongs to some toggle group above. Tools
// OUTSIDE this set are governed by config flags and policy only — composer
// toggles must never affect them. Because a non-empty enabled_tools acts as an
// exclusive allowlist in sidecar/ai/tools/assembly.py, any off-group tool
// would silently vanish from the model's offer the moment one toggle was set
// (this dropped mermaid_generate once, and delete_file/tool_search/git_* until
// 2026-07): normalizeManagedToolPreferences repairs that by unioning all
// off-group manifest tools into the allowlist whenever it is engaged.
const TOGGLE_GROUP_TOOL_IDS = Object.freeze(
  new Set(Object.values(TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS).flat())
);
const NON_TOGGLE_GROUP_TOOL_IDS = Object.freeze(
  require('../tools/tool-manifest.json')
    .tools.map((tool) => String(tool.name || ''))
    .filter((name) => name && !TOGGLE_GROUP_TOOL_IDS.has(name))
);

function isLikelyVllmModel(model) {
  const token = String(model || '').trim().toLowerCase();
  if (!token) {
    return false;
  }
  // Protocol URLs and Windows-style drive letters are local file / URL
  // inputs, never HF-namespaced model IDs.  Keep them out of the vllm
  // bucket — GGUF paths belong to the user's openai-compatible server.
  if (token.includes('://') || /^[a-z]:[\\/]/.test(token)) {
    return false;
  }
  // Unix absolute paths and explicit .gguf tokens are similarly not
  // HF IDs — steer them away from vllm auto-inference.
  if (token.startsWith('/') || token.endsWith('.gguf')) {
    return false;
  }
  if (KNOWN_VLLM_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return true;
  }
  const tail = token.includes('/') ? token.split('/').pop() : token;
  if (KNOWN_VLLM_VISION_PREFIXES.some((prefix) => tail.startsWith(prefix))) {
    return token.includes('/');
  }
  return false;
}

function inferEngineTypeFromModel(model) {
  const token = String(model || '').trim().toLowerCase();
  if (!token) {
    return 'ollama';
  }
  if (token.startsWith('codex-cli/')) {
    return 'codex-cli';
  }
  // ChatGPT-subscription catalog slugs use bare gpt-5* names; local runtimes do not (gpt-oss intentionally does not match).
  if (/^gpt-5([.:-]|$)/.test(token)) {
    return 'chatgpt';
  }
  if (token.startsWith('mock')) {
    return 'mock';
  }
  if (token.startsWith('replay')) {
    return 'replay';
  }
  if (token.startsWith('plugin-host/')) {
    return 'plugin_host';
  }
  if (isLikelyVllmModel(token)) {
    return 'vllm';
  }
  // GGUF filenames and absolute paths only resolve through a user-run
  // llama-server (the Slice B openai-compatible runtime) — Ollama uses
  // `model:tag` names and vLLM serves HF format, so a `.gguf` token
  // unambiguously targets the openai-compatible engine.
  if (token.endsWith('.gguf') || token.startsWith('/') || /^[a-z]:[\\/]/.test(token)) {
    return 'openai-compatible';
  }
  // Everything else stays conservative and falls through to ollama,
  // the safe local-runtime default.
  return 'ollama';
}

// Verdicts inferEngineTypeFromModel reaches from an UNAMBIGUOUS id anchor (the
// 'codex-cli/', '^gpt-5', 'mock', 'replay' prefixes above) rather than from its
// conservative ollama fallback. Only these may override an explicit user pin.
const ID_ANCHORED_ENGINE_TYPES = Object.freeze(
  new Set(['codex-cli', 'chatgpt', 'mock', 'replay'])
);
// Pins naming a LOCAL runtime the model string cannot reliably imply: e.g.
// 'NousResearch/Hermes-3-Llama-3.1-8B' misses isLikelyVllmModel's prefix list
// and falls through to 'ollama', discarding an explicit vLLM pin.
const LOCAL_RUNTIME_ENGINE_PINS = Object.freeze(new Set(['vllm', 'openai-compatible', 'plugin_host']));

// Resolve the engine a load request should target: the user's pin wins for
// local runtimes unless the model id itself names a different engine outright.
function resolveRequestedEngineType(pin, modelId) {
  const inferred = inferEngineTypeFromModel(modelId);
  const normalizedPin = String(pin || '').trim().toLowerCase();
  if (!LOCAL_RUNTIME_ENGINE_PINS.has(normalizedPin)) {
    return inferred;
  }
  return ID_ANCHORED_ENGINE_TYPES.has(inferred) ? inferred : normalizedPin;
}

function normalizeModelCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return {};
  }
  const normalized = {};
  for (const [key, value] of Object.entries(capabilities)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      continue;
    }
    normalized[normalizedKey] = value === true;
  }
  return normalized;
}

function normalizeLocalRuntimeCapabilityEntry(entry, fallbackAvailable = false, fallbackSource = 'unsupported') {
  const normalizedAvailableFallbackSource = String(fallbackSource || '').trim().toLowerCase()
    || 'runtime';
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      available: fallbackAvailable === true,
      source: fallbackAvailable === true
        ? normalizedAvailableFallbackSource
        : 'unsupported',
    };
  }
  const available = entry.available === true;
  return {
    available,
    source: String(entry.source || '').trim().toLowerCase()
      || (available ? normalizedAvailableFallbackSource : 'unsupported'),
  };
}

function getLocalRuntimeCapability(localRuntime, capabilityName) {
  const capabilities =
    localRuntime
    && typeof localRuntime === 'object'
    && !Array.isArray(localRuntime)
    && localRuntime.capabilities
    && typeof localRuntime.capabilities === 'object'
    && !Array.isArray(localRuntime.capabilities)
      ? localRuntime.capabilities
      : {};
  return normalizeLocalRuntimeCapabilityEntry(capabilities[capabilityName]);
}

function getLocalRuntimeReasoningSupport(localRuntime) {
  const reasoning =
    localRuntime
    && typeof localRuntime === 'object'
    && !Array.isArray(localRuntime)
    && localRuntime.reasoning
    && typeof localRuntime.reasoning === 'object'
    && !Array.isArray(localRuntime.reasoning)
      ? localRuntime.reasoning
      : null;
  const support = String(reasoning?.support || '').trim().toLowerCase();
  return support === 'supported' || support === 'unsupported' ? support : '';
}

function isKnownThinkingCapableModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('thinking')) {
    return true;
  }
  const tail = normalized.includes('/') ? normalized.split('/').pop() : normalized;
  return KNOWN_OLLAMA_THINKING_MODEL_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix) || tail.startsWith(prefix),
  );
}

function getManagedReasoningEffortSupport(engineType, providerCapabilities = null, options = {}) {
  const normalizedEngine = String(engineType || '').trim().toLowerCase() || 'mock';
  const localRuntime =
    options.localRuntime
    && typeof options.localRuntime === 'object'
    && !Array.isArray(options.localRuntime)
      ? options.localRuntime
      : null;
  const localRuntimeSupport = getLocalRuntimeReasoningSupport(localRuntime);
  if (localRuntimeSupport) {
    return localRuntimeSupport;
  }
  const activeModelCapabilities = normalizeModelCapabilities(options.activeModelCapabilities);
  const modelId = String(options.modelId || '').trim();
  if (normalizedEngine === 'ollama') {
    if (getLocalRuntimeCapability(localRuntime, 'thinking').available === true) {
      return 'supported';
    }
    if (activeModelCapabilities.thinking === true) {
      return 'supported';
    }
    if (modelId && isKnownThinkingCapableModel(modelId)) {
      return 'supported';
    }
    if (Object.keys(activeModelCapabilities).length) {
      return 'unsupported';
    }
  }
  const capability =
    providerCapabilities
    && typeof providerCapabilities === 'object'
    && !Array.isArray(providerCapabilities)
      ? providerCapabilities[normalizedEngine]
      : null;
  const declaredSupport = String(capability?.reasoning_effort_support || '').trim().toLowerCase();
  if (declaredSupport === 'supported' || declaredSupport === 'unsupported') {
    return declaredSupport;
  }
  return MANAGED_REASONING_EFFORT_SUPPORTED_ENGINES.has(normalizedEngine)
    ? 'supported'
    : 'unsupported';
}

function normalizeManagedReasoningEffort(reasoningEffort, engineType, providerCapabilities = null, options = {}) {
  const normalizedEffort = normalizeReasoningEffort(reasoningEffort);
  if (normalizedEffort === 'default') {
    return 'default';
  }
  if (getManagedReasoningEffortSupport(engineType, providerCapabilities, options) !== 'supported') {
    return 'default';
  }
  return normalizeManagedReasoningEffortForModel(normalizedEffort, engineType, options);
}

function createReasoningEntry(text, index, timestamp, thinkingId) {
  return {
    id: `reasoning_${Date.now()}_${index}_${Math.random().toString(16).slice(2, 8)}`,
    text: String(text || '').trim(),
    timestamp: timestamp || new Date().toISOString(),
    thinkingId: String(thinkingId || ''),
  };
}

function summarizeToolPayload(toolName, toolInput) {
  const name = String(toolName || '').trim();
  const displayName = ({
    read_file: 'Read',
    edit_file: 'Edit',
    glob_files: 'Glob',
    grep_search: 'Grep',
    write_file: 'Write',
    run_command: 'Bash',
    run_temp_script: 'Temp script',
    create_artifact: 'CreateArtifact',
  })[name] || name;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const filePath = String(input.file_path || input.path || input.cwd || '').trim();
  const command = String(input.command || '').trim();
  if (command) {
    return `${displayName} ${command}`.trim();
  }
  if (filePath) {
    return `${displayName} ${filePath}`.trim();
  }
  return displayName || 'Tool';
}

function extractClientMessageId(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  return String(message.client_message_id || '').trim();
}

function dedupeSessionMessages(backendMessages, shadowMessages) {
  const persistedClientMessageIds = new Set(
    ensureArray(backendMessages)
      .filter((message) => isPlainUserAssistantMessage(message))
      .map((message) => extractClientMessageId(message))
      .filter(Boolean)
  );

  const filteredShadowMessages = ensureArray(shadowMessages).filter((message) => {
    if (!isPlainUserAssistantMessage(message)) {
      return true;
    }
    const clientMessageId = extractClientMessageId(message) || String(message.id || '').trim();
    return !persistedClientMessageIds.has(clientMessageId);
  });

  return {
    persistedClientMessageIds: [...persistedClientMessageIds],
    mergedMessages: [...ensureArray(backendMessages), ...filteredShadowMessages].sort(
      (left, right) => {
        const leftValue = String(left.timestamp || '');
        const rightValue = String(right.timestamp || '');
        return leftValue.localeCompare(rightValue);
      }
    ),
  };
}

function buildMemorySuggestionMessages(messages, options = {}) {
  const maxUserMessages = Number.isInteger(options.maxUserMessages)
    ? Math.max(1, options.maxUserMessages)
    : null;

  const normalizedMessages = ensureArray(messages)
    .filter(
      (message) =>
        isPlainUserAssistantMessage(message) && String(message?.role || '').trim() === 'user'
    )
    .map((message) => ({
      role: 'user',
      content: String(message?.content || '').trim(),
    }))
    .filter((message) => message.content);

  return maxUserMessages
    ? normalizedMessages.slice(-maxUserMessages)
    : normalizedMessages;
}

function normalizeRecallQueryFragment(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const RESPONSE_STYLE_RECALL_LIMIT = 2;
const RESPONSE_STYLE_PATTERNS = [
  /\b(?:be concise|keep it brief|short answers?)\b/i,
  /\b(?:be direct|straight to the point|no fluff)\b/i,
  /\b(?:step by step|walk me through|show me step by step)\b/i,
];

function buildRecallQuery(messages, prompt, options = {}) {
  const maxPriorMessages = Math.max(0, Number(options.maxPriorMessages || 2));
  const maxFragmentLength = Math.max(1, Number(options.maxFragmentLength || 200));
  const maxQueryLength = Math.max(1, Number(options.maxQueryLength || 600));
  const normalizedPrompt = normalizeRecallQueryFragment(prompt);
  const priorUserMessages = ensureArray(messages)
    .filter(
      (message) =>
        isPlainUserAssistantMessage(message) && String(message?.role || '').trim() === 'user'
    )
    .slice(-maxPriorMessages);
  const fragments = [];
  const seen = new Set();

  for (const candidate of priorUserMessages.map((message) => message?.content)) {
    const normalized = normalizeRecallQueryFragment(candidate);
    if (!normalized || normalized === normalizedPrompt || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    fragments.push(normalized.slice(0, maxFragmentLength));
  }

  if (normalizedPrompt) {
    fragments.push(normalizedPrompt.slice(0, maxFragmentLength));
  }

  if (!fragments.length) {
    return '';
  }

  const cappedFragments = [...fragments];
  let joined = cappedFragments.join('\n');
  let overflow = joined.length - maxQueryLength;
  let index = 0;
  while (overflow > 0 && index < cappedFragments.length) {
    const fragment = cappedFragments[index];
    if (!fragment) {
      index += 1;
      continue;
    }
    const trimBy = Math.min(overflow, fragment.length);
    cappedFragments[index] = fragment.slice(0, fragment.length - trimBy).trim();
    overflow -= trimBy;
    index += 1;
  }

  joined = cappedFragments.filter(Boolean).join('\n');
  return joined.slice(0, maxQueryLength);
}

function promptHasExplicitResponseStyleInstruction(prompt) {
  const normalizedPrompt = normalizeRecallQueryFragment(prompt);
  if (!normalizedPrompt) {
    return false;
  }
  return RESPONSE_STYLE_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
}

function normalizeManagedToolPreferences(toolPreferences) {
  if (!toolPreferences || typeof toolPreferences !== 'object' || Array.isArray(toolPreferences)) {
    return undefined;
  }
  const enabledTools = new Set();
  const disabledTools = new Set();
  for (const [toggleKey, toolIds] of Object.entries(TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS)) {
    const value = toolPreferences[toggleKey];
    if (typeof value !== 'boolean') {
      continue;
    }
    for (const toolId of toolIds) {
      if (value) {
        enabledTools.add(toolId);
        disabledTools.delete(toolId);
      } else {
        disabledTools.add(toolId);
        enabledTools.delete(toolId);
      }
    }
  }
  if (enabledTools.size) {
    // The allowlist is engaged: protect every off-group tool from being
    // implicitly excluded (see NON_TOGGLE_GROUP_TOOL_IDS above).
    for (const toolId of NON_TOGGLE_GROUP_TOOL_IDS) {
      enabledTools.add(toolId);
    }
  }
  const enabled = [...enabledTools].sort();
  const disabled = [...disabledTools].sort();
  if (!enabled.length && !disabled.length) {
    return undefined;
  }
  return {
    enabled_tools: enabled,
    disabled_tools: disabled,
  };
}

module.exports = {
  LOCAL_AUTH_ACCOUNTS_KEY,
  RESPONSE_STYLE_RECALL_LIMIT,
  inferEngineTypeFromModel,
  resolveRequestedEngineType,
  normalizeModelCapabilities,
  normalizeLocalRuntimeCapabilityEntry,
  getLocalRuntimeCapability,
  getLocalRuntimeReasoningSupport,
  isKnownThinkingCapableModel,
  getManagedReasoningEffortSupport,
  normalizeManagedReasoningEffort,
  createReasoningEntry,
  summarizeToolPayload,
  extractClientMessageId,
  dedupeSessionMessages,
  buildMemorySuggestionMessages,
  normalizeRecallQueryFragment,
  buildRecallQuery,
  promptHasExplicitResponseStyleInstruction,
  TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS,
  NON_TOGGLE_GROUP_TOOL_IDS,
  normalizeManagedToolPreferences,
};
