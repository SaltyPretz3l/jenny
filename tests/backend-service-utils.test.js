const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferEngineTypeFromModel,
  normalizeModelCapabilities,
  normalizeLocalRuntimeCapabilityEntry,
  isKnownThinkingCapableModel,
  getManagedReasoningEffortSupport,
  normalizeManagedReasoningEffort,
  summarizeToolPayload,
  extractClientMessageId,
  dedupeSessionMessages,
  buildMemorySuggestionMessages,
  normalizeRecallQueryFragment,
  buildRecallQuery,
  promptHasExplicitResponseStyleInstruction,
  normalizeManagedToolPreferences,
  TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS,
  NON_TOGGLE_GROUP_TOOL_IDS,
} = require('../services/backend/backend-service-utils');

/* ── inferEngineTypeFromModel ── */

test('inferEngineTypeFromModel treats archived cloud model names as local defaults', () => {
  assert.equal(inferEngineTypeFromModel('claude-3-opus'), 'ollama');
  assert.equal(inferEngineTypeFromModel('gpt-4'), 'ollama');
  assert.equal(inferEngineTypeFromModel('gemini-pro'), 'ollama');
});

test('inferEngineTypeFromModel maps mock models', () => {
  assert.equal(inferEngineTypeFromModel('mock-v1'), 'mock');
});

test('inferEngineTypeFromModel maps codex CLI model IDs before local heuristics', () => {
  assert.equal(inferEngineTypeFromModel('codex-cli/default'), 'codex-cli');
  assert.equal(inferEngineTypeFromModel('codex-cli/gpt-5.5'), 'codex-cli');
  assert.equal(inferEngineTypeFromModel('CODEX-CLI/Qwen/Qwen3.5-9B'), 'codex-cli');
});

test('inferEngineTypeFromModel maps ChatGPT subscription model IDs', () => {
  assert.equal(inferEngineTypeFromModel('gpt-5.5'), 'chatgpt');
  assert.equal(inferEngineTypeFromModel('gpt-5.6-sol'), 'chatgpt');
  assert.equal(inferEngineTypeFromModel('gpt-5.3-codex-spark'), 'chatgpt');
  assert.equal(inferEngineTypeFromModel('gpt-5'), 'chatgpt');
  assert.equal(inferEngineTypeFromModel('gpt-oss'), 'ollama');
  assert.equal(inferEngineTypeFromModel('gpt-4o'), 'ollama');
});

test('inferEngineTypeFromModel maps namespaced local model IDs to vllm', () => {
  assert.equal(inferEngineTypeFromModel('Qwen/Qwen3.5-9B'), 'vllm');
  assert.equal(inferEngineTypeFromModel('meta-llama/Llama-3.1-8B'), 'vllm');
  assert.equal(inferEngineTypeFromModel('llava-hf/llava-1.5-7b-hf'), 'vllm');
  assert.equal(inferEngineTypeFromModel('microsoft/Phi-3.5-mini-instruct'), 'vllm');
});

test('inferEngineTypeFromModel keeps unknown slash-delimited IDs on ollama', () => {
  assert.equal(inferEngineTypeFromModel('custom/model'), 'ollama');
  assert.equal(inferEngineTypeFromModel('workspace/subdir'), 'ollama');
  assert.equal(
    inferEngineTypeFromModel('hf.co/unsloth/gemma-4-E4B-it-GGUF:UD-Q8_K_XL'),
    'ollama'
  );
});

test('inferEngineTypeFromModel defaults to ollama', () => {
  assert.equal(inferEngineTypeFromModel('llama3'), 'ollama');
  assert.equal(inferEngineTypeFromModel('qwen3.5:9b'), 'ollama');
  assert.equal(inferEngineTypeFromModel(''), 'ollama');
  assert.equal(inferEngineTypeFromModel(null), 'ollama');
});

test('inferEngineTypeFromModel is case-insensitive', () => {
  assert.equal(inferEngineTypeFromModel('Claude-3'), 'ollama');
  assert.equal(inferEngineTypeFromModel('GPT-4'), 'ollama');
});

test('inferEngineTypeFromModel routes gguf tokens and file paths to openai-compatible', () => {
  // Slice B (Task 5): GGUF quants live behind the user's llama-server
  // (openai-compatible runtime), never behind vllm or ollama.  The filename
  // suffix and absolute-path shapes are enough to disambiguate — Ollama
  // uses `model:tag` names and vLLM serves HF IDs, so `.gguf` uniquely
  // identifies the openai-compatible path.
  assert.equal(
    inferEngineTypeFromModel('C:\\dev\\jenny\\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'),
    'openai-compatible'
  );
  assert.equal(
    inferEngineTypeFromModel('/home/user/models/qwen3.6-35b-a3b.gguf'),
    'openai-compatible'
  );
  assert.equal(
    inferEngineTypeFromModel('Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'),
    'openai-compatible'
  );
  assert.equal(
    inferEngineTypeFromModel('file:///C:/models/qwen.gguf'),
    'openai-compatible'
  );
});

/* ── normalizeModelCapabilities ── */

test('normalizeModelCapabilities returns empty object for invalid input', () => {
  assert.deepEqual(normalizeModelCapabilities(null), {});
  assert.deepEqual(normalizeModelCapabilities('string'), {});
  assert.deepEqual(normalizeModelCapabilities([]), {});
});

test('normalizeModelCapabilities coerces values to boolean', () => {
  const result = normalizeModelCapabilities({ thinking: true, vision: 'yes', chat: false });
  assert.equal(result.thinking, true);
  assert.equal(result.vision, false);
  assert.equal(result.chat, false);
});

test('normalizeLocalRuntimeCapabilityEntry preserves explicit available fallback sources', () => {
  assert.deepEqual(
    normalizeLocalRuntimeCapabilityEntry(undefined, true, 'engine_default'),
    { available: true, source: 'engine_default' }
  );
  assert.deepEqual(
    normalizeLocalRuntimeCapabilityEntry({ available: true }, true, 'engine_default'),
    { available: true, source: 'engine_default' }
  );
  assert.deepEqual(
    normalizeLocalRuntimeCapabilityEntry({ available: false }, true, 'engine_default'),
    { available: false, source: 'unsupported' }
  );
});

/* ── isKnownThinkingCapableModel ── */

test('isKnownThinkingCapableModel detects thinking models', () => {
  assert.equal(isKnownThinkingCapableModel('model-thinking'), true);
  assert.equal(isKnownThinkingCapableModel('qwen3.5-large'), true);
});

test('isKnownThinkingCapableModel returns false for non-thinking models', () => {
  assert.equal(isKnownThinkingCapableModel('llama3'), false);
  assert.equal(isKnownThinkingCapableModel(''), false);
});

test('isKnownThinkingCapableModel detects qwen3.6 tagged models', () => {
  assert.equal(isKnownThinkingCapableModel('qwen3.6:35b-a3b'), true);
  assert.equal(isKnownThinkingCapableModel('qwen36:35b'), true);
});

test('isKnownThinkingCapableModel detects qwen3.6 via namespaced tail-split', () => {
  assert.equal(isKnownThinkingCapableModel('Qwen/Qwen3.6-35B-A3B'), true);
  assert.equal(isKnownThinkingCapableModel('unsloth/Qwen3.6-35B-A3B-GGUF'), true);
});

test('isKnownThinkingCapableModel detects Qwen3.8 aliases', () => {
  assert.equal(isKnownThinkingCapableModel('qwen3.8:27b-q3-k-s'), true);
  assert.equal(isKnownThinkingCapableModel('qwen38:27b'), true);
  assert.equal(isKnownThinkingCapableModel('Qwen/Qwen-3.8-27B-GGUF'), true);
});

test('isKnownThinkingCapableModel rejects non-thinking namespaced models', () => {
  assert.equal(isKnownThinkingCapableModel('meta-llama/Llama-3.1-8B'), false);
});

/* ── getManagedReasoningEffortSupport ── */

test('getManagedReasoningEffortSupport returns supported for vllm', () => {
  assert.equal(getManagedReasoningEffortSupport('vllm'), 'supported');
});

test('getManagedReasoningEffortSupport returns supported for ChatGPT transports', () => {
  assert.equal(getManagedReasoningEffortSupport('chatgpt', null, {}), 'supported');
  assert.equal(getManagedReasoningEffortSupport('codex-cli', null, {}), 'supported');
});

test('getManagedReasoningEffortSupport returns unsupported for archived cloud engines', () => {
  assert.equal(getManagedReasoningEffortSupport('openai'), 'unsupported');
  assert.equal(getManagedReasoningEffortSupport('anthropic'), 'unsupported');
  assert.equal(getManagedReasoningEffortSupport('gemini'), 'unsupported');
});

test('getManagedReasoningEffortSupport respects provider capabilities', () => {
  const caps = { custom: { reasoning_effort_support: 'supported' } };
  assert.equal(getManagedReasoningEffortSupport('custom', caps), 'supported');
});

test('getManagedReasoningEffortSupport ollama with thinking capability', () => {
  assert.equal(
    getManagedReasoningEffortSupport('ollama', null, { activeModelCapabilities: { thinking: true } }),
    'supported'
  );
});

test('getManagedReasoningEffortSupport recognizes Qwen3.8 from partial Ollama status', () => {
  const options = {
    activeModelCapabilities: {},
    localRuntime: null,
    modelId: 'qwen3.8:27b-q3-k-s',
  };
  assert.equal(getManagedReasoningEffortSupport('ollama', {}, options), 'supported');
  assert.equal(normalizeManagedReasoningEffort('high', 'ollama', {}, options), 'high');
});

/* ── normalizeManagedReasoningEffort ── */

test('normalizeManagedReasoningEffort passes through default', () => {
  assert.equal(normalizeManagedReasoningEffort('default', 'anthropic'), 'default');
});

test('normalizeManagedReasoningEffort downgrades unsupported effort', () => {
  assert.equal(normalizeManagedReasoningEffort('high', 'anthropic'), 'default');
});

test('normalizeManagedReasoningEffort passes through supported effort', () => {
  assert.equal(normalizeManagedReasoningEffort('high', 'vllm'), 'high');
});

test('normalizeManagedReasoningEffort preserves xhigh for supported engines', () => {
  assert.equal(normalizeManagedReasoningEffort('xhigh', 'vllm'), 'xhigh');
  assert.equal(normalizeManagedReasoningEffort('extra high', 'vllm'), 'xhigh');
});

test('normalizeManagedReasoningEffort enforces model-specific ChatGPT choices', () => {
  assert.equal(
    normalizeManagedReasoningEffort('max', 'chatgpt', null, { modelId: 'gpt-5.6-sol' }),
    'max'
  );
  assert.equal(
    normalizeManagedReasoningEffort('max', 'chatgpt', null, { modelId: 'gpt-5.5' }),
    'default'
  );
  assert.equal(
    normalizeManagedReasoningEffort('minimal', 'codex-cli', null, { modelId: 'codex-cli/default' }),
    'minimal'
  );
});

/* —— normalizeManagedToolPreferences —— */

test('normalizeManagedToolPreferences ignores absent or invalid payloads', () => {
  assert.equal(normalizeManagedToolPreferences(undefined), undefined);
  assert.equal(normalizeManagedToolPreferences(null), undefined);
  assert.equal(normalizeManagedToolPreferences('invalid'), undefined);
  assert.equal(normalizeManagedToolPreferences([]), undefined);
  assert.equal(normalizeManagedToolPreferences({}), undefined);
});

test('normalizeManagedToolPreferences maps known false toggle to disabled tool ids', () => {
  assert.deepEqual(normalizeManagedToolPreferences({ web_search: false }), {
    enabled_tools: [],
    disabled_tools: ['fetch_url', 'web_search'],
  });
});

test('normalizeManagedToolPreferences unions off-group tools into an engaged allowlist', () => {
  const normalized = normalizeManagedToolPreferences({ web_search: true });
  assert.deepEqual(normalized.disabled_tools, []);
  const enabled = new Set(normalized.enabled_tools);
  for (const toolId of ['fetch_url', 'web_search']) {
    assert.ok(enabled.has(toolId), `${toolId} must be enabled by its own toggle`);
  }
  // Off-group tools must survive the exclusive allowlist (the delete_file /
  // tool_search / mermaid vanish class).
  for (const toolId of NON_TOGGLE_GROUP_TOOL_IDS) {
    assert.ok(enabled.has(toolId), `off-group tool ${toolId} must not vanish`);
  }
  // Tools that belong to a group left un-toggled stay out of the allowlist.
  assert.ok(!enabled.has('run_command'), 'un-toggled group tools stay excluded');
  assert.ok(!enabled.has('stop_background_job'), 'un-toggled group tools stay excluded');
  assert.ok(!enabled.has('delete_file'), 'file_tools members follow their toggle');
});

test('every canonical manifest tool survives an exclusive composer toggle', () => {
  const manifest = require('../services/tools/tool-manifest.json');
  const grouped = new Set(
    Object.values(TOOL_PREFERENCE_TOGGLE_TO_TOOL_IDS).flat()
  );
  // Derived from the manifest and the toggle map alone. Comparing against
  // NON_TOGGLE_GROUP_TOOL_IDS -- as this test used to -- is a tautology:
  // production DEFINES that constant as exactly this complement, so
  // `grouped.has(name) || protectedIds.has(name)` held for every manifest entry
  // no matter what the runtime allowlist actually did.
  const ungrouped = manifest.tools
    .map((tool) => tool.name)
    .filter((name) => name && !grouped.has(name));
  assert.ok(ungrouped.length > 0, 'fixture guard: the manifest must contain ungrouped tools');

  // Exercise the runtime path instead: one composer toggle set makes the
  // allowlist exclusive, and every ungrouped tool must still be offered.
  const enabled = new Set(normalizeManagedToolPreferences({ web_search: true }).enabled_tools);
  for (const name of ungrouped) {
    assert.ok(
      enabled.has(name),
      `${name} is neither in a composer toggle group nor protected from ` +
        'the exclusive allowlist — it would silently vanish from the model ' +
        'offer whenever any composer toggle is set'
    );
  }
});

test('normalizeManagedToolPreferences maps Bash false to the full job lifecycle', () => {
  assert.deepEqual(normalizeManagedToolPreferences({ Bash: false }), {
    enabled_tools: [],
    disabled_tools: [
      'check_background_job',
      'run_command',
      'run_temp_script',
      'stop_background_job',
    ],
  });
});

test('normalizeManagedToolPreferences ignores unknown keys and non-boolean values', () => {
  assert.equal(
    normalizeManagedToolPreferences({
      unknown_toggle: false,
      web_search: 'false',
      Bash: 1,
    }),
    undefined
  );
});

/* ── summarizeToolPayload ── */

test('summarizeToolPayload includes command when present', () => {
  assert.equal(summarizeToolPayload('shell', { command: 'ls -la' }), 'shell ls -la');
});

test('summarizeToolPayload includes file path when present', () => {
  assert.equal(summarizeToolPayload('write_file', { file_path: '/tmp/a.txt' }), 'Write /tmp/a.txt');
});

test('summarizeToolPayload maps canonical read tool ids to friendly names', () => {
  assert.equal(summarizeToolPayload('read_file', { file_path: '/tmp/a.txt' }), 'Read /tmp/a.txt');
});

test('summarizeToolPayload falls back to tool name', () => {
  assert.equal(summarizeToolPayload('web_search', {}), 'web_search');
});

test('summarizeToolPayload handles null input', () => {
  assert.equal(summarizeToolPayload(null, null), 'Tool');
});

/* ── extractClientMessageId ── */

test('extractClientMessageId extracts id', () => {
  assert.equal(extractClientMessageId({ client_message_id: 'msg_1' }), 'msg_1');
});

test('extractClientMessageId returns empty for invalid input', () => {
  assert.equal(extractClientMessageId(null), '');
  assert.equal(extractClientMessageId({}), '');
});

/* ── dedupeSessionMessages ── */

test('dedupeSessionMessages removes duplicates by client_message_id', () => {
  const backend = [
    { role: 'user', content: 'hi', client_message_id: 'msg_1' },
  ];
  const shadow = [
    { role: 'user', content: 'hi', client_message_id: 'msg_1', timestamp: '2026-01-01' },
    { role: 'assistant', content: 'hey', client_message_id: 'msg_2', timestamp: '2026-01-02' },
  ];
  const result = dedupeSessionMessages(backend, shadow);
  const mergedUserMsgs = result.mergedMessages.filter((m) => m.content === 'hi');
  assert.equal(mergedUserMsgs.length, 1);
});

test('dedupeSessionMessages preserves non-plain messages', () => {
  const backend = [];
  const shadow = [
    { role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'shell' }, timestamp: '2026-01-01' },
  ];
  const result = dedupeSessionMessages(backend, shadow);
  assert.equal(result.mergedMessages.length, 1);
});

test('dedupeSessionMessages handles null inputs', () => {
  const result = dedupeSessionMessages(null, null);
  assert.deepEqual(result.mergedMessages, []);
});

/* ── buildMemorySuggestionMessages ── */

test('buildMemorySuggestionMessages filters empty content', () => {
  const result = buildMemorySuggestionMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'world' },
  ]);
  assert.deepEqual(result, [{ role: 'user', content: 'hello' }]);
});

test('buildMemorySuggestionMessages keeps only recent plain user messages when bounded', () => {
  const result = buildMemorySuggestionMessages([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'second' },
    { role: 'assistant', kind: 'tool_result', content: 'tool output' },
    { role: 'user', content: 'third' },
    { role: 'user', content: 'fourth' },
  ], { maxUserMessages: 3 });

  assert.deepEqual(result, [
    { role: 'user', content: 'second' },
    { role: 'user', content: 'third' },
    { role: 'user', content: 'fourth' },
  ]);
});

/* ── normalizeRecallQueryFragment ── */

test('normalizeRecallQueryFragment collapses whitespace', () => {
  assert.equal(normalizeRecallQueryFragment('  hello   world  '), 'hello world');
});

test('normalizeRecallQueryFragment handles null', () => {
  assert.equal(normalizeRecallQueryFragment(null), '');
});

/* ── buildRecallQuery ── */

test('buildRecallQuery includes prompt', () => {
  const query = buildRecallQuery([], 'tell me about testing');
  assert.ok(query.includes('testing'));
});

test('buildRecallQuery includes prior user messages', () => {
  const messages = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second question' },
  ];
  const query = buildRecallQuery(messages, 'current prompt');
  assert.ok(query.includes('current prompt'));
});

test('buildRecallQuery returns empty for no input', () => {
  assert.equal(buildRecallQuery([], ''), '');
});

test('buildRecallQuery respects maxQueryLength', () => {
  const query = buildRecallQuery([], 'a'.repeat(1000), { maxQueryLength: 50 });
  assert.ok(query.length <= 50);
});

/* ── promptHasExplicitResponseStyleInstruction ── */

test('promptHasExplicitResponseStyleInstruction detects style patterns', () => {
  assert.equal(promptHasExplicitResponseStyleInstruction('please be concise'), true);
  assert.equal(promptHasExplicitResponseStyleInstruction('show me step by step'), true);
  assert.equal(promptHasExplicitResponseStyleInstruction('be direct'), true);
});

test('promptHasExplicitResponseStyleInstruction returns false for plain prompts', () => {
  assert.equal(promptHasExplicitResponseStyleInstruction('what is the weather'), false);
  assert.equal(promptHasExplicitResponseStyleInstruction(''), false);
});
