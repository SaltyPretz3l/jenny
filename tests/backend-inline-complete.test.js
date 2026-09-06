const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateInlineCompletion,
  listLoadedInlineModels,
  unloadInlineModel,
} = require('../services/backend/backend-inline-complete');

function createMockService(overrides = {}) {
  return {
    currentStatus: { model_loaded: true },
    currentModel: 'chat-v1',
    activeStreams: new Map(),
    sidecarClient: {
      request: async () => ({ completion: 'console.log()' }),
    },
    sidecarManager: {
      getStatus: () => ({ phase: 'ready' }),
    },
    _emitServiceLog: () => {},
    ...overrides,
  };
}

const PAYLOAD = { prefix: 'console.', suffix: ')', model: 'qwen2.5-coder:1.5b-base' };

test('returns no_model_selected before any sidecar guard when model is blank', async () => {
  const service = createMockService({ sidecarClient: null });
  const res = await generateInlineCompletion(service, { ...PAYLOAD, model: '' });
  assert.deepEqual(res, { ok: false, available: false, reason: 'no_model_selected' });
});

test('returns empty_context when both prefix and suffix are empty', async () => {
  const service = createMockService();
  assert.equal((await generateInlineCompletion(service, { model: 'm', prefix: '', suffix: '' })).reason, 'empty_context');
});

test('returns sidecar_unavailable when sidecarClient is null', async () => {
  const service = createMockService({ sidecarClient: null });
  assert.equal((await generateInlineCompletion(service, PAYLOAD)).reason, 'sidecar_unavailable');
});

test('returns sidecar_not_ready when the sidecar phase is not ready', async () => {
  const service = createMockService({ sidecarManager: { getStatus: () => ({ phase: 'starting' }) } });
  assert.equal((await generateInlineCompletion(service, PAYLOAD)).reason, 'sidecar_not_ready');
});

test('SKIPS while a chat stream is active (serial sidecar; would queue + time out)', async () => {
  const service = createMockService({ activeStreams: new Map([['s', {}]]) });
  const res = await generateInlineCompletion(service, PAYLOAD);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'chat_stream_active');
});

test('proceeds even when no chat model is loaded (FIM uses its own independent model)', async () => {
  let called = false;
  const service = createMockService({
    currentStatus: { model_loaded: false },
    currentModel: '',
    sidecarClient: { request: async () => { called = true; return { completion: 'fim()' }; } },
  });
  const res = await generateInlineCompletion(service, PAYLOAD);
  assert.deepEqual(res, {
    ok: true,
    completion: 'fim()',
    computeTarget: 'automatic',
    computeReason: 'runtime_resource_policy',
  });
  assert.equal(called, true, 'reaches the sidecar rather than short-circuiting on the chat-model gate');
});

test('forwards completion context without a manual compute override and returns compute status', async () => {
  let captured = null;
  const service = createMockService({
    sidecarClient: {
      request: async (method, params) => {
        captured = { method, params };
        return { completion: 'log("hi")', compute_target: 'automatic', compute_reason: 'ollama_runtime_resource_policy' };
      },
    },
  });
  const res = await generateInlineCompletion(service, { ...PAYLOAD, useGpu: true, maxTokens: 48 });
  assert.deepEqual(res, {
    ok: true,
    completion: 'log("hi")',
    computeTarget: 'automatic',
    computeReason: 'ollama_runtime_resource_policy',
  });
  assert.equal(captured.method, 'inline.complete');
  assert.equal(captured.params.prefix, 'console.');
  assert.equal(captured.params.suffix, ')');
  assert.equal(captured.params.model, 'qwen2.5-coder:1.5b-base');
  assert.equal('use_gpu' in captured.params, false);
  assert.equal(captured.params.max_tokens, 48);
});

test('defaults max_tokens to 96 without sending the retired compute preference', async () => {
  let captured = null;
  const service = createMockService({
    sidecarClient: { request: async (_m, params) => { captured = params; return { completion: 'x' }; } },
  });
  await generateInlineCompletion(service, PAYLOAD);
  assert.equal(captured.max_tokens, 96);
  assert.equal('use_gpu' in captured, false);
});

test('returns generate_failed (no throw) and logs at INFO on a sidecar error', async () => {
  const logs = [];
  const service = createMockService({
    sidecarClient: { request: async () => { throw new Error('inline down'); } },
    _emitServiceLog: (level, event) => logs.push({ level, event }),
  });
  const res = await generateInlineCompletion(service, PAYLOAD);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'generate_failed');
  assert.equal(logs[0].level, 'INFO');
  assert.equal(logs[0].event, 'inline_complete.generate_failed');
});

// --- payload size caps (backstop against a misbehaving/compromised renderer) ---

function createCountingService(overrides = {}) {
  const calls = { count: 0 };
  const service = createMockService({
    sidecarClient: {
      request: async (...args) => { calls.count += 1; return { completion: 'ok()' }; },
    },
    ...overrides,
  });
  return { service, calls };
}

test('rejects an oversized prefix with payload_too_large before touching the sidecar', async () => {
  const { service, calls } = createCountingService();
  const res = await generateInlineCompletion(service, { ...PAYLOAD, prefix: 'x'.repeat(8001) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'payload_too_large');
  assert.equal(calls.count, 0);
});

test('rejects an oversized suffix with payload_too_large before touching the sidecar', async () => {
  const { service, calls } = createCountingService();
  const res = await generateInlineCompletion(service, { ...PAYLOAD, suffix: 'x'.repeat(4001) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'payload_too_large');
  assert.equal(calls.count, 0);
});

test('rejects an oversized model with payload_too_large before touching the sidecar', async () => {
  const { service, calls } = createCountingService();
  const res = await generateInlineCompletion(service, { ...PAYLOAD, model: 'm'.repeat(201) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'payload_too_large');
  assert.equal(calls.count, 0);
});

test('rejects an oversized maxTokens with payload_too_large before touching the sidecar', async () => {
  const { service, calls } = createCountingService();
  const res = await generateInlineCompletion(service, { ...PAYLOAD, maxTokens: 100_000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'payload_too_large');
  assert.equal(calls.count, 0);
});

test('emits INFO inline_complete.payload_too_large when a cap is exceeded', async () => {
  const logs = [];
  const service = createMockService({
    _emitServiceLog: (level, event) => logs.push({ level, event }),
  });
  await generateInlineCompletion(service, { ...PAYLOAD, prefix: 'x'.repeat(8001) });
  assert.equal(logs[0].level, 'INFO');
  assert.equal(logs[0].event, 'inline_complete.payload_too_large');
});

test('BOUNDARY: max-sized prefix/suffix/model/maxTokens together still reach the sidecar', async () => {
  const { service, calls } = createCountingService();
  const res = await generateInlineCompletion(service, {
    prefix: 'x'.repeat(8000),
    suffix: 'y'.repeat(4000),
    model: 'm'.repeat(200),
    maxTokens: 512,
  });
  assert.equal(res.ok, true);
  assert.equal(calls.count, 1);
});

test('does NOT reject an astral prefix whose code-point count is within the cap even though its UTF-16 length exceeds it', async () => {
  const { service, calls } = createCountingService();
  const prefix = '\u{1F600}'.repeat(4001); // 4001 code points, 8002 UTF-16 code units
  const res = await generateInlineCompletion(service, { ...PAYLOAD, prefix });
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
  assert.equal(calls.count, 1);
});

test('still rejects an astral prefix whose code-point count exceeds the cap', async () => {
  const { service, calls } = createCountingService();
  const prefix = '\u{1F600}'.repeat(8001); // 8001 code points, over the 8000 cap
  const res = await generateInlineCompletion(service, { ...PAYLOAD, prefix });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'payload_too_large');
  assert.equal(calls.count, 0);
});

// --- loaded-model status + unload-by-tag --------------------------------------

test('listLoadedInlineModels returns the daemon-loaded model names', async () => {
  let method = null;
  const service = createMockService({
    sidecarClient: {
      request: async (m) => { method = m; return { loaded: ['qwen2.5-coder:1.5b-base', 'gemma4:12b'] }; },
    },
  });
  const res = await listLoadedInlineModels(service);
  assert.deepEqual(res, { ok: true, loaded: ['qwen2.5-coder:1.5b-base', 'gemma4:12b'] });
  assert.equal(method, 'inline.loaded_models');
});

test('listLoadedInlineModels degrades to chat_stream_active during a stream', async () => {
  const service = createMockService({ activeStreams: new Map([['s', {}]]) });
  const res = await listLoadedInlineModels(service);
  assert.deepEqual(res, { ok: false, loaded: [], available: false, reason: 'chat_stream_active' });
});

test('listLoadedInlineModels degrades to query_failed (no throw) on a sidecar error', async () => {
  const service = createMockService({
    sidecarClient: { request: async () => { throw new Error('ps down'); } },
  });
  const res = await listLoadedInlineModels(service);
  assert.deepEqual(res, { ok: false, loaded: [], reason: 'query_failed' });
});

test('unloadInlineModel requires a model tag', async () => {
  const service = createMockService();
  assert.deepEqual(await unloadInlineModel(service, { model: '' }), { ok: false, reason: 'no_model_selected' });
});

test('unloadInlineModel forwards the tag and returns ok from the sidecar', async () => {
  let captured = null;
  const service = createMockService({
    sidecarClient: { request: async (m, params) => { captured = { m, params }; return { ok: true }; } },
  });
  const res = await unloadInlineModel(service, { model: 'qwen2.5-coder:1.5b-base' });
  assert.deepEqual(res, { ok: true });
  assert.equal(captured.m, 'inline.unload');
  assert.equal(captured.params.model, 'qwen2.5-coder:1.5b-base');
});

test('unloadInlineModel degrades to unload_failed (no throw) on a sidecar error', async () => {
  const service = createMockService({
    sidecarClient: { request: async () => { throw new Error('boom'); } },
  });
  assert.deepEqual(await unloadInlineModel(service, { model: 'm' }), { ok: false, reason: 'unload_failed' });
});
