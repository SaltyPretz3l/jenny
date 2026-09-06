'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeManagedSessionPreferencePatch,
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

test('explicit effort uses the active model when the conversation has no model override', () => {
  const patch = normalizeManagedSessionPreferencePatch(createService(), {
    preferred_model: '',
    reasoning_effort: 'high',
  }, 'session-active-model');

  assert.equal(patch.preferred_model, '');
  assert.equal(patch.reasoning_effort, 'high');
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
  const patch = normalizeManagedSessionPreferencePatch(service, {
    preferred_model: '',
    reasoning_effort: 'max',
  }, 'session-active-model');

  assert.equal(patch.reasoning_effort, 'default');
});

test('conversation model override remains the normalization authority', () => {
  const patch = normalizeManagedSessionPreferencePatch(createService(), {
    preferred_model: 'gpt-5.5',
    reasoning_effort: 'max',
  }, 'session-model-override');

  assert.equal(patch.reasoning_effort, 'default');
});

test('partial Ollama status preserves Qwen3.8 session effort', () => {
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
  const patch = normalizeManagedSessionPreferencePatch(service, {
    preferred_model: 'qwen3.8:27b-q3-k-s',
    reasoning_effort: 'high',
  }, 'session-qwen38-partial-status');

  assert.equal(patch.reasoning_effort, 'high');
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
