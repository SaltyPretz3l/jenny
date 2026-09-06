const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/chat/renderer-context-usage-model');
const { selectContextHistoryMessages } = require('../services/backend/chat-stream-reasoning');

function messages() {
  return [
    { id: 'u1', role: 'user', content: 'a'.repeat(40) },
    { id: 'a1', role: 'assistant', content: 'b'.repeat(40) },
    {
      id: 't1',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: { call_id: 'tool-call-1', output_text: 'c'.repeat(40) },
    },
    { id: 'u2', role: 'user', content: 'd'.repeat(40) },
    { id: 'a2', role: 'assistant', content: 'e'.repeat(40) },
  ];
}

test('history-scope estimates mirror session, recent, and fresh selection', () => {
  const source = messages();
  assert.equal(model.estimateContextMessagesTokens(source, 'session'), 50);
  assert.equal(model.estimateContextMessagesTokens(source, 'recent'), 50);
  assert.equal(model.estimateContextMessagesTokens(source, 'fresh'), 0);

  const manyTurns = [];
  for (let index = 0; index < 8; index += 1) {
    manyTurns.push({ id: `u${index}`, role: 'user', content: 'x'.repeat(40) });
    manyTurns.push({ id: `a${index}`, role: 'assistant', content: 'y'.repeat(40) });
  }
  assert.equal(model.estimateContextMessagesTokens(manyTurns, 'session'), 160);
  assert.equal(model.estimateContextMessagesTokens(manyTurns, 'recent'), 120);
  for (const historyScope of ['session', 'recent', 'fresh']) {
    assert.deepEqual(
      model.selectContextEstimateMessages(manyTurns, historyScope),
      selectContextHistoryMessages(manyTurns, { history_scope: historyScope }),
      `${historyScope} selection mirrors the backend fixture`,
    );
  }
});

test('context estimates include provider-shaped tool and interactive rows', () => {
  const source = [
    {
      id: 'tool-use',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-1',
        tool_name: 'read_file',
        input_json: JSON.stringify({ path: 'x'.repeat(40) }),
      },
    },
    {
      id: 'tool-result',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: { call_id: 'call-1', output_text: 'y'.repeat(40) },
    },
    {
      id: 'questions',
      role: 'assistant',
      kind: 'question_batch',
      interactive_batch: { questions: [{ prompt: 'z'.repeat(40) }] },
    },
  ];
  assert.ok(model.estimateContextMessagesTokens(source, 'session') >= 30);
});

test('session estimate uses compacted base plus only the appended suffix', () => {
  const source = messages();
  const estimate = model.buildContextUsageEstimate(source, {
    contextLimit: 10000,
    historyScope: 'session',
    overheadTokens: 25,
    compactionContext: {
      version: 1,
      created_at: '2026-08-14T00:00:00.000Z',
      strategy: 'full',
      tokens_before: 5000,
      tokens_after: 900,
      boundary_message_count: 3,
    },
  });
  assert.equal(estimate.usageSource, 'compaction');
  assert.equal(estimate.usedTokens, 945, '900 compacted + 20 suffix + 25 overhead');
});

test('v2 compaction estimate uses replacement tokens without double-counting overhead', () => {
  const source = messages();
  const estimate = model.buildContextUsageEstimate(source, {
    contextLimit: 10000,
    historyScope: 'session',
    overheadTokens: 25,
    compactionContext: {
      version: 2,
      created_at: '2026-08-18T00:00:00.000Z',
      strategy: 'full',
      tokens_before: 5000,
      tokens_after: 900,
      replacement_tokens: 120,
      boundary_message_count: 3,
    },
  });
  assert.equal(estimate.usageSource, 'compaction');
  assert.equal(estimate.usedTokens, 165, '120 replacement + 20 suffix + 25 overhead');
});

test('v2 compaction estimate falls back to tokens_after without replacement tokens', () => {
  const source = messages();
  const estimate = model.buildContextUsageEstimate(source, {
    contextLimit: 10000,
    historyScope: 'session',
    overheadTokens: 25,
    compactionContext: {
      version: 2,
      created_at: '2026-08-18T00:00:00.000Z',
      strategy: 'full',
      tokens_before: 5000,
      tokens_after: 900,
      boundary_message_count: 3,
    },
  });
  assert.equal(estimate.usageSource, 'compaction');
  assert.equal(estimate.usedTokens, 945, '900 compacted + 20 suffix + 25 overhead');
});

test('unknown compaction snapshot versions fall back to an estimate', () => {
  const source = messages();
  const estimate = model.buildContextUsageEstimate(source, {
    contextLimit: 10000,
    historyScope: 'session',
    overheadTokens: 25,
    compactionContext: {
      version: 3,
      created_at: '2026-08-18T00:00:00.000Z',
      strategy: 'full',
      tokens_before: 5000,
      tokens_after: 900,
      replacement_tokens: 120,
      boundary_message_count: 3,
    },
  });
  assert.equal(estimate.usageSource, 'estimate');
  assert.equal(estimate.usedTokens, 75, '50 estimated messages + 25 overhead');
});

test('aggregate estimates include countable messages without ids', () => {
  const source = [
    { role: 'user', content: 'abcdefgh' },
    { id: 'a1', role: 'assistant', content: 'abcdefgh' },
  ];
  assert.equal(model.walkMessageTokenEstimates(source), 4);
  const meta = model.buildMessageTokenMeta(source);
  assert.equal(meta.get('a1').cumulativeTokens, 4);
});

test('target resolution uses exact auto-compact thresholds only when enabled', () => {
  const usage = { contextLimit: 10000, compactThresholdTokens: 7000 };
  assert.deepEqual(model.resolveContextTarget(usage, { autoCompactEnabled: true }), {
    limit: 7000, type: 'auto_compact', exact: true,
  });
  assert.deepEqual(model.resolveContextTarget(usage, { autoCompactEnabled: false }), {
    limit: 10000, type: 'context_window', exact: true,
  });
  assert.deepEqual(model.resolveContextTarget({ contextLimit: 10000 }, { autoCompactEnabled: true }), {
    limit: 10000, type: 'context_window', exact: true,
  });
});

test('sidecar context_used_tokens is the preferred numerator with source mapping', () => {
  const store = model.createContextUsageStore();
  // The sidecar's max(provider, estimate) figure beats both legacy fields.
  const provider = store.updateUsage('s1', {
    usage: {
      context_used_tokens: 42000,
      context_used_source: 'provider',
      context_tokens_estimate: 41000,
      last_request_input_tokens: 42000,
      context_window: 100000,
      model: 'm',
    },
  });
  assert.equal(provider.usedTokens, 42000);
  assert.equal(provider.usageSource, 'provider');

  // KV-cache undercount already resolved sidecar-side: source is estimate.
  const estimate = store.updateUsage('s2', {
    usage: {
      context_used_tokens: 42000,
      context_used_source: 'estimate',
      context_tokens_estimate: 42000,
      last_request_input_tokens: 900,
      context_window: 100000,
      model: 'm',
    },
  });
  assert.equal(estimate.usedTokens, 42000);
  assert.equal(estimate.usageSource, 'context');
});

test('legacy payloads without context_used_tokens keep the local guard byte-identical', () => {
  const store = model.createContextUsageStore();
  // Provider truth covers the estimate: provider wins.
  const provider = store.updateUsage('s1', {
    usage: {
      context_tokens_estimate: 41000,
      last_request_input_tokens: 42000,
      context_window: 100000,
      model: 'm',
    },
  });
  assert.equal(provider.usedTokens, 42000);
  assert.equal(provider.usageSource, 'provider');

  // KV-cache undercount without the sidecar figure: the local guard falls
  // back to the estimate exactly as before.
  const guard = store.updateUsage('s2', {
    usage: {
      context_tokens_estimate: 42000,
      last_request_input_tokens: 900,
      context_window: 100000,
      model: 'm',
    },
  });
  assert.equal(guard.usedTokens, 42000);
  assert.equal(guard.usageSource, 'context');
});

test('fallback estimate inherits the auto-compact denominator and a prior-usage floor', () => {
  // Cause-B regression: the client fallback estimate used to hard-code
  // compactThresholdTokens: 0, so the ring's denominator silently jumped from
  // the auto-compact threshold to the full window (~2x) whenever the fallback
  // took over from a sidecar-sourced record.
  const estimate = model.buildContextUsageEstimate(messages(), {
    contextLimit: 10000,
    historyScope: 'session',
    compactThresholdTokens: 7000,
    priorUsedTokens: 4000,
    model: 'm',
  });
  assert.equal(estimate.compactThresholdTokens, 7000, 'threshold carried into the estimate');
  assert.deepEqual(model.resolveContextTarget(estimate, { autoCompactEnabled: true }), {
    limit: 7000, type: 'auto_compact', exact: true,
  }, 'fallback renders against the same denominator as the stored record');
  assert.equal(estimate.usedTokens, 4000, 'a prior authoritative reading floors the numerator');

  // The memo signature must invalidate on both new inputs, or a stale cached
  // estimate survives the change.
  const store = model.createContextUsageStore();
  const source = messages();
  const base = { contextLimit: 10000, historyScope: 'session', model: 'm' };
  const first = store.buildCachedEstimate('s1', source, base);
  assert.notEqual(
    store.buildCachedEstimate('s1', source, { ...base, compactThresholdTokens: 7000 }),
    first,
    'threshold change invalidates the cached estimate',
  );
  assert.notEqual(
    store.buildCachedEstimate('s1', source, { ...base, priorUsedTokens: 9000 }),
    first,
    'prior-usage floor change invalidates the cached estimate',
  );
});

test('store is safe for prototype-like ids and bounds usage entries', () => {
  let now = 100;
  const store = model.createContextUsageStore({ now: () => now++ });
  store.updateUsage('__proto__', {
    usage: { context_tokens_estimate: 10, context_window: 100, model: 'm' },
  });
  assert.equal(store.getUsage('__proto__').usedTokens, 10);
  store.updateUsage('second', {
    usage: { context_tokens_estimate: 20, context_window: 100, model: 'm' },
  });
  store.pruneUsage({ maxEntries: 1, keepSessionIds: ['second'] });
  assert.equal(store.getUsage('__proto__'), null);
  assert.equal(store.getUsage('second').usedTokens, 20);
});

test('estimate-only session caches evict their oldest entry at the shared bound', () => {
  let now = 1;
  const store = model.createContextUsageStore({ now: () => now++ });
  const source = messages();
  const options = { contextLimit: 1000, historyScope: 'session' };
  const oldest = store.buildCachedEstimate('estimate-0', source, options);
  for (let index = 1; index <= 200; index += 1) {
    store.buildCachedEstimate(`estimate-${index}`, source, options);
  }
  assert.notEqual(
    store.buildCachedEstimate('estimate-0', source, options),
    oldest,
    'the oldest estimate-only entry is evicted once the cache exceeds 200 sessions',
  );
});

test('fallback memo is O(1) for unchanged inputs and invalidates on relevant changes', () => {
  const store = model.createContextUsageStore();
  const source = messages();
  const options = {
    contextLimit: 10000,
    historyScope: 'session',
    model: 'm',
    autoCompactEnabled: true,
    attachments: [{ id: 'image-1', kind: 'image', sizeBytes: 100 }],
  };
  const first = store.buildCachedEstimate('s1', source, options);
  const second = store.buildCachedEstimate('s1', source, { ...options });
  assert.equal(second, first, 'same array and scalar signature reuse the result object');
  const changedScope = store.buildCachedEstimate('s1', source, { ...options, historyScope: 'fresh', overheadTokens: 1 });
  assert.notEqual(changedScope, first);
  assert.notEqual(store.buildCachedEstimate('s1', source, { ...options, model: 'm2' }), first);
  assert.notEqual(store.buildCachedEstimate('s1', source, { ...options, contextLimit: 20000 }), first);
  assert.notEqual(store.buildCachedEstimate('s1', source, { ...options, autoCompactEnabled: false }), first);
  assert.notEqual(store.buildCachedEstimate('s1', source, {
    ...options,
    attachments: [{ id: 'audio-1', kind: 'audio', sizeBytes: 100 }],
  }), first);
  assert.notEqual(store.buildCachedEstimate('s1', source, {
    ...options,
    compactionContext: {
      version: 1,
      created_at: '2026-08-14T00:00:00.000Z',
      strategy: 'full',
      tokens_before: 100,
      tokens_after: 50,
      boundary_message_count: 1,
    },
  }), first);
  source.push({ id: 'u3', role: 'user', content: 'z'.repeat(40) });
  const appendedSuffix = store.buildCachedEstimate('s1', source, options);
  assert.notEqual(appendedSuffix, first, 'an in-place append invalidates by message count');
  assert.equal(appendedSuffix.usedTokens, first.usedTokens + 10);
  const changedMessages = store.buildCachedEstimate('s1', [...source], options);
  assert.notEqual(changedMessages, first);
});

test('persisted manual compaction immediately replaces stored usage with compaction provenance', () => {
  const store = model.createContextUsageStore();
  store.updateUsage('s1', {
    usage: {
      context_tokens_estimate: 4500,
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'm',
    },
  });
  const updated = store.updateCompactionUsage('s1', {
    compacted: true,
    snapshot_persisted: true,
    tokens_after: 800,
  });
  assert.equal(updated.usedTokens, 800);
  assert.equal(updated.usageSource, 'compaction');
  assert.equal(updated.contextLimit, 10000);
  assert.equal(updated.compactThresholdTokens, 7000);
  assert.equal(store.getUsage('s1'), updated);
});

test('unknown context windows fail honest instead of guessing from model names', () => {
  assert.equal(model.buildContextUsageEstimate(messages(), {
    contextLimit: 0,
    model: 'gemma3-or-any-future-model',
  }), null);
});
