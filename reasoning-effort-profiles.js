(function reasoningEffortProfilesModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.reasoningEffortProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createReasoningEffortProfiles() {
  'use strict';

  const AUTOMATIC_REASONING_EFFORT = 'default';
  const CANONICAL_REASONING_EFFORTS = Object.freeze([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  const REASONING_EFFORT_LABELS = Object.freeze({
    default: 'Use default',
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum',
  });

  // First-party Codex model catalog captured 2026-08-06. `ultra` is deliberately
  // excluded: Codex defines it as maximum reasoning plus automatic delegation,
  // while Jenny does not yet support sub-agents. The direct ChatGPT transport
  // must not imply that unavailable behavior by presenting it as an effort level.
  const CHATGPT_MODEL_PROFILES = Object.freeze({
    'gpt-5.6-sol': Object.freeze({ defaultEffort: 'low', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
    'gpt-5.6-terra': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
    'gpt-5.6-luna': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
    'gpt-5.5': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']) }),
    'gpt-5.4': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']) }),
    'gpt-5.4-mini': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']) }),
    'gpt-5.2': Object.freeze({ defaultEffort: 'medium', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']) }),
  });
  const CODEX_CLI_PROFILE = Object.freeze({
    defaultEffort: AUTOMATIC_REASONING_EFFORT,
    efforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  });

  function normalizeReasoningEffort(value) {
    const token = String(value || '').trim().toLowerCase();
    if (!token || token === 'default' || token === 'automatic' || token === 'auto') {
      return AUTOMATIC_REASONING_EFFORT;
    }
    if (token === 'extra-high' || token === 'extra_high' || token === 'extra high') {
      return 'xhigh';
    }
    // Historical product-level `ultra` meant wire-level max before Codex gave
    // Ultra sub-agent semantics. Existing stored values migrate safely to max.
    if (token === 'ultra') {
      return 'max';
    }
    return CANONICAL_REASONING_EFFORTS.includes(token)
      ? token
      : AUTOMATIC_REASONING_EFFORT;
  }

  function getReasoningEffortProfile(modelId, capabilities) {
    const model = String(modelId || '').trim().toLowerCase();
    const declared = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
      ? capabilities
      : {};
    const declaredEfforts = Array.isArray(declared.reasoning_efforts)
      ? declared.reasoning_efforts.map(normalizeReasoningEffort).filter((effort) => effort !== AUTOMATIC_REASONING_EFFORT)
      : [];
    if (declaredEfforts.length) {
      return {
        defaultEffort: normalizeReasoningEffort(declared.default_reasoning_effort),
        efforts: [...new Set(declaredEfforts)],
      };
    }
    if (model.startsWith('codex-cli/')) {
      return CODEX_CLI_PROFILE;
    }
    if (CHATGPT_MODEL_PROFILES[model]) {
      return CHATGPT_MODEL_PROFILES[model];
    }
    if (/^gpt-5([.:-]|$)/.test(model)) {
      return { defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] };
    }
    return null;
  }

  function normalizeReasoningEffortForModel(value, modelId, capabilities) {
    const normalized = normalizeReasoningEffort(value);
    if (normalized === AUTOMATIC_REASONING_EFFORT) {
      return normalized;
    }
    const profile = getReasoningEffortProfile(modelId, capabilities);
    return profile && profile.efforts.includes(normalized)
      ? normalized
      : AUTOMATIC_REASONING_EFFORT;
  }

  // Mirrors sidecar/ai/engines/model_name.py QWEN38_MODEL_PREFIXES: the qwen3.8
  // family is the only Ollama family whose engine accepts graded effort strings;
  // every other Ollama model (qwen3.5/3.6 included) takes Automatic or None.
  const OLLAMA_GRADED_THINKING_MODEL_PREFIXES = Object.freeze(['qwen3.8', 'qwen38', 'qwen-3.8']);

  function supportsOllamaGradedThinking(modelId) {
    const token = String(modelId || '').trim().toLowerCase().split('/').pop();
    return OLLAMA_GRADED_THINKING_MODEL_PREFIXES.some((prefix) => token.startsWith(prefix));
  }

  function normalizeManagedReasoningEffortForModel(value, engineType, options = {}) {
    const normalized = normalizeReasoningEffort(value);
    const modelId = String(options.modelId || '').trim();
    const normalizedEngine = String(engineType || '').trim().toLowerCase();
    if (normalizedEngine === 'chatgpt' || normalizedEngine === 'codex-cli' || /^gpt-5([.:-]|$)/i.test(modelId)) {
      return normalizeReasoningEffortForModel(normalized, modelId, options.modelCapabilities);
    }
    if (normalizedEngine === 'ollama' && normalized !== 'none' && !supportsOllamaGradedThinking(modelId)) {
      // A graded level chosen while a qwen3.8-family model was active must not
      // ride into another Ollama model's requests — the engine rejects it
      // (CMP-AI-0005). This seam runs on every send, so sessions that already
      // stored a stale graded value self-heal here.
      return AUTOMATIC_REASONING_EFFORT;
    }
    return normalized;
  }

  function buildReasoningEffortOptions(modelId, capabilities) {
    const profile = getReasoningEffortProfile(modelId, capabilities);
    const values = [AUTOMATIC_REASONING_EFFORT, ...(profile?.efforts || [])];
    return values.map((value) => ({
      value,
      label: REASONING_EFFORT_LABELS[value] || value,
    }));
  }

  return Object.freeze({
    AUTOMATIC_REASONING_EFFORT,
    CANONICAL_REASONING_EFFORTS,
    CHATGPT_MODEL_PROFILES,
    CODEX_CLI_PROFILE,
    REASONING_EFFORT_LABELS,
    buildReasoningEffortOptions,
    getReasoningEffortProfile,
    normalizeManagedReasoningEffortForModel,
    normalizeReasoningEffort,
    normalizeReasoningEffortForModel,
    supportsOllamaGradedThinking,
  });
});
