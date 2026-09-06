/* renderer/shared/engine-tuning-schema.js - Canonical Advanced engine-tuning field schema (CommonJS).
 *
 * SINGLE source of truth for the bounded numeric knobs surfaced in Settings ->
 * Developer -> Advanced. Electron loads it as the shared authority:
 *   - services/engine-tuning-service.js validates updates,
 *   - services/backend/managed-sidecar-config.js reads bounds when emitting raw_config.
 * The renderer receives the field definitions through the bridge, so there is
 * exactly one bounds table.
 *
 * Every `min`/`max`/`default` here MIRRORS sidecar/ai/config.py. That mirror is
 * machine-checked by tests/engine-tuning-schema.test.js, which parses config.py
 * and fails on any divergence - do not hand-maintain it from memory.
 *
 * NORMALIZATION CONTRACT: drop, never clamp - and drop values equal to the
 * default. This matches the sidecar (`_as_bounded_int` returns `default` for an
 * out-of-range value rather than clamping) and the sibling normalizers in
 * services/shell-config-model-tuning.js. Consequences relied on downstream:
 *   - persisted config contains ONLY genuine overrides,
 *   - "modified" is exactly `hasOwnProperty(values, key)` - no diffing,
 *   - reset is a delete, and there is no third state between unset and set.
 */
'use strict';

  /* Which segmented pane a field renders on. `shared` fields are engine-agnostic
   * (one key, one value) and render on BOTH panes rather than being hidden on one. */
  const SCOPE_LOCAL = 'local';
  const SCOPE_CLOUD = 'cloud';
  const SCOPE_SHARED = 'shared';

  /* Every field persists in the owned `engineTuning` block. maxBudgetUsd used to
   * live as a bare top-level key; it has no setter and the managed-sidecar
   * resolver already falls back to the legacy spelling, so the v48 migration
   * folds it in here rather than maintaining two write paths for one value. */
  const STORAGE_ENGINE_TUNING = 'engineTuning';

  const ENGINE_TUNING_GROUPS = Object.freeze([
    Object.freeze({
      id: 'reasoning',
      label: 'Reasoning rounds',
      help: 'Each round is one model generation plus the tool calls it requests. '
        + 'Raising these lets a turn work longer before it is cut off.',
      order: 0,
    }),
    Object.freeze({
      id: 'delegation',
      label: 'Delegation',
      help: 'Sub-agent fan-out. Tool calls within a single turn always run one at a '
        + 'time; delegation is the only place Jenny works in parallel.',
      order: 1,
    }),
    Object.freeze({
      id: 'limits',
      label: 'Tool budgets',
      help: 'Caps on how much tool work a reply, or a whole conversation, may do.',
      order: 2,
    }),
    Object.freeze({
      id: 'timeouts',
      label: 'Timeouts',
      help: 'How long Jenny waits before giving up on a tool, a model load, or a request.',
      order: 3,
    }),
    Object.freeze({
      id: 'compaction',
      label: 'Context compaction',
      help: 'Applies to every engine. A per-model summarization threshold set in '
        + 'Models -> Tune wins over the global ratio here.',
      order: 4,
    }),
    Object.freeze({
      id: 'budget',
      label: 'Spend',
      help: 'A hard stop on what one reply may cost on a paid provider.',
      order: 5,
    }),
  ]);

  /* tier: 'A' = reader+emission already exist (only persistence was missing),
   *       'B' = sidecar parses it but Electron never emitted a user value,
   *       'C' = already fully persisted, needed UI only. */
  const RAW_FIELDS = [
    // --- Reasoning rounds -------------------------------------------------
    {
      key: 'maxToolsPerTurn',
      rawKey: 'max_tools_per_turn',
      label: 'Tool calls per turn',
      help: 'How many tool calls (file reads, web searches, and so on) Jenny may make while answering one message. Raise it for long, tool-heavy jobs; lower it to keep replies quick.',
      unit: 'calls', type: 'integer', min: 1, max: 100, step: 1, default: 20,
      presets: [10, 20, 40],
      scope: SCOPE_LOCAL, tier: 'A', group: 'reasoning', order: 0,
    },
    {
      key: 'maxChatLoopIterations',
      rawKey: 'max_chat_loop_iterations',
      label: 'Reasoning rounds (chat)',
      help: 'How many times Jenny may stop to think again after running tools during an ordinary chat reply.',
      unit: 'rounds', type: 'integer', min: 1, max: 32, step: 1, default: 8,
      presets: [4, 8, 16],
      scope: SCOPE_LOCAL, tier: 'A', group: 'reasoning', order: 1,
    },
    {
      key: 'maxTaskLoopIterations',
      rawKey: 'max_task_loop_iterations',
      label: 'Reasoning rounds (task)',
      help: 'The same limit for task mode, where longer multi-step work is expected.',
      unit: 'rounds', type: 'integer', min: 1, max: 32, step: 1, default: 30,
      presets: [10, 20, 30],
      scope: SCOPE_LOCAL, tier: 'A', group: 'reasoning', order: 2,
    },
    {
      key: 'maxLoopIterations',
      rawKey: 'max_loop_iterations',
      label: 'Reasoning rounds (fallback)',
      help: 'Only used when resource discipline is switched off. Also seeds the chat limit when that one is left unset.',
      unit: 'rounds', type: 'integer', min: 1, max: 32, step: 1, default: 8,
      presets: [4, 8, 16],
      scope: SCOPE_LOCAL, tier: 'A', group: 'reasoning', order: 3,
    },
    {
      key: 'cloudMaxChatLoopIterations',
      rawKey: 'cloud_max_chat_loop_iterations',
      label: 'Reasoning rounds (chat)',
      help: 'Cloud models can keep working far longer than a local GPU, so this sits well above the local limit.',
      unit: 'rounds', type: 'integer', min: 1, max: 1000, step: 1, default: 40,
      presets: [20, 40, 100],
      scope: SCOPE_CLOUD, tier: 'B', group: 'reasoning', order: 1,
    },
    {
      key: 'cloudMaxTaskLoopIterations',
      rawKey: 'cloud_max_task_loop_iterations',
      label: 'Reasoning rounds (task)',
      help: 'The same limit for task mode on a cloud model.',
      unit: 'rounds', type: 'integer', min: 1, max: 1000, step: 1, default: 300,
      presets: [100, 300, 600],
      scope: SCOPE_CLOUD, tier: 'B', group: 'reasoning', order: 2,
    },
    {
      key: 'cloudMaxToolsPerTurn',
      rawKey: 'cloud_max_tools_per_turn',
      label: 'Tool calls per turn',
      help: 'How many tool calls a cloud model may make while answering one message.',
      unit: 'calls', type: 'integer', min: 1, max: 500, step: 1, default: 200,
      presets: [100, 200, 400],
      scope: SCOPE_CLOUD, tier: 'B', group: 'reasoning', order: 0,
    },

    // --- Delegation -------------------------------------------------------
    {
      key: 'maxSubAgentConcurrency',
      rawKey: 'max_sub_agent_concurrency',
      label: 'Parallel sub-agents',
      help: 'How many delegated helper tasks may run at the same time on a local model. 1 means one after another.',
      unit: 'agents', type: 'integer', min: 1, max: 8, step: 1, default: 1,
      presets: [1, 2, 4],
      scope: SCOPE_LOCAL, tier: 'A', group: 'delegation', order: 0,
    },
    {
      key: 'maxCloudSubAgentConcurrency',
      rawKey: 'max_cloud_sub_agent_concurrency',
      label: 'Parallel sub-agents',
      help: 'How many delegated helper tasks may run at once on a cloud model. The scheduler caps this at 3.',
      unit: 'agents', type: 'integer', min: 1, max: 3, step: 1, default: 3,
      presets: [1, 2, 3],
      scope: SCOPE_CLOUD, tier: 'A', group: 'delegation', order: 0,
    },
    {
      key: 'maxSubAgentLoopIterations',
      rawKey: 'max_sub_agent_loop_iterations',
      label: 'Sub-agent reasoning rounds',
      help: 'How many thinking rounds each helper task gets. Kept the same for local and cloud on purpose: a bigger job should spawn more helpers, not longer ones.',
      unit: 'rounds', type: 'integer', min: 1, max: 32, step: 1, default: 10,
      presets: [5, 10, 20],
      scope: SCOPE_SHARED, tier: 'A', group: 'delegation', order: 1,
    },

    // --- Tool budgets -----------------------------------------------------
    {
      key: 'maxToolCallsPerSession',
      rawKey: 'max_tool_calls_per_session',
      label: 'Tool calls per session',
      help: 'A safety cap on tool calls across a whole conversation, so a runaway loop cannot keep going forever.',
      unit: 'calls', type: 'integer', min: 1, max: 1000, step: 10, default: 200,
      presets: [100, 200, 500],
      scope: SCOPE_LOCAL, tier: 'A', group: 'limits', order: 0,
    },
    {
      key: 'maxWebToolCallsPerTurn',
      rawKey: 'max_web_tool_calls_per_turn',
      label: 'Web calls per turn',
      help: 'How many web searches or page fetches one reply may use. Only successful calls count; failures are refunded.',
      unit: 'calls', type: 'integer', min: 1, max: 100, step: 1, default: 10,
      presets: [5, 10, 25],
      scope: SCOPE_LOCAL, tier: 'A', group: 'limits', order: 1,
    },
    {
      key: 'maxCodeIntelligenceToolCallsPerTurn',
      rawKey: 'max_code_intelligence_tool_calls_per_turn',
      label: 'Code-intelligence calls per turn',
      help: 'How many code-analysis tool calls one reply may use.',
      unit: 'calls', type: 'integer', min: 1, max: 100, step: 1, default: 16,
      presets: [8, 16, 32],
      scope: SCOPE_LOCAL, tier: 'B', group: 'limits', order: 2,
    },
    {
      key: 'maxInlinePayloadBytes',
      rawKey: 'max_inline_payload_bytes',
      label: 'Inline payload cap',
      help: 'Tool output bigger than this is saved to a file and linked, instead of being pasted into the conversation.',
      unit: 'bytes', type: 'integer', min: 4096, max: 2097152, step: 4096, default: 65536,
      presets: [{ value: 16384, label: '16 KB' }, { value: 65536, label: '64 KB' }, { value: 262144, label: '256 KB' }],
      scope: SCOPE_SHARED, tier: 'A', group: 'limits', order: 3,
    },
    {
      key: 'cloudMaxToolCallsPerSession',
      rawKey: 'cloud_max_tool_calls_per_session',
      label: 'Tool calls per session',
      // The sidecar keeps this max in lockstep with _MAX_SESSION_TOOL_CALL_CEILING;
      // max === default, so this control can only ever be lowered.
      help: 'A safety cap on tool calls across a whole conversation on a cloud model. It already sits at its maximum, so it can only be lowered.',
      unit: 'calls', type: 'integer', min: 1, max: 2000, step: 50, default: 2000,
      presets: [500, 1000, 2000],
      scope: SCOPE_CLOUD, tier: 'B', group: 'limits', order: 0,
    },
    {
      key: 'cloudMaxWebToolCallsPerTurn',
      rawKey: 'cloud_max_web_tool_calls_per_turn',
      label: 'Web calls per turn',
      help: 'How many web searches or page fetches one reply may use on a cloud model.',
      unit: 'calls', type: 'integer', min: 1, max: 100, step: 1, default: 30,
      presets: [10, 30, 60],
      scope: SCOPE_CLOUD, tier: 'B', group: 'limits', order: 1,
    },

    // --- Timeouts ---------------------------------------------------------
    {
      key: 'toolsExecutionTimeoutSeconds',
      rawKey: 'tools_execution_timeout_seconds',
      label: 'Tool execution timeout',
      help: 'How long a single tool call may run before it is stopped. The shell tool can also set its own per-call limit.',
      unit: 'seconds', type: 'number', min: 5, max: 600, step: 5, default: 120,
      presets: [60, 120, 300],
      scope: SCOPE_LOCAL, tier: 'B', group: 'timeouts', order: 0,
    },
    {
      key: 'cloudToolsExecutionTimeoutSeconds',
      rawKey: 'cloud_tools_execution_timeout_seconds',
      label: 'Tool execution timeout',
      help: 'How long a single tool call may run on a cloud model before it is stopped.',
      unit: 'seconds', type: 'number', min: 5, max: 3600, step: 30, default: 1800,
      presets: [600, 1800, 3600],
      scope: SCOPE_CLOUD, tier: 'B', group: 'timeouts', order: 0,
    },
    {
      key: 'maxLoopWallSeconds',
      rawKey: 'max_loop_wall_seconds',
      label: 'Turn working-time limit',
      help: 'How long a local turn may spend actively working. Time waiting for your approval or your answers does not count against this limit.',
      unit: 'seconds', type: 'number', min: 30, max: 3600, step: 30, default: 1800,
      presets: [600, 1800, 3600],
      scope: SCOPE_LOCAL, tier: 'A', group: 'timeouts', order: 1,
    },
    {
      key: 'modelLoadGraceSeconds',
      rawKey: 'model_load_grace_seconds',
      label: 'Model load grace',
      help: 'How long to wait for the first words while a local model is still loading into GPU memory. Raise it for very large models or slow disks.',
      unit: 'seconds', type: 'number', min: 60, max: 1800, step: 30, default: 300,
      presets: [120, 300, 600],
      scope: SCOPE_LOCAL, tier: 'A', group: 'timeouts', order: 2,
    },
    {
      key: 'ollamaRequestTimeoutSeconds',
      rawKey: 'ollama_request_timeout_seconds',
      label: 'Ollama request timeout',
      help: 'How long a single request to Ollama may take before it is abandoned.',
      unit: 'seconds', type: 'integer', min: 30, max: 3600, step: 30, default: 300,
      presets: [120, 300, 900],
      scope: SCOPE_LOCAL, tier: 'A', group: 'timeouts', order: 3,
    },
    {
      key: 'toolsPythonRuntimeTimeoutSeconds',
      rawKey: 'tools_python_runtime_timeout_seconds',
      label: 'Python tool timeout',
      help: 'How long a Python snippet may run before it is stopped.',
      unit: 'seconds', type: 'integer', min: 1, max: 600, step: 5, default: 30,
      presets: [15, 30, 120],
      scope: SCOPE_SHARED, tier: 'B', group: 'timeouts', order: 4,
    },
    {
      key: 'toolsPythonRuntimeMaxMemoryMb',
      rawKey: 'tools_python_runtime_max_memory_mb',
      label: 'Python tool memory cap',
      help: 'The most memory a Python snippet may use.',
      unit: 'MB', type: 'integer', min: 64, max: 4096, step: 64, default: 512,
      presets: [256, 512, 1024],
      scope: SCOPE_SHARED, tier: 'B', group: 'timeouts', order: 5,
    },
    {
      key: 'toolsGitTimeoutSeconds',
      rawKey: 'tools_git_timeout_seconds',
      label: 'Git tool timeout',
      help: 'How long a single git command may run before it is stopped.',
      unit: 'seconds', type: 'number', min: 1, max: 120, step: 1, default: 20,
      presets: [10, 20, 60],
      scope: SCOPE_SHARED, tier: 'B', group: 'timeouts', order: 6,
    },

    // --- Context compaction (engine-agnostic) -----------------------------
    // These four have NO sidecar default: `_as_optional_bounded_float` returns
    // None when unset, and the two int fields use an `... or None` idiom. Unset
    // means "let the sidecar decide", which is why `default` is null here.
    {
      key: 'tokenBudgetAutoCompactRatio',
      rawKey: 'token_budget_auto_compact_ratio',
      label: 'Auto-compact at',
      help: 'When the conversation fills this share of the model\'s context window, older messages are summarized automatically. Lower values summarize sooner.',
      unit: 'ratio', type: 'number', min: 0.1, max: 0.99, step: 0.01, default: null,
      presets: [{ value: 0.7, label: '70%' }, { value: 0.8, label: '80%' }, { value: 0.9, label: '90%' }],
      scope: SCOPE_SHARED, tier: 'B', group: 'compaction', order: 0,
    },
    {
      key: 'tokenBudgetWarningRatio',
      rawKey: 'token_budget_warning_ratio',
      label: 'Warn at',
      help: 'When the conversation fills this share of the context window, Jenny warns that summarization is coming.',
      unit: 'ratio', type: 'number', min: 0.1, max: 0.99, step: 0.01, default: null,
      presets: [{ value: 0.6, label: '60%' }, { value: 0.75, label: '75%' }, { value: 0.85, label: '85%' }],
      scope: SCOPE_SHARED, tier: 'B', group: 'compaction', order: 1,
    },
    {
      key: 'tokenBudgetReservedForSummary',
      rawKey: 'token_budget_reserved_for_summary',
      label: 'Reserved for summary',
      help: 'Room kept free in the context window for the summary that compaction writes.',
      unit: 'tokens', type: 'integer', min: 256, max: 200000, step: 256, default: null,
      presets: [2048, 4096, 8192],
      scope: SCOPE_SHARED, tier: 'B', group: 'compaction', order: 2,
    },
    {
      key: 'tokenBudgetToolOverhead',
      rawKey: 'token_budget_tool_overhead',
      // config.py parses this with min_value=0 but then applies `or None`, so a
      // stored 0 is indistinguishable from unset. Exposing min 1 keeps the
      // control honest instead of offering a value that silently means "unset".
      label: 'Per-tool overhead',
      help: 'Extra room assumed for each tool call when estimating how full the context window is.',
      unit: 'tokens', type: 'integer', min: 1, max: 10000, step: 50, default: null,
      presets: [100, 250, 500],
      scope: SCOPE_SHARED, tier: 'B', group: 'compaction', order: 3,
    },

    // --- Spend ------------------------------------------------------------
    {
      key: 'maxBudgetUsd',
      rawKey: 'max_budget_usd',
      label: 'Turn budget cap',
      help: 'Stop a reply once the provider cost for that turn passes this amount. Leave blank for no cap.',
      unit: 'USD', type: 'number', min: 0.000001, max: 1000000, step: 0.5, default: null,
      presets: [{ value: 0.25, label: '$0.25' }, { value: 1, label: '$1' }, { value: 5, label: '$5' }],
      scope: SCOPE_SHARED, tier: 'C', group: 'budget', order: 0,
    },
  ];

  /* Quick-pick values rendered as chips under the input. Each must be a valid
   * override for its field (in range, integer where the field is integer); a
   * preset equal to the default is allowed - picking it simply clears the
   * override, which is exactly what the normalization contract says it means. */
  function normalizePresets(definition) {
    const raw = Array.isArray(definition.presets) ? definition.presets : [];
    const isInteger = definition.type !== 'number';
    const min = Number(definition.min);
    const max = Number(definition.max);
    const seen = new Set();
    const presets = [];
    for (const entry of raw) {
      const value = Number(entry && typeof entry === 'object' ? entry.value : entry);
      if (!Number.isFinite(value) || value < min || value > max) continue;
      if (isInteger && !Number.isSafeInteger(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      const label = entry && typeof entry === 'object' && entry.label != null
        ? String(entry.label)
        : String(value);
      presets.push(Object.freeze({ value, label }));
    }
    return Object.freeze(presets);
  }

  function normalizeFieldDefinition(definition, index) {
    const key = String(definition?.key || '').trim();
    if (!key) {
      throw new Error('Engine tuning field key is required.');
    }
    return Object.freeze({
      key,
      rawKey: String(definition.rawKey || ''),
      label: String(definition.label || key),
      help: String(definition.help || ''),
      unit: String(definition.unit || ''),
      type: definition.type === 'number' ? 'number' : 'integer',
      min: Number(definition.min),
      max: Number(definition.max),
      step: Number(definition.step) || 1,
      default: definition.default == null ? null : Number(definition.default),
      presets: normalizePresets(definition),
      scope: String(definition.scope || SCOPE_LOCAL),
      tier: String(definition.tier || 'A'),
      group: String(definition.group || 'limits'),
      storage: STORAGE_ENGINE_TUNING,
      order: Number.isFinite(Number(definition.order)) ? Number(definition.order) : index,
    });
  }

  const ENGINE_TUNING_FIELDS = Object.freeze(RAW_FIELDS.map(normalizeFieldDefinition));

  const ENGINE_TUNING_FIELDS_BY_KEY = Object.freeze(
    ENGINE_TUNING_FIELDS.reduce((accumulator, field) => {
      if (accumulator[field.key]) {
        throw new Error(`Duplicate engine tuning field key: ${field.key}`);
      }
      accumulator[field.key] = field;
      return accumulator;
    }, Object.create(null))
  );

  function getFieldDefinition(key) {
    return ENGINE_TUNING_FIELDS_BY_KEY[String(key || '').trim()] || null;
  }

  /* Returns a usable number, or null when the value must NOT be persisted:
   * unknown key, non-finite, non-integer for an integer field, out of bounds, or
   * exactly equal to the default (see the normalization contract at the top). */
  function normalizeEngineTuningValue(key, value) {
    const field = getFieldDefinition(key);
    if (!field) return null;
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    if (field.type === 'integer' && !Number.isSafeInteger(parsed)) return null;
    if (parsed < field.min || parsed > field.max) return null;
    if (field.default != null && parsed === field.default) return null;
    return parsed;
  }

  /* True when the value would round-trip as an override. Callers that need to
   * distinguish "rejected" from "same as default" must compare against the field
   * default themselves - normalizeEngineTuningValue folds both into null. */
  function isEngineTuningValueInRange(key, value) {
    const field = getFieldDefinition(key);
    if (!field) return false;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return false;
    if (field.type === 'integer' && !Number.isSafeInteger(parsed)) return false;
    return parsed >= field.min && parsed <= field.max;
  }

module.exports = {
    SCOPE_LOCAL,
    SCOPE_CLOUD,
    SCOPE_SHARED,
    STORAGE_ENGINE_TUNING,
    ENGINE_TUNING_FIELDS,
    ENGINE_TUNING_FIELDS_BY_KEY,
    ENGINE_TUNING_GROUPS,
    getFieldDefinition,
    normalizeEngineTuningValue,
    isEngineTuningValueInRange,
};
