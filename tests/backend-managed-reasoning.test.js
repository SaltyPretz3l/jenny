'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRequestReasoningEffort,
} = require('../services/backend/backend-managed-reasoning');
const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  makeCtx,
  makeHandleToolNotification,
} = require('./helpers/managed-runtime-notification-harness');

function createService(overrides = {}) {
  return {
    currentModel: 'gpt-5.6-sol',
    defaultModel: 'gpt-5.6-sol',
    currentEngineType: 'chatgpt',
    currentStatus: {
      engine: 'chatgpt',
      model: 'gpt-5.6-sol',
      provider_capabilities: {
        chatgpt: { reasoning_effort_support: 'supported' },
      },
      active_model_capabilities: {},
    },
    sessionStore: {
      getSession: () => ({ preferred_model: '', reasoning_effort: 'default' }),
    },
    shadowStore: { getSession: () => null },
    ...overrides,
  };
}

test('explicit effort uses the active model when the request has no model override', () => {
  const effort = resolveRequestReasoningEffort(createService(), 'high', '');

  assert.equal(effort, 'high');
});

test('active model still rejects an effort that model does not support', () => {
  const service = createService({
    currentModel: 'gpt-5.5',
    defaultModel: 'gpt-5.5',
    currentStatus: {
      engine: 'chatgpt',
      model: 'gpt-5.5',
      provider_capabilities: {
        chatgpt: { reasoning_effort_support: 'supported' },
      },
      active_model_capabilities: {},
    },
  });
  const effort = resolveRequestReasoningEffort(service, 'max', '');

  assert.equal(effort, 'default');
});

test('request model override remains the normalization authority', () => {
  const effort = resolveRequestReasoningEffort(createService(), 'max', 'gpt-5.5');

  assert.equal(effort, 'default');
});

test('partial Ollama status preserves Qwen3.8 request effort', () => {
  const service = createService({
    currentModel: '',
    defaultModel: '',
    currentEngineType: 'ollama',
    currentStatus: {
      engine: 'ollama',
      model: '',
      provider_capabilities: {},
      active_model_capabilities: {},
    },
  });
  const effort = resolveRequestReasoningEffort(service, 'high', 'qwen3.8:27b-q3-k-s');

  assert.equal(effort, 'high');
});

// 2026-09-18: a bare llama-server alias inferred as Ollama, whose non-qwen3.8
// rule reset every graded effort to Automatic on each write.
const BONSAI = 'ternary-bonsai-2-27b-pq2_0';

function llamaServerService(overrides = {}) {
  return createService({
    currentModel: BONSAI,
    defaultModel: BONSAI,
    currentEngineType: 'openai-compatible',
    currentStatus: {
      engine: 'openai-compatible',
      model: BONSAI,
      provider_capabilities: {
        'openai-compatible': { reasoning_effort_support: 'supported' },
        ollama: { reasoning_effort_support: 'supported' },
      },
      active_model_capabilities: {},
    },
    ...overrides,
  });
}

test('a llama-server alias keeps its effort while that server serves it', () => {
  const effort = resolveRequestReasoningEffort(llamaServerService(), 'xhigh', BONSAI);

  assert.equal(effort, 'xhigh');
});

test('a llama-server alias keeps its effort through its catalog engine hint', () => {
  const service = llamaServerService({
    currentModel: 'qwen3.5:9b',
    currentEngineType: 'ollama',
    currentStatus: {
      engine: 'ollama',
      model: 'qwen3.5:9b',
      provider_capabilities: {
        'openai-compatible': { reasoning_effort_support: 'supported' },
        ollama: { reasoning_effort_support: 'supported' },
      },
      active_model_capabilities: {},
    },
    _modelEngineHints: new Map([[BONSAI, 'openai-compatible']]),
  });
  const effort = resolveRequestReasoningEffort(service, 'medium', BONSAI);

  assert.equal(effort, 'medium');
});

// Gate C4 F5 review: with the picker no longer saving its clamp, the request
// must run what the picker shows. Bonsai's llama template treats `low` as
// thinking off, while the picker shows Automatic (medium).
test('a stored effort outside the catalog-declared ladder runs as Automatic on the request', () => {
  const service = llamaServerService({
    _modelListLastResult: {
      value: {
        data: [{
          id: BONSAI,
          engine_type: 'openai-compatible',
          capabilities: { reasoning_efforts: ['none', 'medium', 'xhigh'], default_reasoning_effort: 'medium' },
        }],
      },
    },
  });

  assert.equal(resolveRequestReasoningEffort(service, 'low', ''), 'default');
  assert.equal(resolveRequestReasoningEffort(service, 'xhigh', ''), 'xhigh');
  assert.equal(resolveRequestReasoningEffort(service, 'none', BONSAI), 'none');
});

test('a forced engine outranks a stale catalog hint for the request clamp', () => {
  const service = llamaServerService({
    currentModel: 'qwen3.5:9b',
    currentEngineType: 'vllm',
    currentStatus: {
      engine: 'vllm',
      model: 'qwen3.5:9b',
      provider_capabilities: {
        vllm: { reasoning_effort_support: 'supported' },
        ollama: { reasoning_effort_support: 'supported' },
      },
      active_model_capabilities: {},
    },
    _modelEngineHints: new Map([['qwen3.5:9b', 'ollama']]),
  });

  assert.equal(resolveRequestReasoningEffort(service, 'high', 'qwen3.5:9b'), 'default',
    'without the engine the stale Ollama hint clamps (the pre-fix request behavior)');
  assert.equal(resolveRequestReasoningEffort(service, 'high', 'qwen3.5:9b', 'vllm'), 'high');
});

test('chat.thinking budget raises the persisted reasoning cap while absent signal keeps 48,000', () => {
  const dependenciesFor = (ctx) => ({
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
  const dynamicCtx = makeCtx();
  handleNotification(dynamicCtx, {
    method: 'chat.thinking',
    params: {
      kind: 'reasoning',
      delta: 'd'.repeat(50_000),
      thinking_id: 'think-dynamic',
      thinking_budget_chars: 65_536,
    },
  }, dependenciesFor(dynamicCtx));

  assert.equal(dynamicCtx.thinkingBudgetChars, 65_536);
  assert.equal(dynamicCtx.reasoningEntries[0].text.length, 50_000);
  assert.doesNotMatch(dynamicCtx.reasoningEntries[0].text, /reasoning truncated/);

  const defaultCtx = makeCtx();
  handleNotification(defaultCtx, {
    method: 'chat.thinking',
    params: {
      kind: 'reasoning',
      delta: 'd'.repeat(50_000),
      thinking_id: 'think-default',
    },
  }, dependenciesFor(defaultCtx));

  assert.equal(defaultCtx.thinkingBudgetChars, undefined);
  assert.equal(defaultCtx.reasoningEntries[0].text.length, 48_000);
  assert.match(defaultCtx.reasoningEntries[0].text, /reasoning truncated/);
});
