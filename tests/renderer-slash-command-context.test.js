const test = require('node:test');
const assert = require('node:assert/strict');

const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const { createContextCommand } = require('../renderer/shell/renderer-slash-command-context');

test.afterEach(() => contextUsageUtils.clearAllUsage());

function createHarness(overrides = {}) {
  const outputs = [];
  const logs = [];
  const state = {
    runtimeDraft: {
      preferredModel: 'model-a',
      reasoningEffort: 'high',
      contextPreferences: {
        historyScope: 'recent',
        includePersonality: true,
        includeMemory: false,
      },
    },
    status: { effective_context_length: 10000 },
    ui: { contextOverheadTokens: 25 },
    features: { featureFlags: { token_budget: true, context_compaction: true } },
    sessions: [{ id: 's1' }],
    ...overrides.state,
  };
  const handler = createContextCommand({
    state,
    contextUsageModule: Object.prototype.hasOwnProperty.call(overrides, 'contextUsageModule')
      ? overrides.contextUsageModule : contextUsageUtils,
    getSessionMessages: () => [{ id: 'u1', role: 'user', content: 'hello world' }],
    getCurrentSessionMessages: () => [],
    appendClientLog: (...args) => logs.push(args),
    injectOutput: (...args) => { outputs.push(args); return true; },
    windowRef: overrides.windowRef,
  });
  return { handler, logs, outputs };
}

test('/context reads camelCase preferences and labels fallback usage as estimated', () => {
  const harness = createHarness();
  const result = harness.handler({ sessionId: 's1' });
  assert.equal(result.ok, true);
  const text = harness.outputs[0][0];
  assert.match(text, /History\s+\u00B7+\s+recent/);
  assert.match(text, /Personality and notes\s+\u00B7+\s+on/);
  assert.match(text, /Memory\s+\u00B7+\s+off/);
  assert.doesNotMatch(text, /Research/);
  assert.match(text, /Cached overhead\s+\u00B7+\s+~25 tokens/);
  assert.match(text, /Used\s+\u00B7+\s+~/);
  assert.match(text, /Freshness\s+\u00B7+\s+est\. context/);
});

test('/context uses authoritative usage from the last completed request', () => {
  contextUsageUtils.updateUsage('s1', {
    usage: {
      last_request_input_tokens: 7000,
      context_tokens_estimate: 6900,
      context_window: 10000,
      compact_threshold_tokens: 8000,
      model: 'model-a',
    },
  });
  const harness = createHarness();
  harness.handler({ sessionId: 's1' });
  const text = harness.outputs[0][0];
  assert.match(text, /Used\s+\u00B7+\s+7,000 tokens/);
  assert.doesNotMatch(text, /Used[^\n]+~/);
  assert.match(text, /Freshness\s+\u00B7+\s+last request/);
  assert.match(text, /Remaining\s+\u00B7+\s+1,000 tokens/);
  assert.match(text, /Target\s+\u00B7+\s+auto-compact threshold/);
});

test('/context does not fan out through optional bridge services', () => {
  let bridgeCalls = 0;
  const bridge = new Proxy({}, {
    get() {
      bridgeCalls += 1;
      throw new Error('bridge should not be read');
    },
  });
  const harness = createHarness({ windowRef: { jennyShell: bridge } });
  assert.doesNotThrow(() => harness.handler({ sessionId: 's1' }));
  assert.equal(bridgeCalls, 0);
  assert.equal(harness.outputs.length, 1);
});

test('/context degrades missing or malformed usage to a bounded unavailable result', () => {
  const missing = createHarness({ contextUsageModule: null });
  assert.doesNotThrow(() => missing.handler({ sessionId: 's1' }));
  assert.match(missing.outputs[0][0], /Usage unavailable/);
  assert.equal(missing.logs.some((entry) => entry[1] === 'slash.context_usage_unavailable'), true);

  const malformed = createHarness({
    contextUsageModule: {
      buildContextUsageEstimate() { throw new Error('token=secret'); },
      describeContextUsage() { throw new Error('prompt=secret'); },
    },
  });
  assert.doesNotThrow(() => malformed.handler({ sessionId: 's1' }));
  assert.match(malformed.outputs[0][0], /Usage unavailable/);
  assert.equal(malformed.logs.some((entry) => entry[1] === 'slash.context_usage_unavailable'), true);
  assert.doesNotMatch(JSON.stringify(malformed.logs), /token=secret|prompt=secret/);
});
